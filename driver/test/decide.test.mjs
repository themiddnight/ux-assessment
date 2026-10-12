import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parseFeedback } from '../ledger.mjs';
import { syncLedger } from '../ledger.mjs';
import { DEFAULT_DOCS, resolveDocs, decideConfig, todoFindings, checkDecisions, suggestText, withSuggestions, decisionsTable } from '../decide.mjs';

const DECIDE = fileURLToPath(new URL('../decide.mjs', import.meta.url));
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-decide-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
};
/** A project folder with a put(rel, body) that creates parents; rel is under the project root. */
const project = (t) => {
  const root = tempDir(t);
  const put = (rel, body = 'x\n') => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  return { root, put, ux: (rel, body) => put(path.join('.ux-assessment', rel), body) };
};

// Paths in the driver's output use forward slashes on every OS.
const slashed = (p) => p.split(path.sep).join('/');

test('the default list', () => {
  assert.deepEqual(DEFAULT_DOCS, ['AGENTS.md', 'CLAUDE.md', 'README*', 'SPEC.md', 'PRD*', 'docs/**', '.ux-assessment/docs/**']);
});

test('resolveDocs: the defaults find documents only, sorted, never inside node_modules, .git or .ux-assessment, except the saved documents', (t) => {
  const p = project(t);
  for (const rel of ['AGENTS.md', 'README.md', 'README', 'SPEC.md', 'PRD-v2.md', 'PRD', 'notes.md', 'docs/b.md', 'docs/a/deep.mdx', 'docs/z.txt',
    'docs/guide.rst', 'docs/logo.png', 'docs/node_modules/x.md', 'node_modules/pkg/README.md', '.git/docs/y.md', '.ux-assessment/docs/z.md', '.ux-assessment/docs/logo.png', '.ux-assessment/charter.md', '.ux-assessment/runs/r/report.md']) p.put(rel);
  assert.deepEqual(resolveDocs(p.root, DEFAULT_DOCS, { quiet: true }), {
    files: ['.ux-assessment/docs/z.md', 'AGENTS.md', 'PRD-v2.md', 'README.md', 'SPEC.md', 'docs/a/deep.mdx', 'docs/b.md', 'docs/guide.rst', 'docs/z.txt'], warnings: [] });
  assert.deepEqual(resolveDocs(p.root, ['.ux-assessment/docs']).files, ['.ux-assessment/docs/z.md']);
  assert.deepEqual(resolveDocs(p.root, ['.ux-assessment/runs', '.ux-assessment']).files, []);
});

test('resolveDocs: a file, a folder (recursive), a glob; duplicates once; a symlink to a listed file once', (t) => {
  const p = project(t);
  for (const rel of ['SPEC.md', 'docs/a.md', 'docs/sub/b.md', 'docs/sub/c.txt', 'specs/one.md', 'specs/deep/two.md', 'top.md']) p.put(rel);
  fs.symlinkSync('SPEC.md', path.join(p.root, 'CLAUDE.md'));
  assert.deepEqual(resolveDocs(p.root, ['SPEC.md', 'docs', 'docs/']).files, ['SPEC.md', 'docs/a.md', 'docs/sub/b.md', 'docs/sub/c.txt']);
  assert.deepEqual(resolveDocs(p.root, ['specs/*.md']).files, ['specs/one.md']);
  assert.deepEqual(resolveDocs(p.root, ['specs/**/*.md']).files, ['specs/deep/two.md', 'specs/one.md']);
  assert.deepEqual(resolveDocs(p.root, ['**/*.md']).files, ['CLAUDE.md', 'docs/a.md', 'docs/sub/b.md', 'specs/deep/two.md', 'specs/one.md', 'top.md']);
  assert.deepEqual(resolveDocs(p.root, ['SPEC.md', 'CLAUDE.md']).files, ['CLAUDE.md']); // same file: the first by name
});

test('resolveDocs: an absolute path outside the project stays absolute; a missing non-default entry warns', (t) => {
  const p = project(t);
  const other = tempDir(t);
  fs.mkdirSync(path.join(other, 'brand'));
  fs.writeFileSync(path.join(other, 'brand/voice.md'), 'x');
  fs.writeFileSync(path.join(other, 'terms.md'), 'x');
  fs.writeFileSync(path.join(other, 'logo.png'), 'x');
  p.put('README.md');
  const r = resolveDocs(p.root, ['README.md', path.join(other, 'brand'), path.join(other, 'terms.md'), path.join(other, '*.md'), 'docs/missing.md', path.join(other, 'logo.png')]);
  assert.deepEqual(r.files, ['README.md', slashed(path.join(other, 'brand/voice.md')), slashed(path.join(other, 'terms.md'))]);
  assert.deepEqual(r.warnings, ['product_docs: "docs/missing.md" matches no document',
    `product_docs: "${path.join(other, 'logo.png')}" is not a document (.md, .mdx, .txt or .rst), skipped`]);
});

test('resolveDocs: a glob does not walk into node_modules, .git or .ux-assessment (except the saved documents)', (t) => {
  const p = project(t);
  for (const rel of ['.ux-assessment/feedback.md', '.ux-assessment/runs/r/report.md', '.ux-assessment/charter.md', '.ux-assessment/docs/z.md', '.ux-assessment/docs/sub/y.md',
    '.ux-assessment/docs/node_modules/x.md', 'node_modules/pkg/README.md', 'node_modules/pkg/docs/a.md', '.git/notes.md', 'docs/a.md']) p.put(rel);
  const files = (pattern) => resolveDocs(p.root, [pattern]).files;
  for (const pattern of ['.ux-assessment/**', '.ux-assessment/*/*.md', '.ux-assessment/**/*.md', '.ux-assessment/runs/**', 'node_modules/**', 'node_modules/*/README.md',
    'node_modules/**/*.md', '.git/**', '.git/*.md', 'docs/../.ux-assessment/**', '.ux-assessment/docs/node_modules/**']) assert.deepEqual(files(pattern), [], pattern);
  assert.deepEqual(files('.ux-assessment/docs/**'), ['.ux-assessment/docs/sub/y.md', '.ux-assessment/docs/z.md']);
  assert.deepEqual(files('.ux-assessment/docs/*.md'), ['.ux-assessment/docs/z.md']);
  assert.deepEqual(files('**/*.md'), ['docs/a.md']);
  assert.deepEqual(resolveDocs(p.root, ['node_modules/**']).warnings, ['product_docs: "node_modules/**" matches no document']);
});

