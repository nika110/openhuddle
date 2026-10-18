import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/hub/pages/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const htmlPages = readdirSync(dir).filter((f) => f.endsWith('.html'));

// Mirrors what the hub must do before serving a page.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

test('pages: dashboard.js never assigns innerHTML from data', () => {
  const src = read('dashboard.js');
  for (const m of src.matchAll(/\.(innerHTML|outerHTML)\s*(\+?=)\s*([^;\n]*)/g)) {
    assert.equal(m[2], '=', `appending to ${m[1]} is not allowed`);
    assert.match(m[3].trim(), /^(''|"")$/, `${m[1]} may only be cleared, found: ${m[0]}`);
  }
  assert.ok(!/insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(src), 'no html/code injection sinks');
  assert.ok(!/createContextualFragment|DOMParser/.test(src), 'no html parsing of data');
});

test('pages: join page escapes invite url', () => {
  const raw = read('join.html');
  assert.equal(raw.split('{{INVITE_URL}}').length - 1, 1, 'placeholder appears exactly once');
  const hostile = 'https://hub.example/join/t1.x"><script>alert(1)</script>';
  const served = raw.replace('{{INVITE_URL}}', escapeHtml(hostile));
  assert.ok(!served.includes('<script>alert(1)</script>'));
  assert.ok(served.includes('npx vibecrew join https://hub.example/join/t1.x&quot;&gt;&lt;script&gt;'));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(served), 'no inline script');
  assert.ok(!/<style/i.test(served), 'no inline style block');
});

test('pages: landing has quickstart commands', () => {
  const html = read('landing.html');
  assert.ok(html.includes('npx vibecrew create'));
  assert.ok(html.includes('npx vibecrew join'));
  assert.ok(html.includes('npx vibecrew hub'));
  assert.ok(html.includes('https://github.com/nika110/vibecrew'));
  assert.equal(html.split('{{HUB_URL}}').length - 1, 1, 'hub url placeholder appears once');
});

test('pages: every page is CSP-clean (no inline script, style blocks or style attributes)', () => {
  assert.ok(htmlPages.length >= 3);
  for (const name of htmlPages) {
    const html = read(name);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${name}: inline <script>`);
    assert.ok(!/<style/i.test(html), `${name}: <style> block`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${name}: style= attribute`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${name}: inline event handler`);
    assert.ok(!/(src|href)\s*=\s*["']https?:\/\/(?!github\.com\/nika110\/vibecrew)/i.test(html), `${name}: external asset`);
    assert.match(html, /<link rel="icon" href="\/static\/favicon\.svg"/, `${name}: favicon`);
  }
});

test('pages: dashboard loads only its own static assets', () => {
  const html = read('dashboard.html');
  assert.ok(html.includes('<script src="/static/dashboard.js"'));
  assert.ok(html.includes('href="/static/dashboard.css"'));
  assert.ok(!html.includes('{{'), 'dashboard is served unchanged, no placeholders');
});
