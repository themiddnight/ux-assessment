#!/usr/bin/env node
// Model per role (SPEC D30): defaults, `.ux-assessment/config.yaml` overrides, and the cheap-model warning.
//   node models.mjs show <project>   the resolved map for both harnesses; warnings on stderr
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const EFFORTS = ['low', 'medium', 'high'];
export const HARNESSES = ['claude', 'codex'];
const MODEL_RE = /^[\w.-]+$/;

/** Claude: the agents' frontmatter (null = the user's session model). Codex: what the dogfood ran on (null = the main session). */
export const DEFAULTS = Object.freeze({
  claude: Object.freeze({ persona: 'sonnet', verifier: 'sonnet', recon: 'opus', triage: 'opus', orchestrator: null }),
  codex: Object.freeze({
    persona: Object.freeze({ model: 'gpt-6-sol', effort: 'medium' }),
    verifier: Object.freeze({ model: 'gpt-6-sol', effort: 'medium' }),
    'self-check': Object.freeze({ model: 'gpt-6-sol', effort: 'low' }),
    recon: null, triage: null, orchestrator: null,
  }),
});
/** Roles `.ux-assessment/config.yaml` may set. Codex recon, triage and orchestrator are the user's main session. */
const CONFIG_ROLES = { claude: ['persona', 'verifier', 'recon', 'triage'], codex: ['persona', 'verifier'] };
/** Quick-depth recon runs on Sonnet unless the config names a recon model. */
export const QUICK_RECON = 'sonnet';
export const CHEAP_MODELS = ['haiku', 'claude-haiku-4-5', 'gpt-6-luna'];
export const CHEAP_WARNING = 'cheaper, quality unmeasured: persona mistakes turn into false findings';

export function checkModelChoice({ model = null, effort = null } = {}) {
  if (model != null && !(typeof model === 'string' && MODEL_RE.test(model))) throw new Error('model must match ^[\\w.-]+$');
  if (effort != null && !EFFORTS.includes(effort)) throw new Error('effort must be low, medium or high');
  return { model: model ?? null, effort: effort ?? null };
}

const isMap = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const at = (where, fn) => {
  try { return fn(); } catch (error) { throw new Error(`${where}: ${error.message}`); }
};

/** `models` from config.yaml → {claude: {role: model|null}, codex: {role: {model, effort}}}. A flat map is Claude's; unknown roles are ignored. */
export function normalizeModels(models, source = 'config.yaml') {
  const out = { claude: {}, codex: {} };
  if (models == null) return out;
  if (!isMap(models)) throw new Error(`models in ${source}: must be a map`);
  const nested = 'claude' in models || 'codex' in models;
  const claude = nested ? models.claude ?? {} : models;
  const codex = nested ? models.codex ?? {} : {};
  if (!isMap(claude)) throw new Error(`models.claude in ${source}: must be a map`);
  if (!isMap(codex)) throw new Error(`models.codex in ${source}: must be a map`);
  for (const role of CONFIG_ROLES.claude) {
    if (!(role in claude)) continue;
    const value = claude[role];
    out.claude[role] = value == null || value === 'inherit'
      ? null
      : at(`models${nested ? '.claude' : ''}.${role} in ${source}`, () => checkModelChoice({ model: value }).model);
  }
  for (const role of CONFIG_ROLES.codex) {
    if (!(role in codex)) continue;
    const where = `models.codex.${role} in ${source}`;
    if (!isMap(codex[role])) throw new Error(`${where}: must be {model, effort}`);
    out.codex[role] = at(where, () => checkModelChoice({ model: codex[role].model ?? null, effort: codex[role].effort ?? null }));
  }
  return out;
}

export const configPath = (projectRoot) => path.join(projectRoot, '.ux-assessment', 'config.yaml');

export function readModelsConfig(projectRoot) {
  const file = configPath(projectRoot);
  if (!fs.existsSync(file)) return normalizeModels(null);
  let doc;
  try { doc = YAML.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message.split('\n')[0]}`);
  }
  return normalizeModels(isMap(doc) ? doc.models : null, file);
}

/** job > config > default, field by field. Claude → {model, source}; Codex → {model, effort, source}. null model = the session model. */
export function resolveModel({ harness, role, config = normalizeModels(null), job = {}, depth = null }) {
  if (!HARNESSES.includes(harness)) throw new Error(`harness must be claude or codex, not ${JSON.stringify(harness)}`);
  if (!Object.hasOwn(DEFAULTS[harness], role)) throw new Error(`unknown ${harness} role ${JSON.stringify(role)}`);
  if (harness === 'claude') {
    if (job.model != null) return { model: checkModelChoice({ model: job.model }).model, source: 'job' };
    if (Object.hasOwn(config.claude, role)) return { model: config.claude[role], source: 'config' };
    return { model: role === 'recon' && depth === 'quick' ? QUICK_RECON : DEFAULTS.claude[role], source: 'default' };
  }
  const fromJob = checkModelChoice({ model: job.model ?? null, effort: job.effort ?? null });
  const fromConfig = config.codex[role] ?? { model: null, effort: null };
  const fallback = DEFAULTS.codex[role] ?? { model: null, effort: null };
  const source = fromJob.model != null || fromJob.effort != null ? 'job' : Object.hasOwn(config.codex, role) ? 'config' : 'default';
  return {
    model: fromJob.model ?? fromConfig.model ?? fallback.model,
    effort: fromJob.effort ?? fromConfig.effort ?? fallback.effort,
    source,
  };
}

/** SPEC component 6: cheaper persona models are accepted with a warning until a side-by-side run on a labelled app. */
export function cheapWarning({ harness, role, model = null, effort = null }) {
  if (role !== 'persona') return null;
  const cheap = CHEAP_MODELS.includes(model) || (harness === 'codex' && effort === 'low');
  return cheap ? `warning: ${harness} persona uses ${[model, effort].filter(Boolean).join(' ')}: ${CHEAP_WARNING}` : null;
}

export function showModels(projectRoot, { out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const config = readModelsConfig(projectRoot);
  const session = 'the session model';
  for (const role of Object.keys(DEFAULTS.claude)) {
    const r = resolveModel({ harness: 'claude', role, config });
    const quick = role === 'recon' && r.source === 'default' ? `; quick depth: ${QUICK_RECON}` : '';
    out(`claude ${role}: ${r.model ?? session} (${r.source})${quick}`);
  }
  for (const role of Object.keys(DEFAULTS.codex)) {
    const r = resolveModel({ harness: 'codex', role, config });
    out(`codex ${role}: ${r.model ? [r.model, r.effort].filter(Boolean).join(' ') : session} (${r.source})`);
  }
  const warnings = HARNESSES.map((harness) => cheapWarning({ harness, role: 'persona', ...resolveModel({ harness, role: 'persona', config }) }))
    .filter(Boolean);
  for (const line of warnings) err(line);
  return warnings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, project, ...extra] = process.argv.slice(2);
    if (command !== 'show' || !project || extra.length) throw new Error('usage: node models.mjs show <project>');
    showModels(path.resolve(project));
  } catch (error) {
    process.stderr.write(`${error.message.split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}
