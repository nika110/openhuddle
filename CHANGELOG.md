# Changelog

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
