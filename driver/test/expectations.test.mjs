import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session, CONFIDENCE, EXPECTING_ACTIONS } from '../session.mjs';
import { pairExpectations, summarizeRun } from '../expectations.mjs';
import { startFixtureServer } from './fixture-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
let fx;
before(async () => { fx = await startFixtureServer(); });
after(async () => { await fx.close(); });

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxe-test-'));
const step = (action, extra = {}) => ({ observation: 'A page', reaction: 'ok', event: 'none', frustration_delta: 0, action, ...extra });
const readLog = (dir) => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ADD = { type: 'click', x: 160, y: 120, target: 'Add one button' };
const BLANK = { type: 'click', x: 700, y: 500, target: 'the grey box' };
const interview = { what_it_is_for: 'Counting', would_come_back: 'no', reason: 'Boring', most_confusing: 'Nothing' };

test('the vocabulary: three confidence levels, and the actions that need an expectation', () => {
  assert.deepEqual(CONFIDENCE, ['sure', 'guess', 'cannot_tell']);
  assert.deepEqual(EXPECTING_ACTIONS, ['click', 'double_click', 'drag', 'type', 'press_key']);
});

test('expectations on: a click without expect is refused and uses no step; look and scroll need none', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'e1', dir, url: fx.url('basic.html'), cap: 6, expectations: true });
  try {
    assert.equal((await s.act(step({ type: 'look' }))).ok, true);
    const refused = await s.act(step(ADD));
    assert.equal(refused.ok, false);
    assert.match(refused.text, /^INVALID_ACTION: click needs expect: what you think will happen, and confidence \(sure, guess or cannot_tell\)/);
    assert.equal(s.steps, 0);
    const bad = await s.act(step(ADD, { expect: { outcome: 'the number goes up', confidence: 'certain' } }));
    assert.match(bad.text, /^INVALID_ACTION: expect needs outcome .* and confidence, one of sure, guess, cannot_tell/);
    assert.equal((await s.act(step({ type: 'scroll', dy: 100 }))).ok, true);
    assert.equal(s.steps, 1);
  } finally { await s.stop(); }
});

test('expectations on: the expectation is logged with its step, and the next call must say whether it was met', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'e2', dir, url: fx.url('basic.html'), cap: 6, expectations: true });
  try {
    await s.act(step({ type: 'look' }));
    assert.equal((await s.act(step(ADD, { expect: { outcome: 'the number goes up by one', confidence: 'sure' } }))).ok, true);
    const missing = await s.act(step({ type: 'look' }));
    assert.match(missing.text, /^INVALID_ACTION: expectation_met is missing: say whether step 1 did what you expected \(yes, partly or no\)/);
    assert.equal(s.steps, 1, 'the refused call used no step');
    assert.equal((await s.act(step(BLANK, { expectation_met: 'yes', expect: { outcome: 'no idea, trying it', confidence: 'cannot_tell' } }))).ok, true);
    assert.equal((await s.act(step({ type: 'look' }, { expectation_met: 'no', reaction: 'Nothing happened at all' }))).ok, true);
    // No expectation is pending now: a verdict is neither needed nor recorded.
    assert.equal((await s.act(step({ type: 'look' }, { expectation_met: 'yes' }))).ok, true);
    const steps = readLog(dir).filter((e) => typeof e.step === 'number');
    assert.deepEqual(steps.map((e) => [e.step, e.expect ?? null, e.expectation_met ?? null]), [
      [1, { outcome: 'the number goes up by one', confidence: 'sure' }, null],
      [2, { outcome: 'no idea, trying it', confidence: 'cannot_tell' }, { step: 1, met: 'yes' }],
      [3, null, { step: 2, met: 'no' }],
      [4, null, null],
    ]);
    assert.equal(steps[0].visual_change, 'changed');
    assert.equal(steps[1].visual_change, 'none');
    assert.equal((await s.signals()).expectations, true);
  } finally { await s.stop(); }
});

test('expectations on: end_session records the verdict on the last action', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'e3', dir, url: fx.url('basic.html'), cap: 6, expectations: true });
  try {
    await s.act(step(ADD, { expect: { outcome: 'the number goes up', confidence: 'guess' } }));
    s.end({ outcome: 'gave_up', final_observation: 'The number shows 1', exit_interview: interview, expectation_met: 'partly' });
    assert.deepEqual(readLog(dir).at(-1).end.expectation_met, { step: 1, met: 'partly' });
  } finally { await s.stop(); }
});

