import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { syncLedger, openFindings, verifyTable, statusLines } from '../ledger.mjs';

const LEDGER = fileURLToPath(new URL('../ledger.mjs', import.meta.url));

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-ledger-'));
  const put = (rel, body) => {
    const file = path.join(root, '.ux-assessment', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const ledgerText = () => fs.readFileSync(path.join(root, '.ux-assessment/ledger.yaml'), 'utf8');
  return { root, put, ledgerText, ledger: () => YAML.parse(ledgerText()) };
}

const RUN_0925 = `# Triage of run 2026-09-25
- id: F-01
  title: "Save is silent"
  kind: ux
  severity: medium
  personas: [phone]
  evidence: [phone/screenshots/s03.png, "phone log step 2"]
  what_happened: "Pressed Save; nothing said it worked."
- id: F-02
  title: "Jargon | on landing"
  category: ux
  severity: high
  evidence: [desk/screenshots/s01.png]
  what_happened: "Landing is a synth panel."
- id: E-01
  title: "Shim artefact"
  kind: env_error
  severity: low
  evidence: []
`;

function seedPersonaRun(p, name = '2026-09-25', body = RUN_0925, t = 1790300000000) {
  p.put(`runs/${name}/findings.yaml`, body);
  p.put(`runs/${name}/phone/screenshots/s03.png`, 'png');
  p.put(`runs/${name}/desk/screenshots/s01.png`, 'png');
  p.put(`runs/${name}/phone/log.jsonl`, `${JSON.stringify({ t, step: null, screenshot: 'screenshots/s01.png' })}\n`);
  p.put(`runs/${name}/phone/signals.jsonl`, `${JSON.stringify({ t, step: 0, type: 'setup',
    url: 'http://localhost:3000/items?view=list', viewport: { width: 360, height: 640 } })}\n`);
}

const verifyRun = (p, name, startedAt, results) =>
  p.put(`runs/${name}/verify.yaml`, YAML.stringify({ run: name, started_at: startedAt, results }));

test('sync builds the ledger from runs and feedback; open lists ux findings with absolute evidence', () => {
  const p = makeProject();
  seedPersonaRun(p);
  p.put('feedback.md', '# Finding labels\n\n## Run 2026-09-25 (runs/2026-09-25/report.md)\n'
    + '- F-01 Save is silent — label: valid — note:\n- F-02 Jargon on landing — label: ? — note:\n');
  const { warnings } = syncLedger(p.root);
  assert.deepEqual(warnings, []);
  const l = p.ledger();
  assert.deepEqual(Object.keys(l.findings), ['E-01', 'F-01', 'F-02']);
  assert.equal(l.findings['F-01'].status, 'open');
  assert.deepEqual(l.findings['F-01'].label, { value: 'valid', note: '', run: '2026-09-25' });
  assert.equal(l.runs['2026-09-25'].started_at, new Date(1790300000000).toISOString());
  const open = openFindings(p.root);
  assert.deepEqual(open.map((f) => f.id), ['F-02', 'F-01']); // high before medium; env_error never
  assert.deepEqual(open[1].screenshots, [path.join(p.root, '.ux-assessment/runs/2026-09-25/phone/screenshots/s03.png')]);
  assert.deepEqual(open[1].session, { device: 'mobile-small', url: 'http://localhost:3000/items?view=list',
    start_state: 'newcomer', account: null, storage_state: null });
  assert.equal(open[1].check, null);
  assert.equal(open[0].session.device, 'desktop'); // no signals for this persona: default
});

test('sync is idempotent', () => {
  const p = makeProject();
  seedPersonaRun(p);
  verifyRun(p, '2026-09-26-verify', '2026-09-26T10:00:00.000Z',
    [{ id: 'F-01', verdict: 'reproduced', at_step: 2, evidence: ['s03'], note: 'still silent' }]);
  syncLedger(p.root);
  const first = p.ledgerText();
  syncLedger(p.root);
  assert.equal(p.ledgerText(), first);
});

test('a deleted run folder keeps its history, labels and status', () => {
  const p = makeProject();
  seedPersonaRun(p);
  p.put('feedback.md', '## Run 2026-09-25\n- F-02 Jargon — label: not real — note: intended\n');
  verifyRun(p, '2026-09-26-verify', '2026-09-26T10:00:00.000Z',
    [{ id: 'F-01', verdict: 'not_reproduced', at_step: 1, evidence: [], note: '' }]);
  syncLedger(p.root);
  fs.rmSync(path.join(p.root, '.ux-assessment/runs'), { recursive: true });
  fs.rmSync(path.join(p.root, '.ux-assessment/feedback.md'));
  syncLedger(p.root);
  const l = p.ledger();
  assert.deepEqual(l.findings['F-01'].sightings.map((s) => s.run), ['2026-09-25']);
  assert.equal(l.findings['F-01'].status, 'not_seen');
  assert.equal(l.findings['F-02'].status, 'not_real');
  assert.deepEqual(Object.keys(l.runs), ['2026-09-25', '2026-09-26-verify']);
});

test('not seen, then fixed after two same-day verify runs, then regressed on a new sighting', () => {
  const p = makeProject();
  seedPersonaRun(p);
  const clean = [{ id: 'F-01', verdict: 'not_reproduced', at_step: 2, evidence: [], note: 'toast shown' }];
  verifyRun(p, '2026-09-28-verify', '2026-09-28T09:00:00.000Z', clean);
  syncLedger(p.root);
  assert.equal(p.ledger().findings['F-01'].status, 'not_seen');
  // a persona run that does not list F-01 counts for nothing
  seedPersonaRun(p, '2026-09-28-2', '- id: F-02\n  title: "Jargon"\n  kind: ux\n  severity: high\n  evidence: []\n',
    Date.parse('2026-09-28T11:00:00Z'));
  verifyRun(p, '2026-09-28-verify-2', '2026-09-28T12:00:00.000Z', clean);
  syncLedger(p.root);
  assert.equal(p.ledger().findings['F-01'].status, 'fixed');
  seedPersonaRun(p, '2026-09-29', RUN_0925, Date.parse('2026-09-29T08:00:00Z'));
  syncLedger(p.root);
  assert.equal(p.ledger().findings['F-01'].status, 'regressed');
  assert.deepEqual(Object.keys(p.ledger().runs),
    ['2026-09-25', '2026-09-28-verify', '2026-09-28-2', '2026-09-28-verify-2', '2026-09-29']);
});

test('re-triage of a present run replaces its sightings; a check from triage wins over derived facts', () => {
  const p = makeProject();
  seedPersonaRun(p);
  syncLedger(p.root);
  p.put('runs/2026-09-25/findings.yaml', `- id: F-01
  title: "Save is silent"
  kind: ux
  severity: medium
  evidence: [phone/screenshots/s03.png]
  what_happened: "Pressed Save; nothing said it worked."
  check: {device: desktop, start_state: newcomer, where: "the logo menu, Save", condition: "no message appears after Save"}
`);
  syncLedger(p.root);
  const l = p.ledger();
  assert.equal(l.findings['F-02'], undefined); // no sightings and no verifications left
  const [f1] = openFindings(p.root);
  assert.equal(f1.check.where, 'the logo menu, Save');
  assert.equal(f1.session.device, 'desktop');
  assert.equal(f1.session.url, 'http://localhost:3000/items?view=list');
});

test('table and status render the ledger; the CLI reports odd folders on stderr', async () => {
  const p = makeProject();
  seedPersonaRun(p);
  verifyRun(p, '2026-09-28-verify', '2026-09-28T09:00:00.000Z', [
    { id: 'F-01', verdict: 'not_reproduced', at_step: 2, at_screenshot: 'F-01/screenshots/s03.png', evidence: [], note: 'toast | shown' },
    { id: 'F-02', verdict: 'not_reproduced', at_step: null, evidence: [], note: '' },
  ]);
  p.put('runs/scratch/notes.txt', 'x');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [LEDGER, 'sync', p.root]);
  assert.match(stdout, /^3 findings, 2 runs$/m);
  assert.match(stderr, /ledger: warning: runs\/scratch: not a YYYY-MM-DD\[-suffix\] name, skipped/);
  const table = verifyTable(p.root, '2026-09-28-verify');
  assert.match(table, /^\| Finding \| Verdict \| Status now \| Evidence \| Note \|$/m);
  assert.match(table, /\| F-01 Save is silent \| not_reproduced \(step 2\) \| not seen this time \| \[screenshot\]\(F-01\/screenshots\/s03\.png\) \| toast \\\| shown \|/);
  assert.match(table, /\| F-02 Jargon \\\| on landing \| not_reproduced \(no step: counted as unreachable\) \| open \|/);
  assert.match(statusLines(p.root), /^F-01\tnot_seen\tSave is silent$/m);
  // non-ux records show their kind, not a status: they are never verified
  assert.match(statusLines(p.root), /^E-01\tenv_error\tShim artefact$/m);
  assert.throws(() => verifyTable(p.root, '2026-09-30-verify'), /no verifications for run 2026-09-30-verify/);
});

