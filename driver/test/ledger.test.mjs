import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunName, compareRuns, parseFeedback, latestLabels, readFindings, computeStatus } from '../ledger.mjs';

const order = (names, startedAt = {}) => names
  .map((name) => ({ name, started_at: startedAt[name] ?? null }))
  .sort(compareRuns).map((r) => r.name);

test('run order: date, then started_at, then suffix with the base first and numbers numeric', () => {
  assert.deepEqual(order(['2026-09-28-verify-2', '2026-09-25-rerun-phone', '2026-09-28', '2026-09-25-10',
    '2026-09-25-2', '2026-09-25', '2026-09-28-verify']),
  ['2026-09-25', '2026-09-25-2', '2026-09-25-10', '2026-09-25-rerun-phone', '2026-09-28', '2026-09-28-verify',
    '2026-09-28-verify-2']);
  // A persona run started after a same-day verify run sorts after it.
  assert.deepEqual(order(['2026-09-28-2', '2026-09-28-verify'], {
    '2026-09-28-2': '2026-09-28T15:00:00.000Z', '2026-09-28-verify': '2026-09-28T10:00:00.000Z',
  }), ['2026-09-28-verify', '2026-09-28-2']);
  assert.deepEqual(parseRunName('2026-09-28-verify-2'), { date: '2026-09-28', suffix: 'verify-2' });
  assert.equal(parseRunName('scratch'), null);
});

test('feedback parser tolerates hand edits and keeps the latest non-? label per id', () => {
  const text = [
    '# Finding labels',
    '',
    '## Run 2026-09-25 (runs/2026-09-25/report.md)',
    '- F-03 At 360px the table shows rows 1-5 — label: valid — note:',
    '- F-07 Apply closes the panel - label: Not Real - note: intended',
    '- F-08 Text overflows —  label:  WON’T FIX  — note: known',
    '* F-09 List / Detail – label: wont-fix',
    '- F-10 Date picker — label: ? — note:',
    '- F-11 Labels truncate — label: maybe later — note:',
    '- F-02 B label: valid',
    '- F-12 Something — label: known, won\'t fix — note:',
    '',
    '## Run 2026-09-28 (runs/2026-09-28/report.md)',
    '- F-03 At 360px the table shows rows 1-5 — label: ? — note:',
    '- F-07 Apply closes the panel — label: valid — note: changed my mind',
  ].join('\n');
  const { labels, warnings } = parseFeedback(text);
  const latest = latestLabels(labels, ['2026-09-25', '2026-09-28']);
  assert.deepEqual(Object.fromEntries([...latest].map(([id, l]) => [id, l.label])), {
    'F-03': 'valid', 'F-07': 'valid', 'F-08': "won't fix", 'F-09': "won't fix", 'F-12': "won't fix",
  });
  assert.equal(latest.get('F-07').note, 'changed my mind');
  assert.equal(latest.get('F-03').run, '2026-09-25');
  assert.deepEqual(warnings, [
    'feedback.md line 9: unknown label "maybe later" for F-11 (ignored)',
    'feedback.md line 10: unreadable label line for F-02 (ignored)',
  ]);
});

test('a repeated "— label:" in one line keeps the real, final label', () => {
  const { labels } = parseFeedback('- F-06 Field - label: text overlaps — label: valid\n');
  assert.deepEqual(labels.map((l) => [l.id, l.label]), [['F-06', 'valid']]);
});

test('a non-"Run" "##" heading resets the run to unknown and warns about labels under it', () => {
  const text = [
    '## Run 2026-09-25 (runs/2026-09-25/report.md)',
    '- F-01 A — label: valid — note:',
    '## Notes',
    '- F-02 B — label: valid — note:',
  ].join('\n');
  const { labels, warnings } = parseFeedback(text);
  assert.deepEqual(labels.map((l) => [l.id, l.run, l.label]),
    [['F-01', '2026-09-25', 'valid'], ['F-02', null, 'valid']]);
  assert.deepEqual(warnings, ['feedback.md line 4: label for F-02 follows a non-run heading; run left unknown']);
});