test('resolveDocs: a pattern that matches nothing warns unless quiet; quiet is for a product_docs the developer did not set', (t) => {
  const p = project(t);
  assert.deepEqual(resolveDocs(p.root, ['SPEC.md']).warnings, ['product_docs: "SPEC.md" matches no document']);
  assert.deepEqual(resolveDocs(p.root, DEFAULT_DOCS).warnings.length, DEFAULT_DOCS.length);
  assert.deepEqual(resolveDocs(p.root, DEFAULT_DOCS, { quiet: true }).warnings, []);
});

test('resolveDocs: at most 200 files, and the warning says how many were left out', (t) => {
  const p = project(t);
  for (let i = 0; i < 205; i++) p.put(`docs/d${String(i).padStart(3, '0')}.md`);
  const r = resolveDocs(p.root, ['docs']);
  assert.equal(r.files.length, 200);
  assert.equal(r.files[0], 'docs/d000.md');
  assert.equal(r.files[199], 'docs/d199.md');
  assert.deepEqual(r.warnings, ['product_docs: 205 documents found, 5 left out (the limit is 200); narrow product_docs']);
});

test('decideConfig: defaults, product_docs, decide off, and a bad value is an error', (t) => {
  const p = project(t);
  assert.deepEqual(decideConfig(p.root), { enabled: true, patterns: DEFAULT_DOCS, defaults: true });
  p.ux('config.yaml', 'product_docs: [docs/, SPEC.md]\ndecide: off\n');
  assert.deepEqual(decideConfig(p.root), { enabled: false, patterns: ['docs/', 'SPEC.md'], defaults: false });
  p.ux('config.yaml', 'decide: on\nproduct_docs: docs/prd.md\n');
  assert.deepEqual(decideConfig(p.root), { enabled: true, patterns: ['docs/prd.md'], defaults: false });
  p.ux('config.yaml', 'product_docs: []\n');
  assert.deepEqual(decideConfig(p.root), { enabled: true, patterns: [], defaults: false });
  p.ux('config.yaml', 'decide: on\n');
  assert.equal(decideConfig(p.root).defaults, true);
  p.ux('config.yaml', `product_docs: ${JSON.stringify(DEFAULT_DOCS)}\n`);
  assert.equal(decideConfig(p.root).defaults, false); // the same list, but the developer wrote it
  p.ux('config.yaml', 'decide: maybe\n');
  assert.throws(() => decideConfig(p.root), /decide in .*config\.yaml: must be on or off/);
  p.ux('config.yaml', 'product_docs: [1, {a: b}]\n');
  assert.throws(() => decideConfig(p.root), /product_docs in .*config\.yaml: must be a list of paths/);
  p.ux('config.yaml', 'product_docs: [\n');
  assert.throws(() => decideConfig(p.root), /cannot read .*config\.yaml/);
});

const FINDINGS = `- id: F-01
  title: "Save is silent"
  title_local: "บันทึกแล้วไม่มีอะไรบอก"
  kind: ux
  confidence: signal
  severity: high
  personas: [phone]
  evidence: [phone/screenshots/s03.png, "phone log step 2"]
  what_happened: "Pressed Save; nothing said it worked."
  why_it_matters: "Users lose trust."
  suggested_fix: "Show a toast."
  code_pointer: {path: src/Save.tsx, confidence: medium}
  intended: null
- id: F-02
  title: "Jargon on landing"
  kind: ux
  severity: medium
  evidence: []
- id: F-03
  title: "Odd hover"
  kind: ux
  suppressed: true
- id: F-04
  title: "Labelled already"
  kind: ux
- id: F-05
  title: "Not real"
  kind: ux
- id: E-01
  title: "Shim"
  kind: env_error
`;

function seedRun(p, run = '2026-10-12', findings = FINDINGS) {
  p.ux(`runs/${run}/findings.yaml`, findings);
  p.ux(`runs/${run}/phone/screenshots/s03.png`, 'png');
}

test('todoFindings: ux, not suppressed, no developer label; the fields a decider needs; absolute screenshots inside .ux-assessment', (t) => {
  const p = project(t);
  seedRun(p);
  p.ux('ledger.yaml', YAML.stringify({ version: 1, runs: {}, findings: {
    'F-04': { label: { value: 'valid', note: '', run: '2026-10-12' } }, 'F-05': { label: { value: 'not real', note: 'x', run: '2026-10-12' } },
    'F-02': { label: null } } }));
  const todo = todoFindings(p.root, '2026-10-12');
  assert.deepEqual(todo.map((f) => f.id), ['F-01', 'F-02']);
  assert.deepEqual(todo[0], {
    id: 'F-01', title: 'Save is silent', title_local: 'บันทึกแล้วไม่มีอะไรบอก', severity: 'high', confidence: 'signal', personas: ['phone'],
    what_happened: 'Pressed Save; nothing said it worked.', why_it_matters: 'Users lose trust.', suggested_fix: 'Show a toast.',
    code_pointer: { path: 'src/Save.tsx', confidence: 'medium' }, intended: null,
    screenshots: [path.join(p.root, '.ux-assessment/runs/2026-10-12/phone/screenshots/s03.png')],
  });
  assert.equal(todo[1].title_local, 'Jargon on landing');
  assert.deepEqual(todo[1].screenshots, []);
  assert.equal(todo[1].why_it_matters, null);
});

