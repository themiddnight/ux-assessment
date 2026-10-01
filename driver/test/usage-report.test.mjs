import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { priceOf, dollarsOf, dollarLine, selectRun, formatTokens, formatReport, reportFor, readUsage, appendUsage, usagePath, CLAUDE_OUTPUT_NOTE } from '../usage.mjs';

const USAGE = fileURLToPath(new URL('../usage.mjs', import.meta.url));
const rec = (over) => ({ t: '2026-09-29T10:00:00Z', harness: 'claude', role: 'persona', id: 'core', model: 'claude-sonnet-5-5', input: 0, cache_write: 0,
  cache_write_1h: 0, cached_input: 0, output: 0, source: 'hook', run: '2026-09-29', ...over });
const RECORDS = [
  rec({ input: 8, cache_write: 1200, cached_input: 41000, output: 170 }),
  rec({ input: 10, cache_write: 1500, cached_input: 60000, output: 200 }), // the same persona after its follow-up: the later snapshot
  rec({ id: 'casual', input: 5, cache_write: 500, cached_input: 30000, output: 100 }),
  rec({ role: 'orchestrator', id: 's-main', model: 'claude-opus-5-5', input: 14, cache_write: 5800, cached_input: 5000, output: 400 }),
  rec({ role: 'triage', id: 'a9', model: 'claude-opus-5-5', input: 20, cache_write: 60000, cached_input: 700000, output: 24000 }),
  rec({ harness: 'codex', source: 'codex-json', model: 'gpt-6-sol', run: '2026-09-28', input: 999 }),
];

test('priceOf: exact id, alias, date suffix; unknown is null', () => {
  assert.deepEqual(priceOf('claude-sonnet-5-5'), { input: 2, cw5m: 2.5, cw1h: 4, cached: 0.2, output: 10 });
  assert.equal(priceOf('sonnet'), priceOf('claude-sonnet-5-5'));
  assert.equal(priceOf('claude-sonnet-5-5-20260901'), priceOf('claude-sonnet-5-5'));
  assert.deepEqual(priceOf('gpt-6-luna'), { input: 0.1, cached: 0.01, output: 0.5 });
  assert.equal(priceOf('gpt-7'), null);
  assert.equal(priceOf(null), null);
});

test('dollars: 5-minute and 1-hour cache writes priced apart; Codex cache writes at the input price; unpriced models named', () => {
  const sonnet = rec({ input: 1e6, cache_write: 1e6, cache_write_1h: 5e5, cached_input: 1e6, output: 1e5 });
  assert.equal(dollarsOf(sonnet).toFixed(4), '6.4500'); // 2 + 0.5×2.5 + 0.5×4 + 0.2 + 1
  const sol = rec({ harness: 'codex', model: 'gpt-6-sol', input: 1e6, cache_write: 1e5, cached_input: 1e6, output: 1e5 });
  assert.equal(dollarsOf(sol).toFixed(4), '3.4000'); // 2 + 0.1×2 + 0.2 + 1
  assert.equal(dollarsOf(rec({ model: 'gpt-7', input: 1e6 })), null);
  assert.equal(dollarLine([sonnet, sol, rec({ model: 'gpt-7', input: 1 })]),
    'API-equivalent at list prices on 2026-09-29: $9.85; left out (no listed price): gpt-7');
});

test('selectRun: one run; hook records are cumulative (last per role, id, model); codex records add up', () => {
  const codex = rec({ harness: 'codex', source: 'codex-json', model: 'gpt-6-sol', input: 1 });
  const picked = selectRun([...RECORDS, codex, { ...codex }], '2026-09-29');
  assert.equal(picked.filter((r) => r.role === 'persona' && r.id === 'core' && r.harness === 'claude').length, 1);
  assert.equal(picked.find((r) => r.id === 'core' && r.harness === 'claude').input, 10);
  assert.equal(picked.filter((r) => r.source === 'codex-json').length, 2);
  assert.equal(picked.some((r) => r.run !== '2026-09-29'), false);
});

test('formatTokens', () => {
  assert.deepEqual([0, 999, 1000, 5814, 999949, 1230000].map(formatTokens), ['0', '999', '1.0k', '5.8k', '999.9k', '1.23M']);
});

test('formatTokens never prints 1000.0k: values that round up to 1000k move to millions', () => {
  assert.deepEqual([999950, 999999, 1e6].map(formatTokens), ['1.00M', '1.00M', '1.00M']);
});

test('formatReport: role × model table, totals per model, notes and the dollar line', () => {
  const lines = formatReport(RECORDS, '2026-09-29').split('\n');
  assert.deepEqual(lines.slice(0, 12), [
    '| role | model | sessions | input | cached input | output |',
    '|---|---|---|---|---|---|',
    '| orchestrator | claude-opus-5-5 | 1 | 5.8k | 5.0k | 400 |',
    '| persona | claude-sonnet-5-5 | 2 | 2.0k | 90.0k | 300 |',
    '| triage | claude-opus-5-5 | 1 | 60.0k | 700.0k | 24.0k |',
    '| **total** | claude-opus-5-5 | 2 | 65.8k | 705.0k | 24.4k |',
    '| **total** | claude-sonnet-5-5 | 2 | 2.0k | 90.0k | 300 |',
    '',
    'Input includes cache writes; output includes reasoning tokens.',
    CLAUDE_OUTPUT_NOTE,
    'Orchestrator: the whole conversation, recorded when a turn ends; run this report again after the conversation ends for the final figure.',
    lines[11],
  ]);
  assert.match(lines[11], /^API-equivalent at list prices on 2026-09-29: \$\d+\.\d{2}$/);
  assert.equal(lines.length, 12);
});

test('formatReport: no orchestrator row says not measured; no records says so', () => {
  const codexOnly = [rec({ harness: 'codex', source: 'codex-json', model: 'gpt-6-sol', input: 100 })];
  assert.match(formatReport(codexOnly, '2026-09-29'), /\nOrchestrator: not recorded yet .*run this report again afterwards.*\n/);
  assert.equal(formatReport(codexOnly, '2026-09-29').includes(CLAUDE_OUTPUT_NOTE), false, 'Codex usage is exact: no Claude caveat');
  assert.equal(formatReport(RECORDS, '2026-09-30'), 'No usage records for run 2026-09-30: tokens not measured.');
});

test('readUsage skips blank and broken lines, CRLF included; reportFor needs a run folder', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  appendUsage(root, RECORDS);
  fs.appendFileSync(usagePath(root), '\r\n{broken\r\n');
  assert.equal(readUsage(root).length, RECORDS.length);
  const runFolder = path.join(root, '.ux-assessment', 'runs', '2026-09-29');
  assert.equal(reportFor(runFolder), formatReport(RECORDS, '2026-09-29'));
  assert.throws(() => reportFor(root), (e) => /is not a run folder \(<project>\/\.ux-assessment\/runs\/<name>\)/.test(e.message));
  const r = spawnSync(process.execPath, [USAGE, 'report', runFolder], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.replace(/\r\n/g, '\n'), `${formatReport(RECORDS, '2026-09-29')}\n`);
});