test('a "###" sub-heading keeps the run; a "?" label under a non-run heading is not warned about', () => {
  const text = [
    '## Run 2026-09-25 (runs/2026-09-25/report.md)',
    '### Mobile',
    '- F-01 A — label: valid — note:',
    '## Notes',
    '- F-02 B — label: ? — note:',
    '- F-03 C — label: not real — note:',
  ].join('\n');
  const { labels, warnings } = parseFeedback(text);
  assert.deepEqual(labels.map((l) => [l.id, l.run, l.label]),
    [['F-01', '2026-09-25', 'valid'], ['F-02', null, null], ['F-03', null, 'not real']]);
  assert.deepEqual(warnings, ['feedback.md line 6: label for F-03 follows a non-run heading; run left unknown']);
});

test('compareRuns never throws on a folder name that does not parse, such as "scratch"', () => {
  assert.doesNotThrow(() => order(['scratch', '2026-09-25']));
  assert.deepEqual(order(['scratch', '2026-09-25']), ['2026-09-25', 'scratch']);
  assert.deepEqual(order(['b-scratch', 'a-scratch']), ['a-scratch', 'b-scratch']);
});

test('findings.yaml: a top-level list or {findings: [...]}, legacy category, other kinds kept', () => {
  const a = readFindings('# c\n- id: F-01\n  title: "A"\n  category: ux\n- id: E-04\n  title: "B"\n  kind: env_error\n');
  assert.deepEqual(a.map((f) => [f.id, f.kind]), [['F-01', 'ux'], ['E-04', 'env_error']]);
  assert.deepEqual(readFindings('findings:\n  - id: F-02\n    title: "C"\n    kind: ux\n').map((f) => f.id), ['F-02']);
  assert.deepEqual(readFindings(''), []);
});

const S = (run, order) => ({ run, order, type: 'sighting' });
const V = (run, order, verdict, at_step = 3) => ({ run, order, type: 'verification', verdict, at_step });

test('status table', () => {
  assert.equal(computeStatus({ label: 'not real', events: [S('a', 0)] }), 'not_real');
  assert.equal(computeStatus({ label: "won't fix", events: [S('a', 0)] }), 'suppressed');
  assert.equal(computeStatus({ label: null, suppressed: true, events: [S('a', 0)] }), 'suppressed');
  assert.equal(computeStatus({ label: 'valid', events: [S('a', 0)] }), 'open');
  assert.equal(computeStatus({ events: [] }), 'open');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'reproduced')] }), 'still_present');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced')] }), 'not_seen');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced'), V('v2', 2, 'not_reproduced')] }), 'fixed');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'changed')] }), 'needs_review');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'reproduced'), V('v2', 2, 'not_reproduced')] }), 'not_seen');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced', 0)] }), 'not_seen'); // step 0 = first look
});

test('unreachable and not_reproduced without at_step never change the status', () => {
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'reproduced'), V('v2', 2, 'unreachable', null)] }), 'still_present');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced', null)] }), 'open');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced'), V('v2', 2, 'not_reproduced', null)] }), 'not_seen');
  // an unreachable check between two clean ones does not break the streak
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced'), V('v2', 2, 'unreachable', null),
    V('v3', 3, 'not_reproduced')] }), 'fixed');
});

test('two verdicts in one verify run count once; same-day -verify and -verify-2 count as two runs', () => {
  assert.equal(computeStatus({ events: [S('2026-09-28', 0), V('2026-09-28-verify', 1, 'not_reproduced', 2),
    V('2026-09-28-verify', 1, 'not_reproduced', 4)] }), 'not_seen');
  assert.equal(computeStatus({ events: [S('2026-09-28', 0), V('2026-09-28-verify', 1, 'not_reproduced'),
    V('2026-09-28-verify-2', 2, 'not_reproduced')] }), 'fixed');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced'), V('v', 1, 'reproduced')] }), 'still_present');
});

test('a sighting after fixed is a regression; after one clean check it is just open', () => {
  const fixed = [S('a', 0), V('v', 1, 'not_reproduced'), V('v2', 2, 'not_reproduced')];
  assert.equal(computeStatus({ events: [...fixed, S('b', 3)] }), 'regressed');
  assert.equal(computeStatus({ events: [...fixed, S('b', 3), S('c', 4)] }), 'regressed');
  assert.equal(computeStatus({ events: [S('a', 0), V('v', 1, 'not_reproduced'), S('b', 2)] }), 'open');
  // events arrive unsorted: order decides, not array position
  assert.equal(computeStatus({ events: [S('b', 3), ...fixed] }), 'regressed');
});
