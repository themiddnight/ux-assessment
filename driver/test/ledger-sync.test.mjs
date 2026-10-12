import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { syncLedger, openFindings, verifyTable, statusLines, boardGroups } from '../ledger.mjs';

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

const DESIGN_FINDINGS = `- id: F-11
  title: "Primary button is low contrast"
  kind: ux
  severity: high
  evidence: [viewer/screenshots/v01.png]
  what_happened: "The Save label is hard to read."
`;

function seedDesignRun(p, name = '2026-09-26', runJson = { kind: 'design', started_at: '2026-09-26T08:00:00.000Z' }) {
  p.put(`runs/${name}/findings.yaml`, DESIGN_FINDINGS);
  p.put(`runs/${name}/run.json`, JSON.stringify(runJson));
  p.put(`runs/${name}/viewer/screenshots/v01.png`, 'png');
  p.put(`runs/${name}/viewer/design-log.jsonl`, `${JSON.stringify({ t: 1790400000000, frame: 'v01' })}\n`);
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
  assert.match(table, /\| F-01 · Save is silent \| not_reproduced \(step 2\) \| not seen this time \| \[screenshot\]\(F-01\/screenshots\/s03\.png\) \| toast \\\| shown \|/);
  assert.match(table, /\| F-02 · Jargon \\\| on landing \| not_reproduced \(no step: counted as unreachable\) \| open \|/);
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
  assert.match(verifyTable(p.root, '2026-09-28-verify'), /\| F-01 · Save is silent \| reproduced \|/);
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

const THAI = `- id: F-01
  title: "Save is silent"
  title_local: "บันทึกแล้วไม่มีอะไรบอก"
  kind: ux
  severity: medium
  evidence: []
- id: F-02
  title: "Jargon on landing"
  kind: ux
  severity: high
  evidence: []
`;

test('title_local is kept on the sighting and the finding, falls back to title, and status and table print it', () => {
  const p = makeProject();
  seedPersonaRun(p, '2026-09-25', THAI);
  verifyRun(p, '2026-09-26-verify', '2026-09-26T10:00:00.000Z', [{ id: 'F-01', verdict: 'reproduced', evidence: [], note: '' }]);
  syncLedger(p.root);
  const l = p.ledger();
  assert.equal(l.findings['F-01'].title_local, 'บันทึกแล้วไม่มีอะไรบอก');
  assert.equal(l.findings['F-01'].title, 'Save is silent');
  assert.equal(l.findings['F-01'].sightings[0].title_local, 'บันทึกแล้วไม่มีอะไรบอก');
  assert.equal(l.findings['F-02'].title_local, 'Jargon on landing');
  assert.equal(l.findings['F-02'].sightings[0].title_local, 'Jargon on landing');
  assert.match(statusLines(p.root), /^F-01\tstill_present\tบันทึกแล้วไม่มีอะไรบอก$/m);
  assert.match(statusLines(p.root), /^F-02\topen\tJargon on landing$/m);
  assert.match(verifyTable(p.root, '2026-09-26-verify'), /^\| F-01 · บันทึกแล้วไม่มีอะไรบอก \| reproduced \|/m);
});

const decisionsYaml = (run, decisions) => YAML.stringify({ run, decided_at: '2026-10-12T09:30:00.000Z', checked: true, decisions });
const KEEP = { id: 'F-01', decision: 'keep', reason: 'The PRD says so.', options: [],
  sources: [{ path: 'docs/prd.md', line: 42, quote: 'Save is silent on purpose' }], guard: null };
const ASK = { id: 'F-02', decision: 'ask', reason: 'Docs and code disagree.', options: ['Rename it', 'Keep the jargon'], sources: [], guard: null };

test('decision: the latest run that has one wins, by the run order; the shape is {value, by, reason, sources, options, run}', () => {
  const p = makeProject();
  seedPersonaRun(p);
  p.put('runs/2026-09-25/decisions.yaml', decisionsYaml('2026-09-25', [KEEP, ASK]));
  seedPersonaRun(p, '2026-09-28', RUN_0925, Date.parse('2026-09-28T08:00:00Z'));
  p.put('runs/2026-09-28/decisions.yaml', decisionsYaml('2026-09-28', [{ ...ASK, id: 'F-01', options: ['Add a toast'] }]));
  syncLedger(p.root);
  const l = p.ledger();
  assert.deepEqual(l.findings['F-01'].decision, { value: 'ask', by: 'agent', reason: 'Docs and code disagree.',
    sources: [], options: ['Add a toast'], run: '2026-09-28' });
  assert.deepEqual(l.findings['F-02'].decision, { value: 'ask', by: 'agent', reason: 'Docs and code disagree.',
    sources: [], options: ['Rename it', 'Keep the jargon'], run: '2026-09-25' });
  assert.equal(l.findings['E-01'].decision, null);
});

test('decision: a developer label wins; valid is fix, won\'t fix is keep, not real is none', () => {
  const p = makeProject();
  seedPersonaRun(p);
  p.put('runs/2026-09-25/decisions.yaml', decisionsYaml('2026-09-25', [KEEP, ASK, { ...ASK, id: 'E-01' }]));
  p.put('feedback.md', '## Run 2026-09-25\n- F-01 Save is silent — label: valid — note: users missed it\n'
    + "- F-02 Jargon — label: won't fix — note:\n- E-01 Shim — label: not real — note:\n");
  syncLedger(p.root);
  const l = p.ledger();
  assert.deepEqual(l.findings['F-01'].decision, { value: 'fix', by: 'human', reason: 'users missed it', sources: [], options: [], run: '2026-09-25' });
  assert.equal(l.findings['F-02'].decision.value, 'keep');
  assert.equal(l.findings['F-02'].decision.by, 'human');
  assert.equal(l.findings['E-01'].decision, null);
});

test('decision never changes the status; it survives a deleted run folder and stays idempotent', () => {
  const plain = makeProject();
  seedPersonaRun(plain);
  syncLedger(plain.root);
  const p = makeProject();
  seedPersonaRun(p);
  p.put('runs/2026-09-25/decisions.yaml', decisionsYaml('2026-09-25', [KEEP, ASK]));
  syncLedger(p.root);
  for (const id of ['F-01', 'F-02', 'E-01']) assert.equal(p.ledger().findings[id].status, plain.ledger().findings[id].status, id);
  const first = p.ledgerText();
  syncLedger(p.root);
  assert.equal(p.ledgerText(), first);
  fs.rmSync(path.join(p.root, '.ux-assessment/runs'), { recursive: true });
  syncLedger(p.root);
  assert.equal(p.ledger().findings['F-01'].decision.value, 'keep');
  assert.equal(p.ledger().findings['F-01'].decision.sources[0].path, 'docs/prd.md');
});

test('decision: removing decisions.yaml from a present run removes its decision; a value that is not fix, keep or ask is left out', () => {
  const p = makeProject();
  seedPersonaRun(p);
  p.put('runs/2026-09-25/decisions.yaml', decisionsYaml('2026-09-25', [KEEP, { ...ASK, decision: 'maybe' }]));
  syncLedger(p.root);
  assert.equal(p.ledger().findings['F-01'].decision.value, 'keep');
  assert.equal(p.ledger().findings['F-02'].decision, null);
  fs.rmSync(path.join(p.root, '.ux-assessment/runs/2026-09-25/decisions.yaml'));
  syncLedger(p.root);
  assert.equal(p.ledger().findings['F-01'].decision, null);
});

test('decision: a decisions.yaml that decide.mjs record did not mark checked is ignored with a warning, whatever its shape', () => {
  const p = makeProject();
  seedPersonaRun(p);
  const warning = 'runs/2026-09-25: decisions.yaml was not checked by decide.mjs record, ignored';
  for (const text of [YAML.stringify({ run: '2026-09-25', decisions: [KEEP, ASK] }), YAML.stringify([KEEP, ASK]),
    YAML.stringify({ run: '2026-09-25', checked: 'yes', decisions: [KEEP] })]) {
    p.put('runs/2026-09-25/decisions.yaml', text);
    const { warnings } = syncLedger(p.root);
    assert.ok(warnings.includes(warning), text);
    assert.equal(p.ledger().findings['F-01'].decision, null);
    assert.deepEqual(p.ledger().findings['F-01'].decisions, []);
  }
});

test('decision: a decision whose id is not among that run\'s findings is dropped, though an earlier run has that id (a later triage renumbered)', () => {
  const p = makeProject();
  seedPersonaRun(p);
  p.put('runs/2026-09-25/decisions.yaml', decisionsYaml('2026-09-25', [KEEP]));
  seedPersonaRun(p, '2026-09-28', RUN_0925.replace('id: F-02', 'id: F-05'), Date.parse('2026-09-28T08:00:00Z'));
  p.put('runs/2026-09-28/decisions.yaml', decisionsYaml('2026-09-28', [{ ...ASK, id: 'F-02' }, { ...ASK, id: 'F-05' }]));
  syncLedger(p.root);
  const l = p.ledger();
  assert.equal(l.findings['F-02'].decision, null);
  assert.deepEqual(l.findings['F-02'].decisions, []);
  assert.equal(l.findings['F-05'].decision.run, '2026-09-28');
  assert.equal(l.findings['F-01'].decision.value, 'keep');
});

test('a run whose run.json says kind design is recorded as design, with started_at from run.json and no log.jsonl needed', () => {
  const p = makeProject();
  seedDesignRun(p);
  const { warnings } = syncLedger(p.root);
  assert.deepEqual(warnings, []);
  const l = p.ledger();
  assert.deepEqual(l.runs, { '2026-09-26': { kind: 'design', started_at: '2026-09-26T08:00:00.000Z' } });
  assert.equal(l.findings['F-11'].last_seen, '2026-09-26');
  assert.equal(l.findings['F-11'].status, 'open');
  seedDesignRun(p, '2026-09-27', { kind: 'design' });
  syncLedger(p.root);
  assert.deepEqual(p.ledger().runs['2026-09-27'], { kind: 'design', started_at: null });
});

test('an app run whose run.json has no kind, or no run.json, is still recorded as persona and gains no new field', () => {
  const p = makeProject();
  seedPersonaRun(p);
  p.put('runs/2026-09-25/run.json', JSON.stringify({ url: 'http://localhost:3000/', started_at: '2026-09-25T07:00:00.000Z' }));
  seedPersonaRun(p, '2026-09-26');
  syncLedger(p.root);
  const l = p.ledger();
  assert.deepEqual(l.runs, { '2026-09-25': { kind: 'persona', started_at: '2026-09-25T07:00:00.000Z' },
    '2026-09-26': { kind: 'persona', started_at: new Date(1790300000000).toISOString() } });
  assert.deepEqual(Object.keys(l.findings['F-01']), ['title', 'title_local', 'kind', 'severity', 'status', 'label', 'decision', 'last_seen',
    'check', 'sightings', 'verifications', 'decisions']);
});

test('open and the board tell a design finding from an app finding; open leaves it out, even with --needs-review', () => {
  const p = makeProject();
  seedPersonaRun(p);
  seedDesignRun(p);
  syncLedger(p.root);
  assert.deepEqual(openFindings(p.root).map((f) => f.id), ['F-02', 'F-01']);
  assert.deepEqual(openFindings(p.root, { needsReview: true }).map((f) => f.id), ['F-02', 'F-01']);
  const rows = boardGroups(p.ledger()).find((g) => g.key === 'undecided').rows;
  assert.deepEqual(rows.map((r) => [r.id, r.run_kind]), [['F-02', undefined], ['F-11', 'design'], ['F-01', undefined]]);
});

test('sync is idempotent with an app run, a design run and a verify run together', () => {
  const p = makeProject();
  seedPersonaRun(p);
  seedDesignRun(p);
  verifyRun(p, '2026-09-28-verify', '2026-09-28T09:00:00.000Z', [{ id: 'F-01', verdict: 'reproduced', at_step: 2, evidence: [], note: '' }]);
  syncLedger(p.root);
  const first = p.ledgerText();
  syncLedger(p.root);
  assert.equal(p.ledgerText(), first);
  assert.deepEqual(Object.values(p.ledger().runs).map((r) => r.kind), ['persona', 'design', 'verify']);
});
