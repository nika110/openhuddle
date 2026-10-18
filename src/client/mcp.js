// Stdio MCP server: newline-delimited JSON-RPC 2.0. stdout carries protocol messages only.
import { createInterface } from 'node:readline';
import { VERSION } from '../shared/protocol.js';
import { TOOLS, INSTRUCTIONS, callTool, makeContext, resolveProject } from './tools.js';
import { gitInfo } from './git.js';

export const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const FALLBACK_VERSION = '2025-06-18';

export async function runMcp({ input = process.stdin, output = process.stdout, project = null, dir = null, heartbeatMs = 60_000, log = defaultLog } = {}) {
  const ctx = makeContext(project, { dir });
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');

  // Heartbeats keep this member "online"; a team created mid-session is picked up on the next beat.
  let timer = null;
  if (heartbeatMs > 0) {
    const beat = () => {
      resolveProject(ctx);
      if (ctx.api) ctx.api.post('/api/heartbeat', { status: gitInfo(ctx.project.root) }).catch(() => {});
    };
    beat();
    timer = setInterval(beat, heartbeatMs);
    timer.unref?.();
  }

  const pending = new Set();
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      const p = handle(ctx, m, log)
        .then((res) => {
          if (res) send(res);
        })
        .catch((e) => log(`openhuddle mcp: ${e?.stack || e}`));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  }
  await Promise.allSettled([...pending]);
  if (timer) clearInterval(timer);
}

async function handle(ctx, m, log) {
  if (!m || typeof m !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const isRequest = m.id !== undefined && m.id !== null;
  if (!isRequest) return null; // notifications (initialized, cancelled, ...) need no answer
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(-32600, 'Invalid request');

  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : FALLBACK_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'openhuddle', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      const args = m.params?.arguments ?? {};
      try {
        const text = await callTool(ctx, name, args);
        return reply({ content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e?.message || String(e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${m.method}`);
  }
}

function defaultLog(msg) {
  try {
    process.stderr.write(msg + '\n');
  } catch {}
}
