import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { HubError } from './errors.js';
import { LIMITS, VERSION, ASK_WAIT_MAX_S, DEFAULT_HUB } from '../shared/protocol.js';

const PAGES_DIR = fileURLToPath(new URL('./pages/', import.meta.url));

const CSP =
  "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

const PAGE_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const PING_MS = 25_000;
// Addresses or members a limiter remembers at once; beyond that it forgets the idle ones.
const LIMITER_KEYS = 50_000;

// Token bucket per key: `capacity` requests per `windowMs`, refilled continuously.
class Limiter {
  constructor(capacity, windowMs) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  take(key) {
    const now = Date.now();
    if (this.buckets.size >= LIMITER_KEYS) {
      this.sweep();
      if (this.buckets.size >= LIMITER_KEYS) this.buckets.clear();
    }
    const b = this.buckets.get(key) || { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) * this.capacity) / this.windowMs);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }

  sweep() {
    const now = Date.now();
    for (const [key, b] of this.buckets) if (now - b.at > this.windowMs) this.buckets.delete(key);
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    // An oversized body is drained (not stored) so the client still gets a clean 413;
    // anything absurdly large is cut off.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMITS.body * 16) {
        req.destroy();
        return;
      }
      if (size > LIMITS.body) failed = true;
      if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return reject(new HubError(413, 'too_large', 'Request body is too large.'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HubError(400, 'bad_json', 'Body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

export async function startHub({
  port = 8787,
  host = '0.0.0.0',
  dbPath = ':memory:',
  publicUrl,
  trustProxy = false,
  now,
  backupDir,
  retentionDays = 90,
  log = (...args) => console.error(...args),
} = {}) {
  const db = openDb(dbPath);
  const hub = new Hub(db, { publicUrl: publicUrl || 'http://localhost', now, retentionDays });
  const backup = () => {
    if (!backupDir) return;
    try {
      hub.backup(backupDir);
    } catch (err) {
      log('openhuddle hub: backup failed:', err);
    }
  };
  backup();
  const backups = setInterval(backup, 24 * 3600_000);
  backups.unref();
  const streams = new Set();
  const memberStreams = new Map();
  const openLimiter = new Limiter(20, 3600_000);
  const memberLimiter = new Limiter(600, 60_000);
  // Requests with a missing or unknown token, per address. Tokens are 256 random bits, so this
  // is about load and noise, not about making guessing infeasible: past the budget, misses get
  // a 429 instead of a 401. A valid token is never held up by it.
  const authLimiter = new Limiter(60, 60_000);
  const sweeper = setInterval(() => {
    openLimiter.sweep();
    memberLimiter.sweep();
    authLimiter.sweep();
    try {
      hub.sweep();
    } catch (err) {
      log('openhuddle hub: sweep failed:', err);
    }
  }, 600_000);
  sweeper.unref();

  // Behind one trusted proxy the last X-Forwarded-For hop is the one it added; earlier hops
  // come from the client and can be forged to dodge rate limits.
  const clientIp = (req) => {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',').pop().trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };

  async function page(res, name, replacements = {}, head = false) {
    let html;
    try {
      html = await readFile(join(PAGES_DIR, name), 'utf8');
    } catch {
      html = '<!doctype html><meta charset="utf-8"><title>openhuddle</title><p>openhuddle hub is running.</p>';
    }
    for (const [key, value] of Object.entries(replacements)) html = html.split(`{{${key}}}`).join(escapeHtml(value));
    res.writeHead(200, { ...PAGE_HEADERS, 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
    res.end(head ? undefined : html);
  }

  async function asset(res, name, head) {
    const type = TYPES[extname(name).toLowerCase()];
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.') || !type || type === TYPES['.html']) return notFound(res);
    let body;
    try {
      body = await readFile(join(PAGES_DIR, name));
    } catch {
      return notFound(res);
    }
    res.writeHead(200, { ...PAGE_HEADERS, 'content-type': type, 'cache-control': 'public, max-age=300' });
    res.end(head ? undefined : body);
  }

  function notFound(res) {
    res.writeHead(404, { ...PAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  function stream(req, res, member, since) {
    if (streams.size >= LIMITS.streams_total) throw new HubError(503, 'busy', 'The hub is full right now. Try again in a minute.');
    // A member keeps at most a few live feeds; a new one (a reloaded dashboard) replaces the oldest.
    let mine = memberStreams.get(member.id);
    if (!mine) memberStreams.set(member.id, (mine = []));
    while (mine.length >= LIMITS.streams_per_member) mine[0]();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    // A cursor from the future (another hub, a reset db) must not mute the stream.
    let cursor = Math.min(since, hub.lastEventId(member.team_id));
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe?.();
      hub.streamClosed(member.id);
      streams.delete(res);
      const i = mine.indexOf(finish);
      if (i !== -1) mine.splice(i, 1);
      if (!mine.length) memberStreams.delete(member.id);
      res.end();
    };
    mine.push(finish);
    // A reader that stops reading must not make the hub buffer without bound.
    const write = (ev) => {
      if (closed) return;
      cursor = ev.id;
      res.write(`id: ${ev.id}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (res.writableLength > LIMITS.stream_buffer) finish();
    };
    let unsubscribe;
    let ping;
    hub.streamOpened(member.id);
    streams.add(res);
    req.on('close', finish);
    res.on('error', finish);
    for (const ev of hub.events(member, { since: cursor, limit: 500 }).events) write(ev);
    if (closed) return;
    unsubscribe = hub.subscribe(member.team_id, (ev) => {
      if (ev.id <= cursor) return;
      write(ev);
      if (ev.kind === 'member_removed' && ev.data?.member_id === member.id) finish();
    });
    ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    ping.unref();
  }

  async function api(req, res, url) {
    const path = url.pathname;
    const method = req.method;

    if (method === 'POST' && (path === '/api/teams' || path === '/api/join')) {
      if (!openLimiter.take(clientIp(req))) throw new HubError(429, 'rate_limited', 'Too many new teams or joins from here. Try again later.');
      const body = await readBody(req);
      return sendJson(res, 200, path === '/api/teams' ? hub.createTeam(body) : hub.join(body));
    }

    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    let member;
    try {
      member = hub.auth(token);
    } catch (err) {
      // Valid tokens are never held up by a guesser sharing their address; the guesses are.
      if (err instanceof HubError && err.status === 401 && !authLimiter.take(clientIp(req))) {
        throw new HubError(429, 'rate_limited', 'Too many requests without a valid token from here. Try again in a minute.');
      }
      throw err;
    }
    if (!memberLimiter.take(member.id)) throw new HubError(429, 'rate_limited', 'Slow down: too many requests.');

    if (method === 'GET') {
      if (path === '/api/state') return sendJson(res, 200, hub.state(member));
      if (path === '/api/events') {
        const q = url.searchParams;
        return sendJson(
          res,
          200,
          hub.events(member, {
            since: q.get('since'),
            limit: q.get('limit'),
            urgent: q.get('urgent') === '1',
            tail: q.get('tail'),
          }),
        );
      }
      if (path === '/api/huddle') return sendJson(res, 200, hub.huddle(member, { id: url.searchParams.get('id') }));
      if (path === '/api/stream') {
        const since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0) || 0;
        return stream(req, res, member, since);
      }
      throw new HubError(404, 'not_found', `No route GET ${path}.`);
    }

    if (method !== 'POST') throw new HubError(405, 'method_not_allowed', 'Use GET or POST.');
    const body = await readBody(req);
    switch (path) {
      case '/api/heartbeat':
        return sendJson(res, 200, hub.heartbeat(member, body.status));
      case '/api/post':
        return sendJson(res, 200, hub.post(member, body));
      case '/api/ask': {
        const result = hub.ask(member, body);
        let answer = null;
        if (result.to.online) {
          const wait = Math.min(Math.max(Number(body.wait_s ?? ASK_WAIT_MAX_S) || 0, 0), ASK_WAIT_MAX_S);
          if (wait > 0) answer = await hub.waitAnswer(member.team_id, result.ask_id, wait * 1000);
        }
        return sendJson(res, 200, { ...result, answer });
      }
      case '/api/reply':
        return sendJson(res, 200, hub.reply(member, body));
      case '/api/huddle/start':
        return sendJson(res, 200, hub.huddleStart(member, body));
      case '/api/huddle/post':
        return sendJson(res, 200, hub.huddlePost(member, body));
      case '/api/huddle/vote':
        return sendJson(res, 200, hub.huddleVote(member, body));
      case '/api/huddle/close':
        return sendJson(res, 200, hub.huddleClose(member, body));
      case '/api/prompt/edit':
        return sendJson(res, 200, hub.promptEdit(member, body));
      case '/api/prompt/submit':
        return sendJson(res, 200, hub.promptSubmit(member));
      case '/api/prompt/vote':
        return sendJson(res, 200, hub.promptVote(member, body));
      case '/api/plan':
        return sendJson(res, 200, hub.plan(member, body));
      case '/api/task':
        return sendJson(res, 200, hub.taskAction(member, body));
      case '/api/claims':
        return sendJson(res, 200, hub.claims(member, body));
      case '/api/file-edit':
        return sendJson(res, 200, hub.fileEdit(member, body));
      case '/api/commit':
        return sendJson(res, 200, hub.commit(member, body));
      case '/api/settings':
        return sendJson(res, 200, hub.settings(member, body));
      case '/api/invite':
        return sendJson(res, 200, hub.invite(member, body));
      case '/api/members/remove':
        return sendJson(res, 200, hub.removeMember(member, body));
      case '/api/leave':
        return sendJson(res, 200, hub.leave(member));
      case '/api/team/delete':
        return sendJson(res, 200, hub.deleteOwnTeam(member));
      default:
        throw new HubError(404, 'not_found', `No route POST ${path}.`);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path === '/health') return sendJson(res, 200, { ok: true, version: VERSION });
    if (path.startsWith('/api/')) return api(req, res, url);
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return notFound(res);
    if (path === '/') {
      // The public hub's page shows the plain command; a self-hosted hub's page names itself.
      const createCmd = hub.publicUrl === DEFAULT_HUB ? 'npx openhuddle create' : `npx openhuddle create --hub ${hub.publicUrl}`;
      return page(res, 'landing.html', { HUB_URL: hub.publicUrl, CREATE_CMD: createCmd }, head);
    }
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('User-agent: *\nDisallow: /t/\nDisallow: /join/\n');
    }
    let m = /^\/join\/([a-z0-9]+\.[A-Za-z0-9_-]+)$/.exec(path);
    if (m) return page(res, 'join.html', { INVITE_URL: `${hub.publicUrl}/join/${m[1]}`, HUB_URL: hub.publicUrl }, head);
    m = /^\/t\/([a-z0-9]+)$/.exec(path);
    if (m) return page(res, 'dashboard.html', { HUB_URL: hub.publicUrl }, head);
    m = /^\/static\/([^/]+)$/.exec(path);
    if (m) return asset(res, m[1], head);
    return notFound(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HubError) {
        if (err.status === 413) res.setHeader('connection', 'close');
        return sendJson(res, err.status, { error: err.message, code: err.code });
      }
      log(`openhuddle hub: ${req.method} ${req.url} failed:`, err);
      sendJson(res, 500, { error: 'Something went wrong on the hub.', code: 'internal' });
    });
  });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  if (!publicUrl) hub.publicUrl = `http://localhost:${actualPort}`;
  const localHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  async function close() {
    clearInterval(sweeper);
    clearInterval(backups);
    for (const res of streams) res.end();
    streams.clear();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    db.close();
  }

  return { url: `http://${localHost}:${actualPort}`, hub, server, close };
}
