// The `vibecrew` command. main() returns an exit code and never throws.
import { parseArgs } from 'node:util';
import { homedir, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { VERSION, DEFAULT_HUB } from '../shared/protocol.js';
import { Api, ApiError } from './api.js';
import { findProject, saveConfig, removeConfig } from './config.js';
import { gitRoot, originUrl, gitUserName, clone, isCloneableUrl } from './git.js';
import { wireAll, unwireAll, detectTools, wiringStatus } from './wire.js';
import { runMcp } from './mcp.js';
import { runHook } from './hooks.js';
import { NOT_IN_TEAM } from './tools.js';
import { briefing, taskBoard, eventLine, byId, byKey } from './format.js';

const HELP = `vibecrew ${VERSION} — multiplayer mode for AI coding agents

Start a crew (inside your project's git repo):
  npx vibecrew create [--name "Crew name"] [--as yourname]

Join a crew (your friend sends you the link):
  npx vibecrew join <invite-link> [--as yourname]

Then open Claude Code, Codex or Cursor in the project and just talk:
  "let's write the master prompt"   "what is everyone doing?"   "take the next task"

Other commands:
  status            who is doing what, the master prompt, the task board
  watch             live crew feed in this terminal
  dash              open the live dashboard in your browser
  invite [--rotate] show the invite link (owner can --rotate it)
  doctor [--fix]    check the setup (and repair it)
  leave             leave the crew and remove vibecrew from this project
  hub               run your own hub (--port, --db, --public-url, --trust-proxy)

Options: --hub <url> (or VIBECREW_HUB) picks a self-hosted hub.`;

const OPTIONS = {
  hub: { type: 'string' },
  as: { type: 'string' },
  name: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  db: { type: 'string' },
  'public-url': { type: 'string' },
  'trust-proxy': { type: 'boolean' },
  rotate: { type: 'boolean' },
  fix: { type: 'boolean' },
  dir: { type: 'string' },
  'no-open': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

function makeIo(io) {
  const write = (stream) => (s) => stream.write(s);
  return {
    cwd: io.cwd ?? process.cwd(),
    env: io.env ?? process.env,
    home: io.home ?? homedir(),
    stdin: io.stdin ?? process.stdin,
    out: (s = '') => (io.out ?? write(process.stdout))(s + '\n'),
    err: (s = '') => (io.err ?? write(process.stderr))(s + '\n'),
    real: !io.out,
  };
}

export async function main(argv = [], io = {}) {
  const ctx = makeIo(io);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false });
  } catch (e) {
    ctx.err(`vibecrew: ${e.message}`);
    return 1;
  }
  const flags = parsed.values;
  const [cmd, ...args] = parsed.positionals;
  try {
    if (flags.version && !cmd) {
      ctx.out(VERSION);
      return 0;
    }
    if (!cmd || flags.help || cmd === 'help') {
      ctx.out(HELP);
      return 0;
    }
    const fn = COMMANDS[cmd];
    if (!fn) {
      ctx.err(`vibecrew: unknown command "${cmd}". Run \`npx vibecrew help\`.`);
      return 1;
    }
    return await fn(ctx, flags, args);
  } catch (e) {
    ctx.err(`vibecrew: ${explain(e)}`);
    return 1;
  }
}

function explain(e) {
  if (e instanceof ApiError) {
    if (e.code === 'unreachable') return `${e.message}. Check your internet connection, or pass --hub if your crew uses its own hub.`;
    if (e.status === 401) return 'your membership is no longer valid (removed from the crew, or the token was reset). Ask a teammate for a new invite.';
    if (e.code === 'invalid_invite') return 'that invite link is not valid anymore. Ask your friend for a fresh one (`npx vibecrew invite`).';
    return e.message;
  }
  return e?.message || String(e);
}

function hubUrl(ctx, flags) {
  return String(flags.hub || ctx.env.VIBECREW_HUB || DEFAULT_HUB).replace(/\/+$/, '');
}

function myName(ctx, flags, root) {
  if (flags.as) return String(flags.as);
  const g = gitUserName(root || ctx.cwd);
  if (g) return g;
  try {
    return userInfo().username || 'me';
  } catch {
    return 'me';
  }
}

function toolLabel(tools) {
  const list = [tools.claude && 'claude-code', tools.codex && 'codex', tools.cursor && 'cursor'].filter(Boolean);
  return list.length ? list.join('+') : 'claude-code';
}

function claudeCli(ctx) {
  return ctx.env.VIBECREW_NO_CLAUDE_CLI === '1' ? false : undefined;
}

function needProject(ctx, flags) {
  const project = findProject(flags.dir || ctx.cwd);
  if (!project) {
    ctx.err(NOT_IN_TEAM);
    return null;
  }
  return project;
}