test('todoFindings: a screenshot path that leaves .ux-assessment is dropped with a ledger warning on stderr', (t) => {
  const p = project(t);
  seedRun(p, '2026-10-12', FINDINGS.replace('"phone log step 2"]', '"phone log step 2", ../../../secret.png]'));
  fs.writeFileSync(path.join(p.root, 'secret.png'), 'private');
  const write = process.stderr.write;
  let err = '';
  process.stderr.write = (chunk) => { err += chunk; return true; };
  let todo;
  try { todo = todoFindings(p.root, '2026-10-12'); } finally { process.stderr.write = write; }
  assert.deepEqual(todo[0].screenshots, [path.join(p.root, '.ux-assessment/runs/2026-10-12/phone/screenshots/s03.png')]);
  assert.match(err, /ledger: warning: F-01 evidence "\.\.\/\.\.\/\.\.\/secret\.png" is outside \.ux-assessment, dropped/);
});

test('todoFindings: a design run has nothing to decide, an app run in the same project still has', (t) => {
  const p = project(t);
  seedRun(p);
  seedRun(p, '2026-10-13');
  p.ux('runs/2026-10-13/run.json', JSON.stringify({ kind: 'design' }));
  seedRun(p, '2026-10-14');
  p.ux('runs/2026-10-14/run.json', JSON.stringify({ url: 'http://localhost:3000/' }));
  assert.deepEqual(todoFindings(p.root, '2026-10-13'), []);
  assert.deepEqual(todoFindings(p.root, '2026-10-12').map((f) => f.id), ['F-01', 'F-02', 'F-04', 'F-05']);
  assert.deepEqual(todoFindings(p.root, '2026-10-14').map((f) => f.id), ['F-01', 'F-02', 'F-04', 'F-05']);
  assert.throws(() => todoFindings(p.root, '2026-10-15'), /no findings\.yaml for run 2026-10-15/);
});

test('todoFindings: no ledger yet means no labels; a missing run is an error', (t) => {
  const p = project(t);
  seedRun(p);
  assert.deepEqual(todoFindings(p.root, '2026-10-12').map((f) => f.id), ['F-01', 'F-02', 'F-04', 'F-05']);
  assert.throws(() => todoFindings(p.root, '2026-10-13'), /no findings\.yaml for run 2026-10-13/);
  assert.throws(() => todoFindings(p.root, '../x'), /--run takes the run folder name/);
});

// ---- checkDecisions ----

const TODO = ['F-01', 'F-02', 'F-03'].map((id) => ({ id }));
const PRD = 'Intro\n\nExport is for signed-in users.\nSaving is   silent\nby design.\n';
const files = { 'docs/prd.md': PRD, 'src/a.js': 'x' };
const readFile = (p) => {
  if (p === 'elsewhere.md') throw new Error('not inside the project or a product document');
  if (!(p in files)) throw new Error('file not found');
  return files[p];
};
const keep = (over = {}) => ({ id: 'F-01', decision: 'keep', reason: 'on purpose', sources: [{ path: 'docs/prd.md', line: 3, quote: 'Export is for signed-in users' }], ...over });
const check = (decisions) => checkDecisions({ decisions, todo: TODO, readFile });
const byIdOf = (r, id) => r.decisions.find((d) => d.id === id);

test('checkDecisions: a clean keep, fix and ask pass through in todo order with the normalized shape', () => {
  const r = check([{ id: 'F-03', decision: 'ask', reason: 'r', options: ['A', 'B'] }, keep(), { id: 'F-02', decision: 'fix', reason: 'no doc mentions it' }]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.decisions, [
    { id: 'F-01', decision: 'keep', reason: 'on purpose', sources: [{ path: 'docs/prd.md', line: 3, quote: 'Export is for signed-in users' }], options: [], guard: null },
    { id: 'F-02', decision: 'fix', reason: 'no doc mentions it', sources: [], options: [], guard: null },
    { id: 'F-03', decision: 'ask', reason: 'r', sources: [], options: ['A', 'B'], guard: null },
  ]);
});

