// openhuddle dashboard. Everything teammates write is untrusted: it only ever
// reaches the page through textContent / text nodes, never as markup.

const teamId = location.pathname.split('/').filter(Boolean)[1] || '';
const storeKey = `openhuddle:${teamId}`;

let token = '';
let state = null;
let lastId = 0;
let lockedOut = false;
const feedEvents = new Map();
const editing = new Map();
const FEED_MAX = 150;
const openTalks = new Set();
const talkDetails = new Map();
const drafts = new Map();

const $ = (sel) => document.querySelector(sel);

// ---------- tiny DOM helpers ----------

function h(tag, opts = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function clear(el) {
  el.replaceChildren();
  return el;
}

function code(text) {
  return h('code', { text });
}

function quoted(text) {
  return h('q', { class: 'quote', text: shorten(text, 220) });
}

function shorten(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------- time ----------

function toMs(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return t < 1e11 ? t * 1000 : t;
  const n = Number(t);
  if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : null;
}

function ago(t) {
  const ms = toMs(t);
  if (ms == null) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function clock(t) {
  const ms = toMs(t);
  if (ms == null) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- team identity ----------

function member(id) {
  return state?.members.find((m) => m.id === id) || null;
}

function colorOf(id) {
  const i = state ? state.members.findIndex((m) => m.id === id) : -1;
  return i < 0 ? 'c0' : `c${(i % 6) + 1}`;
}

function nameOf(id) {
  if (!id) return 'someone';
  return member(id)?.name || 'a former member';
}

function who(id) {
  const me = state?.me?.id === id;
  return h('span', { class: `who ${colorOf(id)}` }, h('span', { class: 'dot' }), h('b', { text: nameOf(id) }), me ? h('span', { class: 'you', text: '(you)' }) : null);
}

function task(key) {
  return state?.tasks.find((t) => t.key === key) || null;
}

function taskRef(key) {
  const t = task(key);
  return [code(key || '?'), t ? ` ${shorten(t.title, 60)}` : ''];
}

// ---------- api ----------

async function api(path, body) {
  const opts = { headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) {
    lockOut('expired');
    throw new Error('This access key no longer works.');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed with status ${res.status}.`);
  return data;
}

async function act(fn, okText) {
  try {
    await fn();
    if (okText) toast(okText);
    await refresh();
  } catch (err) {
    if (!lockedOut) toast(err.message, true);
  }
}

// ---------- token ----------

function takeToken() {
  const m = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  if (m) {
    let t = m[1];
    try {
      t = decodeURIComponent(t);
    } catch {
      // a malformed link keeps its raw value and fails the auth check like any other bad key
    }
    try {
      sessionStorage.setItem(storeKey, t);
    } catch {
      // Private mode: keep it in memory for this visit.
    }
    history.replaceState(null, '', location.pathname + location.search);
    return t;
  }
  try {
    return sessionStorage.getItem(storeKey) || '';
  } catch {
    return '';
  }
}

function lockOut(reason) {
  if (lockedOut) return;
  lockedOut = true;
  try {
    sessionStorage.removeItem(storeKey);
  } catch {
    // ignore
  }
  $('#app').hidden = true;
  $('#asks').hidden = true;
  $('#locked-out').hidden = false;
  $('#team-name').textContent = 'Dashboard';
  setConn(false, 'Not connected');
  if (reason === 'expired') {
    $('#locked-title').textContent = 'This access key no longer works';
    $('#locked-text').textContent = 'You may have left the team or been removed, or the link is old. Run this inside the project folder to get a fresh dashboard link:';
  }
}

// ---------- rendering ----------

function renderAll() {
  if (!state) return;
  renderHeader();
  renderAsks();
  renderMembers();
  renderRules();
  renderBoard();
  renderHuddles();
  renderPrompt();
  renderFeed();
}

function renderHeader() {
  const name = state.team?.name || 'Your team';
  $('#team-name').textContent = name;
  document.title = `${name} on openhuddle`;
  const me = state.me;
  const box = clear($('#me'));
  if (me) box.append(who(me.id), h('span', { class: 'role', text: me.role === 'owner' ? 'owner' : 'member' }));
}

function renderAsks() {
  const asks = state.asks_for_me || [];
  const talks = state.huddles_for_me || [];
  const box = clear($('#asks'));
  const n = asks.length + talks.length;
  box.hidden = n === 0;
  if (!n) return;
  const title = !talks.length
    ? asks.length === 1 ? 'A question is waiting for your agent' : `${asks.length} questions are waiting for your agent`
    : !asks.length
      ? talks.length === 1 ? 'A huddle is waiting for your take' : `${talks.length} huddles are waiting for your take`
      : `${n} things are waiting for your agent`;
  box.append(
    h('p', { class: 'asks-title', text: title }),
    h('ul', {},
      asks.slice(0, 4).map((a) => h('li', {}, who(a.from_id), ' asked ', quoted(a.question), h('span', { class: 'time', text: ` ${ago(a.created_at)}` }))),
      talks.slice(0, 4).map((x) => h('li', {}, who(x.started_by), ` started a ${KIND_TEXT[x.kind]?.toLowerCase() || 'huddle'} `, code(x.id), ': ', quoted(x.topic))),
    ),
    h('p', { class: 'hint', text: 'Your agent sees these on its next step and answers them.' }),
  );
}

function renderMembers() {
  const list = clear($('#members'));
  const members = state.members || [];
  const online = members.filter((m) => m.online).length;
  $('#team-count').textContent = `${online} of ${members.length} online`;
  for (const m of members) {
    const claims = (state.claims || []).filter((c) => c.member_id === m.id).map((c) => c.path);
    const current = (m.current_tasks || []).map(task).filter(Boolean);
    const doing = m.status?.activity
      ? shorten(m.status.activity, 120)
      : current.length
        ? `On ${current[0].key}, ${shorten(current[0].title, 70)}`
        : m.online
          ? 'Online, no task yet'
          : 'Away';
    const meta = [];
    if (claims.length) meta.push(h('span', { class: 'm-files' }, 'editing ', claims.slice(0, 2).map((p, i) => [i ? ', ' : '', h('code', { text: p.split('/').pop(), title: p })]), claims.length > 2 ? ` and ${claims.length - 2} more` : ''));
    if (m.status?.branch) meta.push(h('span', {}, 'branch ', code(m.status.branch)));
    meta.push(h('span', { class: 'm-seen', text: m.online ? 'online now' : `last seen ${ago(m.last_seen) || 'a while ago'}` }));

    list.append(
      h('li', { class: `member ${colorOf(m.id)}${m.online ? ' is-online' : ''}` },
        h('span', { class: 'avatar', 'aria-hidden': 'true', text: (m.name || '?').slice(0, 1).toUpperCase() }),
        h('div', { class: 'm-main' },
          h('div', { class: 'm-top' },
            h('b', { class: 'm-name', text: m.name }),
            m.id === state.me?.id ? h('span', { class: 'you', text: '(you)' }) : null,
            m.tool ? h('span', { class: 'pill', text: toolName(m.tool) }) : null,
            m.role === 'owner' ? h('span', { class: 'pill quiet', text: 'owner' }) : null,
          ),
          h('p', { class: 'm-doing', text: doing }),
          h('p', { class: 'm-meta' }, meta),
        ),
      ),
    );
  }
}

function toolName(tool) {
  const map = { 'claude-code': 'Claude Code', claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI' };
  return map[String(tool).toLowerCase()] || String(tool);
}

const ASSIGN_TEXT = {
  hybrid: 'The lead proposes who does what; each person accepts or declines',
  agent: 'The lead assigns tasks directly',
  self: 'Everyone picks their own tasks',
};
const RULE_TEXT = {
  all: 'Everyone approves the master prompt',
  majority: 'A majority approves the master prompt',
  owner: 'The owner approves the master prompt',
};
const CLAIM_TEXT = {
  ask: 'Agents ask before editing a file a teammate is working on',
  block: 'Agents can’t edit a file a teammate is working on',
  warn: 'Agents get a warning before editing a teammate’s file',
};

function renderRules() {
  const s = state.team?.settings || {};
  const lead = s.lead_id ?? s.lead ?? null;
  const rows = [
    ['Lead', lead ? nameOf(lead) : 'Nobody yet. Whoever makes the plan becomes the lead.'],
    ['Tasks', ASSIGN_TEXT[s.assign_mode] || s.assign_mode || '–'],
    ['Master prompt', RULE_TEXT[s.approvals?.master_prompt] || '–'],
    ['Files', CLAIM_TEXT[s.claim_mode] || '–'],
    ['File hold', s.claim_ttl_min ? `${s.claim_ttl_min} minutes after the last edit` : '–'],
  ];
  const dl = clear($('#rules'));
  for (const [k, v] of rows) dl.append(h('div', { class: 'rule' }, h('dt', { text: k }), h('dd', { text: v })));
}

const COLUMNS = [
  { title: 'Proposed and open', match: (t) => t.status === 'proposed' || t.status === 'open' },
  { title: 'Assigned', match: (t) => t.status === 'assigned' },
  { title: 'In progress', match: (t) => t.status === 'in_progress' },
  { title: 'Done', match: (t) => t.status === 'done' },
];

function keyNum(k) {
  const n = parseInt(String(k).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) ? n : 1e9;
}

function renderBoard() {
  const tasks = [...(state.tasks || [])].sort((a, b) => keyNum(a.key) - keyNum(b.key));
  const done = tasks.filter((t) => t.status === 'done').length;
  $('#board-count').textContent = tasks.length ? `${done} of ${tasks.length} done` : '';
  const board = clear($('#board'));
  if (!tasks.length) {
    board.classList.add('is-empty');
    board.append(
      h('div', { class: 'empty' },
        h('p', { class: 'empty-title', text: 'No tasks yet' }),
        h('p', {}, 'Once the master prompt is locked, tell your agent ', quoted('plan this from our master prompt'), '. The plan shows up here, with the project skeleton first.'),
      ),
    );
    return;
  }
  board.classList.remove('is-empty');
  for (const col of COLUMNS) {
    const items = tasks.filter(col.match);
    board.append(
      h('section', { class: 'column' },
        h('h3', { class: 'column-title' }, col.title, h('span', { class: 'count', text: String(items.length) })),
        items.length ? items.map(card) : h('p', { class: 'column-empty', text: 'Nothing here' }),
      ),
    );
  }
}

function card(t) {
  const meId = state.me?.id;
  const owner = t.assignee_id || t.proposed_id;
  const deps = t.depends_on || [];
  const waiting = deps.filter((k) => task(k)?.status !== 'done');

  let person;
  if (t.assignee_id) person = who(t.assignee_id);
  else if (t.proposed_id) person = h('span', { class: 'proposed' }, 'proposed to ', who(t.proposed_id));
  else person = h('span', { class: 'unassigned', text: 'Unassigned' });

  let flag = null;
  if (t.status !== 'done') {
    if (deps.length && waiting.length) flag = h('span', { class: 'flag wait' }, 'waiting on ', waiting.map((k, i) => [i ? ', ' : '', code(k)]));
    else flag = h('span', { class: 'flag ready', text: 'ready' });
  }

  const buttons = [];
  const btn = (label, action, ghost) =>
    h('button', {
      class: `btn small${ghost ? ' ghost' : ''}`,
      type: 'button',
      text: label,
      onclick: () => act(() => api('/api/task', { action, key: t.key })),
    });
  if (t.status === 'proposed' && t.proposed_id === meId) buttons.push(btn('Accept', 'accept'), btn('Decline', 'decline', true));
  else if (t.status === 'open' || t.status === 'proposed') buttons.push(btn('Take it', 'take', true));
  if (t.status === 'assigned' && t.assignee_id === meId) {
    if (t.ready !== false && !waiting.length) buttons.push(btn('Start', 'start'));
    buttons.push(btn('Release', 'release', true));
  }
  if (t.status === 'in_progress' && t.assignee_id === meId) buttons.push(btn('Mark done', 'done'), btn('Release', 'release', true));

  const area = (t.area || []).slice(0, 2);
  return h('article', { class: `card ${owner ? colorOf(owner) : 'c0'}${t.status === 'done' ? ' is-done' : ''}` },
    h('div', { class: 'card-top' }, h('span', { class: 'key', text: t.key }), flag),
    h('p', { class: 'card-title', text: t.title }),
    t.note ? h('p', { class: 'card-note', text: shorten(t.note, 140) }) : null,
    h('div', { class: 'card-meta' },
      person,
      area.length ? h('span', { class: 'area' }, area.map((g, i) => [i ? ' ' : '', code(g)])) : null,
      t.branch ? h('span', { class: 'area' }, 'branch ', code(t.branch)) : null,
    ),
    buttons.length ? h('div', { class: 'card-actions' }, buttons) : null,
  );
}

// ---------- huddles ----------

const KIND_TEXT = { brainstorm: 'Brainstorm', design: 'Design', review: 'Review', standup: 'Standup' };

function people(ids) {
  return ids.map((id, i) => [i ? ', ' : '', who(id)]);
}

function renderHuddles() {
  // Leave the panel alone while someone types into it; the draft survives the next render anyway.
  const typing = document.activeElement;
  if (typing && typing.tagName === 'INPUT' && $('#huddles').contains(typing)) return;
  const list = state.huddles || [];
  const open = list.filter((x) => x.status === 'open').length;
  $('#huddles-count').textContent = open ? `${open} open` : '';
  const box = clear($('#huddles'));
  if (!list.length) {
    box.append(
      h('div', { class: 'empty' },
        h('p', { class: 'empty-title', text: 'No huddles yet' }),
        h('p', {}, 'When something needs more than one opinion, tell your agent ', quoted('start a brainstorm with the team about how we store sessions'), '. Everyone’s agents weigh in here, and so can you.'),
      ),
    );
    return;
  }
  for (const x of list) box.append(huddleCard(x));
}

function huddleCard(x) {
  const meId = state.me?.id;
  const isOpen = x.status === 'open';
  const standup = x.kind === 'standup';
  let status = null;
  if (isOpen) {
    status = x.waiting_on?.length
      ? h('p', { class: 'huddle-wait' }, 'Waiting on ', people(x.waiting_on))
      : h('p', { class: 'huddle-wait is-done', text: 'Everyone has weighed in. Whoever started it closes it with the decision.' });
  }
  const ideas = (x.ideas || []).length
    ? h('ol', { class: 'ideas' }, x.ideas.map((i) => ideaRow(x, i, meId)))
    : isOpen && !standup ? h('p', { class: 'hint', text: 'No ideas yet.' }) : null;
  const decision = !isOpen
    ? h('div', { class: 'decision' },
      x.decision ? h('p', {}, h('b', { text: 'Decision: ' }), x.decision) : null,
      x.why ? h('p', { class: 'hint', text: `Why: ${x.why}` }) : null,
      h('p', { class: 'hint' }, 'Closed by ', who(x.closed_by), ` ${ago(x.closed_at)}`),
    )
    : null;
  let add = null;
  if (isOpen) {
    const input = h('input', {
      class: 'vote-comment',
      type: 'text',
      placeholder: standup ? 'Your update: done, next, blockers' : 'Add an idea',
      'aria-label': `Add to ${x.id}`,
      maxlength: '2000',
    });
    input.value = drafts.get(x.id) || '';
    input.addEventListener('input', () => drafts.set(x.id, input.value));
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      input.blur();
      act(async () => {
        await api('/api/huddle/post', { id: x.id, kind: standup ? 'comment' : 'idea', text });
        drafts.delete(x.id);
        if (openTalks.has(x.id)) await loadTalk(x.id);
      }, 'Posted');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    add = h('div', { class: 'bar-actions' }, input, h('button', { class: 'btn small', type: 'button', text: standup ? 'Post update' : 'Add idea', onclick: send }));
  }
  const shown = openTalks.has(x.id);
  const more = x.post_count
    ? h('button', { class: 'btn ghost small', type: 'button', text: shown ? 'Hide discussion' : `Show discussion (${x.post_count})`, onclick: () => toggleTalk(x.id) })
    : null;
  return h('article', { class: `huddle ${colorOf(x.started_by)}${isOpen ? '' : ' is-closed'}` },
    h('div', { class: 'card-top' },
      h('span', { class: 'huddle-tags' }, h('span', { class: 'key', text: x.id }), h('span', { class: `pill kind kind-${x.kind}`, text: KIND_TEXT[x.kind] || x.kind })),
      isOpen ? null : h('span', { class: 'pill quiet', text: 'closed' }),
    ),
    h('p', { class: 'huddle-topic', text: x.topic }),
    h('p', { class: 'huddle-meta' }, 'Started by ', who(x.started_by), ` ${ago(x.created_at)}, with `, x.people?.length ? people(x.people) : 'the whole team'),
    x.context ? h('p', { class: 'huddle-context', text: shorten(x.context, 320) }) : null,
    status,
    ideas,
    decision,
    add,
    more,
    shown ? discussion(x.id) : null,
  );
}

function ideaRow(x, i, meId) {
  const vote = (dir, label, okText) =>
    h('button', { class: 'btn ghost small', type: 'button', text: label, onclick: () => act(() => api('/api/huddle/vote', { id: x.id, idea: i.seq, vote: dir }), okText) });
  const buttons = x.status === 'open' && i.member_id !== meId ? [vote('up', 'Back it', 'Backed'), vote('down', 'Push back', 'Pushed back')] : [];
  return h('li', { class: 'idea' },
    h('div', { class: 'idea-top' },
      h('span', { class: 'key', text: `#${i.seq}` }),
      who(i.member_id),
      h('span', { class: 'score', title: `${i.up} backing, ${i.down} pushing back` }, h('span', { class: 'up', text: `+${i.up}` }), ' ', h('span', { class: 'down', text: `−${i.down}` })),
    ),
    h('p', { class: 'idea-text', text: i.text }),
    buttons.length ? h('div', { class: 'card-actions' }, buttons) : null,
  );
}

function toggleTalk(id) {
  if (openTalks.has(id)) {
    openTalks.delete(id);
  } else {
    openTalks.add(id);
    loadTalk(id);
  }
  renderHuddles();
}

async function loadTalk(id) {
  try {
    talkDetails.set(id, await api(`/api/huddle?id=${encodeURIComponent(id)}`));
  } catch (err) {
    openTalks.delete(id);
    if (!lockedOut) toast(err.message, true);
  }
  if (state) renderHuddles();
}

function discussion(id) {
  const d = talkDetails.get(id);
  if (!d) return h('p', { class: 'hint', text: 'Loading the discussion…' });
  return h('ol', { class: 'talk' }, d.posts.map((p) =>
    h('li', { class: `talk-item is-${p.kind}` },
      h('div', { class: 'idea-top' },
        h('span', { class: 'key', text: `#${p.seq}` }),
        who(p.member_id),
        p.kind === 'idea' ? h('span', { class: 'pill quiet', text: 'idea' }) : p.on ? h('span', { class: 'hint', text: `on idea #${p.on}` }) : null,
        h('span', { class: 'hint', text: ago(p.created_at) }),
      ),
      h('p', { class: 'idea-text', text: p.text }),
      (p.votes || []).filter((v) => v.note).map((v) =>
        h('p', { class: `talk-vote ${v.value > 0 ? 'yes' : 'no'}` }, who(v.member_id), v.value > 0 ? ' backs it: ' : ' pushes back: ', v.note),
      ),
    ),
  ));
}

const PROMPT_BADGE = {
  draft: (p) => `Draft, v${p.version}`,
  voting: (p) => `Voting on v${p.version}`,
  locked: (p) => `Locked, v${p.locked_version ?? p.version}`,
  amending: (p) => `Amending v${p.locked_version}`,
};
const VOTE_RULE = {
  all: 'Everyone has to approve.',
  majority: 'A majority has to approve.',
  owner: 'The owner has to approve.',
};

function renderPrompt() {
  const p = state.prompt;
  if (!p) return;
  const badge = $('#prompt-badge');
  badge.textContent = (PROMPT_BADGE[p.state] || (() => p.state))(p);
  badge.dataset.state = p.state;

  const bar = clear($('#prompt-bar'));
  const votes = p.votes || {};
  const myVote = votes[state.me?.id];

  if (p.state === 'draft' || p.state === 'amending') {
    bar.append(
      h('p', { class: 'bar-text', text: p.state === 'amending'
        ? `Locked v${p.locked_version} stays in force until the team approves these changes.`
        : 'Anyone in the team can write here, directly or by telling their agent. When it reads right, put it up for a vote.' }),
      h('div', { class: 'bar-actions' },
        h('button', { class: 'btn small', type: 'button', text: 'Submit for vote', onclick: () => act(() => api('/api/prompt/submit', {}), 'Submitted for a vote') }),
      ),
    );
  } else if (p.state === 'voting') {
    const comment = h('input', { class: 'vote-comment', type: 'text', placeholder: 'Comment (optional)', 'aria-label': 'Comment on your vote', maxlength: '500' });
    const vote = (approve) => act(() => api('/api/prompt/vote', { approve, comment: comment.value.trim() || undefined }), approve ? 'Approved' : 'Rejected');
    bar.append(
      h('p', { class: 'bar-text', text: `${VOTE_RULE[p.rule] || ''} ${myVote ? `You ${myVote.approve ? 'approved' : 'rejected'} this version.` : 'Your vote is still open.'}`.trim() }),
      h('ul', { class: 'votes' }, (state.members || []).map((m) => {
        const v = votes[m.id];
        const label = v ? (v.approve ? 'approved' : 'rejected') : 'not voted';
        return h('li', { class: `vote ${v ? (v.approve ? 'yes' : 'no') : 'open'}` }, who(m.id), h('span', { class: 'vote-label', text: label }), v?.comment ? quoted(v.comment) : null);
      })),
      h('div', { class: 'bar-actions' },
        comment,
        h('button', { class: 'btn small', type: 'button', text: 'Approve', onclick: () => vote(true) }),
        h('button', { class: 'btn small ghost', type: 'button', text: 'Reject', onclick: () => vote(false) }),
      ),
    );
  } else if (p.state === 'locked') {
    bar.append(h('p', { class: 'bar-text', text: 'Approved by the team. The lead turns this into the plan. Editing a section starts an amendment that needs a new vote.' }));
  }

  // Leave open editors alone so a live update never eats what someone is typing.
  if (editing.size) return;
  const box = clear($('#sections'));
  const locked = new Map((p.locked_sections || []).map((s) => [s.title.toLowerCase(), s.body]));
  for (const s of p.sections || []) box.append(sectionView(s, p, locked));
}

function sectionView(s, p, locked) {
  const changed = p.state === 'amending' && locked.size && (locked.get(s.title.toLowerCase()) ?? '') !== (s.body ?? '');
  const head = h('div', { class: 'section-head' },
    h('h3', { text: s.title }),
    changed ? h('span', { class: 'pill warn', text: `changed since v${p.locked_version}` }) : null,
    s.updated_by ? h('span', { class: 'section-meta' }, who(s.updated_by), h('span', { text: ` ${ago(s.updated_at)}` })) : null,
    h('button', { class: 'btn ghost small edit', type: 'button', text: 'Edit', onclick: () => startEdit(s.title, s.body || '') }),
  );
  const body = s.body && s.body.trim()
    ? h('div', { class: 'section-body', text: s.body })
    : h('p', { class: 'section-empty', text: 'Nothing written yet.' });
  return h('article', { class: 'section', 'data-title': s.title }, head, body);
}

function startEdit(title, body) {
  editing.set(title, body);
  const el = [...document.querySelectorAll('#sections .section')].find((n) => n.dataset.title === title);
  if (!el) return;
  const area = h('textarea', { class: 'editor', rows: String(Math.min(16, Math.max(4, body.split('\n').length + 2))), 'aria-label': `Edit ${title}` });
  area.value = body;
  area.addEventListener('input', () => editing.set(title, area.value));
  const save = h('button', { class: 'btn small', type: 'button', text: 'Save section' });
  const cancel = h('button', { class: 'btn small ghost', type: 'button', text: 'Cancel' });
  const hint = state.prompt?.state === 'locked'
    ? h('p', { class: 'hint', text: 'Saving starts an amendment. Locked v' + state.prompt.locked_version + ' stays in force until the team approves the new version.' })
    : null;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api('/api/prompt/edit', { section: title, text: area.value, mode: 'replace' });
      editing.delete(title);
      toast('Section saved');
      await refresh();
    } catch (err) {
      save.disabled = false;
      if (!lockedOut) toast(err.message, true);
    }
  });
  cancel.addEventListener('click', () => {
    editing.delete(title);
    renderPrompt();
  });
  const bodyEl = el.querySelector('.section-body, .section-empty');
  const editor = h('div', { class: 'section-editor' }, area, hint, h('div', { class: 'bar-actions' }, save, cancel));
  bodyEl.replaceWith(editor);
  el.querySelector('.edit').hidden = true;
  area.focus();
}

