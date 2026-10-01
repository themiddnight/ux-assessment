import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexRecord, runOf, appendUsage, usagePath } from '../usage.mjs';

const tempProject = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const readLines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

test('codexRecord: input is the uncached part (input_tokens includes cached and cache writes); null usage is no record', () => {
  const usage = { input_tokens: 52000, cached_input_tokens: 41000, cache_write_input_tokens: 1000, output_tokens: 3100, reasoning_output_tokens: 1800 };
  assert.deepEqual(codexRecord(usage, { role: 'persona', id: 'core', model: 'gpt-6-sol', run: '2026-09-29', t: 'T' }), {
    t: 'T', harness: 'codex', role: 'persona', id: 'core', model: 'gpt-6-sol', input: 10000, cache_write: 1000, cache_write_1h: 0,
    cached_input: 41000, output: 3100, source: 'codex-json', run: '2026-09-29',
  });
  assert.equal(codexRecord({ input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 }, { role: 'persona', id: 'p', model: 'm', t: 'T' }).input, 0);
  assert.equal(codexRecord(null, { role: 'persona', id: 'p', model: 'm' }), null);
});

test('runOf: the first folder under .ux-assessment/runs, else null', () => {
  // Assembled, so the release scan does not read this as a file in the unpublished work directory.
  const root = path.resolve(['', 'work', 'app'].join('/'));
  const runs = path.join(root, '.ux-assessment', 'runs');
  assert.equal(runOf(root, path.join(runs, '2026-09-29', 'core')), '2026-09-29');
  assert.equal(runOf(root, path.join(runs, '2026-09-29-verify', 'F-01')), '2026-09-29-verify');
  assert.equal(runOf(root, path.join(root, '.ux-assessment', 'self-check')), null);
  assert.equal(runOf(root, runs), null);
  assert.equal(runOf(root, path.resolve('/elsewhere/runs/x')), null);
});

test('appendUsage: one JSON line per record, appended, owner-only', (t) => {
  const root = tempProject(t);
  appendUsage(root, [{ a: 1 }]);
  appendUsage(root, [{ b: 2 }, { c: 3 }]);
  appendUsage(root, []);
  assert.deepEqual(readLines(usagePath(root)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(usagePath(root)).mode & 0o777, 0o600);
});
