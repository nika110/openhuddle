import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from '../src/hub/server.js';

let hubUrl;
let close;

let offset = 0;

before(async () => {
  const started = await startHub({ port: 0, host: '127.0.0.1', now: () => Date.now() + offset, log: () => {} });
  hubUrl = started.url;
  close = started.close;
});

after(() => close());

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(hubUrl + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not json
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function crew() {
  const a = (await call('POST', '/api/teams', { body: { team_name: 'Pizza', member_name: 'ana' } })).json;
  const code = a.invite_url.split('/join/')[1];
  const b = (await call('POST', '/api/join', { body: { code, member_name: 'ben' } })).json;
  return { a, b, code };
}

test('http: create → join → state shows both', async () => {
  const { a, b } = await crew();
  assert.ok(a.invite_url.startsWith('http://localhost:'));
  const { status, json } = await call('GET', '/api/state', { token: b.token });
  assert.equal(status, 200);
  assert.deepEqual(json.members.map((m) => m.name), ['ana', 'ben']);
  assert.equal(json.me.name, 'ben');
});

test('http: missing token 401 json', async () => {
  const { status, json } = await call('GET', '/api/state');
  assert.equal(status, 401);
  assert.equal(json.code, 'missing_token');
});

test('http: huddle routes need a token, an id and the right team', async (t) => {
  // Its own hub, so the teams made here don't use up the shared hub's create budget.
  const own = await startHub({ port: 0, host: '127.0.0.1', log: () => {} });
  const shared = hubUrl;
  hubUrl = own.url;
  t.after(async () => {
    hubUrl = shared;
    await own.close();
  });
  const one = await crew();
  const two = await crew();
  assert.equal((await call('GET', '/api/huddle?id=H1')).status, 401);
  assert.equal((await call('POST', '/api/huddle/start', { body: { topic: 'x' } })).status, 401);
  const started = await call('POST', '/api/huddle/start', { token: one.a.token, body: { kind: 'brainstorm', topic: 'Pick a DB' } });
  assert.equal(started.status, 200);
  const id = started.json.huddle.id;
  const missing = await call('GET', '/api/huddle', { token: one.a.token });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing_huddle');
  assert.equal((await call('GET', `/api/huddle?id=${id}`, { token: one.b.token })).status, 200);
  // another team's member sees nothing and changes nothing
  assert.equal((await call('GET', `/api/huddle?id=${id}`, { token: two.a.token })).status, 404);
  assert.equal((await call('POST', '/api/huddle/post', { token: two.a.token, body: { id, text: 'hi' } })).status, 404);
  assert.equal((await call('POST', '/api/huddle/close', { token: two.a.token, body: { id, decision: 'x' } })).status, 404);
  const posted = await call('POST', '/api/huddle/post', { token: one.b.token, body: { id, kind: 'idea', text: 'Postgres' } });
  assert.equal(posted.json.seq, 1);
  const voted = await call('POST', '/api/huddle/vote', { token: one.a.token, body: { id, idea: 1, vote: 'up' } });
  assert.equal(voted.status, 200);
  const closed = await call('POST', '/api/huddle/close', { token: one.a.token, body: { id, decision: 'Postgres' } });
  assert.equal(closed.json.huddle.status, 'closed');
});

test('http: bad json 400', async () => {
  const { a } = await crew();
  const { status, json } = await call('POST', '/api/post', { token: a.token, raw: '{nope' });
  assert.equal(status, 400);
  assert.equal(json.code, 'bad_json');
});

test('http: oversized body 413', async () => {
  const { a } = await crew();
  const { status, json } = await call('POST', '/api/post', { token: a.token, body: { kind: 'update', text: 'x'.repeat(300_000) } });
  assert.equal(status, 413);
  assert.equal(json.code, 'too_large');
});

test('http: unknown route 404 and domain errors keep their status', async () => {
  const { a } = await crew();
  assert.equal((await call('POST', '/api/nope', { token: a.token, body: {} })).status, 404);
  const r = await call('POST', '/api/task', { token: a.token, body: { action: 'take', key: 'T99' } });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'unknown_task');
});

