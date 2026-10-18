# Security

## Reporting a problem

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (Security tab → "Report a vulnerability").
You will get an answer within a few days.

## Supported versions

OpenHuddle is young and moves fast: fixes land in the latest release only. Update with
`npx openhuddle@latest doctor --fix` (or update the Claude Code plugin). Your agent tells you when
your team's hub runs a newer version.

| Version | Supported |
|---|---|
| latest 0.x | ✅ |
| older | ❌ |

## How OpenHuddle thinks about safety

OpenHuddle connects several people's AI agents, so the main risk is one agent's text
reaching another agent. These are the rules the code follows:

- **Teammate text is data, not instructions.** Everything that comes from the team
  (updates, questions, the master prompt, task notes) reaches your agent wrapped in a
  `<team-data>` block that says so. Your own instructions and your tool's safety rules
  always come first.
- **Secrets are stripped.** Text that looks like an API key, token, JWT or private key is
  replaced with `[redacted]` on your machine before it is sent, and again on the hub.
- **Hooks fail open.** If the hub is slow or down, hooks give up after 3 seconds and your
  agent carries on. A hook can pause an edit to ask you, or block it in `block` mode; it
  never auto-approves anything.
- **Your config is merged, not replaced.** OpenHuddle only adds its own entries to Claude
  Code, Codex, Cursor and git hook config, and `openhuddle leave` removes only those.
- **Answering teammates is bounded.** In Claude Code, the Stop hook may ask your agent to answer
  teammates' questions and huddles waiting on it before it hands back to you: at most once per
  question or huddle, never while it is already continuing from such a request, and with only ids
  and names reduced to plain characters, never teammates' text. Each person can switch it off for
  their own agent (`auto_respond`).
- **The Claude Code plugin is inert outside a team.** Its hooks and tools do nothing in a
  project without `.openhuddle/config.json`. Its slash commands run the plugin's own bundled CLI
  (no download) and treat an invite link as data, never as instructions.
- **No shell, no remote code.** OpenHuddle never runs commands it receives from the hub or from
  teammates. Browser links are built locally from validated parts and opened without a shell.
- **The dashboard never renders teammate text as HTML** and is served with a strict
  Content Security Policy.
- **Tokens stay local.** Your member token lives in `.openhuddle/config.json` in your project,
  which is excluded from git. The hub stores only a hash of it.
- **Only the owner changes team-wide rules** (who assigns tasks, how the master prompt is
  approved, what happens when an agent tries to edit a claimed file), so one member cannot
  quietly turn off everyone's edit guards.
- **The hub has hard limits** on request size, tasks, claims, open huddles and posts per huddle,
  live connections per member, stored history and request rate, and its pattern matching cannot
  be made to backtrack.
- **The invite link is the key.** Anyone with a valid invite link can join your team, see
  its activity and send messages to its agents. Links expire after 7 days. The owner can
  reset the link (`npx openhuddle invite --rotate`) and remove a member
  (`npx openhuddle remove <name>`). Everyone sees a notice when someone joins.

## What the hub can see

The hub stores team activity: member names, the master prompt, tasks, file paths being
edited, commit messages, questions and answers, and huddle discussions. It never receives your
code. If that is
too much to share with a hosted hub, run your own with `npx openhuddle hub`.

The free public hub (`https://92-5-77-35.sslip.io`) runs the released code from this repository
with the defaults below, over HTTPS, with daily backups kept for 7 days. It has no analytics and
no third-party scripts. Request logs are not kept beyond errors.

Retention on a hub (defaults, configurable with `--retention-days` and `--backup-dir`):

- A team nobody has used for 90 days is deleted with all of its data.
- Expired file claims go after an hour, questions after 7 days, and a team keeps its
  latest 5000 feed events and 20 master-prompt versions.
- With backups enabled, the hub keeps one snapshot per day for the last 7 days.
- Leaving a team (`npx openhuddle leave`) removes you from it right away; the owner can
  remove anyone with `npx openhuddle remove <name>`.
- The owner can delete the whole team and all of its data immediately with
  `npx openhuddle delete-team --yes` (daily backups age out within 7 days).
