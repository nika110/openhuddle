// Starts a local hub with a demo team so you can look at the dashboard without friends.
//   node scripts/demo.mjs [port]
import { startHub } from '../src/hub/server.js';

const port = Number(process.argv[2] || 8787);
const hub = await startHub({ port, host: '127.0.0.1' });
const base = hub.url;

async function call(path, token, body) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

const ana = await call('/api/teams', null, { team_name: 'pizza-app', member_name: 'Ana', tool: 'claude-code' });
const code = ana.invite_url.split('/join/')[1];
const sam = await call('/api/join', null, { code, member_name: 'Sam', tool: 'codex' });
const leo = await call('/api/join', null, { code, member_name: 'Leo', tool: 'cursor' });

await call('/api/prompt/edit', ana.token, { section: 'Idea', text: 'A pizza ordering app for our street. Pick a pizza, pay, watch it get made.' });
await call('/api/prompt/edit', sam.token, { section: 'Who it is for', text: 'Neighbours ordering from Luigi, and Luigi on a tablet in the kitchen.' });
await call('/api/prompt/edit', ana.token, { section: 'Must-haves', text: '- Menu with photos\n- Email magic-link login\n- Stripe checkout\n- Live order status for the kitchen' });
await call('/api/prompt/edit', leo.token, { section: 'Tech stack', text: 'Next.js, Postgres, Stripe, Tailwind.' });
await call('/api/prompt/edit', sam.token, { section: 'Look and feel', text: 'Warm, big photos, one-thumb ordering on a phone.' });
await call('/api/prompt/edit', ana.token, { section: 'Done means', text: 'A neighbour orders and pays on their phone, and Luigi sees it on the tablet within a second.' });
await call('/api/prompt/submit', ana.token, {});
await call('/api/prompt/vote', sam.token, { approve: true });
await call('/api/prompt/vote', leo.token, { approve: true, comment: 'Ship it' });

await call('/api/plan', ana.token, {
  tasks: [
    { key: 'T1', title: 'Skeleton: repo, shared types, DB schema, lint', area: ['package.json', 'src/types', 'db'], assignee: 'Ana' },
    { key: 'T2', title: 'Magic-link login API', area: ['src/api/auth'], depends_on: ['T1'], assignee: 'Ana' },
    { key: 'T3', title: 'Login screen', area: ['src/ui/login'], depends_on: ['T1'], assignee: 'Sam' },
    { key: 'T4', title: 'Stripe checkout', area: ['src/payments'], depends_on: ['T2'], assignee: 'Leo' },
    { key: 'T5', title: 'Menu page with photos', area: ['src/ui/menu'], depends_on: ['T1'], assignee: 'Sam' },
    { key: 'T6', title: 'Kitchen board for the tablet', area: ['src/ui/kitchen'], depends_on: ['T4'] },
  ],
});
await call('/api/task', ana.token, { action: 'accept', key: 'T1' });
await call('/api/task', ana.token, { action: 'start', key: 'T1', branch: 'skeleton' });
await call('/api/file-edit', ana.token, { path: 'src/types/order.ts' });
await call('/api/commit', ana.token, { sha: '3f9c2a1b7e', branch: 'skeleton', message: 'shared Order and User types', files: ['src/types/order.ts'] });
await call('/api/task', ana.token, { action: 'done', key: 'T1', note: 'Merged to main. Types in src/types.' });
await call('/api/task', ana.token, { action: 'accept', key: 'T2' });
await call('/api/task', ana.token, { action: 'start', key: 'T2', branch: 'feat/magic-link' });
await call('/api/task', sam.token, { action: 'accept', key: 'T3' });
await call('/api/task', sam.token, { action: 'start', key: 'T3', branch: 'feat/login-ui' });
await call('/api/task', leo.token, { action: 'accept', key: 'T4' });
await call('/api/post', ana.token, { kind: 'decision', text: 'Magic links instead of passwords', why: 'Nobody on the street remembers passwords' });
await call('/api/file-edit', ana.token, { path: 'src/api/auth/magic-link.ts' });
await call('/api/file-edit', sam.token, { path: 'src/ui/login/LoginForm.tsx' });
await call('/api/heartbeat', ana.token, { status: { branch: 'feat/magic-link', activity: 'Sending the magic-link email' } });
await call('/api/heartbeat', sam.token, { status: { branch: 'feat/login-ui', activity: 'Login form done, wiring it to the API' } });
await call('/api/heartbeat', leo.token, { status: { activity: 'Reading Stripe docs while T2 finishes' } });
const q = await call('/api/ask', sam.token, { to: 'Ana', question: 'Does the login API return the user too?', wait_s: 0 });
await call('/api/reply', ana.token, { ask_id: q.ask_id, answer: 'Yes: { user, token }. The type is User in src/types/user.ts.' });
await call('/api/ask', leo.token, { to: 'Ana', question: 'Can checkout get the user id from the session cookie?', wait_s: 0 });

// The team thinks together: a design discussion still going, and a brainstorm already decided.
const design = await call('/api/huddle/start', leo.token, {
  kind: 'design',
  topic: 'How should the kitchen tablet get new orders?',
  context: 'Luigi has to see an order within a second of payment. The tablet sits on kitchen Wi-Fi all day.',
  proposal: 'Server-sent events from /api/orders/stream, with a full refresh every minute as a safety net.',
});
const H = design.huddle.id;
await call('/api/huddle/post', sam.token, { id: H, kind: 'idea', text: 'Poll /api/orders every 2 seconds. Dumb, but nothing to keep alive.' });
await call('/api/huddle/vote', sam.token, { id: H, idea: 1, vote: 'up', note: 'One second is hard to hit with polling' });
await call('/api/huddle/vote', leo.token, { id: H, idea: 2, vote: 'down', note: 'A tablet polling all day drains the battery' });
await call('/api/huddle/post', sam.token, { id: H, kind: 'comment', on: 1, text: 'Fine by me if the stream reconnects on its own after Wi-Fi drops.' });
const brainstorm = await call('/api/huddle/start', ana.token, { kind: 'brainstorm', topic: 'What do we call the order states?' });
await call('/api/huddle/post', sam.token, { id: brainstorm.huddle.id, kind: 'idea', text: 'placed, cooking, ready, picked up' });
await call('/api/huddle/post', leo.token, { id: brainstorm.huddle.id, kind: 'idea', text: 'new, in_oven, done' });
await call('/api/huddle/vote', ana.token, { id: brainstorm.huddle.id, idea: 1, vote: 'up', note: 'Reads well on the tablet' });
await call('/api/huddle/vote', leo.token, { id: brainstorm.huddle.id, idea: 1, vote: 'up' });
await call('/api/huddle/close', ana.token, { id: brainstorm.huddle.id, decision: 'placed, cooking, ready, picked_up', why: 'Clear words Luigi already uses' });

console.log(`openhuddle demo hub on ${base}`);
console.log(`Dashboard as Ana: ${base}/t/${ana.team_id}#k=${ana.token}`);
console.log(`Dashboard as Sam: ${base}/t/${ana.team_id}#k=${sam.token}`);
console.log('Ctrl+C to stop.');

// Keep the team looking alive.
setInterval(() => {
  for (const t of [ana.token, sam.token, leo.token]) call('/api/heartbeat', t, {}).catch(() => {});
}, 60_000);
