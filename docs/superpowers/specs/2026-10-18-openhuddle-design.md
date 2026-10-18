# OpenHuddle — design

**One line:** multiplayer mode for AI coding agents. A few friends, each with their own
Claude Code / Codex / Cursor, build one project together, and every agent knows in real
time what the others are doing.

## Why

Today friends who vibe-code together coordinate through GitHub plus chat. Their agents
know nothing about each other: two agents edit the same file, one changes an API the
other depends on, nobody can ask "what is friend2 doing right now?" without pinging a
human. Prior art covers pieces (MCP Agent Mail: leases + inbox; Claude Code Agent
Teams: one machine only; agentmemory/projectmem: single-user memory). Nobody covers
**different people, different machines, different tools, live**.

## Goals

1. **Setup is two commands, no config files.** Friend1 runs `npx openhuddle create` in the
   repo, gets an invite link. Others run `npx openhuddle join <link>`. It detects installed
   AI tools and wires itself in. Under 2 minutes, no docs.
2. **Live awareness inside the agent.** News from teammates lands in the running agent on
   every prompt and after every edit, without anyone asking.
3. **Ask a teammate's agent.** "What is friend2 doing?" answers instantly from live state;
   deeper questions are delivered to friend2's agent, which replies.
4. **Master prompt.** All friends co-write one shared description of what they build
   (sections, versioned, signed). Submitting starts a vote; when approved it locks as v1.
5. **Plan + assignment.** The main agent (a role any member can hold, the "lead") turns the
   locked master prompt into tasks with file areas and dependencies. Contracts first: task
   one is always the skeleton (repo setup, shared types/API shapes, schema, lint).
   Assignment modes: `self` (friends pick), `agent` (lead assigns), `hybrid` (lead proposes,
   friend accepts or declines) — default `hybrid`.
6. **No collisions.** Editing a file auto-claims it for 30 min (refreshed while online).
   Before an agent edits a file a teammate holds, the edit pauses and asks the human
   (`claim_mode: ask`, alternatives `block` / `warn`).
7. **Humans can watch.** A live web dashboard: members + presence, master prompt with
   votes, task board, live feed. A terminal feed: `openhuddle watch`.
8. **Settings by talking.** Every setting has a default and is changed by telling your agent
   ("let the agent assign tasks from now on"), never by editing files.

## Non-goals (v1)

- Storing or syncing code. Git stays the source of truth for code; the hub coordinates.
- A background daemon. The helper runs only while an AI tool is open; offline members are
  represented by their last known status.
- Accounts / OAuth. The invite link is the access.
- Running agents headlessly on someone's machine on another member's request.

## Anti-goals (failure even if it works)

- Setup that needs editing JSON/TOML/YAML by hand.
- Slowing down or breaking the agent when the hub is down (hooks must fail open fast).
- A teammate's text acting as instructions to my agent; leaking secrets into the hub.
- Clobbering the user's existing tool config or git hooks.

## Architecture

```
            ┌──────── HUB (one per deployment, many teams) ────────┐
            │ teams · members · master prompt · tasks · claims     │
            │ asks · events (feed) · presence        SQLite + SSE  │
            └──────▲───────────────────▲───────────────────▲───────┘
              HTTPS│JSON / SSE         │                   │
           ┌───────┴──────┐    ┌───────┴──────┐    ┌───────┴──────┐
           │ friend1 PC   │    │ friend2 PC   │    │ friendN PC   │
           │ openhuddle CLI │    │              │    │              │
           │ ├ MCP server │◄── agent tools (Claude Code, Codex, Cursor)
           │ ├ hooks      │◄── Claude Code hooks: inject news, guard edits
           │ └ git hook   │◄── post-commit: any tool
           └──────────────┘    └──────────────┘    └──────────────┘
```

- **Hub:** zero-dependency Node (`node:http`, `node:sqlite`, SSE). Multi-tenant. Hosted
  default, self-host with `npx openhuddle hub` or Docker.
- **Client:** the same npm package. `create`/`join` copy the package to `~/.openhuddle/app`
  so hooks and the MCP server start fast with an absolute `node` path.
- **Per-project local state:** `.openhuddle/config.json` (hub, team, member, token) and
  `.openhuddle/state.json` (feed cursors), excluded via `.git/info/exclude`.
- **Wiring:** Claude Code → `claude mcp add --scope local` + hooks in
  `.claude/settings.local.json`; Codex → `[mcp_servers.openhuddle]` in `~/.codex/config.toml`;
  Cursor → `.cursor/mcp.json`; every repo → `post-commit` git hook. All merges are
  idempotent and never remove foreign entries.
- **Agent tools (MCP):** `team_sync`, `team_post`, `team_ask`, `team_reply`, `master_prompt`,
  `plan`, `task`, `claim`, `team_settings`.

## Decisions made by Claude (owner delegated all decisions)

- Name **OpenHuddle** (npm + GitHub free); tagline "multiplayer mode for AI coding agents".
- Plain JavaScript ESM, zero runtime dependencies, Node ≥ 20 for the client, Node ≥ 22.13
  for the hub (`node:sqlite`). Tests with `node --test`.
- Hand-rolled stdio MCP (JSON-RPC 2.0, newline-delimited) instead of the SDK: keeps
  `npx` instant.
- Defaults: `assign_mode: hybrid`, master prompt approval `all`, `claim_mode: ask`, claim
  TTL 30 min, lead = whoever creates the plan (any member can take over).
- Team data shown to agents is wrapped in a `<team-data>` frame marked as information, not
  instructions. Secrets matching common key formats are redacted on client and hub.
- Dashboard renders all teammate text with `textContent`; strict CSP; token in URL
  fragment, never in query strings.
- Open source, MIT, `github.com/nika110/openhuddle`.

## Open (owner)

- Where the hosted hub runs and how it is exposed publicly.
- npm publish needs the owner's npm login.