test('http: SSE delivers posted update', async () => {
  const { a, b } = await crew();
  const controller = new AbortController();
  const res = await fetch(`${hubUrl}/api/stream?since=999999`, {
    headers: { authorization: `Bearer ${a.token}` },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  await call('POST', '/api/post', { token: b.token, body: { kind: 'update', text: 'cart works' } });
  let buf = '';
  const deadline = Date.now() + 3000;
  while (!buf.includes('cart works') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.match(buf, /event: update\ndata: .*cart works/);
  const data = JSON.parse(buf.split('\n').find((l) => l.startsWith('data:') && l.includes('cart works')).slice(5));
  assert.equal(data.kind, 'update');
  assert.equal(data.team_id, undefined, 'internal fields stay internal');
});

test('http: a member holds at most 3 live streams (oldest is closed)', async () => {
  const { a } = await crew();
  const open = async () => {
    const controller = new AbortController();
    const res = await fetch(`${hubUrl}/api/stream`, { headers: { authorization: `Bearer ${a.token}` }, signal: controller.signal });
    return { reader: res.body.getReader(), controller };
  };
  const first = await open();
  const others = [await open(), await open(), await open()];
  const deadline = Date.now() + 3000;
  let closed = false;
  while (!closed && Date.now() < deadline) {
    const { done } = await Promise.race([first.reader.read(), new Promise((r) => setTimeout(() => r({ done: false }), 200))]);
    closed = done;
  }
  for (const s of [first, ...others]) s.controller.abort();
  assert.ok(closed, 'the oldest stream was closed when a fourth one opened');
});

test('http: ask returns live answer when target replies within wait', async () => {
  const { a, b } = await crew();
  const asking = call('POST', '/api/ask', { token: a.token, body: { to: 'ben', question: 'jwt?', wait_s: 5 } });
  let pending = [];
  for (let i = 0; i < 50 && !pending.length; i++) {
    pending = (await call('GET', '/api/state', { token: b.token })).json.asks_for_me;
    if (!pending.length) await new Promise((r) => setTimeout(r, 20));
  }
  await call('POST', '/api/reply', { token: b.token, body: { ask_id: pending[0].id, answer: 'yes, JWT' } });
  const { json } = await asking;
  assert.equal(json.answer, 'yes, JWT');
  assert.equal(json.to.name, 'ben');
  assert.ok(json.snapshot);
});

test('http: ask to offline member returns immediately with answer null', async () => {
  const { a } = await crew();
  offset += 10 * 60_000;
  const started = Date.now();
  const { json } = await call('POST', '/api/ask', { token: a.token, body: { to: 'ben', question: 'there?' } });
  assert.equal(json.answer, null);
  assert.equal(json.to.online, false);
  assert.ok(Date.now() - started < 2000);
});

test('http: a self-hosted hub landing page names itself in the create command', async () => {
  const { text } = await call('GET', '/');
  assert.ok(text.includes(`npx openhuddle create --hub ${hubUrl.replace('127.0.0.1', 'localhost')}`), 'self-hosted command');
  assert.ok(!text.includes('{{'), 'no placeholders left');
});

test('http: dashboard has CSP header, join page escapes', async () => {
  const { a } = await crew();
  const dash = await call('GET', `/t/${a.team_id}`);
  assert.equal(dash.status, 200);
  assert.match(dash.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(dash.headers.get('x-frame-options'), 'DENY');
  const join = await call('GET', `/join/${a.invite_url.split('/join/')[1]}`);
  assert.equal(join.status, 200);
  assert.equal((await call('GET', '/join/<script>')).status, 404);
  assert.equal((await call('GET', '/static/..%2Fhub.js')).status, 404);
  const health = await call('GET', '/health');
  assert.equal(health.json.ok, true);
});

test('http: behind a proxy, forged X-Forwarded-For hops do not dodge the rate limit', async () => {
  const proxied = await startHub({ port: 0, host: '127.0.0.1', trustProxy: true, log: () => {} });
  try {
    let status = 200;
    for (let i = 0; i < 25 && status === 200; i++) {
      const res = await fetch(`${proxied.url}/api/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` },
        body: JSON.stringify({ member_name: `p${i}` }),
      });
      status = res.status;
    }
    assert.equal(status, 429);
  } finally {
    await proxied.close();
  }
});

test('http: only the owner can delete the team', async () => {
  const { a, b } = await crew();
  assert.equal((await call('POST', '/api/team/delete', { token: b.token, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/team/delete', { token: a.token, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/state', { token: b.token })).status, 401);
});

test('http: create rate limit 429 after 20', async () => {
  // Earlier tests already used part of the budget from 127.0.0.1; keep creating until it trips.
  let status = 200;
  for (let i = 0; i < 25 && status === 200; i++) {
    status = (await call('POST', '/api/teams', { body: { member_name: `x${i}` } })).status;
  }
  assert.equal(status, 429);
});


test('http: JSON answers carry nosniff; repeated requests with bad tokens get 429 without touching the team', async () => {
  const own = await startHub({ port: 0, host: '127.0.0.1', log: () => {} });
  const shared = hubUrl;
  hubUrl = own.url;
  try {
    const { a } = await crew();
    const ok = await call('GET', '/api/state', { token: a.token });
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    let status = 401;
    let tries = 0;
    while (status === 401 && tries < 80) {
      status = (await call('GET', '/api/state', { token: `vc_guess${tries++}` })).status;
    }
    assert.equal(status, 429);
    assert.ok(tries > 50 && tries <= 62, `tripped after ${tries}`);
    assert.equal((await call('GET', '/api/state', { token: a.token })).status, 200, 'a valid token on the same address still works');
    assert.equal((await call('GET', '/api/state')).status, 429, 'missing tokens count as guesses too');
  } finally {
    hubUrl = shared;
    await own.close();
  }
});