function apiOf(project, opts) {
  return new Api(project.config.hub, project.config.token, opts);
}

export function parseInvite(link, hubOverride) {
  const s = String(link || '').trim();
  try {
    const u = new URL(s);
    const i = u.pathname.indexOf('/join/');
    if (i !== -1) {
      const code = decodeURIComponent(u.pathname.slice(i + 6).replace(/\/+$/, ''));
      return { hub: `${u.origin}${u.pathname.slice(0, i)}`, code };
    }
  } catch {}
  if (/^t[a-z2-7]+\.[A-Za-z0-9_-]+$/.test(s)) return { hub: hubOverride || DEFAULT_HUB, code: s };
  return null;
}

function repoDirName(url) {
  const last = String(url).replace(/[\\/]+$/, '').split(/[\\/:]/).pop() || 'project';
  return last.replace(/\.git$/i, '') || 'project';
}

function sameRepo(a, b) {
  const norm = (u) =>
    String(u)
      .toLowerCase()
      .replace(/^[a-z+]+:\/\//, '')
      .replace(/^[^@/]+@/, '')
      .replace(':', '/')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function printWired(ctx, lines) {
  ctx.out('Set up on this machine:');
  for (const l of lines) ctx.out(`  - ${l}`);
}

const COMMANDS = {
  async create(ctx, flags) {
    const root = gitRoot(ctx.cwd);
    if (!root) {
      ctx.err('vibecrew works inside a git repository, so your crew can share the code. Make one first:');
      ctx.err('  git init && git add -A && git commit -m "first commit"');
      ctx.err('then run: npx vibecrew create');
      return 1;
    }
    const existing = findProject(root);
    if (existing) {
      ctx.err(`This project is already in the crew "${existing.config.team_name ?? existing.config.team_id}". See it with \`npx vibecrew status\`, or leave with \`npx vibecrew leave\`.`);
      return 1;
    }
    const hub = hubUrl(ctx, flags);
    const tools = detectTools({ home: ctx.home });
    const repo_url = originUrl(root);
    const body = { team_name: String(flags.name || basename(root)), member_name: myName(ctx, flags, root), tool: toolLabel(tools) };
    if (repo_url) body.repo_url = repo_url;
    const res = await Api.anon(hub, { timeoutMs: 15000 }).post('/api/teams', body);
    saveConfig(root, {
      hub,
      team_id: res.team_id,
      team_name: res.team_name,
      member_id: res.member_id,
      member_name: res.member_name,
      token: res.token,
      dashboard_url: res.dashboard_url,
    });
    const lines = wireAll(root, { home: ctx.home, tools, claudeCli: claudeCli(ctx) });
    ctx.out(`Crew "${res.team_name}" is ready. You are ${res.member_name} (owner).`);
    ctx.out('');
    ctx.out('Send this to your friends:');
    ctx.out(`  npx vibecrew join ${res.invite_url}`);
    ctx.out('');
    if (!repo_url) {
      ctx.out('Tip: push this repo somewhere your friends can clone (git remote add origin ...), so `join` can fetch the code for them.');
      ctx.out('');
    }
    printWired(ctx, lines);
    ctx.out('');
    ctx.out(`Live dashboard (your personal link, don't share it): ${res.dashboard_url}`);
    ctx.out('');
    ctx.out('Next: open your AI tool in this folder and say "let\'s write the master prompt".');
    return 0;
  },

  async join(ctx, flags, args) {
    const inv = parseInvite(args[0], flags.hub || ctx.env.VIBECREW_HUB);
    if (!inv || !inv.code) {
      ctx.err('Usage: npx vibecrew join <invite-link>   (the link looks like https://.../join/t...)');
      return 1;
    }
    let root = gitRoot(ctx.cwd);
    const existing = root && findProject(root);
    if (existing) {
      ctx.err(`This project is already in the crew "${existing.config.team_name ?? existing.config.team_id}". Run \`npx vibecrew leave\` first to switch crews.`);
      return 1;
    }
    const tools = detectTools({ home: ctx.home });
    const res = await Api.anon(inv.hub, { timeoutMs: 15000 }).post('/api/join', {
      code: inv.code,
      member_name: myName(ctx, flags, root),
      tool: toolLabel(tools),
    });
    if (!root) {
      if (res.repo_url && isCloneableUrl(res.repo_url)) {
        const name = repoDirName(res.repo_url);
        const dest = resolve(ctx.cwd, name);
        if (!(existsSync(dest) && gitRoot(dest))) {
          ctx.out(`Getting the crew's code: git clone ${res.repo_url}`);
          try {
            clone(res.repo_url, name, ctx.cwd);
          } catch {
            // Undo the membership so the retry does not leave a stray "name-2" teammate behind.
            await new Api(inv.hub, res.token, { timeoutMs: 8000 }).post('/api/leave', {}).catch(() => {});
            ctx.err(`Could not clone ${res.repo_url}. Clone it yourself, cd into it, and run this join command again.`);
            return 1;
          }
        }
        root = gitRoot(dest) || dest;
      } else {
        ctx.out('This folder is not a git repository and the crew has no repo link, so vibecrew is set up right here.');
        root = resolve(ctx.cwd);
      }
    } else if (res.repo_url) {
      const mine = originUrl(root);
      if (mine && !sameRepo(mine, res.repo_url)) {
        ctx.out(`Heads-up: this repo's origin (${mine}) is not the crew's repo (${res.repo_url}). Continuing here anyway.`);
      }
    }
    saveConfig(root, {
      hub: inv.hub,
      team_id: res.team_id,
      team_name: res.team_name,
      member_id: res.member_id,
      member_name: res.member_name,
      token: res.token,
      dashboard_url: res.dashboard_url,
    });
    const lines = wireAll(root, { home: ctx.home, tools, claudeCli: claudeCli(ctx) });
    ctx.out(`Joined the crew "${res.team_name}" as ${res.member_name}. Your teammates can see you now.`);
    ctx.out('');
    printWired(ctx, lines);
    ctx.out('');
    ctx.out(`Live dashboard (your personal link, don't share it): ${res.dashboard_url}`);
    ctx.out('');
    ctx.out(`Next: open your AI tool in ${root} and say "what is the crew doing?".`);
    return 0;
  },

  async status(ctx, flags) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    const state = await apiOf(project).get('/api/state');
    ctx.out(briefing(state));
    ctx.out('');
    ctx.out('Task board:');
    ctx.out(taskBoard(state));
    ctx.out('');
    ctx.out('Live view: npx vibecrew watch   ·   dashboard: npx vibecrew dash');
    return 0;
  },

  async watch(ctx, flags) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    const api = apiOf(project);
    let state = await api.get('/api/state');
    let members = byId(state.members);
    let tasks = byKey(state.tasks);
    let since = Math.max(0, (state.last_event_id ?? 0) - 15);
    const recent = await api.get(`/api/events?since=${since}&limit=15`);
    ctx.out(`Watching crew "${state.team?.name}" — Ctrl+C to stop.`);
    for (const e of recent.events || []) ctx.out(eventLine(e, members, tasks));
    since = recent.last_event_id ?? state.last_event_id ?? since;
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    process.once('SIGINT', stop);
    let backoff = 1000;
    while (!ctrl.signal.aborted) {
      try {
        await api.stream(
          since,
          async (e) => {
            backoff = 1000;
            since = Math.max(since, e.id ?? since);
            if ((e.member_id && !members[e.member_id]) || (e.data?.key && !tasks[e.data.key])) {
              state = await api.get('/api/state').catch(() => state);
              members = byId(state.members);
              tasks = byKey(state.tasks);
            }
            ctx.out(eventLine(e, members, tasks));
          },
          { signal: ctrl.signal },
        );
      } catch (e) {
        if (ctrl.signal.aborted) break;
        ctx.err(`(connection lost: ${explain(e)} — retrying)`);
      }
      if (ctrl.signal.aborted) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15000);
    }
    process.removeListener('SIGINT', stop);
    return 0;
  },

  async dash(ctx, flags) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    const c = project.config;
    const url = c.dashboard_url || `${c.hub}/t/${c.team_id}#k=${c.token}`;
    ctx.out(`Dashboard (your personal link, don't share it — share \`npx vibecrew invite\` instead):`);
    ctx.out(`  ${url}`);
    if (!flags['no-open'] && ctx.real) openBrowser(url);
    return 0;
  },

  async invite(ctx, flags) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    const res = await apiOf(project).post('/api/invite', { rotate: !!flags.rotate });
    if (flags.rotate) ctx.out('New invite link made; the old one no longer works.');
    ctx.out('Send this to your friends:');
    ctx.out(`  npx vibecrew join ${res.invite_url}`);
    if (res.expires_at) ctx.out(`(valid until ${new Date(res.expires_at).toLocaleString()})`);
    return 0;
  },

  async doctor(ctx, flags) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    let ok = true;
    const mark = (good, label, hint) => {
      if (!good) ok = false;
      ctx.out(`  ${good ? 'ok ' : 'XX '} ${label}${!good && hint ? ` — ${hint}` : ''}`);
    };
    const c = project.config;
    ctx.out(`vibecrew ${VERSION} · project ${project.root}`);
    mark(true, `crew "${c.team_name ?? c.team_id}" as ${c.member_name}`);
    let health = null;
    try {
      health = await Api.anon(c.hub, { timeoutMs: 5000 }).get('/health');
    } catch {}
    mark(!!health?.ok, `hub ${c.hub}${health?.version ? ` (v${health.version})` : ''}`, 'not reachable');
    if (health?.ok) {
      try {
        await apiOf(project, { timeoutMs: 5000 }).get('/api/state');
        mark(true, 'membership is valid');
      } catch (e) {
        mark(false, 'membership', explain(e));
      }
    }
    if (flags.fix) {
      const lines = wireAll(project.root, { home: ctx.home, claudeCli: claudeCli(ctx) });
      ctx.out('Re-wired:');
      for (const l of lines) ctx.out(`  - ${l}`);
    }
    const w = wiringStatus(project.root, { home: ctx.home });
    mark(w.app, 'vibecrew installed in ~/.vibecrew/app', 'run `npx vibecrew doctor --fix`');
    mark(w.claude_hooks, 'Claude Code hooks', 'run `npx vibecrew doctor --fix`');
    if (w.codex !== null) mark(w.codex, 'Codex MCP entry', 'run `npx vibecrew doctor --fix`');
    if (w.cursor !== null) mark(w.cursor, 'Cursor MCP entry', 'run `npx vibecrew doctor --fix`');
    mark(w.git_hook, 'git post-commit hook', 'run `npx vibecrew doctor --fix`');
    return ok ? 0 : 1;
  },

  async leave(ctx, flags) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    try {
      await apiOf(project, { timeoutMs: 8000 }).post('/api/leave', {});
    } catch (e) {
      ctx.err(`(could not tell the hub: ${explain(e)}; removing vibecrew locally anyway)`);
    }
    const lines = unwireAll(project.root, { home: ctx.home, claudeCli: claudeCli(ctx) });
    removeConfig(project.root);
    ctx.out(`Left the crew "${project.config.team_name ?? project.config.team_id}".`);
    for (const l of lines) ctx.out(`  - ${l}`);
    return 0;
  },

  async hub(ctx, flags) {
    const { startHub } = await import('../hub/server.js');
    const port = Number(flags.port ?? ctx.env.PORT ?? 8787);
    const hub = await startHub({
      port,
      host: flags.host || ctx.env.VIBECREW_HOST || '0.0.0.0',
      dbPath: flags.db || ctx.env.VIBECREW_DB || join(ctx.cwd, 'vibecrew-hub.db'),
      publicUrl: flags['public-url'] || ctx.env.VIBECREW_PUBLIC_URL,
      trustProxy: !!flags['trust-proxy'] || ctx.env.VIBECREW_TRUST_PROXY === '1',
    });
    ctx.out(`vibecrew hub ${VERSION} listening on ${hub.url}`);
    await new Promise((done) => {
      const stop = () => done();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await hub.close();
    return 0;
  },

  async mcp(ctx, flags) {
    const project = findProject(flags.dir || ctx.cwd);
    await runMcp({ project });
    return 0;
  },

  async hook(ctx, flags, args) {
    const name = args[0];
    let out = '';
    try {
      let input = {};
      if (name !== 'git-commit') {
        const raw = typeof ctx.stdin === 'string' ? ctx.stdin : await readStdin(ctx.stdin);
        try {
          input = raw && raw.trim() ? JSON.parse(raw) : {};
        } catch {
          input = {};
        }
      }
      if (flags.dir && !input.cwd) input.cwd = flags.dir;
      out = await runHook(name, input, { cwd: ctx.cwd });
    } catch {
      out = '';
    }
    if (ctx.real) {
      // Let the process end on its own (process.exit while a stdin pipe is closing can abort
      // Node on Windows); the unref'd timer is only a backstop.
      setTimeout(() => process.exit(0), 5000).unref();
      if (out) process.stdout.write(out);
      return 0;
    }
    if (out) ctx.out(out);
    return 0;
  },
};

function readStdin(stream, ms = 1500) {
  if (!stream || stream.isTTY) return Promise.resolve('');
  return new Promise((resolveRead) => {
    let data = '';
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        stream.pause?.();
        stream.unref?.();
      } catch {}
      resolveRead(data);
    };
    const timer = setTimeout(done, ms);
    try {
      stream.setEncoding?.('utf8');
      stream.on('data', (c) => {
        data += c;
      });
      stream.on('end', done);
      stream.on('error', done);
    } catch {
      done();
    }
  });
}

function openBrowser(url) {
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', `"${url}"`], { ...opts, windowsVerbatimArguments: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch {}
}
