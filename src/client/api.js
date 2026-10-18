// Thin JSON client for the hub API. Every failure becomes an ApiError. Every string in a
// response is made plain text (no terminal escapes, no direction overrides) before anyone sees it.
import { plainJson } from '../shared/plain.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class Api {
  constructor(hub, token, { timeoutMs = 8000 } = {}) {
    this.hub = String(hub || '').replace(/\/+$/, '');
    this.token = token || null;
    this.timeoutMs = timeoutMs;
  }

  static anon(hub, opts) {
    return new Api(hub, null, opts);
  }

  headers(extra = {}) {
    const h = { accept: 'application/json', ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async request(method, path, body, { timeoutMs = this.timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetch(this.hub + path, {
          method,
          headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch {
        throw new ApiError(0, 'unreachable', `Cannot reach the openhuddle hub at ${this.hub}`);
      }
      let text;
      try {
        text = await res.text();
      } catch {
        throw new ApiError(0, 'unreachable', `The openhuddle hub at ${this.hub} stopped responding`);
      }
      let data = null;
      try {
        data = text ? plainJson(JSON.parse(text)) : {};
      } catch {
        data = null;
      }
      if (!res.ok) {
        const code = (data && data.code) || `http_${res.status}`;
        const msg = (data && data.error) || `Hub returned HTTP ${res.status}`;
        throw new ApiError(res.status, code, msg);
      }
      if (data === null) throw new ApiError(res.status, 'bad_response', 'Hub sent a response that is not JSON');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  get(path, opts) {
    return this.request('GET', path, undefined, opts);
  }

  post(path, body = {}, opts) {
    return this.request('POST', path, body, opts);
  }

  // Server-sent events from /api/stream. Calls onEvent(event) per message; resolves when the
  // stream ends, rejects with ApiError when it cannot connect.
  async stream(since, onEvent, { signal } = {}) {
    let res;
    try {
      res = await fetch(`${this.hub}/api/stream?since=${Number(since) || 0}`, {
        headers: this.headers({ accept: 'text/event-stream' }),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) return;
      throw new ApiError(0, 'unreachable', `Cannot reach the openhuddle hub at ${this.hub}`);
    }
    if (!res.ok || !res.body) {
      let data = null;
      try {
        data = plainJson(await res.json());
      } catch {}
      throw new ApiError(res.status, data?.code || `http_${res.status}`, data?.error || `Hub returned HTTP ${res.status}`);
    }
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
          const frameText = buf.slice(0, idx);
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
          const ev = parseSse(frameText);
          if (ev) onEvent(ev);
        }
      }
    } catch (e) {
      if (signal?.aborted) return;
      throw new ApiError(0, 'unreachable', 'Lost the connection to the openhuddle hub');
    }
  }
}

export function parseSse(frameText) {
  const data = [];
  for (const line of frameText.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  try {
    return plainJson(JSON.parse(data.join('\n')));
  } catch {
    return null;
  }
}
