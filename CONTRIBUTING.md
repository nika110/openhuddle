# Contributing

Thanks for helping. A few things keep vibecrew easy to install and easy to trust:

- **No dependencies.** The package has none, so `npx vibecrew` starts instantly. Please
  keep it that way; Node's standard library covers what we need.
- **Plain JavaScript (ESM).** No build step. The client runs on Node 20+, the hub on
  Node 22.5+ (it uses `node:sqlite`).
- **Tests first.** `npm test` runs everything with `node --test`. New behavior comes
  with a test; bugs come with a failing test first.
- **Never touch real user config in tests.** Tests point `HOME`, `USERPROFILE` and
  `VIBECREW_HOME` at temp folders and never call the real `claude` CLI.

## Layout

```
bin/vibecrew.js       CLI entry
src/shared/           code used by both sides (ids, globs, paths, secret scrubbing)
src/hub/              the hub: SQLite domain logic, HTTP + SSE server, web pages
src/client/           CLI commands, MCP server, Claude Code hooks, tool wiring
test/                 node:test suites
```

## Running a hub locally

```
node bin/vibecrew.js hub --port 8787
VIBECREW_HUB=http://localhost:8787 node bin/vibecrew.js create
```
