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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-clock-'));
const step = (action) => ({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action });
const readLog = (dir) => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let n = 0;
const start = (url, opts = {}) => Session.start({ id: `clk${++n}`, dir: tmpDir(), url: fx.url(url), clock: 'controlled', ...opts });
const pageNow = (s) => s.evalHarness('Date.now()');
const text = (s, id) => s.evalHarness(`document.getElementById('${id}').textContent`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GO = { type: 'click', x: 100, y: 50 };
const setupOf = (s) => s.events.find((e) => e.type === 'setup' && e.url);

test('clock must be real or controlled; the wait cap follows the mode', () => {
  assert.throws(() => new Session({ id: 'x', dir: tmpDir(), url: 'http://127.0.0.1/', profileDir: tmpDir(), clock: 'fast' }),
    /clock must be real or controlled/);
  assert.equal(new Session({ id: 'x', dir: tmpDir(), url: 'http://127.0.0.1/', profileDir: tmpDir() }).waitCap, 10);
  assert.equal(new Session({ id: 'x', dir: tmpDir(), url: 'http://127.0.0.1/', profileDir: tmpDir(), clock: 'controlled' }).waitCap, 600);
});

test('real: wait above 10 s is invalid; controlled: wait 601 is invalid', async () => {
  const real = await Session.start({ id: 'wr', dir: tmpDir(), url: fx.url('clock.html') });
  try {
    const r = await real.act(step({ type: 'wait', seconds: 11 }));
    assert.equal(r.ok, false);
    assert.match(r.text, /INVALID_ACTION: wait seconds must be between 0 and 10\./);
    assert.equal(real.steps, 0);
  } finally { await real.stop(); }
  const s = await start('clock.html');
  try {
    const r = await s.act(step({ type: 'wait', seconds: 601 }));
    assert.equal(r.ok, false);
    assert.match(r.text, /INVALID_ACTION: wait seconds must be between 0 and 600\./);
    assert.equal(s.steps, 0);
  } finally { await s.stop(); }
});

test('controlled: setup pauses the clock without an error and page time stays still while the persona thinks', async () => {
  const s = await start('clock.html'); // install + pause must not throw "Cannot fast-forward to the past"
  try {
    assert.equal(setupOf(s).clock, 'controlled');
    const t1 = await pageNow(s);
    const ticks1 = await s.evalHarness('window.ticks');
    await sleep(3000);
    assert.equal(await pageNow(s), t1, 'Date.now() did not move');
    assert.equal(await s.evalHarness('window.ticks'), ticks1, 'no interval fired');
  } finally { await s.stop(); }
});

test('controlled: fetch → setTimeout(0) → text lands before the post screenshot', async () => {
  const s = await start('clock.html');
  try {
    await s.act(step({ type: 'look' }));
    const r = await s.act(step(GO));
    assert.equal(r.ok, true);
    assert.equal(await text(s, 'status'), 'loaded');
  } finally { await s.stop(); }
});

test('controlled: a counted step adds 2 s of page time, a 10-character type 2 s more', async () => {
  const s = await start('clock.html');
  try {
    await s.act(step({ type: 'look' })); // free: no human time
    await s.act(step({ type: 'click', x: 100, y: 112 })); // focus the field
    const t0 = await pageNow(s);
    await s.act(step({ type: 'look' }));
    const t1 = await pageNow(s);
    await s.act(step({ type: 'type', text: '0123456789' }));
    const t2 = await pageNow(s);
    assert.ok(t1 - t0 >= 2000, `look moved page time ${t1 - t0} ms`);
    assert.ok(t2 - t1 >= 4000, `type moved page time ${t2 - t1} ms`);
    assert.equal(await s.evalHarness("document.getElementById('field').value"), '0123456789');
    const steps = readLog(s.dir).filter((e) => e.step);
    assert.ok(steps.every((e, i) => Number.isInteger(e.page_time_ms) && (i === 0 || e.page_time_ms > steps[i - 1].page_time_ms)));
    assert.ok(steps.at(-1).page_time_ms - steps.at(-2).page_time_ms >= 4000);
  } finally { await s.stop(); }
});

test('real: the setup signal says clock real and every step logs page_time_ms', async () => {
  const s = await Session.start({ id: 'real-pt', dir: tmpDir(), url: fx.url('clock.html') });
  try {
    await s.act(step({ type: 'look' }));
    await s.act(step({ type: 'wait', seconds: 1 }));
    assert.equal(setupOf(s).clock, 'real');
    const [look, wait] = readLog(s.dir);
    assert.ok(wait.page_time_ms - look.page_time_ms >= 1000);
    assert.equal(wait.waited_ms, undefined, 'waited_ms / wait_stop only under controlled');
    assert.equal(wait.wait_stop, undefined, 'waited_ms / wait_stop only under controlled');
  } finally { await s.stop(); }
});

test('controlled: a timer that throws during a step is a pageerror signal and the step completes', async () => {
  const s = await start('clock.html?throw=4000'); // later than setup: reached partway through one step's human time
  try {
    await s.act(step({ type: 'look' })); // free: no human time; the timer must not have fired during setup
    assert.ok(!s.events.some((e) => e.type === 'pageerror'), 'the timer fired before any counted step');
    const r = await s.act(step({ type: 'type', text: '01234567890123456789' })); // 6 s of human time crosses the throw
    assert.equal(r.ok, true);
    const errors = s.events.filter((e) => e.type === 'pageerror' && e.via === 'timer');
    assert.ok(errors.some((e) => /boom from a timer/.test(e.msg) && e.step >= 1), JSON.stringify(errors));
  } finally { await s.stop(); }
});

test('controlled: a page that busy-waits on Date.now() does not hang act or stop', async () => {
  // busy.html spins `while (Date.now() - t < 40000)`: on a paused fake clock that never ends.
  const s = await start('busy.html');
  let t = Date.now();
  try {
    const r = await s.act(step({ type: 'click', x: 160, y: 120 }));
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t < 20000, `busy step took ${Date.now() - t} ms`);
    t = Date.now();
    const r2 = await s.act(step({ type: 'look' }));
    assert.equal(r2.ok, true);
    assert.ok(Date.now() - t < 20000, `next step took ${Date.now() - t} ms`);
    assert.ok(s.events.some((e) => e.type === 'clock-stuck'));
  } finally {
    t = Date.now();
    await s.stop();
    assert.ok(Date.now() - t < 20000, `stop took ${Date.now() - t} ms`);
  }
});

