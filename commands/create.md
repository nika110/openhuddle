---
description: Start an OpenHuddle team for this project and get an invite link for your friends
argument-hint: '[--name "Team name"] [--as yourname]'
---

Start an OpenHuddle team for this project. Run this with the Bash tool from the project's root
folder (it must be a git repository; if it is not, tell the user to run `git init` and make a
first commit, and stop):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/openhuddle.js" create $ARGUMENTS
```

Then tell the user, briefly and in plain words:

- The invite link from the output. They send it to their friends, who run
  `/openhuddle:join <link>` in Claude Code, or `npx openhuddle join <link>` for Codex or Cursor.
- Their personal dashboard link from the output, and that it is private (it logs them in).
- The team tools are active in this session already. A good first step together is
  "let's write the master prompt".

If the command fails, show the error message and suggest `npx openhuddle doctor`.
