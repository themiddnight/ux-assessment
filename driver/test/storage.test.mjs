// Returning-user start state (SPEC D9): a setup session logs in once and saves its state; persona
// sessions start from it. Restoring is setup, never a step.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session.mjs';
import { startFixtureServer } from './fixture-server.mjs';

let fx;
before(async () => { fx = await startFixtureServer(); });
after(async () => { await fx.close(); });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-state-'));
const IDB_PUT = `new Promise((ok, fail) => { const r = indexedDB.open('app', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put('token-1', 'auth'); tx.oncomplete = () => { r.result.close(); ok(true); }; tx.onerror = fail; };
  r.onerror = fail; })`;
const IDB_GET = `new Promise((ok) => { const r = indexedDB.open('app', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('auth'); g.onsuccess = () => { r.result.close(); ok(g.result ?? null); }; };
  r.onerror = () => ok(null); })`;

test('saved state (cookie, localStorage, IndexedDB) starts the next session logged in', async () => {
  const statePath = path.join(tmp(), 'state', 'ana.json');
  const setupDir = tmp();
  fs.chmodSync(setupDir, 0o755); // simulate a project-created run directory
  const a = await Session.start({ id: 'setup', dir: setupDir, url: fx.url('basic.html') });
  try {
    // owner-only modes are no-ops on Windows (spec component 5, D28)
    if (process.platform !== 'win32') assert.equal(fs.statSync(setupDir).mode & 0o777, 0o700, 'session directory protects screenshots and login logs');
    await a.evalHarness("document.cookie = 'sid=abc123; path=/; max-age=3600'; localStorage.setItem('user', 'ana')");
    await a.evalHarness(IDB_PUT);
    const saved = await a.saveState(statePath);
    assert.deepEqual(saved, { path: statePath, cookies: 1, origins: 1 });
    assert.ok(fs.existsSync(statePath));
    if (process.platform !== 'win32') assert.equal(fs.statSync(statePath).mode & 0o777, 0o600, 'saved login state is private to the current user');
  } finally { await a.stop(); }
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(setupDir, 'signals.jsonl')).mode & 0o777, 0o600, 'signal log is private');

  const seen = fx.requests.length;
  const dir = tmp();
  const b = await Session.start({ id: 'returning', dir, url: fx.url('basic.html?home'), storageState: statePath });
  try {
    assert.equal(b.steps, 0);
    assert.match(await b.evalHarness('document.cookie'), /sid=abc123/);
    assert.equal(await b.evalHarness("localStorage.getItem('user')"), 'ana');
    assert.equal(await b.evalHarness(IDB_GET), 'token-1');
    const entry = fx.requests.slice(seen).find((q) => q.path === '/basic.html?home');
    assert.match(entry.cookie ?? '', /sid=abc123/, 'the server sees the cookie on the entry request');
    const r = await b.act({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action: { type: 'look' } });
    assert.match(r.text, /Free first look/);
    assert.match(r.text, /Address bar: .*basic\.html\?home/);
    const sig = await b.signals();
    assert.ok(!sig.events.some((e) => e.type === 'new-page' || e.warning), JSON.stringify(sig.events));
    assert.equal(b.context.pages().length, 1);
  } finally { await b.stop(); }
});

test('a failed start closes Chromium and deletes the profile', async () => {
  const profileDir = path.join(tmp(), 'profile');
  await assert.rejects(Session.start({ id: 'bad', dir: tmp(), url: fx.url('basic.html'), profileDir, storageState: path.join(tmp(), 'missing.json') }), /ENOENT/);
  assert.equal(fs.existsSync(profileDir), false, 'profile deleted');
  const { execFileSync } = await import('node:child_process');
  let ps = '';
  try { ps = execFileSync('pgrep', ['-f', profileDir], { encoding: 'utf8' }); } catch { /* exit 1: no match */ }
  assert.equal(ps.trim(), '', 'no Chromium left running on that profile');
});
