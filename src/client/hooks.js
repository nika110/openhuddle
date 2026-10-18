// Claude Code hooks (and the git post-commit hook). They bring crew news into the running
// agent and pause edits to files a teammate holds. They always fail open: on any error or
// after HOOK_TIMEOUT_MS they return '' and the agent carries on untouched.
import { Api } from './api.js';
import { findProject, loadState, saveState } from './config.js';
import { gitInfo, lastCommit } from './git.js';
import { frame, briefing, newsBlock, byId, clip, clock } from './format.js';
import { isAbsolute, join } from 'node:path';
import { toRepoPath } from '../shared/paths.js';
import { HOOK_TIMEOUT_MS, URGENT_KINDS } from '../shared/protocol.js';

export const HOOK_NAMES = ['session-start', 'prompt', 'pre-edit', 'post-edit', 'stop', 'git-commit'];

const HEADER =
  'vibecrew: you are part of a crew. Other people\'s AI agents are working on this project right now. Use team_sync, task, team_ask and team_post to stay in sync.';

export async function runHook(name, input = {}, ctx = {}) {
  const ms = ctx.timeoutMs ?? HOOK_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(''), ms);
  });
  try {
    const out = await Promise.race([inner(name, input || {}, ctx, ms).catch(() => ''), timeout]);
    return typeof out === 'string' ? out : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function context(event, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

function cacheSettings(st, state) {
  const s = state?.team?.settings;
  if (s) st.settings = { claim_mode: s.claim_mode };
}

function editedPath(input, root) {
  const ti = input.tool_input || {};
  const p = ti.file_path ?? ti.notebook_path ?? ti.path;
  return typeof p === 'string' ? toRepoPath(p, root) : null;
}

const SHELL_TOOLS = ['Bash', 'PowerShell'];
// Shell commands that can change files: redirects (not 2>&1), common file tools, in-place editors,
// and PowerShell's file cmdlets. Anything else is treated as read-only and costs no hub call.
const SHELL_WRITE =
  /(?:^|[^<>&0-9])>>?(?!&)|\b(?:tee|mv|cp|rm|truncate|touch|install|ln|unlink)\b|\bsed\b[^|;&]*\s(?:-[a-zA-Z]*i\b|--in-place)|\bperl\b[^|;&]*\s-[a-zA-Z]*i|\bdd\b[^|;&]*\bof=|\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Clear-Content)\b/i;

// Repo-relative paths a shell command mentions, resolved against the shell's cwd.
function shellPaths(command, cwd, root) {
  const out = new Set();
  for (const token of String(command).split(/[\s'"`;|&()<>,]+/)) {
    if (!token || token.startsWith('-') || !/[./\\]/.test(token)) continue;
    const rel = toRepoPath(isAbsolute(token) || /^[a-zA-Z]:/.test(token) ? token : join(cwd, token), root);
    if (rel) out.add(rel);
    if (out.size >= 20) break;
  }
  return [...out];
}

function editTargets(input, root) {
  if (SHELL_TOOLS.includes(input.tool_name)) {
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || !SHELL_WRITE.test(command)) return [];
    return shellPaths(command, input.cwd || root, root);
  }
  const rel = editedPath(input, root);
  return rel ? [rel] : [];
}

function questionsBlock(state) {
  const asks = state.asks_for_me || [];
  if (!asks.length) return '';
  const members = byId(state.members);
  return [
    'Questions waiting for your answer (use team_reply):',
    ...asks.map((a) => `- ${a.id ?? a.ask_id} from ${clip(members[a.from_id]?.name ?? 'a teammate')}: ${a.question}`),
  ].join('\n');
}

async function inner(name, input, ctx, ms) {
  const project = ctx.project ?? findProject(input.cwd || ctx.cwd || process.cwd());
  if (!project) return '';
  const api = new Api(project.config.hub, project.config.token, { timeoutMs: Math.max(200, ms - 300) });
  const { root, dir } = project;

  switch (name) {
    case 'session-start': {
      const st = loadState(dir);
      const [state, ev] = await Promise.all([api.get('/api/state'), api.get(`/api/events?since=${st.cursor}&limit=50`)]);
      const last = Math.max(st.cursor, ev.last_event_id ?? 0, state.last_event_id ?? 0);
      st.cursor = last;
      st.urgent_cursor = Math.max(st.urgent_cursor, last);
      cacheSettings(st, state);
      saveState(dir, st);
      const body = [briefing(state), newsBlock(ev.events, state)].filter(Boolean).join('\n\n');
      return context('SessionStart', `${HEADER}\n${frame(body)}`);
    }

    case 'prompt': {
      const st = loadState(dir);
      const [ev, state] = await Promise.all([api.get(`/api/events?since=${st.cursor}&limit=50`), api.get('/api/state')]);
      // Urgent events were already shown after an edit; don't repeat them.
      const events = (ev.events || []).filter((e) => !(URGENT_KINDS.includes(e.kind) && e.id <= st.urgent_cursor));
      const news = newsBlock(events, state);
      const asks = questionsBlock(state);
      const last = Math.max(st.cursor, ev.last_event_id ?? 0);
      st.cursor = last;
      st.urgent_cursor = Math.max(st.urgent_cursor, last);
      cacheSettings(st, state);
      saveState(dir, st);
      if (!news && !asks) return '';
      return context('UserPromptSubmit', frame([news, asks].filter(Boolean).join('\n\n')));
    }

    case 'pre-edit': {
      const paths = editTargets(input, root);
      if (!paths.length) return '';
      const mode = loadState(dir).settings?.claim_mode ?? 'ask';
      if (mode === 'warn') return '';
      const res = await api.post('/api/claims', { action: 'check', paths });
      const c = (res.conflicts || [])[0];
      if (!c) return '';
      const reason =
        `vibecrew: ${clip(c.member_name)} is working on ${c.path}${c.task_key ? ` (task ${c.task_key})` : ''}, held until ${clock(c.expires_at)}. ` +
        'Ask them first with team_ask, or work on another file.';
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: mode === 'block' ? 'deny' : 'ask',
          permissionDecisionReason: mode === 'block' ? `${reason} (Your crew blocks edits to files a teammate holds.)` : reason,
        },
      });
    }

    case 'post-edit': {
      const rel = editedPath(input, root);
      if (!rel) return '';
      const st = loadState(dir);
      const since = Math.max(st.cursor, st.urgent_cursor);
      const res = await api.post('/api/file-edit', { path: rel, since });
      const me = project.config.member_id;
      const events = (res.events || []).filter((e) => e.member_id !== me || e.kind === 'prompt_locked');
      const parts = [];
      if (res.conflict) {
        const c = res.conflict;
        parts.push(`Note: ${clip(c.member_name)} also holds ${c.path}${c.task_key ? ` (task ${c.task_key})` : ''}. Tell them (team_ask or team_post) so your changes don't collide.`);
      }
      if (events.length) {
        const state = await api.get('/api/state');
        cacheSettings(st, state);
        parts.push(newsBlock(events, state, { urgentOnly: true }));
      }
      st.urgent_cursor = Math.max(st.urgent_cursor, res.last_event_id ?? since);
      saveState(dir, st);
      if (!parts.length) return '';
      return context('PostToolUse', frame(parts.join('\n\n')));
    }

    case 'stop': {
      await api.post('/api/heartbeat', { status: gitInfo(root) });
      return '';
    }

    case 'git-commit': {
      const c = lastCommit(root);
      if (!c) return '';
      await api.post('/api/commit', { sha: c.sha, branch: c.branch, message: c.message, files: c.files });
      return '';
    }

    default:
      return '';
  }
}
