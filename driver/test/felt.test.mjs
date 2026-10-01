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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-felt-'));
const step = (action) => ({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action });
const readLog = (dir) => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const GO = { type: 'click', x: 100, y: 50 };
const vibrations = (s) => s.events.filter((e) => e.type === 'vibrate').map(({ pattern, allowed }) => ({ pattern, allowed }));

test('touch device: a vibrate after a tap gives the status line once and a signal', async () => {
  const s = await Session.start({ id: 'vib-touch', dir: tmpDir(), url: fx.url('clock.html?vibrate=click'), viewport: 'mobile-small' });
  try {
    await s.act(step({ type: 'look' }));
    const r = await s.act(step(GO));
    assert.match(r.text, /^The phone vibrated\.$/m);
    assert.deepEqual(vibrations(s), [{ pattern: [200], allowed: true }]);
    const r2 = await s.act(step({ type: 'look' }));
    assert.doesNotMatch(r2.text, /vibrated/, 'told once');
  } finally { await s.stop(); }
});

test('desktop: a vibrate is a signal only', async () => {
  const s = await Session.start({ id: 'vib-desk', dir: tmpDir(), url: fx.url('clock.html?vibrate=click') });
  try {
    await s.act(step({ type: 'look' }));
    const r = await s.act(step(GO));
    assert.doesNotMatch(r.text, /vibrated/);
    assert.deepEqual(vibrations(s), [{ pattern: [200], allowed: true }]);
  } finally { await s.stop(); }
});

test('a vibrate before any gesture is refused by Chrome: signal only, no status line', async () => {
  const s = await Session.start({ id: 'vib-load', dir: tmpDir(), url: fx.url('clock.html?vibrate=load'), viewport: 'mobile-small' });
  try {
    const r = await s.act(step({ type: 'look' }));
    assert.doesNotMatch(r.text, /vibrated/);
    assert.deepEqual(vibrations(s), [{ pattern: [100], allowed: false }]);
  } finally { await s.stop(); }
});

test('controlled: a Notification with nothing visible still ends a wait early', async () => {
  const s = await Session.start({ id: 'notify', dir: tmpDir(), url: fx.url('clock.html?notify=20000'), clock: 'controlled' });
  try {
    const r = await s.act(step({ type: 'wait', seconds: 60 }));
    const entry = readLog(s.dir).at(-1);
    assert.equal(entry.wait_stop, 'changed');
    assert.ok(entry.waited_ms < 20000, `waited ${entry.waited_ms}`);
    assert.match(r.text, /Something on the screen changed\./);
  } finally { await s.stop(); }
});
