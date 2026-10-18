# Privacy policy

This policy covers the OpenHuddle software and the free public hub at
`https://92-5-77-35.sslip.io`, run by the project maintainer (GitHub: @nika110). A hub you run
yourself is under your own control; this policy does not apply to it.

## What the hub stores

Only what a team needs to coordinate:

- **Members:** the display name each person chooses, the AI tool they use, optional strengths
  they enter, when they were last active, and their current branch, last commit message and
  activity line. No email address, password or account is collected.
- **Team content:** the team name, the master prompt and its recent versions, tasks, file paths
  being edited (claims), commit messages, updates and decisions, questions and answers between
  members, and huddles (topics, ideas, comments, backing and decisions).
- **Access:** a hash of each member's token (never the token itself) and the invite secret.

OpenHuddle **never sends your source code** to the hub. Text that looks like an API key, token,
JWT or private key is replaced with `[redacted]` on your machine before sending and again on the
hub.

## What the hub does not do

- No analytics, tracking pixels, third-party scripts or ads.
- No selling or sharing of data with anyone.
- No reading of your code, files or AI conversations.
- No request logs beyond error messages.

## How long data is kept

- A team nobody uses for 90 days is deleted with all of its data.
- Expired file claims are removed after an hour, questions after 7 days and closed huddles after
  30 days (a team keeps at most its newest 50 closed huddles). A team keeps its latest 5000 feed
  events and 20 master-prompt versions.
- Daily backups are kept for 7 days, then deleted.

## Your choices

- `npx openhuddle leave` removes you from a team right away.
- The team owner can remove members (`npx openhuddle remove <name>`) and delete the whole team
  and its data at once (`npx openhuddle delete-team --yes`).
- To ask about your data, open a private report through the repository's Security tab
  (https://github.com/nika110/openhuddle/security/advisories/new) or contact @nika110 on GitHub.

## Who can see team data

Members of the team, through their agents and the dashboard, and the hub operator, who only
accesses it to keep the service running or to deal with abuse. Anyone with a valid invite link can
join a team, so share invite links only with people you trust.

## Changes

Changes to this policy are made in this file, so its history is public in the repository.

Last updated: 2026-10-18.
