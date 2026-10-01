import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { extractVerdict, recordVerifyRun, checkStorageState } from '../verify.mjs';
import { syncLedger } from '../ledger.mjs';

const VERIFY = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const project = (t) => {
  const root = tempDir(t, 'uxa-verify-');
  const put = (rel, body) => {
    const file = path.join(root, '.ux-assessment', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  return { root, put };
};
/** Runs fn with process.stderr.write captured; returns [fn's result, the text written]. */
const withStderr = (fn) => {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { return [fn(), out]; } finally { process.stderr.write = orig; }
};

const block = (yaml) => `I reached the spot.\n\n\`\`\`yaml\n${yaml}\`\`\`\n`;

test('extractVerdict takes the last YAML block that has a verdict', () => {
  const text = '```yaml\nid: F-01\nverdict: reproduced\n```\nthen\n```yaml\nid: F-01\nverdict: not_reproduced\nat_step: 2\n```\n';
  assert.deepEqual(extractVerdict(text), { id: 'F-01', verdict: 'not_reproduced', at_step: 2 });
  assert.equal(extractVerdict('no block here'), null);
  assert.equal(extractVerdict('```yaml\nfoo: [\n```'), null);
});

test('extractVerdict accepts an upper-case YAML fence', () => {
  assert.deepEqual(extractVerdict('```YAML\nid: F-01\nverdict: reproduced\n```\n'), { id: 'F-01', verdict: 'reproduced' });
  assert.deepEqual(extractVerdict('```Yml\nverdict: changed\n```\n'), { verdict: 'changed' });
});

test('record writes verify.yaml with guards, and the ledger never counts a guarded not_reproduced', (t) => {
  const { root, put } = project(t);
  put('runs/2026-09-28/findings.yaml', ['F-01', 'F-02', 'F-03', 'F-04', 'F-05']
    .map((id) => `- id: ${id}\n  title: "${id} title"\n  kind: ux\n  severity: medium\n  evidence: []\n`).join(''));
  const run = 'runs/2026-09-28-verify';
  const log = (id, steps) => put(`${run}/${id}/log.jsonl`, steps.map((step, i) =>
    JSON.stringify({ t: 1790600000000 + i * 1000, step, screenshot: `screenshots/s0${i + 1}.png` })).join('\n') + '\n');
  log('F-01', [null, 1, 2]);
  put(`${run}/F-01/summary.md`, block('id: F-01\nverdict: not_reproduced\nat_step: 2\nevidence: ["step 2 shows the toast"]\nnote: fixed\n'));
  put(`${run}/F-01/codex-result.json`, JSON.stringify({ usage: { input_tokens: 8600, cached_input_tokens: 8000, cache_write_input_tokens: 0, output_tokens: 400, reasoning_output_tokens: 100 } }));
  log('F-02', [null, 1]);
  put(`${run}/F-02/summary.md`, block('id: F-02\nverdict: not_reproduced\nat_step: 7\nnote: looked fine\n'));
  log('F-03', [null]);
  put(`${run}/F-03/summary.md`, 'I could not decide.');
  log('F-04', [null, 1]);
  put(`${run}/F-04/summary.md`, block('id: F-04\nverdict: reproduced\nnote: still there\n'));
  put(`${run}/F-04/session.json`, JSON.stringify({ tokens: 12000 }));
  // preflight: the saved login had expired, no session was started
  put(`${run}/F-05/summary.md`, block('id: F-05\nverdict: unreachable\nnote: "saved login expired (preflight)"\n'));

  const doc = recordVerifyRun(root, '2026-09-28-verify', { cli: 'codex', url: 'http://localhost:3000/' });
  const by = Object.fromEntries(doc.results.map((r) => [r.id, r]));
  assert.equal(doc.started_at, new Date(1790600000000).toISOString());
  assert.deepEqual([by['F-01'].verdict, by['F-01'].at_step, by['F-01'].at_screenshot, by['F-01'].tokens, by['F-01'].guard],
    ['not_reproduced', 2, 'F-01/screenshots/s03.png', 9000, null]);
  assert.deepEqual([by['F-02'].verdict, by['F-02'].at_step], ['not_reproduced', null]);
  assert.match(by['F-02'].guard, /at_step 7 is not a step with a screenshot in F-02\/log\.jsonl/);
  assert.deepEqual([by['F-03'].verdict, by['F-03'].guard], ['unreachable', 'no verdict block in the verifier reply']);
  assert.deepEqual([by['F-04'].verdict, by['F-04'].tokens], ['reproduced', 12000]);
  assert.deepEqual([by['F-05'].verdict, by['F-05'].steps], ['unreachable', 0]);
  const onDisk = YAML.parse(fs.readFileSync(path.join(root, '.ux-assessment', run, 'verify.yaml'), 'utf8'));
  assert.equal(onDisk.results.length, 5);

  syncLedger(root);
  const ledger = YAML.parse(fs.readFileSync(path.join(root, '.ux-assessment/ledger.yaml'), 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(ledger.findings).map(([id, e]) => [id, e.status])),
    { 'F-01': 'not_seen', 'F-02': 'open', 'F-03': 'open', 'F-04': 'still_present', 'F-05': 'open' });

  // re-recording keeps the first started_at
  assert.equal(recordVerifyRun(root, '2026-09-28-verify', {}).started_at, doc.started_at);
});

test('record guards: no reply, unknown verdict, a reply naming another id, not_reproduced without at_step', (t) => {
  const { root, put } = project(t);
  const run = 'runs/2026-09-29-verify';
  const log = (id) => put(`${run}/${id}/log.jsonl`, `${JSON.stringify({ t: 1790700000000, step: null, screenshot: 'screenshots/s01.png' })}\n`);
  log('F-01'); // a session ran, but the verifier wrote no summary.md
  log('F-02');
  put(`${run}/F-02/summary.md`, block('id: F-02\nverdict: maybe\nnote: unsure\n'));
  log('F-03');
  put(`${run}/F-03/summary.md`, block('id: F-09\nverdict: reproduced\nnote: still there\n'));
  log('F-04');
  put(`${run}/F-04/summary.md`, block('id: F-04\nverdict: not_reproduced\nnote: looked fine\n'));
  const by = Object.fromEntries(recordVerifyRun(root, '2026-09-29-verify').results.map((r) => [r.id, r]));
  assert.deepEqual([by['F-01'].verdict, by['F-01'].guard], ['unreachable', 'no verifier reply']);
  assert.deepEqual([by['F-02'].verdict, by['F-02'].guard, by['F-02'].note], ['unreachable', 'unknown verdict "maybe"', 'unsure']);
  assert.deepEqual([by['F-03'].verdict, by['F-03'].guard], ['reproduced', 'reply names F-09; recorded under its session folder F-03']);
  assert.deepEqual([by['F-04'].verdict, by['F-04'].at_step, by['F-04'].guard], ['not_reproduced', null, 'not_reproduced without at_step']);
});

test('record: a malformed session.json or codex-result.json warns with its path and leaves tokens null', (t) => {
  const { root, put } = project(t);
  const run = 'runs/2026-09-29-verify';
  put(`${run}/F-01/summary.md`, block('id: F-01\nverdict: reproduced\n'));
  put(`${run}/F-01/session.json`, '{"tokens": 21,000}');
  put(`${run}/F-02/summary.md`, block('id: F-02\nverdict: reproduced\n'));
  put(`${run}/F-02/codex-result.json`, '{"cli": {"tokens": 21,000}}');
  const [doc, stderr] = withStderr(() => recordVerifyRun(root, '2026-09-29-verify'));
  assert.deepEqual(doc.results.map((r) => [r.id, r.verdict, r.tokens]), [['F-01', 'reproduced', null], ['F-02', 'reproduced', null]]);
  assert.match(stderr, /verify: warning: .*runs\/2026-09-29-verify\/F-01\/session\.json is not valid JSON; tokens left empty/);
  assert.match(stderr, /verify: warning: .*runs\/2026-09-29-verify\/F-02\/codex-result\.json is not valid JSON; tokens left empty/);
});

test('record: session.json context_tokens (new) or tokens (older runs) fill tokens', (t) => {
  const { root, put } = project(t);
  const run = 'runs/2026-09-29-verify';
  put(`${run}/F-01/summary.md`, block('id: F-01\nverdict: reproduced\n'));
  put(`${run}/F-01/session.json`, JSON.stringify({ context_tokens: 15000, tool_uses: 9, duration_s: 80 }));
  put(`${run}/F-02/summary.md`, block('id: F-02\nverdict: reproduced\n'));
  put(`${run}/F-02/session.json`, JSON.stringify({ tokens: 12000 }));
  const [doc] = withStderr(() => recordVerifyRun(root, '2026-09-29-verify'));
  assert.deepEqual(doc.results.map((r) => [r.id, r.tokens]), [['F-01', 15000], ['F-02', 12000]]);
});

test('record: a malformed earlier verify.yaml aborts with its path and is left untouched', (t) => {
  const { root, put } = project(t);
  put('runs/2026-09-29-verify/F-01/summary.md', block('id: F-01\nverdict: reproduced\n'));
  put('runs/2026-09-29-verify/verify.yaml', 'run: x\nresults: [\n');
  const file = path.join(root, '.ux-assessment/runs/2026-09-29-verify/verify.yaml');
  assert.throws(() => recordVerifyRun(root, '2026-09-29-verify'),
    (e) => e.message.includes(file) && /cannot read the earlier verify\.yaml/.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), 'run: x\nresults: [\n');
});

test('re-record without log.jsonl (gitignored, fresh clone) keeps the earlier at_step and screenshot', (t) => {
  const { root, put } = project(t);
  const run = 'runs/2026-09-29-verify';
  put(`${run}/F-01/log.jsonl`, [null, 1, 2].map((step, i) =>
    JSON.stringify({ t: 1790700000000 + i, step, screenshot: `screenshots/s0${i + 1}.png` })).join('\n') + '\n');
  put(`${run}/F-01/summary.md`, block('id: F-01\nverdict: not_reproduced\nat_step: 2\n'));
  const first = recordVerifyRun(root, '2026-09-29-verify', { cli: 'claude', url: 'http://localhost:3000/' }).results[0];
  assert.deepEqual([first.at_step, first.at_screenshot, first.steps, first.guard], [2, 'F-01/screenshots/s03.png', 2, null]);
  fs.rmSync(path.join(root, '.ux-assessment', run, 'F-01/log.jsonl'));
  const again = recordVerifyRun(root, '2026-09-29-verify');
  assert.deepEqual([again.results[0].at_step, again.results[0].at_screenshot, again.results[0].steps, again.results[0].guard],
    [2, 'F-01/screenshots/s03.png', 2, null]);
  assert.deepEqual([again.cli, again.url], ['claude', 'http://localhost:3000/']);
  // a different step than the one recorded cannot be checked without the log: guarded
  put(`${run}/F-01/summary.md`, block('id: F-01\nverdict: not_reproduced\nat_step: 1\n'));
  const changed = recordVerifyRun(root, '2026-09-29-verify').results[0];
  assert.deepEqual([changed.at_step, changed.at_screenshot], [null, null]);
  assert.match(changed.guard, /at_step 1 is not a step with a screenshot in F-01\/log\.jsonl/);
});

test('--run is a folder name: a value with a path separator fails with a clear message', async (t) => {
  const { root, put } = project(t);
  put('runs/2026-09-29-verify/F-01/summary.md', block('id: F-01\nverdict: reproduced\n'));
  for (const bad of ['runs/2026-09-29-verify', '.ux-assessment/runs/2026-09-29-verify', '..', '2026-09-29-verify\\x']) {
    assert.throws(() => recordVerifyRun(root, bad), /--run takes the run folder name, such as 2026-09-29-verify/);
  }
  const cli = await promisify(execFile)(process.execPath, [VERIFY, 'record', root, '--run', 'runs/2026-09-29-verify'])
    .then(() => null, (e) => e);
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /--run takes the run folder name, such as 2026-09-29-verify, not a path \(got "runs\/2026-09-29-verify"\)/);
});

