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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-test-'));
const step = (action, extra = {}) => ({
  observation: 'A page', reaction: 'ok', event: 'none', frustration_delta: 0, action, ...extra,
});
const readLog = (dir) => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const readSignals = (dir) => fs.readFileSync(path.join(dir, 'signals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const count = (s) => s.evalHarness("document.getElementById('count').textContent");

test('initial goto is not counted and a first look is free', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't1', dir, url: fx.url('basic.html'), cap: 3 });
  try {
    assert.equal(s.steps, 0);
    const r = await s.act(step({ type: 'look' }));
    assert.equal(r.ok, true);
    assert.equal(s.steps, 0, 'first look is free');
    assert.ok(r.png.length > 1000, 'look returns a screenshot');
    const r2 = await s.act(step({ type: 'look' }));
    assert.equal(r2.ok, true);
    assert.equal(s.steps, 1, 'a later look counts like waiting');
  } finally { await s.stop(); }
});

test('click performs the action, counts a step, logs it and saves a screenshot', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't2', dir, url: fx.url('basic.html'), cap: 5 });
  try {
    const r = await s.act(step({ type: 'click', x: 160, y: 120, target: 'Add one button' },
      { observation: 'A button says Add one', reaction: 'Let me try it' }));
    assert.equal(r.ok, true);
    assert.equal(await count(s), '1');
    assert.equal(s.steps, 1);
    assert.match(r.text, /Step 1 of 5/);
    assert.ok(fs.existsSync(r.screenshotPath));
    // owner-only modes are no-ops on Windows (spec component 5, D28)
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'log.jsonl')).mode & 0o777, 0o600, 'persona log is private');
    const [entry] = readLog(dir).filter((e) => e.step === 1);
    assert.equal(entry.observation, 'A button says Add one');
    assert.equal(entry.reaction, 'Let me try it');
    assert.deepEqual(entry.action, { type: 'click', x: 160, y: 120, target: 'Add one button' });
    assert.equal(entry.event, 'none');
    assert.equal(entry.frustration_delta, 0);
    assert.equal(entry.screenshot, path.relative(dir, r.screenshotPath).split(path.sep).join('/'));
    assert.equal(entry.visual_change, 'changed');
    assert.ok(entry.url.includes('basic.html'));
  } finally { await s.stop(); }
});

test('step cap refuses the action beyond the cap without performing it', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't3', dir, url: fx.url('basic.html'), cap: 2 });
  try {
    await s.act(step({ type: 'click', x: 160, y: 120 }));
    await s.act(step({ type: 'click', x: 160, y: 120 }));
    const r = await s.act(step({ type: 'click', x: 160, y: 120 }));
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.match(r.text, /^STEP_CAP_REACHED \(2\)/);
    assert.equal(await count(s), '2', 'third click not performed');
    assert.equal(s.steps, 2);
    assert.ok(readLog(dir).some((e) => e.refused === 'STEP_CAP_REACHED'));
  } finally { await s.stop(); }
});

test('harness eval and setup never count toward the cap', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't4', dir, url: fx.url('basic.html'), cap: 1 });
  try {
    await s.evalHarness("document.getElementById('inc').click()");
    assert.equal(s.steps, 0);
    assert.equal(await count(s), '1');
  } finally { await s.stop(); }
});

test('coordinates outside the viewport are rejected without counting', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't5', dir, url: fx.url('basic.html'), cap: 5 });
  try {
    for (const bad of [{ x: -1, y: 10 }, { x: 5000, y: 10 }, { x: 10, y: 900 }, { x: 10.5, y: 10 }]) {
      const r = await s.act(step({ type: 'click', ...bad }));
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.refused, undefined);
      assert.match(r.text, /INVALID_ACTION/);
    }
    assert.equal(s.steps, 0);
  } finally { await s.stop(); }
});

test('type, press_key, scroll, back, reload, wait and drag work', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't6', dir, url: fx.url('basic.html'), cap: 20 });
  try {
    await s.act(step({ type: 'click', x: 150, y: 210, target: 'Name field' }));
    await s.act(step({ type: 'type', text: 'Somchai' }));
    assert.equal(await s.evalHarness("document.getElementById('field').value"), 'Somchai');
    await s.act(step({ type: 'press_key', key: 'Backspace' }));
    assert.equal(await s.evalHarness("document.getElementById('field').value"), 'Somcha');
    await s.act(step({ type: 'scroll', dy: 500 }));
    assert.ok((await s.evalHarness('scrollY')) > 0);
    await s.act(step({ type: 'scroll', dy: -500 }));
    await s.act(step({ type: 'click', x: 130, y: 310, target: 'Next page link' }));
    assert.match(await s.evalHarness('location.search'), /page=2/);
    await s.act(step({ type: 'back' }, { event: 'went_back', frustration_delta: 1 }));
    assert.equal(await s.evalHarness('location.search'), '');
    await s.act(step({ type: 'reload' }));
    await s.act(step({ type: 'wait', seconds: 1 }));
    const r = await s.act(step({ type: 'drag', from: { x: 10, y: 10 }, to: { x: 200, y: 10 } }));
    assert.equal(r.ok, true);
    assert.equal(s.steps, 10);
    assert.equal(s.frustration, 1);
  } finally { await s.stop(); }
});

test('patience budget: reaching it refuses the action and ends the session', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't7', dir, url: fx.url('basic.html'), cap: 10, patienceBudget: 3 });
  try {
    await s.act(step({ type: 'click', x: 160, y: 120 }, { event: 'no_response', frustration_delta: 2 }));
    const r = await s.act(step({ type: 'click', x: 160, y: 120 }, { event: 'jargon', frustration_delta: 1 }));
    assert.equal(r.ok, false);
    assert.match(r.text, /^PATIENCE_EXHAUSTED/);
    assert.equal(await count(s), '1');
    assert.equal(s.frustration, 3);
    const r2 = await s.act(step({ type: 'look' }));
    assert.match(r2.text, /^PATIENCE_EXHAUSTED|^SESSION_ENDED/);
  } finally { await s.stop(); }
});

