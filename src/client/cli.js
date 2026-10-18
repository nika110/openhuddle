// The `openhuddle` command. main() returns an exit code and never throws.
import { parseArgs } from 'node:util';
import { homedir, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { VERSION, DEFAULT_HUB } from '../shared/protocol.js';
import { Api, ApiError } from './api.js';
import { findProject, findConfig, saveConfig, removeConfig, dashboardUrl, machineId, gitTracking } from './config.js';
import { gitRoot, originUrl, gitUserName, clone, isCloneableUrl } from './git.js';
import { wireAll, unwireAll, detectTools, wiringStatus } from './wire.js';
import { runMcp } from './mcp.js';
import { runHook } from './hooks.js';
import { NOT_IN_TEAM } from './tools.js';
import { briefing, taskBoard, eventLine, byId, byKey } from './format.js';

const HELP = `openhuddle ${VERSION} — multiplayer mode for AI coding agents

Start a team (inside your project's git repo):
  npx openhuddle create [--name "Team name"] [--as yourname]

Join a team (your friend sends you the link):
  npx openhuddle join <invite-link> [--as yourname]

Then open Claude Code, Codex or Cursor in the project and just talk:
  "let's write the master prompt"   "what is everyone doing?"   "take the next task"

Other commands:
  status            who is doing what, the master prompt, the task board
  watch             live team feed in this terminal
  dash              open the live dashboard in your browser
  invite [--rotate] show the invite link (owner can --rotate it)
  remove <name>     remove a teammate from the team (owner only)
  delete-team --yes delete the whole team and its data on the hub (owner only)
  doctor [--fix]    check the setup (and repair it)
  leave             leave the team and remove OpenHuddle from this project
  hub               run your own hub (--port, --db, --public-url, --trust-proxy,
                    --backup-dir, --retention-days; 0 keeps inactive teams forever)

Options: --hub <url> (or OPENHUDDLE_HUB) picks a self-hosted hub.`;

const OPTIONS = {
  hub: { type: 'string' },
  as: { type: 'string' },
  name: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  db: { type: 'string' },
  'public-url': { type: 'string' },
  'trust-proxy': { type: 'boolean' },
  'backup-dir': { type: 'string' },
  'retention-days': { type: 'string' },
  rotate: { type: 'boolean' },
  fix: { type: 'boolean' },
  yes: { type: 'boolean' },
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
    importModule: io.importModule ?? ((m) => import(m)),
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
    ctx.err(`openhuddle: ${e.message}`);
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
      ctx.err(`openhuddle: unknown command "${cmd}". Run \`npx openhuddle help\`.`);
      return 1;
    }
    return await fn(ctx, flags, args);
  } catch (e) {
    ctx.err(`openhuddle: ${explain(e)}`);
    return 1;
  }
}

function explain(e) {
  if (e instanceof ApiError) {
    if (e.code === 'unreachable') return `${e.message}. Check your internet connection, or pass --hub if your team uses its own hub.`;
    if (e.status === 401) return 'your membership is no longer valid (removed from the team, or the token was reset). Ask a teammate for a new invite.';
    if (e.code === 'invalid_invite') return 'that invite link is not valid anymore. Ask your friend for a fresh one (`npx openhuddle invite`).';
    return e.message;
  }
  return e?.message || String(e);
}

const NO_HUB = `No OpenHuddle hub is configured, so one of you runs it:
  1. On a machine your friends can reach:  npx openhuddle hub --public-url https://your-host
  2. In your project:                      npx openhuddle create --hub https://your-host
(or set OPENHUDDLE_HUB once instead of passing --hub). Friends just use the invite link.`;

// --hub wins, then OPENHUDDLE_HUB, then the public hub.
export function resolveHub(flagHub, envHub, defaultHub = DEFAULT_HUB) {
  const hub = String(flagHub || envHub || defaultHub || '').replace(/\/+$/, '');
  if (!hub) throw new Error(NO_HUB);
  return hub;
}

function hubUrl(ctx, flags) {
  return resolveHub(flags.hub, ctx.env.OPENHUDDLE_HUB);
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
  return ctx.env.OPENHUDDLE_NO_CLAUDE_CLI === '1' ? false : undefined;
}

const COMMITTED_CONFIG = `This repository has a committed .openhuddle folder, so OpenHuddle ignores it: a team setup belongs to
one person on one machine and is never shared through git (it holds that person's access token).
If this is your own team, take it out of git (git rm --cached -r .openhuddle) and run \`npx openhuddle doctor --fix\`.`;
const UNCONFIRMED_CONFIG = {
  other_machine: 'This folder holds an OpenHuddle team setup made on another machine, so it is not used here.',
  legacy: 'This folder holds an OpenHuddle team setup written by an older version, which this version does not use until it is confirmed.',
  unverified: 'This folder holds an OpenHuddle team setup written by an older version, outside any git repository, which this version does not use until it is confirmed.',
};
const CONFIRM_HINT = `If you set up this team yourself, run \`npx openhuddle doctor --fix\` here once to use it on this machine.
If this folder came from someone else, delete its .openhuddle folder (and run \`npx openhuddle join <invite-link>\` for your own team).`;