test('check-state: an expired saved login is reported before any session starts', (t) => {
  const dir = tempDir(t, 'uxa-state-');
  const file = path.join(dir, 'main.json');
  const now = Date.parse('2026-09-28T12:00:00Z');
  const cookie = (expires) => ({ name: 'sid', value: 'x', domain: 'localhost', path: '/', expires, httpOnly: true, secure: false, sameSite: 'Lax' });
  const origins = [{ origin: 'http://localhost:3000', localStorage: [] }];
  fs.writeFileSync(file, JSON.stringify({ cookies: [cookie(now / 1000 - 60)], origins }));
  assert.deepEqual(checkStorageState(file, 'http://localhost:3000/app', now), { ok: false, reason: 'expired' });
  fs.writeFileSync(file, JSON.stringify({ cookies: [cookie(now / 1000 - 60), cookie(-1)], origins }));
  assert.equal(checkStorageState(file, 'http://localhost:3000/app', now).ok, true); // a session cookie may still work
  fs.writeFileSync(file, JSON.stringify({ cookies: [cookie(now / 1000 + 3600)], origins }));
  assert.deepEqual(checkStorageState(file, 'http://localhost:3000/', now), { ok: true, expires_at: '2026-09-28T13:00:00.000Z' });
  assert.deepEqual(checkStorageState(file, 'http://127.0.0.1:3000/', now), { ok: false, reason: 'origin_mismatch' });
  assert.deepEqual(checkStorageState(path.join(dir, 'none.json'), 'http://localhost:3000/', now), { ok: false, reason: 'missing' });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(checkStorageState(file, 'http://localhost:3000/', now), { ok: false, reason: 'unreadable' });
});