test('expectations off (a verifier, a setup login): nothing is required, and a given expectation is still logged', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'e4', dir, url: fx.url('basic.html'), cap: 6 });
  try {
    assert.equal((await s.act(step(ADD))).ok, true);
    assert.equal((await s.act(step(ADD, { expect: { outcome: 'two', confidence: 'sure' } }))).ok, true);
    assert.equal((await s.act(step({ type: 'look' }))).ok, true, 'no verdict is demanded');
    const steps = readLog(dir).filter((e) => typeof e.step === 'number');
    assert.deepEqual(steps.map((e) => e.expect ?? null), [null, { outcome: 'two', confidence: 'sure' }, null]);
    assert.equal((await s.signals()).expectations, false);
  } finally { await s.stop(); }
});

test('a verdict is kept across an Unknown-key retry, a step-cap refusal and GOAL_CHECK', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'e5', dir, url: fx.url('basic.html'), cap: 2, expectations: true, goal: 'Count to one' });
  try {
    const expect = { outcome: 'the number goes up', confidence: 'sure' };
    await s.act(step(ADD, { expect }));
    const unknown = await s.act(step({ type: 'press_key', key: 'NoSuchKey' }, { expect, expectation_met: 'yes' }));
    assert.match(unknown.text, /^INVALID_ACTION: /);
    assert.match((await s.act(step({ type: 'look' }))).text, /expectation_met is missing: say whether step 1/, 'the retry must answer for step 1 again');
    await s.act(step(ADD, { expect, expectation_met: 'yes' }));
    const capped = await s.act(step(ADD, { expect, expectation_met: 'partly' }));
    assert.match(capped.text, /^STEP_CAP_REACHED/);
    await s.act(step({ type: 'look' }, { expectation_met: 'no' })); // already answered: nothing more is logged
    const log = readLog(dir);
    assert.deepEqual(log.filter((e) => e.expectation_met).map((e) => [e.step ?? e.refused, e.expectation_met]),
      [[2, { step: 1, met: 'yes' }], ['STEP_CAP_REACHED', { step: 2, met: 'partly' }]]);
  } finally { await s.stop(); }

  const dir2 = tmpDir();
  const s2 = await Session.start({ id: 'e6', dir: dir2, url: fx.url('basic.html'), cap: 4, expectations: true, goal: 'Count to one' });
  try {
    await s2.act(step(ADD, { expect: { outcome: 'one', confidence: 'guess' } }));
    assert.match(s2.end({ outcome: 'goal_achieved', final_observation: '1', exit_interview: interview, expectation_met: 'yes' }), /^GOAL_CHECK/);
    s2.end({ outcome: 'goal_achieved', final_observation: 'The number shows 1', exit_interview: interview });
    assert.deepEqual(readLog(dir2).at(-1).end.expectation_met, { step: 1, met: 'yes' });
  } finally { await s2.stop(); }
});

test('an action the harness stopped is marked in the log, and is never a dead control', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'e7', dir, url: fx.url('safety.html'), cap: 4, expectations: true });
  try {
    const r = await s.act(step({ type: 'click', x: 180, y: 118, target: 'Visit partner' }, { expect: { outcome: 'the partner site opens', confidence: 'sure' } }));
    assert.match(r.text, /STOP: /);
    s.end({ outcome: 'stop_before', final_observation: 'A STOP note', exit_interview: interview, expectation_met: 'no' });
    const log = readLog(dir);
    assert.equal(log.find((e) => e.step === 1).stopped_before.length, 1);
    assert.deepEqual(pairExpectations(log).map((row) => row.pattern), ['stopped_by_harness']);
  } finally { await s.stop(); }
});

test('pairExpectations: a failed action is action_failed, whatever the screen did', () => {
  const rows = pairExpectations([line(1, { type: 'click', x: 1, y: 2, target: 'Play' },
    { expect: { outcome: 'music', confidence: 'sure' }, visual_change: 'none', action_error: 'page crashed' })]);
  assert.deepEqual([rows[0].pattern, rows[0].action_error], ['action_failed', 'page crashed']);
});

const line = (stepNo, action, extra = {}) => ({ t: stepNo, step: stepNo, observation: 'o', reaction: `r${stepNo}`, action, event: 'none', screenshot: `screenshots/s0${stepNo}.png`, visual_change: 'changed', ...extra });