test('controlled: wait 90 on a per-tick countdown fires every tick (not one)', async () => {
  const s = await start('clock.html');
  try {
    await s.act(step({ type: 'look' }));
    const before = await s.evalHarness('window.ticks');
    const t = Date.now();
    const r = await s.act(step({ type: 'wait', seconds: 90 }));
    const ticks = await s.evalHarness('window.ticks');
    assert.ok(ticks - before >= 90, `${ticks - before} ticks`);
    const left = 780 - ticks;
    assert.equal(await text(s, 'timer'), `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`);
    const entry = readLog(s.dir).at(-1);
    assert.equal(entry.waited_ms, 90000);
    assert.equal(entry.wait_stop, 'full');
    assert.doesNotMatch(r.text, /You waited/);
    assert.ok(Date.now() - t < 30000, `wait took ${Date.now() - t} ms`);
  } finally { await s.stop(); }
});

test('controlled: a banner at +31 s ends wait 120 early and the status says so', async () => {
  const s = await start('clock.html?banner=31000');
  try {
    await s.act(step({ type: 'look' }));
    const r = await s.act(step({ type: 'wait', seconds: 120 }));
    const entry = readLog(s.dir).at(-1);
    assert.equal(entry.wait_stop, 'changed');
    assert.ok(entry.waited_ms > 20000 && entry.waited_ms < 31000, `waited ${entry.waited_ms}`);
    assert.match(r.text, new RegExp(`^You waited ${Math.round(entry.waited_ms / 1000)} s\\. Something on the screen changed\\.$`, 'm'));
    assert.equal(await text(s, 'banner'), 'Time is up!');
  } finally { await s.stop(); }
});