// ---------- feed ----------

function describe(ev) {
  const d = ev.data || {};
  const actor = ev.member_id;
  switch (ev.kind) {
    case 'joined': return [who(actor), ' joined the team', d.tool ? ` with ${toolName(d.tool)}` : ''];
    case 'left': return [who(actor), ' left the team'];
    case 'update': return [who(actor), ': ', shorten(d.text, 300)];
    case 'decision': return [who(actor), ' decided: ', shorten(d.text, 220), d.why ? ` Why: ${shorten(d.why, 160)}` : ''];
    case 'file_edit': return [who(actor), ' is editing ', code(d.path || ''), d.task_key ? [' for ', code(d.task_key)] : ''];
    case 'commit': return [who(actor), ' committed ', quoted(d.message || ''), d.branch ? [' on ', code(d.branch)] : ''];
    case 'ask': return [who(actor), ' asked ', who(d.to_id), ': ', quoted(d.question || '')];
    case 'reply': return [who(actor), ' answered ', who(d.to_id), ': ', quoted(d.answer || '')];
    case 'prompt_edit': return [who(actor), ' edited ', quoted(d.section || ''), ' in the master prompt'];
    case 'prompt_submitted': return [who(actor), ` put master prompt v${d.version ?? '?'} up for a vote`];
    case 'prompt_vote': return [who(actor), d.approve ? ' approved' : ' rejected', ` v${d.version ?? '?'}`, d.comment ? [': ', quoted(d.comment)] : ''];
    case 'prompt_locked': return [h('b', { text: `Master prompt v${d.version ?? '?'} is locked` })];
    case 'plan_created': return [who(actor), ` made a plan with ${(d.keys || []).length} tasks`];
    case 'task_created': return [who(actor), ' added ', code(d.key), ` ${shorten(d.title, 60)}`];
    case 'task_proposed': return [who(actor), ' proposed ', taskRef(d.key), ' for ', who(d.proposed_id)];
    case 'task_assigned':
      if (actor && actor === d.assignee_id) return [who(actor), ' took ', taskRef(d.key)];
      return [who(actor), ' assigned ', taskRef(d.key), ' to ', who(d.assignee_id)];
    case 'task_started': return [who(actor), ' started ', taskRef(d.key)];
    case 'task_updated': return [who(actor), ' on ', code(d.key), ': ', shorten(d.note, 200)];
    case 'task_done': return [who(actor), ' finished ', taskRef(d.key), d.branch ? [' on ', code(d.branch)] : ''];
    case 'task_released': return [who(actor), ' released ', taskRef(d.key)];
    case 'task_unblocked': return [taskRef(d.key), ' is ready for ', who(d.assignee_id)];
    case 'settings_changed': return [who(actor), ' changed the house rules', d.changes ? `: ${Object.keys(d.changes).join(', ').replace(/_/g, ' ')}` : ''];
    case 'lead_changed': return [who(d.lead_id), ' is now the lead'];
    case 'member_removed': return [h('b', { text: d.name || 'Someone' }), ' was removed from the team'];
    case 'huddle_started': return [who(actor), ` started a ${KIND_TEXT[d.kind]?.toLowerCase() || ''} huddle `, code(d.huddle_id || '?'), ': ', quoted(d.topic || '')];
    case 'huddle_post':
      if (d.post_kind === 'idea') return [who(actor), ' added an idea to ', code(d.huddle_id || '?'), ': ', quoted(d.text || '')];
      return [who(actor), ' in ', code(d.huddle_id || '?'), d.on ? ` on idea #${d.on}` : '', ': ', quoted(d.text || '')];
    case 'huddle_vote': return [who(actor), d.value > 0 ? ' backed' : ' pushed back on', ` idea #${d.seq} in `, code(d.huddle_id || '?'), d.note ? [': ', quoted(d.note)] : ''];
    case 'huddle_closed': return [who(actor), ' closed ', code(d.huddle_id || '?'), d.decision ? [', decided: ', quoted(d.decision)] : ''];
    default: return [who(actor), ` ${String(ev.kind || 'did something').replace(/_/g, ' ')}`];
  }
}

