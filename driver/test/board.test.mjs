import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { boardGroups, boardMarkdown } from '../ledger.mjs';

const LEDGER = fileURLToPath(new URL('../ledger.mjs', import.meta.url));
const agent = (value, extra = {}) => ({ value, by: 'agent', reason: '', sources: [], options: [], run: '2026-10-12', ...extra });
const f = (title, status, decision = null, extra = {}) => ({ title, title_local: title, kind: 'ux', severity: 'medium', status,
  decision, last_seen: '2026-10-12', ...extra });
const keys = (groups) => groups.map((g) => g.key);
const idsOf = (groups, key) => groups.find((g) => g.key === key).rows.map((r) => r.id);

test('each rule puts a finding in the first group it meets, whatever its decision', () => {
  const groups = boardGroups({ findings: {
    'F-01': f('a', 'fixed', agent('ask')),
    'F-02': f('b', 'not_real', agent('fix')),
    'F-03': f('c', 'suppressed', agent('keep')),
    'F-04': f('d', 'not_seen', agent('ask')),
    'F-05': f('e', 'needs_review', agent('fix')),
    'F-06': f('f', 'open', agent('ask')),
    'F-07': f('g', 'still_present', agent('fix')),
    'F-08': f('h', 'regressed', agent('keep')),
    'F-09': f('i', 'open'),
    'F-10': f('j', 'open', { ...agent('fix'), by: 'human' }),
  } });
  assert.deepEqual(keys(groups), ['needs_you', 'to_fix', 'kept', 'undecided', 'awaiting_check', 'closed']);
  assert.deepEqual(idsOf(groups, 'closed'), ['F-01', 'F-02', 'F-03']);
  assert.deepEqual(idsOf(groups, 'awaiting_check'), ['F-04']);
  assert.deepEqual(idsOf(groups, 'needs_you'), ['F-05', 'F-06']);
  assert.deepEqual(idsOf(groups, 'to_fix'), ['F-07', 'F-10']);
  assert.deepEqual(idsOf(groups, 'kept'), ['F-08']);
  assert.deepEqual(idsOf(groups, 'undecided'), ['F-09']);
});

test('agent_error and env_error records are not on the board', () => {
  const groups = boardGroups({ findings: { 'F-01': f('a', 'open'), 'A-01': f('x', 'open', null, { kind: 'agent_error' }), 'E-01': f('y', 'open', null, { kind: 'env_error' }) } });
  assert.deepEqual(groups.flatMap((g) => g.rows.map((r) => r.id)), ['F-01']);
});

test('rows are ordered by severity, then id numerically; the title is title_local', () => {
  const groups = boardGroups({ findings: {
    'F-10': f('ten', 'open', null, { severity: 'high' }), 'F-02': f('two', 'open', null, { severity: 'low' }),
    'F-09': f('nine', 'open', null, { severity: 'high' }), 'F-03': f('three', 'open', null, { severity: 'medium', title_local: 'สาม' }),
    'F-04': f('four', 'open', null, { severity: null }),
  } });
  assert.deepEqual(groups.find((g) => g.key === 'undecided').rows.map((r) => [r.id, r.title]),
    [['F-09', 'nine'], ['F-10', 'ten'], ['F-03', 'สาม'], ['F-02', 'two'], ['F-04', 'four']]);
});

test('markdown: groups in print order, an empty group left out, closed as one line of counts, then what to do next', () => {
  const text = boardMarkdown(boardGroups({ findings: {
    'F-01': f('Save is silent', 'open', agent('keep', { sources: [{ path: 'docs/prd.md', line: 42, quote: 'q' }] }), { severity: 'high' }),
    'F-02': f('Jargon | on landing', 'still_present', agent('ask', { options: ['Rename it', 'Keep the jargon'] })),
    'F-03': f('Odd focus', 'open', null, { severity: 'low', last_seen: null }),
    'F-04': f('Old toast', 'fixed'), 'F-05': f('Typo', 'fixed'), 'F-06': f('Maybe', 'not_real'), 'F-07': f('Slow', 'suppressed'),
  } }));
  assert.equal(text, [
    '## Needs you (1)',
    '',
    '| Finding | Severity | Status | Decision | Last seen |',
    '|---|---|---|---|---|',
    '| F-02 · Jargon \\| on landing | medium | still there | ask · agent · Rename it | [2026-10-12](.ux-assessment/runs/2026-10-12/report.md) |',
    '',
    '## Kept (1)',
    '',
    '| Finding | Severity | Status | Decision | Last seen |',
    '|---|---|---|---|---|',
    '| F-01 · Save is silent | high | open | keep · agent · docs/prd.md:42 | [2026-10-12](.ux-assessment/runs/2026-10-12/report.md) |',
    '',
    '## Not decided yet (1)',
    '',
    '| Finding | Severity | Status | Decision | Last seen |',
    '|---|---|---|---|---|',
    '| F-03 · Odd focus | low | open | not decided |  |',
    '',
    'Closed: 2 fixed · 1 not real · 1 won\'t fix',
    '',
    'Next: answer the findings under Needs you; run /ux-assessment:decide for Not decided yet.',
    '',
  ].join('\n'));
});

test('markdown: a human decision, the to-fix group and the awaiting-check group', () => {
  const text = boardMarkdown(boardGroups({ findings: {
    'F-01': f('A', 'open', { ...agent('fix'), by: 'human' }), 'F-02': f('B', 'not_seen'),
  } }));
  assert.match(text, /^## To fix \(1\)$/m);
  assert.match(text, /^\| F-01 · A \| medium \| open \| fix · human \| /m);
  assert.match(text, /^## Waiting for a check \(1\)$/m);
  assert.match(text, /^\| F-02 · B \| medium \| not seen this time \| not decided \| /m);
  assert.doesNotMatch(text, /Closed:/);
  assert.match(text, /\nNext: fix the findings under To fix, then verify them; verify again to confirm those under Waiting for a check\.\n$/);
});

test('markdown: nothing on the board', () => {
  assert.equal(boardMarkdown(boardGroups({ findings: {} })), 'No findings on the board.\n');
  assert.equal(boardMarkdown(boardGroups({ findings: { 'F-01': f('A', 'fixed') } })), 'Closed: 1 fixed\n\nNext: nothing to do.\n');
});

test('CLI: board prints the Markdown, --json prints the groups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-board-'));
  try {
    fs.mkdirSync(path.join(root, '.ux-assessment'));
    fs.writeFileSync(path.join(root, '.ux-assessment/ledger.yaml'), YAML.stringify({ version: 1, runs: {},
      findings: { 'F-01': f('Save is silent', 'open', agent('fix')) } }));
    const md = spawnSync(process.execPath, [LEDGER, 'board', root], { encoding: 'utf8' });
    assert.equal(md.status, 0);
    assert.match(md.stdout, /^## To fix \(1\)$/m);
    const json = spawnSync(process.execPath, [LEDGER, 'board', root, '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 0);
    const groups = JSON.parse(json.stdout);
    assert.deepEqual(groups.map((g) => g.key), ['needs_you', 'to_fix', 'kept', 'undecided', 'awaiting_check', 'closed']);
    assert.deepEqual(groups[1].rows, [{ id: 'F-01', title: 'Save is silent', severity: 'medium', status: 'open',
      decision: agent('fix'), last_seen: '2026-10-12' }]);
    const missing = spawnSync(process.execPath, [LEDGER, 'board', path.join(root, 'nope')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no ledger at .*; run: ledger\.mjs sync/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
