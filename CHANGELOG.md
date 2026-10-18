# Changelog

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