function addEvents(events) {
  for (const ev of events || []) {
    if (!ev || ev.id == null) continue;
    feedEvents.set(ev.id, ev);
    if (ev.id > lastId) lastId = ev.id;
  }
  if (feedEvents.size > FEED_MAX) {
    const ids = [...feedEvents.keys()].sort((a, b) => a - b);
    for (const id of ids.slice(0, feedEvents.size - FEED_MAX)) feedEvents.delete(id);
  }
}

function renderFeed() {
  const list = clear($('#feed'));
  const events = [...feedEvents.values()].sort((a, b) => b.id - a.id);
  if (!events.length) {
    list.append(h('li', { class: 'feed-empty', text: 'Quiet so far. Things your team’s agents do show up here as they happen.' }));
    return;
  }
  for (const ev of events) {
    list.append(
      h('li', { class: `feed-item kind-${String(ev.kind).replace(/[^a-z_]/g, '')}` },
        h('time', { class: 'time', text: clock(ev.created_at), title: ago(ev.created_at) }),
        h('p', { class: 'feed-text' }, describe(ev)),
      ),
    );
  }
}

async function loadFeed() {
  const r = await api(`/api/events?tail=${FEED_MAX}`);
  addEvents(r?.events || []);
  if (state?.last_event_id > lastId) lastId = state.last_event_id;
  renderFeed();
}

