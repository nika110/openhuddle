// Starts a throwaway hub and a two-person crew for client tests.
import { Api } from '../../src/client/api.js';
import { saveConfig, findProject } from '../../src/client/config.js';

export async function startTestHub() {
  const { startHub } = await import('../../src/hub/server.js');
  return startHub({ port: 0, host: '127.0.0.1' });
}

export function inviteCode(inviteUrl) {
  return decodeURIComponent(new URL(inviteUrl).pathname.split('/join/')[1]);
}

// Creates a team owned by `alice` and joins `bob`. Returns credentials for both.
export async function makeCrew(url, { team = 'pizza-app', a = 'alice', b = 'bob' } = {}) {
  const anon = Api.anon(url);
  const owner = await anon.post('/api/teams', { team_name: team, member_name: a, tool: 'claude-code' });
  const member = await anon.post('/api/join', { code: inviteCode(owner.invite_url), member_name: b, tool: 'codex' });
  return { owner, member };
}

// Writes .openhuddle/config.json into `repo` for these credentials and returns the project.
export function projectFor(repo, url, creds) {
  saveConfig(repo, {
    hub: url,
    team_id: creds.team_id,
    team_name: creds.team_name,
    member_id: creds.member_id,
    member_name: creds.member_name,
    token: creds.token,
  });
  return findProject(repo);
}

export function apiFor(url, creds) {
  return new Api(url, creds.token);
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
