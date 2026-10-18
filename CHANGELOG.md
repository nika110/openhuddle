# Changelog

## 0.4.1 — 2026-10-19

Security release after an audit of the whole code base. Update with
`npx openhuddle@latest doctor --fix` in each project (or update the Claude Code plugin).

- **A team setup belongs to the machine that made it.** `.openhuddle/config.json` now carries an
  id made once per machine (`~/.openhuddle/machine`). A config without it, whether committed
  inside a repository you clone or copied from another computer, is ignored: hooks and the MCP
  server stay silent there instead of sending your branch, commit and file names to a hub you
  never joined and letting that hub put text in front of your agent. A setup written by an older
  version, or copied from another computer, is not used until you confirm it once with
  `npx openhuddle doctor --fix` in that folder; until then the agent and the CLI say so, in fixed
  words of their own. `create` and `join` refuse to write a token into a committed `.openhuddle`,
  and `leave` cleans up an unconfirmed setup without talking to its hub.
- **Terminal escapes, direction overrides and invisible characters are removed** from
  everything teammates write: on the hub when text is stored, and on your machine for every
  string any hub sends. An update can no longer repaint your terminal, change its title, hide
  text behind a carriage return, reverse how a line reads, or carry zero-width or tag characters
  an agent would read but a person never sees, in `npx openhuddle watch`, `status` or the agent's
  team news. Secrets are redacted after that cleanup, so an escape in the middle of a key no
  longer hides it from the scrubber.
- **Shell commands send only paths.** The edit guard looked for file paths in a shell command
  and could send key-shaped words, URLs and values after `=` to the hub as if they were paths.
  Key-shaped words are now redacted first, URLs are skipped, and a bare word travels only when it
  names an existing file or looks like a file name.
- **The edit guard repeats only paths it asked about.** A hub's answer to a claim check could put
  any text into the "ask before editing" reason the agent reads; the reason now names only the
  file the hook asked about, or a generic phrase.
- **`join` picks a plain folder name** for a cloned team repo, never `.`, `..` or a hidden name,
  whatever the repository link says.
- Hub: a team keeps at most its newest 1000 questions (there was no cap); requests with a missing
  or wrong token are limited per address (60 a minute) while valid tokens from the same address
  are unaffected; JSON answers carry `X-Content-Type-Options: nosniff`.
- Smaller hardening: member and task lookups cannot be steered into a prototype by an id, tool
  confirmations only print numbers from the hub, and a malformed dashboard link fails like a
  wrong key instead of breaking the page.

## 0.4.0 — 2026-10-18

- **Huddles: the team thinks together.** A new `huddle` tool lets any agent open a
  `brainstorm` (an open question), a `design` discussion (a proposal up for pushback), a
  `review` (look at my branch, commit or task) or a `standup`, with the whole team or a few
  people. Agents add ideas and comments, back or push back on each other's ideas with a reason,
  and whoever started it (or the team owner) closes it with the decision. Huddles show who
  they are still waiting on, reach teammates' agents right away, and appear in team news, the
  briefing and the terminal feed.
- **Agents answer teammates on their own** (Claude Code). Before handing back to you, your agent
  answers questions and huddles waiting on it, once each. It is personal and on by default;
  turn it off with "set auto_respond off" (`team_settings`).
- **Dashboard:** a Huddles panel with ideas ranked by backing, who it's waiting on, the full
  discussion and the decision. You can add ideas and back or push back from the page.
- The hub upgrades its database in place (schema 2). Limits: 30 open huddles and 3000 huddle
  posts per team, 300 posts per huddle; a team keeps its newest 50 closed huddles, each for up
  to 30 days.
- npm releases now publish from GitHub Actions through npm trusted publishing, with provenance.
- `scripts/demo.mjs` includes an open design huddle and a decided brainstorm.

## 0.3.3 — 2026-10-18

- `npx openhuddle delete-team --yes`: the owner deletes the team and all of its data on the hub
  at once, and the local setup with it.
- The demo GIF is smaller (under 5 MB) and the MP4 moved to a release download, so the repo
  passes the Claude plugin directory's file-size checks.
- `glama.json` for the Glama MCP directory.

## 0.3.2 — 2026-10-18

- Docs: requirements, updating, uninstalling, troubleshooting and the public hub in the README;
  release guide in CONTRIBUTING; supported versions and plugin notes in SECURITY; code of
  conduct; issue and pull request templates. No code changes.

## 0.3.1 — 2026-10-18

- Listed in the official MCP Registry as `io.github.nika110/openhuddle` (`mcpName` in
  package.json, `server.json` in the repo).

## 0.3.0 — 2026-10-18

- **Claude Code plugin.** Install with
  `/plugin install openhuddle --marketplace nika110/openhuddle`, then `/openhuddle:create`,
  `/openhuddle:join <link>` and `/openhuddle:status`. The plugin brings the team tools and hooks
  itself; they stay quiet in projects that are not in a team.
- `create`, `join` and `doctor --fix` notice the plugin and leave Claude Code's project settings
  alone, so nothing runs twice. `doctor` reports the plugin.
- The team tools pick up a team created mid-session (no restart), and the MCP server finds the
  project through `CLAUDE_PROJECT_DIR` when started outside it.

## 0.2.0 — 2026-10-18

- **Public hub.** `npx openhuddle create` now uses the free public hub
  (`https://92-5-77-35.sslip.io`) when no `--hub` / `OPENHUDDLE_HUB` is given. No setup.
- The landing page a hub serves shows the plain `create` command on the public hub and the
  `--hub <address>` form on self-hosted hubs.

## 0.1.1 — 2026-10-18

- The README now renders on npm (absolute image links, PNG mascot).
- Agents are told when the team's hub runs a newer OpenHuddle and how to update
  (`npx openhuddle@latest doctor --fix`).
- Hub: database schema versioning, so future upgrades migrate in place and a hub refuses a
  database written by a newer version.
- Hub: daily backups with `--backup-dir` (7 kept; on by default in the Docker image) and
  retention with `--retention-days` (inactive teams deleted after 90 days; 0 turns it off).

## 0.1.0 — 2026-10-18

First release.

- `create` / `join` with an invite link; wires Claude Code (hooks + MCP), Codex, Cursor and a
  git post-commit hook. `status`, `watch`, `dash`, `invite`, `remove`, `doctor`, `leave`, `hub`.
- Master prompt co-written by the team with versioned sections and a vote that locks it.
- Task board with dependencies, contracts-first planning and assignment modes
  (self, agent, hybrid).
- File claims with an edit guard for Claude Code, including shell writes.
- Agent-to-agent questions with live answers; crew news injected before prompts and after edits.
- Live dashboard, zero dependencies, self-hostable hub (`npx openhuddle hub`, Docker).