// ---------- live stream ----------

let refreshTimer = null;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 250);
}

function setConn(on, label) {
  const el = $('#conn');
  el.dataset.state = on ? 'on' : 'off';
  $('#conn-label').textContent = label || (on ? 'Live' : 'Reconnecting');
}

function handleBlock(block) {
  let data = '';
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data += (data ? '\n' : '') + value;
  }
  if (!data) return;
  let ev;
  try {
    ev = JSON.parse(data);
  } catch {
    return;
  }
  addEvents([ev]);
  renderFeed();
  scheduleRefresh();
}

async function stream() {
  let backoff = 1000;
  while (!lockedOut) {
    try {
      const res = await fetch(`/api/stream?since=${lastId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
      });
      if (res.status === 401) {
        lockOut('expired');
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setConn(true);
      backoff = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          handleBlock(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } catch {
      // fall through to reconnect
    }
    if (lockedOut) return;
    setConn(false);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 15000);
  }
}

// ---------- invite, toast ----------

function wireInvite() {
  const show = $('#invite-show');
  const box = $('#invite-box');
  const input = $('#invite-url');
  show.addEventListener('click', async () => {
    show.disabled = true;
    try {
      const r = await api('/api/invite', {});
      input.value = r.invite_url || '';
      $('#invite-exp').textContent = r.expires_at ? `Works until ${new Date(toMs(r.expires_at)).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.` : '';
      box.hidden = false;
      show.hidden = true;
    } catch (err) {
      show.disabled = false;
      if (!lockedOut) toast(err.message, true);
    }
  });
  $('#invite-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Invite link copied');
    } catch {
      input.select();
      toast('Press Ctrl+C to copy');
    }
  });
}

let toastTimer = null;

function toast(text, isError) {
  const el = $('#toast');
  el.textContent = text;
  el.dataset.kind = isError ? 'error' : 'ok';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isError ? 5000 : 2200);
}

// ---------- boot ----------

async function refresh() {
  const next = await api('/api/state');
  state = next;
  renderAll();
  for (const id of openTalks) loadTalk(id);
}

let inviteWired = false;

async function boot() {
  token = token || takeToken();
  if (!teamId || !token) {
    lockOut('missing');
    return;
  }
  if (!inviteWired) {
    wireInvite();
    inviteWired = true;
  }
  try {
    await refresh();
  } catch (err) {
    if (lockedOut) return;
    $('#team-name').textContent = 'Can’t reach the hub';
    setConn(false, 'Offline');
    toast(`${err.message} Retrying.`, true);
    setTimeout(boot, 5000);
    return;
  }
  $('#app').hidden = false;
  try {
    await loadFeed();
  } catch {
    renderFeed();
  }
  stream();
  setInterval(() => {
    if (!lockedOut) refresh().catch(() => {});
  }, 30000);
}

boot();
