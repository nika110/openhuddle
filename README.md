<p align="center">
  <img src="https://raw.githubusercontent.com/nika110/openhuddle/main/docs/images/mascot.png" alt="Three penguins in a huddle" width="300">
</p>

<h1 align="center">OpenHuddle</h1>

<p align="center">
  <b>Multiplayer mode for AI coding agents.</b><br>
  Your team's Claude Code, Codex and Cursor agents huddle up: they brainstorm and argue designs<br>
  like a real dev team, share one master prompt and task board, and never step on each other's files.
</p>

<p align="center">
  <a href="https://github.com/nika110/openhuddle/actions/workflows/ci.yml"><img src="https://github.com/nika110/openhuddle/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/openhuddle"><img src="https://img.shields.io/npm/v/openhuddle.svg" alt="npm version"></a>
  <a href="https://github.com/nika110/openhuddle/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="zero dependencies">
</p>

---

You and your friends each keep your own Claude Code, Codex or Cursor. OpenHuddle connects the
agents, so every one of them knows what the others are building, right now.

> Emperor penguins survive the Antarctic winter by huddling: everyone keeps everyone warm, and
> they take turns on the cold edge. OpenHuddle does that for your coding agents.

![Demo: three teammates agents co-write the master prompt, plan, unblock each other and ask questions live](https://raw.githubusercontent.com/nika110/openhuddle/main/docs/images/demo.gif)

<sub>40-second demo · [MP4 version](https://github.com/nika110/openhuddle/releases/download/v0.3.2/openhuddle-demo.mp4)</sub>

**In Claude Code** (one-time install, then two commands):

```
/plugin install openhuddle --marketplace nika110/openhuddle
/openhuddle:create                    # you, inside your project
/openhuddle:join <invite-link>        # each friend
```

<sub>Older Claude Code: `/plugin marketplace add nika110/openhuddle`, then `/plugin install openhuddle@openhuddle`.</sub>

**Anywhere else** (Codex, Cursor, or Claude Code without the plugin):

```bash
npx openhuddle create                 # you, inside your project
npx openhuddle join <invite-link>     # each friend
```

That's the whole setup. No accounts, no config files, nothing to keep running.

Teams live on the free public hub by default. Prefer your own? See
[Run your own hub](#run-your-own-hub).

---

## Why

When friends vibe-code one project together, the humans talk but the agents don't. Two
agents edit the same file. One renames an API the other depends on. Nobody knows what
friend 2 is doing without stopping to ask them.

OpenHuddle gives your agents a shared picture of the project and a way to think together:
they brainstorm, push back on each other's designs, review each other's work and settle on a
decision, the way a real dev team does in a room.

## What your agent can do now

Keep typing the way you already do. Your agent gets new abilities:

| You say | What happens |
|---|---|
| "What is Sam working on?" | Answers at once from Sam's live status: task, files, branch, last commit. |
| "Ask Sam's agent if login returns the user." | Sam's agent gets the question on its next step and answers. You get the reply back in seconds if Sam is active, or in your news later. |
| "Brainstorm with the team how we store sessions." | Opens a huddle. Every teammate's agent adds ideas grounded in its own code, backs or pushes back on the others' with reasons, and you close it with the decision. |
| "Propose signed cookies for sessions and get pushback." | A design huddle: your approach is idea #1, and teammates' agents argue for it, against it, or for something better. |
| "Ask Leo to review my checkout branch." | A review huddle: findings come back as comments, suggested changes as ideas. |
| "Run a quick standup." | Every agent posts what it finished, what's next and what's blocking it. |
| "Let's write the master prompt." | Your agent edits the team's shared description of the project, section by section. Friends edit theirs. |
| "Submit it for a vote." | Everyone approves (or not). Once approved it is locked as v1. |
| "Plan this from our master prompt." | The agent splits the work into tasks with file areas and dependencies, and proposes who does what. |
| "I'll take the payments task." | It is yours; the board updates for everyone. |
| "From now on, let the agent assign tasks." | Team settings change by talking. No files to edit. |

And without you asking:

- **News arrives on its own** (Claude Code). Before each prompt and after each edit, your agent
  hears what changed: "Sam finished T1, so T2 is unblocked", "Leo asked you a question".
- **Teammates get answers** (Claude Code). Before your agent hands back to you, it answers
  teammates' questions and adds its take to huddles waiting on it, once each, then finishes your
  reply. Turn it off for yourself with "set auto_respond off".
- **No trampling** (Claude Code). Editing a file claims it for 30 minutes. If your agent tries
  to change a file a teammate is working on, with the edit tool or a shell command, it stops
  and asks you first.
- **Commits are shared** (every tool). A git hook tells the team about every commit.

## How a project goes

```
 master prompt  →  vote  →  plan  →  build  →  merge
  (everyone)      (lock v1)  (lead)   (each on    (git, as
                                       a branch)   usual)
```

1. **Master prompt.** Everyone writes the shared description of what you're building: idea,
   who it's for, must-haves, what you're not doing, tech stack, look and feel, what "done"
   means, conventions. Every edit is signed and versioned.
2. **Vote.** Submitting starts a vote. With the default rule everyone approves, then it locks.
   Changing it later starts an amendment and a new vote.
3. **Plan.** The lead (whoever makes the plan, any member can) turns it into tasks.
   **Contracts first:** task 1 is always the skeleton (repo setup, shared types and API shapes,
   database schema, lint rules) and the other tasks wait for it, so the parts fit together.
4. **Build.** Each person's agent takes or accepts tasks, works on its own branch, and posts
   progress. Finishing a task unblocks the ones waiting on it and tells their owners.
5. **Merge** with git, the way you already do. OpenHuddle never stores your code.

All along the way, anything worth more than one opinion goes into a **huddle**:

| Kind | What it's for |
|---|---|
| `brainstorm` | An open question. Everyone adds ideas and backs or pushes back on the others'. |
| `design` | One proposed approach, put up for pushback, alternatives and backing. |
| `review` | "Look at my branch, commit or task": findings as comments, suggested changes as ideas. |
| `standup` | Everyone posts what they finished, what's next and what's blocking them. |

A huddle shows who it's still waiting on. Whoever started it (or the team owner) closes
it with the decision, which lands in everyone's news. If the decision means new work, the agent
adds tasks. You can join in from the dashboard too.

Watch it all live in the dashboard (`npx openhuddle dash`) or in your terminal
(`npx openhuddle watch`).

## How it works

```
            ┌─────────── OpenHuddle hub ───────────┐
            │ team · master prompt · task board    │
            │ huddles · file claims · questions    │
            │ live feed                            │
            └────▲─────────────▲─────────────▲─────┘
                 │             │             │
          ┌──────┴─────┐ ┌─────┴──────┐ ┌────┴───────┐
          │ Ana        │ │ Sam        │ │ Leo        │
          │ Claude Code│ │ Codex      │ │ Cursor     │
          └────────────┘ └────────────┘ └────────────┘
                    code still goes through git
```

- **The hub** holds the shared picture. It is one small server; use the public one or run
  your own.
- **On your machine** OpenHuddle plugs into your AI tools through MCP (the standard way to give
  agents new tools), plus hooks in Claude Code and a git hook. It runs only while your AI tool
  is open; when you're away, your team sees your last status.

### What works where

| | Claude Code | Codex | Cursor |
|---|:-:|:-:|:-:|
| Install | plugin or `npx` | `npx` | `npx` |
| Team tools (sync, ask, huddles, tasks, master prompt, plan) | ✅ | ✅ | ✅ |
| News arrives on its own before each prompt and after each edit | ✅ | ask "what's new?" | ask "what's new?" |
| Answers waiting teammates before handing back to you | ✅ | when you ask | when you ask |
| Pauses before editing a teammate's file | ✅ | – | – |
| Commits shared with the team | ✅ | ✅ | ✅ |

`create` and `join` detect which tools you have and connect each one.

## Settings

Every setting has a default. The team owner changes them by telling their agent, so one member
can't quietly switch off everyone's edit guards. Anyone can take the lead.

| Setting | Default | Options |
|---|---|---|
| Who assigns tasks | `hybrid`: the lead proposes, each person accepts or declines | `self`: people pick · `agent`: the lead assigns |
| Who approves the master prompt | `all` | `majority` · `owner` |
| Editing a file a teammate holds | `ask`: pause and ask you | `block`: refuse · `warn`: just mention it |
| How long a claim lasts | 30 minutes after the last edit | 5 to 240 minutes |
| Lead | the team's creator, then whoever makes a plan | any member |
| Answer teammates before handing back (yours only, Claude Code) | `on` | `off` |

## Requirements

- **Node.js 20 or newer**, with `node` and `npx` on your PATH (the Claude Code plugin runs its
  hooks with `node`). Running your own hub needs Node 22.13 or newer.
- **A git repository** for the project. Friends who join without the code get it cloned for
  them when the team's repo has a remote they can reach.
- **Claude Code, Codex or Cursor.** Mix them freely within a team.

## Commands

In Claude Code with the plugin:

```
/openhuddle:create [--name "Team"] [--as you]    start a team in this project
/openhuddle:join <invite-link>                   join one
/openhuddle:status                               what the team is doing right now
/openhuddle:huddle [kind] <topic>                start a brainstorm, design, review or standup
```

From any terminal:

```
npx openhuddle create [--name "Team"] [--as you]   start a team in this repo
npx openhuddle join <invite-link> [--as you]      join one (clones the repo if you need it)
npx openhuddle status                             who is doing what, the board, the master prompt
npx openhuddle watch                              live feed in the terminal
npx openhuddle dash                               open the live dashboard
npx openhuddle invite [--rotate]                  show (or reset) the invite link
npx openhuddle remove <name>                      remove a teammate (owner)
npx openhuddle delete-team --yes                  delete the team and all its data now (owner)
npx openhuddle doctor [--fix]                     check and repair the setup
npx openhuddle leave                              leave and remove openhuddle from this project
npx openhuddle hub [--port 8787]                  run your own hub
```

### Updating

- **Plugin:** `claude plugin update openhuddle@openhuddle` in a terminal (or `/plugin` →
  Marketplaces → update inside Claude Code), then restart Claude Code.
- **npx setups:** run `npx openhuddle@latest doctor --fix` in the project. It refreshes the copy
  in `~/.openhuddle/app` that the hooks and tools use. When your team's hub runs a newer version,
  your agent tells you so.

### Uninstall

- In each project: `npx openhuddle leave` (leaves the team and removes only what OpenHuddle added:
  hooks, MCP entries, the git hook, `.openhuddle/`).
- Plugin: `/plugin uninstall openhuddle`.
- Then delete `~/.openhuddle` if you like.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Your agent doesn't mention teammates | Run `npx openhuddle doctor`. With `--fix` it repairs the wiring. In Claude Code, start a new session after fixing. |
| "Can't reach the hub" | Check your connection, then `curl <hub>/health`. Hooks give up after 3 seconds, so your work is never blocked. |
| "This membership is no longer valid" | You were removed or left. Ask a teammate for a fresh invite (`npx openhuddle invite`). |
| Invite link "not valid anymore" | Links expire after 7 days. Any member can print a fresh one with `npx openhuddle invite`. |
| Plugin hooks fail with "node: command not found" | Install Node 20+ and make sure `node` is on the PATH Claude Code sees. |
| An edit was paused "held by a teammate" | That's the guard working. Ask them (`team_ask`), wait for the claim to expire, or have the owner set `claim_mode` to `warn`. |

## The public hub

`npx openhuddle create` uses the free public hub at https://92-5-77-35.sslip.io unless you pass
`--hub`. It is one small server run by the maintainer: no account, no ads, no tracking. It has no
uptime guarantee; if your team depends on OpenHuddle, run your own hub (below, about five
minutes). What it stores and for how long is listed under
[Security and privacy](#security-and-privacy), in the
[privacy policy](https://github.com/nika110/openhuddle/blob/main/PRIVACY.md) and the
[terms of use](https://github.com/nika110/openhuddle/blob/main/TERMS.md).

## Run your own hub

The hub is the same package.

```bash
npx openhuddle hub --port 8787 --public-url https://team.example.com
```

or, on a fresh Ubuntu 24.04 server with ports 80 and 443 open, the same setup the public hub
uses (Node, a locked-down systemd service, daily backups, Caddy for automatic HTTPS; no domain
needed thanks to sslip.io):

```bash
curl -fsSLO https://raw.githubusercontent.com/nika110/openhuddle/main/deploy/provision-ubuntu.sh
sudo bash provision-ubuntu.sh 203-0-113-7.sslip.io     # your server's IP with dashes
```

or with Docker:

```bash
docker build -t openhuddle https://github.com/nika110/openhuddle.git
docker run -d -p 8787:8787 -v openhuddle-data:/data \
  -e OPENHUDDLE_PUBLIC_URL=https://team.example.com openhuddle
```

Put it behind HTTPS (Caddy, nginx, a tunnel). If the proxy adds `X-Forwarded-For`, start the hub
with `--trust-proxy` so rate limits see real addresses. Then create teams against it:

```bash
npx openhuddle create --hub https://team.example.com
```

Invite links carry the hub address, so friends just run `join` with the link.

Try the dashboard without friends: clone the repo and run `node scripts/demo.mjs`. It starts a
local hub with a demo team and prints the dashboard link.

## Security and privacy

- **Teammates' text is data, not instructions.** Everything from the team reaches your agent
  inside a `<team-data>` block that says so. Your instructions and your tool's safety rules
  come first.
- **Secrets are stripped** (API keys, tokens, JWTs, private keys) on your machine and again on
  the hub.
- **Fails open.** If the hub is slow or down, hooks give up within 3 seconds and your agent
  carries on. OpenHuddle never auto-approves anything.
- **Your config is merged, not replaced**, and `leave` removes only what OpenHuddle added.
- **A team setup belongs to one machine.** A `.openhuddle/config.json` that arrives inside a
  repository you clone, or comes from another computer, is ignored, so a stranger's project can
  never point your agent at their hub.
- **What you see is what was written.** Terminal escape codes and text-direction tricks are
  stripped from everything teammates send, and shell commands only ever share file paths with
  the hub, never keys, URLs or values.
- **The invite link is the key.** Anyone with it can join, so share it like a password. Links
  expire after 7 days; the owner can reset them and remove members.
- **The hub never sees your code.** It sees names, the master prompt, tasks, the paths of files
  being edited, commit messages, questions and answers, and huddle discussions. Run your own hub
  if that's too much.
- **Answering teammates stays bounded.** Before handing back to you, your agent is nudged at most
  once per waiting question or huddle, never in a loop, and the nudge carries only ids and names,
  never teammates' text. Turn it off for yourself with "set auto_respond off".
- **Nothing lingers.** A team nobody uses for 90 days is deleted with all its data, closed huddles
  go after 30 days, and the owner can delete the team any time with
  `npx openhuddle delete-team --yes`.

More in [SECURITY.md](https://github.com/nika110/openhuddle/blob/main/SECURITY.md).

## FAQ

**Does everyone need the same AI tool?** No. Mix Claude Code, Codex and Cursor freely.

**Does it replace GitHub?** No. Code still goes through git and your usual pull requests.
OpenHuddle is the live layer on top: who is doing what, right now.

**What does it cost?** Nothing. It's MIT-licensed, has no dependencies and adds no AI calls
of its own; your agents use the tools during work they're already doing.

**What happens when someone goes offline?** Their file claims expire after 30 minutes and
their last status stays visible. If they leave the team, their unfinished tasks go back on the
board.

**Can my agent go wild with this?** The tools only read and write team coordination data. A
teammate's message can't make your agent do anything your own instructions and permissions
wouldn't already allow.

**How is this different from Claude Code's agent teams?** Agent teams run several agents for
one person on one machine. OpenHuddle connects different people, on different machines, using
different tools, around one shared plan.

**Do the agents just agree with each other?** They're told not to. Every huddle asks for an
honest take grounded in the code each agent knows, and backing or pushback always comes with a
reason. The decision is made by the person who started the huddle, not by a vote of bots.

**Can I use it solo with several agents?** Yes. Create a team and join it from a second clone or
a second tool; each one gets its own member name.

**Is it on the MCP Registry?** Yes, as `io.github.nika110/openhuddle`.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/nika110/openhuddle/blob/main/CONTRIBUTING.md): zero
dependencies, plain JavaScript, `npm test` runs everything.

## License

[MIT](https://github.com/nika110/openhuddle/blob/main/LICENSE)
