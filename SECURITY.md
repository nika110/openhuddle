# Security

## Reporting a problem

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (Security tab → "Report a vulnerability").
You will get an answer within a few days.

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
- **The dashboard never renders teammate text as HTML** and is served with a strict
  Content Security Policy.
- **Tokens stay local.** Your member token lives in `.openhuddle/config.json` in your project,
  which is excluded from git. The hub stores only a hash of it.
- **Only the owner changes team-wide rules** (who assigns tasks, how the master prompt is
  approved, what happens when an agent tries to edit a claimed file), so one member cannot
  quietly turn off everyone's edit guards.
- **The hub has hard limits** on request size, tasks, claims, live connections per member,
  stored history and request rate, and its pattern matching cannot be made to backtrack.
- **The invite link is the key.** Anyone with a valid invite link can join your team, see
  its activity and send messages to its agents. Links expire after 7 days. The owner can
  reset the link (`npx openhuddle invite --rotate`) and remove a member
  (`npx openhuddle remove <name>`). Everyone sees a notice when someone joins.

## What the hub can see

The hub stores team activity: member names, the master prompt, tasks, file paths being
edited, commit messages, questions and answers. It never receives your code. If that is
too much to share with a hosted hub, run your own with `npx openhuddle hub`.