test('pairExpectations: each expectation meets its verdict and the harness result, and gets one pattern', () => {
  const click = (target) => ({ type: 'click', x: 1, y: 2, target });
  const rows = pairExpectations([
    line(1, click('Play'), { expect: { outcome: 'music starts', confidence: 'sure' } }),
    line(2, click('the grey tile'), { expect: { outcome: 'it opens', confidence: 'guess' }, expectation_met: { step: 1, met: 'yes' }, visual_change: 'none' }),
    line(3, click('gear icon'), { expect: { outcome: 'no idea', confidence: 'cannot_tell' }, expectation_met: { step: 2, met: 'no' } }),
    line(4, click('Share'), { expect: { outcome: 'a link to copy', confidence: 'sure' }, expectation_met: { step: 3, met: 'yes' } }),
    line(5, click('Save'), { expect: { outcome: 'it saves', confidence: 'guess' }, expectation_met: { step: 4, met: 'no' } }),
    line(6, click('Export'), { expect: { outcome: 'a file downloads', confidence: 'guess' }, expectation_met: { step: 5, met: 'partly' } }),
    line(7, { type: 'look' }, { expectation_met: { step: 6, met: 'yes' } }),
    line(8, click('Help'), { expect: { outcome: 'a help page', confidence: 'sure' } }),
    { t: 9, end: { outcome: 'gave_up', final_observation: 'Still the same screen' } },
  ]);
  assert.deepEqual(rows.map((r) => [r.step, r.target, r.confidence, r.visual_change, r.met, r.pattern]), [
    [1, 'Play', 'sure', 'changed', 'yes', 'as_expected'],
    [2, 'the grey tile', 'guess', 'none', 'no', 'dead_control'],
    [3, 'gear icon', 'cannot_tell', 'changed', 'yes', 'control_unpredictable'],
    [4, 'Share', 'sure', 'changed', 'no', 'unexpected_result'],
    [5, 'Save', 'guess', 'changed', 'partly', 'partly_expected'],
    [6, 'Export', 'guess', 'changed', 'yes', 'guess_confirmed'],
    [8, 'Help', 'sure', 'changed', null, 'unjudged'],
  ]);
  assert.deepEqual([rows[0].expect, rows[0].screenshot, rows[0].after], ['music starts', 'screenshots/s01.png', 'r2']);
  assert.equal(rows[3].after, 'r5', 'what the persona said once it saw the result');
});

test('pairExpectations: a verdict given at end_session closes the last expectation', () => {
  const rows = pairExpectations([
    line(1, { type: 'click', x: 1, y: 2, target: 'Pay' }, { expect: { outcome: 'a card form', confidence: 'sure' } }),
    { t: 2, end: { outcome: 'stop_before', final_observation: 'A STOP note', expectation_met: { step: 1, met: 'no' } } },
  ]);
  assert.deepEqual([rows[0].met, rows[0].pattern, rows[0].after], ['no', 'unexpected_result', 'A STOP note']);
});

test('summarizeRun and the CLI: one entry per persona folder, with counts, and "off" for a session that did not ask', (t) => {
  const run = tmpDir();
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  const write = (persona, log, signals) => {
    fs.mkdirSync(path.join(run, persona));
    fs.writeFileSync(path.join(run, persona, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.writeFileSync(path.join(run, persona, 'signals.jsonl'), signals.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  write('ann', [
    line(1, { type: 'click', x: 1, y: 2, target: 'Play' }, { expect: { outcome: 'music', confidence: 'sure' }, visual_change: 'none' }),
    line(2, { type: 'look' }, { expectation_met: { step: 1, met: 'no' } }),
  ], [{ type: 'setup', expectations: true }]);
  write('bob', [line(1, { type: 'click', x: 1, y: 2, target: 'Play' })], [{ type: 'setup', expectations: false }]);
  fs.writeFileSync(path.join(run, 'run.json'), '{}');
  const summary = summarizeRun(run);
  assert.deepEqual(summary.personas.map((p) => [p.persona, p.expectations, p.rows.length]), [['ann', 'on', 1], ['bob', 'off', 0]]);
  assert.deepEqual(summary.personas[0].patterns, { dead_control: 1 });
  assert.deepEqual(summary.personas[0].confidence, { sure: 1, guess: 0, cannot_tell: 0 });
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'driver', 'expectations.mjs'), run], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), summary);
  const none = spawnSync(process.execPath, [path.join(ROOT, 'driver', 'expectations.mjs')], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^usage: node expectations\.mjs <run folder>\n$/);
});

test('the persona instructions, the skill and the triage rules use the harness vocabulary', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const persona = read('agents/persona.md');
  for (const word of ['`expect`', '`expectation_met`', ...CONFIDENCE.map((c) => `\`${c}\``)]) assert.ok(persona.includes(word), `agents/persona.md names ${word}`);
  assert.match(read('skills/ux-assessment/SKILL.md'), /`expectations: true`/);
  const triage = read('knowledge/triage.md');
  assert.match(triage, /driver\/expectations\.mjs/);
  for (const pattern of ['stopped_by_harness', 'action_failed', 'dead_control', 'unexpected_result', 'partly_expected', 'control_unpredictable', 'guess_confirmed', 'as_expected', 'unjudged']) {
    assert.ok(triage.includes(`\`${pattern}\``), `knowledge/triage.md explains ${pattern}`);
  }
});