test('end() records the exit interview and later actions are refused', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't8', dir, url: fx.url('basic.html'), cap: 10 });
  try {
    const out = s.end({ outcome: 'gave_up', exit_interview: { what_it_is_for: 'Counting', would_come_back: false, reason: 'Boring', most_confusing: 'Nothing' } });
    assert.match(out, /recorded/i);
    const r = await s.act(step({ type: 'click', x: 160, y: 120 }));
    assert.equal(r.ok, false);
    assert.match(r.text, /^SESSION_ENDED/);
    assert.throws(() => s.end({ outcome: 'gave_up', exit_interview: {} }), /already ended/);
    const endEntry = readLog(dir).find((e) => e.end);
    assert.equal(endEntry.end.outcome, 'gave_up');
    assert.equal(endEntry.end.exit_interview.what_it_is_for, 'Counting');
  } finally { await s.stop(); }
});

test('end() asks once to re-check the goal before recording goal_achieved', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't8g', dir, url: fx.url('basic.html'), cap: 10 });
  const interview = { what_it_is_for: 'Counting', would_come_back: 'yes', reason: 'Quick', most_confusing: 'Nothing' };
  try {
    const first = s.end({ outcome: 'goal_achieved', final_observation: 'The number shows 0', exit_interview: interview });
    assert.match(first, /^GOAL_CHECK/);
    assert.match(first, /read your goal again, part by part in your briefing\./i, 'no goal given: points at the briefing');
    assert.equal(s.ended, false, 'the first goal_achieved is a check, not the end');
    const r = await s.act(step({ type: 'click', x: 160, y: 120 }));
    assert.equal(r.ok, true, 'the persona can keep going after the check');
    assert.equal(readLog(dir).some((e) => e.end), false);
    const second = s.end({ outcome: 'goal_achieved', final_observation: 'The number shows 1', exit_interview: interview });
    assert.match(second, /recorded/i);
    assert.equal(s.ended, true);
    assert.equal(readLog(dir).find((e) => e.end).end.final_observation, 'The number shows 1');
    const checks = readSignals(dir).filter((e) => e.type === 'goal-check');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].final_observation, 'The number shows 0');
    assert.equal(checks[0].step, 0);
  } finally { await s.stop(); }
});

test('GOAL_CHECK quotes the persona\'s own goal when the session was given one', async () => {
  const s = await Session.start({ id: 't8q', dir: tmpDir(), url: fx.url('basic.html'), cap: 10, goal: '  Count to two, and see it say so  ' });
  const interview = { what_it_is_for: 'Counting', would_come_back: 'yes', reason: 'Quick', most_confusing: 'Nothing' };
  try {
    const check = s.end({ outcome: 'goal_achieved', final_observation: 'It shows 1', exit_interview: interview });
    assert.match(check, /^GOAL_CHECK: .*part by part: "Count to two, and see it say so"\. Is every part/);
    assert.doesNotMatch(check, /in your briefing/);
  } finally { await s.stop(); }
});

test('two sessions are isolated (profile, counters, logs)', async () => {
  const [d1, d2] = [tmpDir(), tmpDir()];
  const [a, b] = await Promise.all([
    Session.start({ id: 'iso-a', dir: d1, url: fx.url('basic.html'), cap: 5 }),
    Session.start({ id: 'iso-b', dir: d2, url: fx.url('basic.html'), cap: 5 }),
  ]);
  try {
    await a.evalHarness("localStorage.setItem('who', 'a')");
    await b.evalHarness("localStorage.setItem('who', 'b')");
    await a.act(step({ type: 'click', x: 160, y: 120 }));
    assert.equal(await a.evalHarness("localStorage.getItem('who')"), 'a');
    assert.equal(await b.evalHarness("localStorage.getItem('who')"), 'b');
    assert.equal(a.steps, 1);
    assert.equal(b.steps, 0);
    assert.equal(await count(b), '0');
    assert.ok(!fs.existsSync(path.join(d2, 'log.jsonl')) || readLog(d2).every((e) => !e.step));
  } finally { await Promise.all([a.stop(), b.stop()]); }
});

test('mobile-small viewport emulates a phone', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 't9', dir, url: fx.url('basic.html'), viewport: 'mobile-small' });
  try {
    assert.equal(await s.evalHarness('innerWidth'), 360);
    const r = await s.act(step({ type: 'click', x: 160, y: 120 }));
    assert.equal(r.ok, true);
    assert.equal(await count(s), '1');
    assert.equal(r.png.readUInt32BE(16), 360, 'screenshot is 360 CSS px wide');
    assert.match((await s.act(step({ type: 'click', x: 400, y: 10 }))).text, /INVALID_ACTION.*360x640/);
  } finally { await s.stop(); }
});

test('Session warns once on win32 when its folder is outside the user profile (D28)', () => {
  const lines = [];
  const warn = (line) => lines.push(line);
  const profileDir = tmpDir(); // an explicit profile, so the constructor creates no temp folder of its own
  try {
    for (const id of ['a', 'b']) {
      new Session({ id, dir: `D:\\work\\app\\.ux-assessment\\runs\\r\\${id}`, url: 'http://localhost:1/', profileDir, platform: 'win32', homedir: 'C:\\Users\\me', warn });
    }
  } finally { fs.rmSync(profileDir, { recursive: true, force: true }); }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^warning: D:\\work\\app\\\.ux-assessment\\runs\\r\\a is outside your user profile/);
});