function explainUnused(ctx, found) {
  if (!found) ctx.err(NOT_IN_TEAM);
  else if (found.trust === 'committed') ctx.err(COMMITTED_CONFIG);
  else ctx.err(`${UNCONFIRMED_CONFIG[found.trust] || UNCONFIRMED_CONFIG.other_machine}\n${CONFIRM_HINT}`);
}

function needProject(ctx, flags) {
  const start = flags.dir || ctx.cwd;
  const project = findProject(start);
  if (project) return project;
  explainUnused(ctx, findConfig(start));
  return null;
}

// create and join write a token into .openhuddle/config.json; a tracked one would carry it
// into the repository's history, so they refuse there.
function refuseCommitted(ctx, root) {
  if (gitTracking(root) !== 'tracked') return false;
  ctx.err(COMMITTED_CONFIG);
  return true;
}

function apiOf(project, opts) {
  return new Api(project.config.hub, project.config.token, opts);
}

export function parseInvite(link, hubOverride) {
  const s = String(link || '').trim();
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const i = u.pathname.indexOf('/join/');
    if (i !== -1) {
      const code = decodeURIComponent(u.pathname.slice(i + 6).replace(/\/+$/, ''));
      return { hub: `${u.origin}${u.pathname.slice(0, i)}`, code };
    }
  } catch {}
  const hub = hubOverride || DEFAULT_HUB;
  if (hub && /^t[a-z2-7]+\.[A-Za-z0-9_-]+$/.test(s)) return { hub, code: s };
  return null;
}

