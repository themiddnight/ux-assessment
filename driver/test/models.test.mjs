import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, CHEAP_WARNING, readModelsConfig, resolveModel, cheapWarning } from '../models.mjs';

const MODELS = fileURLToPath(new URL('../models.mjs', import.meta.url));
const project = (t, configText = null) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (configText != null) {
    fs.mkdirSync(path.join(root, '.ux-assessment'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ux-assessment', 'config.yaml'), configText);
  }
  return root;
};

test('defaults: Claude from the agent frontmatter, Codex what the dogfood ran on, quick recon on Sonnet', () => {
  assert.deepEqual(resolveModel({ harness: 'claude', role: 'persona' }), { model: 'sonnet', source: 'default' });
  assert.deepEqual(resolveModel({ harness: 'claude', role: 'recon' }), { model: 'opus', source: 'default' });
  assert.deepEqual(resolveModel({ harness: 'claude', role: 'recon', depth: 'quick' }), { model: 'sonnet', source: 'default' });
  assert.deepEqual(resolveModel({ harness: 'claude', role: 'orchestrator' }), { model: null, source: 'default' });
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'persona' }), { model: 'gpt-6-sol', effort: 'medium', source: 'default' });
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'self-check' }), { model: 'gpt-6-sol', effort: 'low', source: 'default' });
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'triage' }), { model: null, effort: null, source: 'default' });
  assert.throws(() => resolveModel({ harness: 'gemini', role: 'persona' }), /harness must be claude or codex/);
  assert.throws(() => resolveModel({ harness: 'codex', role: 'planner' }), /unknown codex role "planner"/);
});

test("the Claude defaults are the agents' frontmatter models", () => {
  const root = path.resolve(path.dirname(MODELS), '..');
  for (const role of ['persona', 'verifier', 'recon', 'triage']) {
    const text = fs.readFileSync(path.join(root, 'agents', `${role}.md`), 'utf8');
    assert.equal(text.match(/^model:\s*(\S+)\s*$/m)?.[1], DEFAULTS.claude[role], role);
  }
});

test('job > config > default, field by field', (t) => {
  const root = project(t, 'models:\n  claude: {persona: haiku, triage: inherit}\n  codex:\n    persona: {model: gpt-6-luna}\n    verifier: {effort: high}\n');
  const config = readModelsConfig(root);
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'persona', config }), { model: 'gpt-6-luna', effort: 'medium', source: 'config' });
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'verifier', config }), { model: 'gpt-6-sol', effort: 'high', source: 'config' });
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'persona', config, job: { effort: 'low' } }), { model: 'gpt-6-luna', effort: 'low', source: 'job' });
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'persona', config, job: { model: 'gpt-6-sol', effort: 'high' } }),
    { model: 'gpt-6-sol', effort: 'high', source: 'job' });
  assert.deepEqual(resolveModel({ harness: 'claude', role: 'persona', config }), { model: 'haiku', source: 'config' });
  assert.deepEqual(resolveModel({ harness: 'claude', role: 'triage', config }), { model: null, source: 'config' });
  assert.deepEqual(resolveModel({ harness: 'claude', role: 'recon', config, depth: 'quick' }), { model: 'sonnet', source: 'default' });
});

test("an old flat models map is Claude's; planner and other unknown keys are ignored; no file or no models is the defaults", (t) => {
  const flat = readModelsConfig(project(t, 'adapter: playwright-driver\nmodels: {persona: sonnet, planner: inherit, triage: opus}\ncap: 30\n'));
  assert.deepEqual(flat, { claude: { persona: 'sonnet', triage: 'opus' }, codex: {} });
  assert.deepEqual(resolveModel({ harness: 'codex', role: 'persona', config: flat }), { model: 'gpt-6-sol', effort: 'medium', source: 'default' });
  assert.deepEqual(readModelsConfig(project(t)), { claude: {}, codex: {} });
  assert.deepEqual(readModelsConfig(project(t, 'cap: 30\n')), { claude: {}, codex: {} });
});

test('an invalid model or effort in config.yaml is an error naming the key and the file', (t) => {
  assert.throws(() => readModelsConfig(project(t, 'models:\n  codex:\n    persona: {model: gpt-6-sol, effort: max}\n')),
    (e) => /^models\.codex\.persona in .*config\.yaml: effort must be low, medium or high$/.test(e.message));
  assert.throws(() => readModelsConfig(project(t, 'models:\n  claude: {persona: "a b"}\n')), (e) => /^models\.claude\.persona in .*: model must match/.test(e.message));
  assert.throws(() => readModelsConfig(project(t, 'models:\n  codex: {persona: gpt-6-sol}\n')), (e) => /^models\.codex\.persona in .*: must be \{model, effort\}$/.test(e.message));
  assert.throws(() => readModelsConfig(project(t, 'models:\n  codex: [a]\n')), (e) => /^models\.codex in .*: must be a map$/.test(e.message));
  assert.throws(() => readModelsConfig(project(t, 'models: [a]\n')), (e) => /^models in .*: must be a map$/.test(e.message));
  assert.throws(() => readModelsConfig(project(t, 'models: {persona: [\n')), (e) => /^cannot read .*config\.yaml: /.test(e.message));
});

test('cheaper persona models warn; the defaults and other roles do not', () => {
  const w = (harness, model, effort = null, role = 'persona') => cheapWarning({ harness, role, model, effort });
  assert.equal(w('codex', 'gpt-6-luna', 'medium'), `warning: codex persona uses gpt-6-luna medium: ${CHEAP_WARNING}`);
  assert.equal(w('codex', 'gpt-6-sol', 'low'), `warning: codex persona uses gpt-6-sol low: ${CHEAP_WARNING}`);
  assert.equal(w('claude', 'haiku'), `warning: claude persona uses haiku: ${CHEAP_WARNING}`);
  assert.equal(w('claude', 'claude-haiku-4-5'), `warning: claude persona uses claude-haiku-4-5: ${CHEAP_WARNING}`);
  assert.equal(w('codex', 'gpt-6-sol', 'medium'), null);
  assert.equal(w('claude', 'sonnet'), null);
  assert.equal(w('codex', 'gpt-6-luna', 'low', 'verifier'), null);
  assert.equal(CHEAP_WARNING, 'cheaper, quality unmeasured: persona mistakes turn into false findings');
});

test('models.mjs show prints both harnesses on stdout and the warnings on stderr', (t) => {
  const root = project(t, 'models:\n  claude: {persona: haiku}\n  codex:\n    persona: {model: gpt-6-luna, effort: medium}\n');
  const r = spawnSync(process.execPath, [MODELS, 'show', root], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.replace(/\r\n/g, '\n'), [
    'claude persona: haiku (config)', 'claude verifier: sonnet (default)', 'claude recon: opus (default); quick depth: sonnet',
    'claude triage: opus (default)', 'claude orchestrator: the session model (default)',
    'codex persona: gpt-6-luna medium (config)', 'codex verifier: gpt-6-sol medium (default)', 'codex self-check: gpt-6-sol low (default)',
    'codex recon: the session model (default)', 'codex triage: the session model (default)', 'codex orchestrator: the session model (default)', ''].join('\n'));
  assert.equal(r.stderr.replace(/\r\n/g, '\n'),
    `warning: claude persona uses haiku: ${CHEAP_WARNING}\nwarning: codex persona uses gpt-6-luna medium: ${CHEAP_WARNING}\n`);
  const bad = spawnSync(process.execPath, [MODELS, 'show'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr.trim(), 'usage: node models.mjs show <project>');
});