test('open drops evidence paths that escape .ux-assessment, with a warning on stderr', () => {
  const p = makeProject();
  seedPersonaRun(p, '2026-09-25', RUN_0925.replace('evidence: [phone/screenshots/s03.png, "phone log step 2"]',
    'evidence: ["../../../secret.png", "runs/../../secret.png", phone/screenshots/s03.png]'));
  fs.writeFileSync(path.join(p.root, 'secret.png'), 'private');
  syncLedger(p.root);
  const orig = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  let open;
  try { open = openFindings(p.root); } finally { process.stderr.write = orig; }
  const f1 = open.find((f) => f.id === 'F-01');
  assert.deepEqual(f1.screenshots, [path.join(p.root, '.ux-assessment/runs/2026-09-25/phone/screenshots/s03.png')]);
  assert.match(stderr, /ledger: warning: F-01 evidence "\.\.\/\.\.\/\.\.\/secret\.png" is outside \.ux-assessment, dropped/);
  assert.match(stderr, /ledger: warning: F-01 evidence "runs\/\.\.\/\.\.\/secret\.png" is outside \.ux-assessment, dropped/);
});

test('table --run is a folder name: a path fails with a clear message', async () => {
  const p = makeProject();
  seedPersonaRun(p);
  verifyRun(p, '2026-09-28-verify', '2026-09-28T09:00:00.000Z', [{ id: 'F-01', verdict: 'reproduced', evidence: [], note: '' }]);
  syncLedger(p.root);
  assert.throws(() => verifyTable(p.root, 'runs/2026-09-28-verify'), /--run takes the run folder name, such as 2026-09-29-verify, not a path/);
  const cli = await promisify(execFile)(process.execPath, [LEDGER, 'table', p.root, '--run', '.ux-assessment/runs/2026-09-28-verify'])
    .then(() => null, (e) => e);
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /--run takes the run folder name, such as 2026-09-29-verify, not a path/);
  assert.match(verifyTable(p.root, '2026-09-28-verify'), /\| F-01 Save is silent \| reproduced \|/);
});

test('open --needs-review adds the needs_review findings a user may Pick; plain open leaves them out', async () => {
  const p = makeProject();
  seedPersonaRun(p);
  verifyRun(p, '2026-09-28-verify', '2026-09-28T09:00:00.000Z', [{ id: 'F-01', verdict: 'changed', evidence: [], note: 'new layout' }]);
  syncLedger(p.root);
  assert.deepEqual(openFindings(p.root).map((f) => f.id), ['F-02']);
  const both = openFindings(p.root, { needsReview: true });
  assert.deepEqual(both.map((f) => [f.id, f.status]), [['F-02', 'open'], ['F-01', 'needs_review']]);
  assert.equal(both[1].screenshots.length, 1);
  const { stdout } = await promisify(execFile)(process.execPath, [LEDGER, 'open', p.root, '--needs-review']);
  assert.deepEqual(JSON.parse(stdout).map((f) => f.id), ['F-02', 'F-01']);
});
