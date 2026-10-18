# Contributing

Thanks for helping. A few things keep OpenHuddle easy to install and easy to trust:

- **No dependencies.** The package has none, so `npx openhuddle` starts instantly. Please
  keep it that way; Node's standard library covers what we need.
- **Plain JavaScript (ESM).** No build step. The client runs on Node 20+, the hub on
  Node 22.13+ (it uses `node:sqlite`).
- **Tests first.** `npm test` runs everything with `node --test`. New behavior comes
  with a test; bugs come with a failing test first.
- **Never touch real user config in tests.** Tests point `HOME`, `USERPROFILE` and
  `OPENHUDDLE_HOME` at temp folders, set `OPENHUDDLE_NO_CLAUDE_CLI=1`, and never call the real
  `claude` CLI.
- **Teammate text is untrusted.** Anything another member wrote must reach an agent through
  `frame()` and the dashboard through `textContent`. Reviews check this first.

## Layout

```
bin/openhuddle.js        CLI entry
src/shared/              code used by both sides (ids, globs, paths, secret scrubbing, protocol)
src/hub/                 the hub: SQLite domain logic, HTTP + SSE server, web pages
src/client/              CLI commands, MCP server, Claude Code hooks, tool wiring
.claude-plugin/          Claude Code plugin manifest (hooks + MCP) and marketplace listing
commands/                the plugin's slash commands (/openhuddle:create, :join, :status)
server.json              MCP Registry listing
deploy/                  Ubuntu provisioning script, Docker Compose + Caddy
scripts/demo.mjs         local hub with a demo team, for trying the dashboard
test/                    node:test suites
docs/                    images and the original design notes
```

## Running things locally

```bash
npm test                                          # everything
node --test test/hub-http.test.js                 # one suite
node scripts/demo.mjs                             # demo hub + dashboard link
node bin/openhuddle.js hub --port 8787            # a hub
node bin/openhuddle.js create --hub http://localhost:8787
```

### Trying the plugin from your checkout

```bash
claude plugin validate .
claude plugin marketplace add /path/to/openhuddle
claude plugin install openhuddle@openhuddle
# ...try it in a test project, then:
claude plugin uninstall openhuddle@openhuddle
claude plugin marketplace remove openhuddle
```

## Releasing (maintainers)

1. Bump the version in `package.json`, `.claude-plugin/plugin.json` and `server.json` (both
   `version` fields); `test/plugin.test.js` fails if they disagree. Add a `CHANGELOG.md` entry.
2. `npm test`, then commit, tag `vX.Y.Z` and push.
3. Create the GitHub release from the tag. The `publish` workflow runs the tests and publishes
   to npm with provenance through npm trusted publishing (no token, no 2FA prompt). A version
   already published by hand is skipped.
4. Upgrade the public hub: `sudo env PATH=/opt/node/bin:$PATH npm i -g openhuddle@X.Y.Z` and
   `sudo systemctl restart openhuddle-hub`.
5. `mcp-publisher publish` from the repo root to update the MCP Registry listing.

Schema changes to the hub database go into `MIGRATIONS` in `src/hub/db.js` as a new entry;
never edit an existing one.