test('controlled: a 1.5 s response during wait 10 lands before the app\'s 1 s client timeout', async () => {
  // The fetch starts at +9 s of page time, inside the wait (setup ≈ 1 s + human time 2 s before it).
  const s = await start('clock.html?fetchAt=9000&slow=1500');
  try {
    await s.act(step({ type: 'wait', seconds: 10 }));
    assert.equal(await text(s, 'status'), 'loaded');
    assert.equal(readLog(s.dir).at(-1).wait_stop, 'changed');
  } finally { await s.stop(); }
});

test('controlled: the wall cap ends a slow wait and reports the page time that passed', async () => {
  const s = await start('clock.html?raf', { waitWallCapMs: 3000 });
  try {
    const t = Date.now();
    const r = await s.act(step({ type: 'wait', seconds: 600 }));
    const entry = readLog(s.dir).at(-1);
    assert.equal(entry.wait_stop, 'wall_cap');
    assert.ok(entry.waited_ms > 0 && entry.waited_ms < 600000, `waited ${entry.waited_ms}`);
    assert.match(r.text, new RegExp(`^You waited ${Math.round(entry.waited_ms / 1000)} s\\.$`, 'm'));
    assert.doesNotMatch(r.text, /Something on the screen changed/);
    assert.ok(Date.now() - t < 20000, `wait took ${Date.now() - t} ms`);
  } finally { await s.stop(); }
});

test('controlled: a request that never answers holds page time back for at most 5 s', async () => {
  const s = await start('clock.html?hang');
  try {
    const t = Date.now();
    const r = await s.act(step({ type: 'wait', seconds: 30 }));
    assert.equal(r.ok, true);
    const entry = readLog(s.dir).at(-1);
    assert.equal(entry.wait_stop, 'full');
    assert.equal(entry.waited_ms, 30000);
    assert.ok(Date.now() - t < 20000, `wait took ${Date.now() - t} ms`);
  } finally { await s.stop(); }
});

test('controlled: after a 600 s wait a reload keeps page time and completes', async () => {
  const s = await start('clock.html');
  try {
    await s.act(step({ type: 'wait', seconds: 600 }));
    assert.equal(readLog(s.dir).at(-1).wait_stop, 'full');
    const before = await pageNow(s);
    const t = Date.now();
    const r = await s.act(step({ type: 'reload' }));
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t < 15000, `reload step took ${Date.now() - t} ms`);
    const after = await pageNow(s);
    assert.ok(after - before >= 2000 && after - before < 60000, `page time moved ${after - before} ms across the reload`);
  } finally { await s.stop(); }
});

test('controlled: a countdown crossing digit width (ASCII 10 -> 9, Thai numerals ๑๐ -> ๙) does not end the wait as "changed"', async () => {
  // countdown=15 with plenty of margin: even with the free look's pacer and the wait's own 2 s of
  // human time spent first, the count is still comfortably above 10 when the tracked wait starts,
  // and a 10 s wait after that is certain to carry it past the 10 -> 9 (and ๑๐ -> ๙) boundary.
  const s = await start('clock.html?countdown=15');
  try {
    await s.act(step({ type: 'look' }));
    const r = await s.act(step({ type: 'wait', seconds: 10 }));
    const entry = readLog(s.dir).at(-1);
    assert.equal(entry.wait_stop, 'full', `stopped early: ${JSON.stringify(entry)}`);
    assert.equal(entry.waited_ms, 10000);
    assert.doesNotMatch(r.text, /Something on the screen changed/);
  } finally { await s.stop(); }
});