test('guard: an id that is not in todo is dropped', () => {
  const r = check([keep(), { id: 'F-99', decision: 'fix' }, { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
  assert.deepEqual(r.decisions.map((d) => d.id), ['F-01', 'F-02', 'F-03']);
  assert.deepEqual(r.warnings, ['F-99: not a finding to decide in this run (already labelled, suppressed, or not in it), dropped']);
});

test('guard: a todo finding with no decision is added as ask', () => {
  const r = check([keep(), { id: 'F-02', decision: 'fix' }]);
  assert.deepEqual(byIdOf(r, 'F-03'), { id: 'F-03', decision: 'ask', reason: 'The decide agent returned no decision for this finding.',
    sources: [], options: ['Fix it', 'Keep: leave it as it is'], guard: 'no decision returned' });
  assert.deepEqual(r.warnings, ['F-03: no decision returned']);
});

test('guard: a decision that is not fix, keep or ask becomes ask', () => {
  const r = check([keep({ decision: 'maybe' }), { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
  assert.equal(byIdOf(r, 'F-01').decision, 'ask');
  assert.equal(byIdOf(r, 'F-01').guard, 'unknown decision "maybe": counted as ask');
  assert.deepEqual(byIdOf(r, 'F-01').options, ['Fix it', 'Keep: leave it as it is']);
  assert.deepEqual(byIdOf(r, 'F-01').sources.length, 1); // the source is real; the developer sees it
});

test('guard: keep with no source becomes ask', () => {
  for (const sources of [undefined, [], null]) {
    const r = check([keep({ sources }), { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
    assert.equal(byIdOf(r, 'F-01').decision, 'ask');
    assert.equal(byIdOf(r, 'F-01').guard, 'keep without a source: counted as ask');
  }
});

test('guard: a source whose file does not exist, or is outside the project and the product documents, is dropped; keep then becomes ask', () => {
  const r = check([keep({ sources: [{ path: 'docs/none.md', line: 1, quote: 'x' }] }),
    { id: 'F-02', decision: 'keep', sources: [{ path: 'elsewhere.md', line: 1, quote: 'x' }, { path: 'docs/prd.md', line: 3, quote: 'by design' }] },
    { id: 'F-03', decision: 'fix' }]);
  assert.equal(byIdOf(r, 'F-01').decision, 'ask');
  assert.equal(byIdOf(r, 'F-01').guard, 'source docs/none.md dropped (file not found); keep without a usable source: counted as ask');
  assert.deepEqual(byIdOf(r, 'F-01').sources, []);
  assert.equal(byIdOf(r, 'F-02').decision, 'keep');
  assert.equal(byIdOf(r, 'F-02').guard, 'source elsewhere.md dropped (not inside the project or a product document)');
  assert.deepEqual(byIdOf(r, 'F-02').sources, [{ path: 'docs/prd.md', line: 5, quote: 'by design' }]);
  assert.deepEqual(r.warnings, ['F-01: source docs/none.md dropped (file not found); keep without a usable source: counted as ask',
    'F-02: source elsewhere.md dropped (not inside the project or a product document)']);
});

test('guard: a quote that is not in the file drops the source', () => {
  const r = check([keep({ sources: [{ path: 'docs/prd.md', line: 3, quote: 'Export is for everyone' }] }),
    { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
  assert.equal(byIdOf(r, 'F-01').decision, 'ask');
  assert.equal(byIdOf(r, 'F-01').guard, 'source docs/prd.md dropped (quote not found in the file); keep without a usable source: counted as ask');
});

test('a quote found at another line gets its line corrected, with no guard; whitespace and line breaks do not matter', () => {
  const r = check([keep({ sources: [{ path: 'docs/prd.md', line: 99, quote: 'Export is for signed-in users' }] }),
    { id: 'F-02', decision: 'keep', sources: [{ path: 'docs/prd.md', line: 4, quote: 'Saving is silent by\n  design.' }] },
    { id: 'F-03', decision: 'keep', sources: [{ path: 'docs/prd.md', quote: '  Intro ' }] }]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(byIdOf(r, 'F-01').sources, [{ path: 'docs/prd.md', line: 3, quote: 'Export is for signed-in users' }]);
  assert.equal(byIdOf(r, 'F-01').guard, null);
  assert.deepEqual(byIdOf(r, 'F-02').sources[0].line, 4);
  assert.deepEqual(byIdOf(r, 'F-03').sources[0], { path: 'docs/prd.md', line: 1, quote: 'Intro' });
});

test('a quote that occurs twice keeps the stated line when it is one of them, else the first', () => {
  const text = 'a\nrepeat me\nb\nrepeat me\n';
  const run = (line) => checkDecisions({ decisions: [{ id: 'F-01', decision: 'keep', sources: [{ path: 'x.md', line, quote: 'repeat me' }] }],
    todo: [{ id: 'F-01' }], readFile: () => text }).decisions[0].sources[0].line;
  assert.equal(run(4), 4);
  assert.equal(run(2), 2);
  assert.equal(run(1), 2);
  assert.equal(run(undefined), 2);
});

test('a quote that matches on every line of a 60,000-line file is checked in linear time', () => {
  const text = Array.from({ length: 60000 }, (_, i) => `line ${i} of the product document`).join('\n');
  const started = Date.now();
  const r = checkDecisions({ decisions: [{ id: 'F-01', decision: 'keep', sources: [{ path: 'big.md', line: 59999, quote: 'of the product' }] }],
    todo: [{ id: 'F-01' }], readFile: () => text });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(r.decisions[0].sources[0].line, 59999);
  assert.equal(checkDecisions({ decisions: [{ id: 'F-01', decision: 'keep', sources: [{ path: 'big.md', line: 1, quote: 'line 30000 of\nthe  product' }] }],
    todo: [{ id: 'F-01' }], readFile: () => text }).decisions[0].sources[0].line, 30001);
});

test('keep whose sources are all dropped becomes ask; a partly good list stays keep; a source with no path or quote is dropped', () => {
  const r = check([keep({ sources: [{ path: 'docs/prd.md' }, 'text', { quote: 'q' }, { path: 'docs/prd.md', line: 3, quote: 'Export is for signed-in users' }] }),
    { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
  assert.equal(byIdOf(r, 'F-01').decision, 'keep');
  assert.equal(byIdOf(r, 'F-01').sources.length, 1);
  assert.equal(byIdOf(r, 'F-01').guard, 'source without a path or quote dropped; source without a path or quote dropped; source without a path or quote dropped');
});

test('a fix or ask keeps the sources that check out and drops the others', () => {
  const r = check([{ id: 'F-01', decision: 'ask', reason: 'docs and code disagree', options: ['A', 'B'],
    sources: [{ path: 'docs/prd.md', line: 3, quote: 'Export is for signed-in users' }, { path: 'src/a.js', line: 1, quote: 'nope' }] },
  { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
  assert.equal(byIdOf(r, 'F-01').decision, 'ask');
  assert.equal(byIdOf(r, 'F-01').sources.length, 1);
  assert.deepEqual(byIdOf(r, 'F-01').options, ['A', 'B']);
  assert.equal(byIdOf(r, 'F-01').guard, 'source src/a.js dropped (quote not found in the file)');
});

const TWO_OPTIONS = ['Fix it', 'Keep: leave it as it is'];

test('an ask with fewer than two options gets the default two, with a guard note; two or more stay as written', () => {
  const r = check([{ id: 'F-01', decision: 'ask', reason: 'x' }, { id: 'F-02', decision: 'ask', reason: 'x', options: ['Only one', '  '] },
    { id: 'F-03', decision: 'ask', reason: 'x', options: ['A', 'B', 'C'] }]);
  const note = 'ask with fewer than two options: the default two were used';
  assert.deepEqual(byIdOf(r, 'F-01').options, TWO_OPTIONS);
  assert.equal(byIdOf(r, 'F-01').guard, note);
  assert.deepEqual(byIdOf(r, 'F-02').options, TWO_OPTIONS);
  assert.equal(byIdOf(r, 'F-02').guard, note);
  assert.deepEqual(byIdOf(r, 'F-03').options, ['A', 'B', 'C']);
  assert.equal(byIdOf(r, 'F-03').guard, null);
  assert.deepEqual(r.warnings, [`F-01: ${note}`, `F-02: ${note}`]);
});

test('options: a one-key map from an unquoted "Keep: text" becomes the text; any other option that is not text is dropped with a note', () => {
  const options = YAML.parse('- Fix it\n- Keep: saving stays manual\n- 42\n- [a, b]\n- {a: 1, b: 2}\n- null\n- Also text\n');
  const r = check([{ id: 'F-01', decision: 'ask', reason: 'x', options }, { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
  assert.deepEqual(byIdOf(r, 'F-01').options, ['Fix it', 'Keep: saving stays manual', 'Also text']);
  assert.equal(byIdOf(r, 'F-01').guard, 'an option that is not text was dropped');
  const few = check([{ id: 'F-01', decision: 'ask', reason: 'x', options: YAML.parse('- Keep: saving stays manual\n- 42\n') }, { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }]);
  assert.deepEqual(byIdOf(few, 'F-01').options, TWO_OPTIONS);
  assert.equal(byIdOf(few, 'F-01').guard, 'an option that is not text was dropped; ask with fewer than two options: the default two were used');
});

test('a guard already in a checked file is kept when the same input produces none (record twice); one the agent wrote is discarded', () => {
  const decisions = [{ id: 'F-01', decision: 'ask', reason: 'x', options: ['A', 'B'], guard: 'keep without a source: counted as ask' },
    { id: 'F-02', decision: 'fix' }, { id: 'F-03', decision: 'fix' }];
  const checked = checkDecisions({ decisions, todo: TODO, readFile, checked: true });
  assert.equal(byIdOf(checked, 'F-01').guard, 'keep without a source: counted as ask');
  assert.deepEqual(checked.warnings, []);
  for (const r of [check(decisions), checkDecisions({ decisions, todo: TODO, readFile, checked: false })]) {
    assert.equal(byIdOf(r, 'F-01').guard, null);
    assert.deepEqual(r.warnings, []);
  }
});

test('checkDecisions: relPath turns a path the agent wrote into the one stored; a second decision for an id replaces the first', () => {
  const r = checkDecisions({ decisions: [{ id: 'F-01', decision: 'fix' }, { id: 'F-01', decision: 'keep', sources: [{ path: '/abs/docs/prd.md', line: 3, quote: 'Export is for signed-in users' }] }],
    todo: [{ id: 'F-01' }], readFile: () => PRD, relPath: (p) => p.replace('/abs/', '') });
  assert.deepEqual(r.decisions[0].sources[0].path, 'docs/prd.md');
  assert.equal(r.decisions[0].decision, 'keep');
  assert.deepEqual(r.warnings, ['F-01: decided twice, the last one counts']);
});

// ---- text helpers ----

test('suggestText', () => {
  assert.equal(suggestText({ decision: 'keep', sources: [{ path: 'docs/prd.md', line: 42 }] }), 'keep (docs/prd.md:42)');
  assert.equal(suggestText({ decision: 'fix', sources: [] }), 'fix');
  assert.equal(suggestText({ decision: 'ask' }), 'ask');
  assert.equal(suggestText({ decision: 'keep', sources: [] }), 'keep');
});

const FEEDBACK = [
  '# Finding labels', '',
  '## Run 2026-10-11 (runs/2026-10-11/report.md)',
  '- F-03 Older — suggest: ask — label: ? — note:',
  '- F-04 Another — label: valid — note: ok', '',
  '## Run 2026-10-12 (runs/2026-10-12/report.md)',
  '- F-03 ไม่มีอะไรบอกว่าเสียงกำลังเล่น — label: ? — note:',
  '- F-04 Save is silent - label: valid -  note: my note — with a dash',
  '- F-05 Replace me — suggest: ask — label: not real — note: intended',
  '- F-06 No decision for me — label: ? — note:',
  '### Mobile',
  '- F-07 Under a sub-heading — label: ? — note:', '',
  '## Notes',
  '- F-03 Stray — label: ? — note:', '',
].join('\n');
const DECISIONS = [
  { id: 'F-03', decision: 'keep', sources: [{ path: 'docs/prd.md', line: 42, quote: 'q' }] }, { id: 'F-04', decision: 'fix' },
  { id: 'F-05', decision: 'ask' }, { id: 'F-07', decision: 'fix' }, { id: 'F-99', decision: 'fix' },
];

test('withSuggestions: adds, replaces, touches only the named run, keeps labels and notes, skips lines without a decision', () => {
  const out = withSuggestions(FEEDBACK, '2026-10-12', DECISIONS).split('\n');
  assert.equal(out[3], '- F-03 Older — suggest: ask — label: ? — note:'); // another run: untouched
  assert.equal(out[4], '- F-04 Another — label: valid — note: ok');
  assert.equal(out[7], '- F-03 ไม่มีอะไรบอกว่าเสียงกำลังเล่น — suggest: keep (docs/prd.md:42) — label: ? — note:');
  assert.equal(out[8], '- F-04 Save is silent — suggest: fix - label: valid -  note: my note — with a dash');
  assert.equal(out[9], '- F-05 Replace me — suggest: ask — label: not real — note: intended');
  assert.equal(out[10], '- F-06 No decision for me — label: ? — note:');
  assert.equal(out[12], '- F-07 Under a sub-heading — suggest: fix — label: ? — note:');
  assert.equal(out[15], '- F-03 Stray — label: ? — note:'); // under a non-run heading
  assert.equal(out.length, FEEDBACK.split('\n').length);
});

test('withSuggestions: only a suggest segment of ours right before label is replaced; a title that says "suggest:" stays', () => {
  const feedback = ['## Run 2026-10-12',
    '- F-01 Four - suggest: nothing shows — label: ? — note:',
    '- F-02 Two - suggest: fix the typo - suggest: ask — label: ? — note:',
    '- F-03 Three — suggest: keep (docs/my - prd.md:7) — label: ? — note:',
    '- F-04 Four — suggest: keepers — label: ? — note:', ''].join('\n');
  const out = withSuggestions(feedback, '2026-10-12', ['F-01', 'F-02', 'F-03', 'F-04'].map((id) => ({ id, decision: 'fix' }))).split('\n');
  assert.equal(out[1], '- F-01 Four - suggest: nothing shows — suggest: fix — label: ? — note:');
  assert.equal(out[2], '- F-02 Two - suggest: fix the typo — suggest: fix — label: ? — note:');
  assert.equal(out[3], '- F-03 Three — suggest: fix — label: ? — note:');
  assert.equal(out[4], '- F-04 Four — suggest: keepers — suggest: fix — label: ? — note:');
});

test('withSuggestions: running twice gives the same text; a run with no section, and CRLF, are handled', () => {
  const once = withSuggestions(FEEDBACK, '2026-10-12', DECISIONS);
  assert.equal(withSuggestions(once, '2026-10-12', DECISIONS), once);
  assert.equal(withSuggestions(FEEDBACK, '2026-10-20', DECISIONS), FEEDBACK);
  const crlf = FEEDBACK.replaceAll('\n', '\r\n');
  assert.equal(withSuggestions(crlf, '2026-10-12', DECISIONS), once.replaceAll('\n', '\r\n'));
});

test('parseFeedback still reads every line withSuggestions writes', () => {
  const before = parseFeedback(FEEDBACK);
  const after = parseFeedback(withSuggestions(FEEDBACK, '2026-10-12', DECISIONS));
  assert.deepEqual(after.warnings, before.warnings);
  assert.deepEqual(after.labels, before.labels);
});

test('decisionsTable: Needs you with options, To fix, Kept with path:line; each row starts with the id and the local title', () => {
  const text = decisionsTable([
    { id: 'F-03', decision: 'keep', reason: 'The PRD requires sign-up.', sources: [{ path: 'docs/prd.md', line: 42, quote: 'q' }], options: [] },
    { id: 'F-10', decision: 'ask', reason: 'Docs and code disagree.', sources: [], options: ['Rename it', 'Keep the jargon'] },
    { id: 'F-04', decision: 'fix', reason: 'Nothing says it is on purpose.', sources: [], options: [] },
    { id: 'F-02', decision: 'ask', reason: 'Costs the goal.', sources: [], options: [] },
  ], { 'F-03': 'ไม่มีอะไรบอกว่าเสียงกำลังเล่น', 'F-10': 'Jargon', 'F-04': 'Save is silent' });
  assert.equal(text, [
    '### Needs you (2)', '',
    '- F-02 — Costs the goal.',
    '- F-10 · Jargon — Docs and code disagree.',
    '  - Rename it',
    '  - Keep the jargon', '',
    '### To fix (1)', '',
    '- F-04 · Save is silent — Nothing says it is on purpose.', '',
    '### Kept (1)', '',
    '- F-03 · ไม่มีอะไรบอกว่าเสียงกำลังเล่น — docs/prd.md:42 — The PRD requires sign-up.', '',
  ].join('\n'));
  assert.equal(decisionsTable([], {}), 'No findings to decide.\n');
});

// ---- the CLI ----

const run = (args) => spawnSync(process.execPath, [DECIDE, ...args], { encoding: 'utf8' });

function cliProject(t) {
  const p = project(t);
  p.put('docs/prd.md', 'Intro\n\nExport is for signed-in users.\n');
  p.put('README.md', 'Readme\n');
  seedRun(p);
  p.ux('feedback.md', '# Finding labels\n\n## Run 2026-10-12 (runs/2026-10-12/report.md)\n- F-01 บันทึกแล้วไม่มีอะไรบอก — label: ? — note:\n'
    + '- F-02 Jargon on landing — label: ? — note:\n- F-04 Labelled already — label: valid — note:\n- F-05 Not real — label: not real — note:\n');
  syncLedger(p.root);
  return p;
}
const AGENT_OUT = {
  decisions: [
    { id: 'F-01', decision: 'keep', reason: 'The PRD says so.', sources: [{ path: 'docs/prd.md', line: 1, quote: 'Export is for signed-in users' }] },
    { id: 'F-02', decision: 'keep', reason: 'Just because.' },
    { id: 'F-77', decision: 'fix' },
  ],
};

test('CLI docs and todo print JSON', (t) => {
  const p = cliProject(t);
  p.ux('config.yaml', 'product_docs: [docs/, nothing.md]\n');
  const docs = run(['docs', p.root]);
  assert.equal(docs.status, 0);
  assert.deepEqual(JSON.parse(docs.stdout), { enabled: true, patterns: ['docs/', 'nothing.md'], files: ['docs/prd.md'],
    warnings: ['product_docs: "nothing.md" matches no document'] });
  const todo = run(['todo', p.root, '--run', '2026-10-12']);
  assert.equal(todo.status, 0);
  const out = JSON.parse(todo.stdout);
  assert.equal(out.run, '2026-10-12');
  assert.deepEqual(out.findings.map((f) => f.id), ['F-01', 'F-02']);
  assert.deepEqual(out.docs, ['docs/prd.md']);
  assert.match(todo.stderr, /^decide: warning: product_docs: "nothing\.md" matches no document$/m);
});

test('CLI docs and todo: a product_docs entry that matches nothing warns even when it is one of the defaults; unset product_docs stays quiet', (t) => {
  const p = cliProject(t);
  const warning = 'product_docs: "SPEC.md" matches no document';
  const docs = () => JSON.parse(run(['docs', p.root]).stdout);
  assert.deepEqual(docs().warnings, []);
  assert.equal(run(['todo', p.root, '--run', '2026-10-12']).stderr, '');
  p.ux('config.yaml', 'product_docs: [SPEC.md, README.md]\n');
  assert.deepEqual(docs(), { enabled: true, patterns: ['SPEC.md', 'README.md'], files: ['README.md'], warnings: [warning] });
  assert.equal(run(['todo', p.root, '--run', '2026-10-12']).stderr, `decide: warning: ${warning}\n`);
});

test('CLI record: guards, normalized decisions.yaml, suggest segments in feedback.md, one JSON line; twice gives the same files', (t) => {
  const p = cliProject(t);
  const dec = path.join(p.root, '.ux-assessment/runs/2026-10-12/decisions.yaml');
  const fb = path.join(p.root, '.ux-assessment/feedback.md');
  fs.writeFileSync(dec, YAML.stringify(AGENT_OUT));
  const r = run(['record', p.root, '--run', '2026-10-12']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { decisions: 2, counts: { fix: 0, keep: 1, ask: 1 }, guards: ['F-02'] });
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(r.stderr, 'decide: warning: F-77: not a finding to decide in this run (already labelled, suppressed, or not in it), dropped\ndecide: warning: F-02: keep without a source: counted as ask\n');
  const doc = YAML.parse(fs.readFileSync(dec, 'utf8'));
  assert.equal(doc.run, '2026-10-12');
  assert.match(doc.decided_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(doc.checked, true);
  assert.match(fs.readFileSync(dec, 'utf8'), /\ndecided_at: .*\nchecked: true\n/);
  assert.deepEqual(doc.decisions.map((d) => [d.id, d.decision, d.guard]), [['F-01', 'keep', null], ['F-02', 'ask', 'keep without a source: counted as ask']]);
  assert.equal(doc.decisions[0].sources[0].line, 3);
  assert.match(fs.readFileSync(dec, 'utf8'), /^# Written by ux-assessment driver\/decide\.mjs record/);
  const feedback = fs.readFileSync(fb, 'utf8');
  assert.match(feedback, /^- F-01 บันทึกแล้วไม่มีอะไรบอก — suggest: keep \(docs\/prd\.md:3\) — label: \? — note:$/m);
  assert.match(feedback, /^- F-02 Jargon on landing — suggest: ask — label: \? — note:$/m);
  assert.match(feedback, /^- F-04 Labelled already — label: valid — note:$/m);
  const decText = fs.readFileSync(dec, 'utf8');
  const again = run(['record', p.root, '--run', '2026-10-12']);
  assert.deepEqual(JSON.parse(again.stdout), { decisions: 2, counts: { fix: 0, keep: 1, ask: 1 }, guards: ['F-02'] });
  assert.equal(fs.readFileSync(dec, 'utf8'), decText);
  assert.equal(again.stderr, '');
  assert.equal(fs.readFileSync(fb, 'utf8'), feedback);
});

test('CLI record accepts a bare list, reads a source outside the project only when it is a product document, and sync then shows the decision', (t) => {
  const p = cliProject(t);
  const other = tempDir(t);
  fs.writeFileSync(path.join(other, 'brand.md'), 'Voice\nWe never use jargon.\n');
  fs.writeFileSync(path.join(other, 'private.md'), 'We never use jargon.\n');
  p.ux('config.yaml', `product_docs: [docs/, ${JSON.stringify(path.join(other, 'brand.md'))}]\n`);
  const dec = path.join(p.root, '.ux-assessment/runs/2026-10-12/decisions.yaml');
  fs.writeFileSync(dec, YAML.stringify([
    { id: 'F-01', decision: 'keep', sources: [{ path: path.join(other, 'brand.md'), line: 2, quote: 'We never use jargon.' },
      { path: path.join(other, 'private.md'), line: 1, quote: 'We never use jargon.' }] },
    { id: 'F-02', decision: 'fix', reason: 'no doc' },
  ]));
  const r = run(['record', p.root, '--run', '2026-10-12']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { decisions: 2, counts: { fix: 1, keep: 1, ask: 0 }, guards: ['F-01'] });
  assert.match(r.stderr, /F-01: source .*private\.md dropped \(not inside the project or a product document\)/);
  syncLedger(p.root);
  const ledger = YAML.parse(fs.readFileSync(path.join(p.root, '.ux-assessment/ledger.yaml'), 'utf8'));
  assert.equal(ledger.findings['F-01'].decision.value, 'keep');
  assert.equal(ledger.findings['F-01'].decision.sources[0].path, slashed(path.join(other, 'brand.md')));
  assert.deepEqual(ledger.findings['F-02'].decision, { value: 'fix', by: 'agent', reason: 'no doc', sources: [], options: [], run: '2026-10-12' });
});

const recordOf = (p, project = p.root) => {
  const r = run(['record', project, '--run', '2026-10-12']);
  assert.equal(r.status, 0, r.stderr);
  return YAML.parse(fs.readFileSync(path.join(p.root, '.ux-assessment/runs/2026-10-12/decisions.yaml'), 'utf8')).decisions;
};
const writeAgent = (p, decisions) => fs.writeFileSync(path.join(p.root, '.ux-assessment/runs/2026-10-12/decisions.yaml'), YAML.stringify({ decisions }));

test('CLI record: a source may not cite the run\'s own output; the charter and the saved documents stay citable', (t) => {
  const p = cliProject(t);
  p.ux('charter.md', 'Goal: export without sign-up.\n');
  p.ux('docs/saved.md', 'Saved ticket text.\n');
  const own = 'an invented quote about toasts';
  const cite = (rel, quote) => ({ path: rel, line: 1, quote });
  writeAgent(p, [
    { id: 'F-01', decision: 'keep', reason: 'r', sources: [cite('.ux-assessment/runs/2026-10-12/decisions.yaml', own), cite('.ux-assessment/feedback.md', 'Jargon on landing'),
      cite('.ux-assessment/ledger.yaml', 'F-01')] },
    { id: 'F-02', decision: 'keep', reason: 'r', sources: [cite('.ux-assessment/charter.md', 'Goal: export'), cite('.ux-assessment/docs/saved.md', 'Saved ticket text.')] },
  ]);
  const [one, two] = recordOf(p);
  assert.equal(one.decision, 'ask');
  assert.equal(one.guard, ['decisions.yaml', 'feedback.md', 'ledger.yaml'].map((n) => `source .ux-assessment/${n === 'decisions.yaml' ? 'runs/2026-10-12/' : ''}${n} dropped (not a citable file)`)
    .join('; ') + '; keep without a usable source: counted as ask');
  assert.equal(two.decision, 'keep');
  assert.deepEqual(two.sources.map((s) => s.path), ['.ux-assessment/charter.md', '.ux-assessment/docs/saved.md']);
  const dec = path.join(p.root, '.ux-assessment/runs/2026-10-12/decisions.yaml');
  const once = fs.readFileSync(dec, 'utf8');
  assert.equal(run(['record', p.root, '--run', '2026-10-12']).status, 0);
  assert.equal(fs.readFileSync(dec, 'utf8'), once);
});

test('CLI record: paths are compared by real path; a symlink out of the project is a product document only when its target is one', (t) => {
  const p = cliProject(t);
  const other = tempDir(t);
  fs.writeFileSync(path.join(other, 'secret.md'), 'Private plan.\n');
  fs.writeFileSync(path.join(other, 'brand.md'), 'Brand voice.\n');
  fs.symlinkSync(path.join(other, 'secret.md'), path.join(p.root, 'docs/secret-link.md'));
  fs.symlinkSync(path.join(other, 'brand.md'), path.join(p.root, 'docs/brand-link.md'));
  p.ux('config.yaml', `product_docs: [README.md, ${JSON.stringify(path.join(other, 'brand.md'))}]\n`);
  const cite = (rel, quote) => ({ path: rel, line: 1, quote });
  writeAgent(p, [
    { id: 'F-01', decision: 'keep', reason: 'r', sources: [cite('docs/secret-link.md', 'Private plan.')] },
    { id: 'F-02', decision: 'keep', reason: 'r', sources: [cite('docs/brand-link.md', 'Brand voice.'), cite('docs/none.md', 'x')] },
  ]);
  const [one, two] = recordOf(p);
  assert.equal(one.guard, 'source docs/secret-link.md dropped (not inside the project or a product document); keep without a usable source: counted as ask');
  assert.deepEqual(two.sources, [{ path: 'docs/brand-link.md', line: 1, quote: 'Brand voice.' }]);
  assert.equal(two.guard, 'source docs/none.md dropped (file not found)');
});

test('CLI record: a project reached through a symlinked path still accepts its own files, written relative or by their real path', (t) => {
  const p = cliProject(t);
  const alias = path.join(tempDir(t), 'alias');
  fs.symlinkSync(p.root, alias);
  writeAgent(p, [{ id: 'F-01', decision: 'keep', reason: 'r', sources: [{ path: 'docs/prd.md', line: 3, quote: 'Export is for signed-in users' },
    { path: path.join(p.root, 'docs/prd.md'), line: 3, quote: 'Intro' }] }, { id: 'F-02', decision: 'fix', reason: 'r' }]);
  const [one] = recordOf(p, alias);
  assert.equal(one.decision, 'keep');
  assert.equal(one.guard, null);
  assert.deepEqual(one.sources.map((s) => s.path), ['docs/prd.md', 'docs/prd.md']);
});

test('CLI record: a guard the agent wrote is not kept; the one record wrote survives a second record', (t) => {
  const p = cliProject(t);
  writeAgent(p, [{ id: 'F-01', decision: 'fix', reason: 'r', guard: 'invented by the agent' }, { id: 'F-02', decision: 'keep', reason: 'r' }]);
  assert.deepEqual(recordOf(p).map((d) => d.guard), [null, 'keep without a source: counted as ask']);
  assert.deepEqual(recordOf(p).map((d) => d.guard), [null, 'keep without a source: counted as ask']);
});

test('CLI table prints the Decisions section from decisions.yaml and the local titles', (t) => {
  const p = cliProject(t);
  fs.writeFileSync(path.join(p.root, '.ux-assessment/runs/2026-10-12/decisions.yaml'), YAML.stringify(AGENT_OUT));
  assert.equal(run(['record', p.root, '--run', '2026-10-12']).status, 0);
  const r = run(['table', p.root, '--run', '2026-10-12']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, [
    '### Needs you (1)', '',
    '- F-02 · Jargon on landing — Just because.',
    '  - Fix it',
    '  - Keep: leave it as it is', '',
    '### Kept (1)', '',
    '- F-01 · บันทึกแล้วไม่มีอะไรบอก — docs/prd.md:3 — The PRD says so.', '',
  ].join('\n'));
});

test('CLI: a design run lists nothing under todo, and record fails with a one-line error', (t) => {
  const p = cliProject(t);
  seedRun(p, '2026-10-13');
  p.ux('runs/2026-10-13/run.json', JSON.stringify({ kind: 'design' }));
  p.ux('runs/2026-10-13/decisions.yaml', YAML.stringify(AGENT_OUT));
  const todo = run(['todo', p.root, '--run', '2026-10-13']);
  assert.equal(todo.status, 0);
  assert.deepEqual(JSON.parse(todo.stdout).findings, []);
  const record = run(['record', p.root, '--run', '2026-10-13']);
  assert.equal(record.status, 1);
  assert.equal(record.stderr, 'run 2026-10-13 is a design run, which has no app source to decide from\n');
  assert.equal(YAML.parse(fs.readFileSync(path.join(p.root, '.ux-assessment/runs/2026-10-13/decisions.yaml'), 'utf8')).checked, undefined);
});

test('CLI errors: usage, a run that is a path, a missing decisions.yaml, a broken one', (t) => {
  const p = cliProject(t);
  assert.match(run([]).stderr, /^usage: decide\.mjs docs <project> \| decide\.mjs todo\|record\|table <project> --run <folder>$/m);
  assert.equal(run([]).status, 1);
  assert.match(run(['record', p.root]).stderr, /record needs --run <folder>/);
  assert.match(run(['record', p.root, '--run', 'runs/2026-10-12']).stderr, /--run takes the run folder name/);
  assert.match(run(['record', p.root, '--run', '2026-10-12']).stderr, /no decisions\.yaml in .*2026-10-12; the decide agent writes it/);
  fs.writeFileSync(path.join(p.root, '.ux-assessment/runs/2026-10-12/decisions.yaml'), 'decisions: [\n');
  const bad = run(['record', p.root, '--run', '2026-10-12']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot read .*decisions\.yaml/);
  assert.match(run(['frobnicate', p.root]).stderr, /unknown command frobnicate/);
});
