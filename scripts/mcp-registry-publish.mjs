#!/usr/bin/env node
// Publishes ./server.json to the official MCP Registry without installing mcp-publisher: the
// same GitHub device flow (the registry's own OAuth app), token exchange and POST /v0/publish.
// Run it from the repo root after a release; it prints a code to enter at github.com/login/device.
import { readFileSync } from 'node:fs';

const REGISTRY = process.env.MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io';
const serverJson = JSON.parse(readFileSync('server.json', 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) });

const health = await fetch(`${REGISTRY}/v0/health`).then((r) => r.json());
const clientId = health.github_client_id;
if (!clientId) throw new Error('the registry did not report a github_client_id');

const dev = await post('https://github.com/login/device/code', { client_id: clientId, scope: 'read:org read:user' }).then((r) => r.json());
if (!dev.device_code) throw new Error(`device code failed: ${JSON.stringify(dev)}`);
log(`Open ${dev.verification_uri} and enter the code: ${dev.user_code}  (valid ${Math.round((dev.expires_in || 900) / 60)} min)`);

let interval = (dev.interval || 5) * 1000;
const deadline = Date.now() + Math.min(dev.expires_in || 900, 900) * 1000;
let githubToken = null;
while (Date.now() < deadline) {
  await sleep(interval);
  const r = await post('https://github.com/login/oauth/access_token', {
    client_id: clientId,
    device_code: dev.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }).then((r) => r.json());
  if (r.access_token) {
    githubToken = r.access_token;
    break;
  }
  if (r.error === 'slow_down') interval += 5000;
  else if (r.error !== 'authorization_pending') throw new Error(`GitHub: ${r.error} ${r.error_description || ''}`);
}
if (!githubToken) throw new Error('the code expired before it was entered; run this again');
log('GitHub confirmed');

const ex = await post(`${REGISTRY}/v0/auth/github-at`, { github_token: githubToken });
if (!ex.ok) throw new Error(`token exchange failed (${ex.status}): ${await ex.text()}`);
const { registry_token } = await ex.json();

const pub = await post(`${REGISTRY}/v0/publish`, serverJson, { authorization: `Bearer ${registry_token}` });
const body = await pub.text();
if (!pub.ok) {
  console.error(`publish failed (${pub.status}): ${body}`);
  process.exit(1);
}
log(`published ${serverJson.name}@${serverJson.version}`);
