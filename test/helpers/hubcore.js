import { openDb } from '../../src/hub/db.js';
import { Hub } from '../../src/hub/hub.js';

// An in-memory hub with a controllable clock, plus helpers to add members.
export function makeHub() {
  let t = Date.UTC(2026, 9, 18, 12, 0, 0);
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  const hub = new Hub(openDb(':memory:'), { publicUrl: 'https://hub.test', now: clock.now });
  return { hub, clock };
}

export function crew(hub, names = ['ana', 'ben', 'cy']) {
  const created = hub.createTeam({ team_name: 'Pizza', member_name: names[0], tool: 'claude-code' });
  const code = created.invite_url.split('/join/')[1];
  const tokens = [created.token];
  for (const name of names.slice(1)) tokens.push(hub.join({ code, member_name: name, tool: 'codex' }).token);
  const members = tokens.map((tok) => hub.auth(tok));
  return { created, code, tokens, members, auth: (i) => hub.auth(tokens[i]) };
}