// The folder a cloned team repo goes into: the repo's name, reduced to plain characters, never
// `.`, `..` or a hidden name, so a repo link from the hub cannot pick a folder outside this one.
export function repoDirName(url) {
  const last = String(url ?? '').replace(/[\\/]+$/, '').split(/[\\/:]/).pop() || '';
  const name = last
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 100)
    .replace(/\.+$/, '');
  if (!name) return 'project';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name}-repo` : name;
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
      ctx.err('openhuddle works inside a git repository, so your team can share the code. Make one first:');
      ctx.err('  git init && git add -A && git commit -m "first commit"');
      ctx.err('then run: npx openhuddle create');
      return 1;
    }
    const existing = findProject(root);
    if (existing) {
      ctx.err(`This project is already in the team "${existing.config.team_name ?? existing.config.team_id}". See it with \`npx openhuddle status\`, or leave with \`npx openhuddle leave\`.`);
      return 1;
    }
    if (refuseCommitted(ctx, root)) return 1;
    machineId({ create: true }); // fails here, before a team exists, if the home folder is not writable
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
    });
    const lines = wireAll(root, { home: ctx.home, tools, claudeCli: claudeCli(ctx) });
    const dash = dashboardUrl(findProject(root)?.config);
    ctx.out(`Team "${res.team_name}" is ready. You are ${res.member_name} (owner).`);
    ctx.out('');
    ctx.out('Send this to your friends:');
    ctx.out(`  npx openhuddle join ${res.invite_url}`);
    ctx.out('');
    if (!repo_url) {
      ctx.out('Tip: push this repo somewhere your friends can clone (git remote add origin ...), so `join` can fetch the code for them.');
      ctx.out('');
    }
    printWired(ctx, lines);
    ctx.out('');
    if (dash) ctx.out(`Live dashboard (your personal link, don't share it): ${dash}`);
    ctx.out('');
    ctx.out('Next: open your AI tool in this folder and say "let\'s write the master prompt".');
    return 0;
  },

  async join(ctx, flags, args) {
    const inv = parseInvite(args[0], flags.hub || ctx.env.OPENHUDDLE_HUB);
    if (!inv || !inv.code) {
      ctx.err('Usage: npx openhuddle join <invite-link>   (the link looks like https://.../join/t...)');
      return 1;
    }
    let root = gitRoot(ctx.cwd);
    const existing = root && findProject(root);
    if (existing) {
      ctx.err(`This project is already in the team "${existing.config.team_name ?? existing.config.team_id}". Run \`npx openhuddle leave\` first to switch teams.`);
      return 1;
    }
    if (root && refuseCommitted(ctx, root)) return 1;
    machineId({ create: true });
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
          ctx.out(`Getting the team's code: git clone ${res.repo_url}`);
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
        if (refuseCommitted(ctx, root)) {
          await new Api(inv.hub, res.token, { timeoutMs: 8000 }).post('/api/leave', {}).catch(() => {});
          return 1;
        }
      } else {
        ctx.out('This folder is not a git repository and the team has no repo link, so OpenHuddle is set up right here.');
        root = resolve(ctx.cwd);
      }
    } else if (res.repo_url) {
      const mine = originUrl(root);
      if (mine && !sameRepo(mine, res.repo_url)) {
        ctx.out(`Heads-up: this repo's origin (${mine}) is not the team's repo (${res.repo_url}). Continuing here anyway.`);
      }
    }
    saveConfig(root, {
      hub: inv.hub,
      team_id: res.team_id,
      team_name: res.team_name,
      member_id: res.member_id,
      member_name: res.member_name,
      token: res.token,
    });
    const lines = wireAll(root, { home: ctx.home, tools, claudeCli: claudeCli(ctx) });
    const dash = dashboardUrl(findProject(root)?.config);
    ctx.out(`Joined the team "${res.team_name}" as ${res.member_name}. Your teammates can see you now.`);
    ctx.out('');
    printWired(ctx, lines);
    ctx.out('');
    if (dash) ctx.out(`Live dashboard (your personal link, don't share it): ${dash}`);
    ctx.out('');
    ctx.out(`Next: open your AI tool in ${root} and say "what is the team doing?".`);
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
    ctx.out('Live view: npx openhuddle watch   ·   dashboard: npx openhuddle dash');
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
    ctx.out(`Watching team "${state.team?.name}" — Ctrl+C to stop.`);
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
    // Built from local config only; never from anything the hub sent.
    const url = dashboardUrl(project.config);
    if (!url) {
      ctx.err('The openhuddle config in this project looks wrong (the hub must be an http or https address). Run `npx openhuddle doctor`, or leave and join again.');
      return 1;
    }
    ctx.out(`Dashboard (your personal link, don't share it — share \`npx openhuddle invite\` instead):`);
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
    ctx.out(`  npx openhuddle join ${res.invite_url}`);
    if (res.expires_at) ctx.out(`(valid until ${new Date(res.expires_at).toLocaleString()})`);
    return 0;
  },

  async doctor(ctx, flags) {
    const start = flags.dir || ctx.cwd;
    let project = findProject(start);
    if (!project) {
      // `doctor --fix`, typed by the user in this folder, is how a setup this machine has not
      // confirmed (older version, other computer) becomes this machine's. Never a committed one.
      const found = findConfig(start);
      if (!found || found.trust === 'committed' || !flags.fix) {
        explainUnused(ctx, found);
        return 1;
      }
      ctx.out(`Using the team setup in ${found.root} on this machine from now on (hub ${found.config.hub}).`);
      project = saveConfig(found.root, found.config);
    }
    let ok = true;
    const mark = (good, label, hint) => {
      if (!good) ok = false;
      ctx.out(`  ${good ? 'ok ' : 'XX '} ${label}${!good && hint ? ` — ${hint}` : ''}`);
    };
    const c = project.config;
    ctx.out(`openhuddle ${VERSION} · project ${project.root}`);
    mark(true, `team "${c.team_name ?? c.team_id}" as ${c.member_name}`);
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
      // Rewriting the config also restores .openhuddle/.gitignore for projects set up by older versions.
      saveConfig(project.root, project.config);
      const lines = wireAll(project.root, { home: ctx.home, claudeCli: claudeCli(ctx) });
      ctx.out('Re-wired:');
      for (const l of lines) ctx.out(`  - ${l}`);
    }
    const w = wiringStatus(project.root, { home: ctx.home });
    mark(w.app, 'openhuddle installed in ~/.openhuddle/app', 'run `npx openhuddle doctor --fix`');
    if (w.plugin) mark(true, 'Claude Code: OpenHuddle plugin installed');
    else mark(w.claude_hooks, 'Claude Code hooks', 'run `npx openhuddle doctor --fix`');
    if (w.codex !== null) mark(w.codex, 'Codex MCP entry', 'run `npx openhuddle doctor --fix`');
    if (w.cursor !== null) mark(w.cursor, 'Cursor MCP entry', 'run `npx openhuddle doctor --fix`');
    if (w.git_hook === null) ctx.out('  --  git post-commit hook: skipped (your existing hook is not a shell script, or hooks live in the repo)');
    else mark(w.git_hook, 'git post-commit hook', 'run `npx openhuddle doctor --fix`');
    return ok ? 0 : 1;
  },

  async remove(ctx, flags, args) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    const who = args.join(' ').trim();
    if (!who) {
      ctx.err('Usage: npx openhuddle remove <teammate name>   (team owner only)');
      return 1;
    }
    await apiOf(project).post('/api/members/remove', { member: who });
    ctx.out(`Removed ${who} from the team. Their agent can no longer read or post.`);
    ctx.out('If they still have the invite link, reset it: npx openhuddle invite --rotate');
    return 0;
  },

  async leave(ctx, flags) {
    const start = flags.dir || ctx.cwd;
    const project = findProject(start);
    if (!project) {
      // A setup this machine never confirmed: nothing to tell a hub, but the local traces go.
      const found = findConfig(start);
      if (!found) {
        ctx.err(NOT_IN_TEAM);
        return 1;
      }
      const lines = unwireAll(found.root, { home: ctx.home, claudeCli: claudeCli(ctx) });
      removeConfig(found.root);
      ctx.out(`Removed the OpenHuddle setup from ${found.root} (it was not made on this machine, so no hub was told).`);
      for (const l of lines) ctx.out(`  - ${l}`);
      return 0;
    }
    try {
      await apiOf(project, { timeoutMs: 8000 }).post('/api/leave', {});
    } catch (e) {
      ctx.err(`(could not tell the hub: ${explain(e)}; removing OpenHuddle locally anyway)`);
    }
    const lines = unwireAll(project.root, { home: ctx.home, claudeCli: claudeCli(ctx) });
    removeConfig(project.root);
    ctx.out(`Left the team "${project.config.team_name ?? project.config.team_id}".`);
    for (const l of lines) ctx.out(`  - ${l}`);
    return 0;
  },

  async 'delete-team'(ctx, flags) {
    const project = needProject(ctx, flags);
    if (!project) return 1;
    const name = project.config.team_name ?? project.config.team_id;
    if (!flags.yes) {
      ctx.err(`This deletes the team "${name}" and everything in it on the hub (master prompt, tasks, feed, members), for everyone, right away.`);
      ctx.err('Run again with --yes if you are sure: npx openhuddle delete-team --yes');
      return 1;
    }
    await apiOf(project, { timeoutMs: 8000 }).post('/api/team/delete', {});
    const lines = unwireAll(project.root, { home: ctx.home, claudeCli: claudeCli(ctx) });
    removeConfig(project.root);
    ctx.out(`Deleted the team "${name}" and all of its data on the hub.`);
    for (const l of lines) ctx.out(`  - ${l}`);
    ctx.out("Teammates' setups stop working; they can run `npx openhuddle leave` to clean up.");
    return 0;
  },

  async hub(ctx, flags) {
    if (!(await sqliteAvailable(ctx))) {
      ctx.err(`The hub needs Node 22.13 or newer (it uses the built-in node:sqlite); you have ${process.version}.`);
      ctx.err('Team members only need Node 20; this is just for running your own hub.');
      return 1;
    }
    const { startHub } = await import('../hub/server.js');
    const port = Number(flags.port ?? ctx.env.PORT ?? 8787);
    const hub = await startHub({
      port,
      host: flags.host || ctx.env.OPENHUDDLE_HOST || '0.0.0.0',
      dbPath: flags.db || ctx.env.OPENHUDDLE_DB || join(ctx.cwd, 'openhuddle-hub.db'),
      publicUrl: flags['public-url'] || ctx.env.OPENHUDDLE_PUBLIC_URL,
      trustProxy: !!flags['trust-proxy'] || ctx.env.OPENHUDDLE_TRUST_PROXY === '1',
      backupDir: flags['backup-dir'] || ctx.env.OPENHUDDLE_BACKUP_DIR || undefined,
      retentionDays: Number(flags['retention-days'] ?? ctx.env.OPENHUDDLE_RETENTION_DAYS ?? 90),
    });
    ctx.out(`openhuddle hub ${VERSION} listening on ${hub.url}`);
    await new Promise((done) => {
      const stop = () => done();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await hub.close();
    return 0;
  },

  async mcp(ctx, flags) {
    // A plugin-launched server may start outside the project; Claude Code tells us where it is.
    const dir = flags.dir || ctx.env.CLAUDE_PROJECT_DIR || ctx.cwd;
    const project = findProject(dir);
    await runMcp({ project, dir });
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

async function sqliteAvailable(ctx) {
  // node:sqlite announces itself with an ExperimentalWarning on some versions; this probe
  // should not print it.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    await ctx.importModule('node:sqlite');
    return true;
  } catch {
    return false;
  } finally {
    process.emitWarning = emit;
  }
}

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

// Opens a URL with no shell in between, so nothing in it can be read as a command.
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

function openBrowser(url) {
  try {
    const [cmd, args] = browserCommand(url);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {}
}
