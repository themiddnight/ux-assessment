#!/usr/bin/env node
// Token accounting (SPEC D31): usage.jsonl records, the Claude Code hook, `report` and `estimate`.
// Top-level imports are node: builtins only: `hook` runs on every Stop of every Claude Code session with the plugin
// on, so it must start fast and work without driver/node_modules. `estimate` loads `yaml` with a dynamic import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE_FILE = 'usage.jsonl';
export const MARKER_FILE = 'active-run';
const RUN_RE = /^[\w.-]+$/;

export const usagePath = (projectRoot) => path.join(projectRoot, '.ux-assessment', USAGE_FILE);
export const markerPath = (projectRoot) => path.join(projectRoot, '.ux-assessment', MARKER_FILE);
export const validRun = (name) => typeof name === 'string' && RUN_RE.test(name) && name !== '.' && name !== '..';
/** A token count from untrusted JSON: a finite non-negative integer, else 0. */
export const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** True when `url` is the module node was started with; realpath on both sides, so a symlinked plugin root still matches. */
export function isMain(url = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(url)); } catch { return false; }
}

/** The run a record belongs to: the first path segment of `sessionDir` under `<project>/.ux-assessment/runs/`, else null. */
export function runOf(projectRoot, sessionDir) {
  const rel = path.relative(path.join(projectRoot, '.ux-assessment', 'runs'), sessionDir);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const first = rel.split(/[\\/]/)[0];
  return validRun(first) ? first : null;
}

/** codex-result.json `usage` (the raw `--json` keys) → one record. input_tokens includes cached and cache-write tokens. */
export function codexRecord(usage, { role, id, model, run = null, t = new Date().toISOString() }) {
  if (!usage) return null;
  const cached = count(usage.cached_input_tokens);
  const write = count(usage.cache_write_input_tokens);
  return {
    t, harness: 'codex', role, id: id ?? null, model: model ?? null,
    input: Math.max(0, count(usage.input_tokens) - cached - write), cache_write: write, cache_write_1h: 0,
    cached_input: cached, output: count(usage.output_tokens), source: 'codex-json', run,
  };
}

/** Append records to `<project>/.ux-assessment/usage.jsonl`, owner-only like the rest of .ux-assessment. */
export function appendUsage(projectRoot, records) {
  if (!records.length) return;
  const file = usagePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 });
}

// ---- Claude Code hook (SubagentStop, Stop) ----

export const AGENT_PREFIX = 'ux-assessment:';
const SESSION_RE = /^[\w-]+$/;

/** `.ux-assessment/active-run`: line 1 the run folder name (the skill writes it), line 2 the session the first Stop claimed. */
export function readMarker(projectRoot) {
  let text;
  try { text = fs.readFileSync(markerPath(projectRoot), 'utf8'); } catch { return null; }
  const [run = '', session = ''] = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
  return validRun(run) ? { run, session: SESSION_RE.test(session) ? session : null } : null;
}

const zero = () => ({ input: 0, cache_write: 0, cache_write_1h: 0, cached_input: 0, output: 0 });
// Duplicates codex-self-check's jsonLines on purpose: this module may import only node: builtins, and that module pulls heavy deps.
const jsonl = (text) => String(text).split(/\r?\n/).flatMap((line) => {
  if (!line.startsWith('{')) return [];
  try { return [JSON.parse(line)]; } catch { return []; } // the transcript is written asynchronously: a half line is skipped
});

/**
 * Per-model totals of a Claude Code transcript. A streamed message repeats its usage on every content-block line:
 * the last line per message.id counts. `skipSidechain` leaves out subagent lines that older main transcripts inlined.
 */
export function sumTranscript(text, { skipSidechain = false } = {}) {
  const messages = new Map();
  let anonymous = 0;
  for (const entry of jsonl(text)) {
    if (entry?.type !== 'assistant' || (skipSidechain && entry.isSidechain === true)) continue;
    const message = entry.message;
    if (!message?.usage || typeof message.model !== 'string' || message.model === '<synthetic>') continue;
    messages.set(message.id ?? `anonymous-${anonymous++}`, message);
  }
  const totals = {};
  for (const { model, usage } of messages.values()) {
    const sum = (totals[model] ??= zero());
    sum.input += count(usage.input_tokens);
    sum.cache_write += count(usage.cache_creation_input_tokens);
    sum.cache_write_1h += count(usage.cache_creation?.ephemeral_1h_input_tokens);
    sum.cached_input += count(usage.cache_read_input_tokens);
    sum.output += count(usage.output_tokens);
  }
  return totals;
}

/** The `Session id:` line of the first user message (the briefing), or null. */
export function briefingId(text) {
  const first = jsonl(text).find((entry) => entry?.type === 'user');
  const content = first?.message?.content;
  const body = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '';
  return body.match(/^Session id: (\S+)/m)?.[1].slice(0, 100) ?? null;
}

const toRecords = (totals, { t, role, id, run }) => Object.entries(totals)
  .map(([model, sums]) => ({ t, harness: 'claude', role, id, model, ...sums, source: 'hook', run }));

/**
 * The nearest directory at or above `cwd` that holds `.ux-assessment/`, or null. A hook's cwd follows the main
 * session's Bash `cd`: an orchestrator that ran `cd .ux-assessment/runs/<run>` still records into the project.
 * The walk goes up to the filesystem root; an unrelated ancestor's `.ux-assessment/` could only match an agent with
 * our prefix, or a Stop whose session holds that ancestor's active-run marker.
 */
export function projectRootOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.ux-assessment'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The records for one hook call; [] when it is not ours. The first Stop that sees an unclaimed marker claims it. */
export function hookRecords(input, { t = new Date().toISOString() } = {}) {
  const cwd = projectRootOf(input?.cwd);
  if (!cwd) return [];
  if (input.hook_event_name === 'SubagentStop') {
    const type = String(input.agent_type ?? '');
    if (!type.startsWith(AGENT_PREFIX) || typeof input.agent_transcript_path !== 'string') return [];
    const text = fs.readFileSync(input.agent_transcript_path, 'utf8');
    const id = briefingId(text) ?? (input.agent_id ? String(input.agent_id) : null);
    return toRecords(sumTranscript(text), { t, role: type.slice(AGENT_PREFIX.length), id, run: readMarker(cwd)?.run ?? null });
  }
  if (input.hook_event_name === 'Stop') {
    const marker = readMarker(cwd);
    const session = input.session_id;
    if (!marker || typeof session !== 'string' || !SESSION_RE.test(session) || typeof input.transcript_path !== 'string') return [];
    if (marker.session && marker.session !== session) return []; // a later, unrelated conversation in this repository
    // Read before claiming: a transcript that cannot be read must never claim the run for this session.
    const totals = sumTranscript(fs.readFileSync(input.transcript_path, 'utf8'), { skipSidechain: true });
    if (!marker.session) fs.writeFileSync(markerPath(cwd), `${marker.run}\n${session}\n`);
    return toRecords(totals, { t, role: 'orchestrator', id: session, run: marker.run });
  }
  return [];
}

/** `usage.mjs hook`: never throws and never prints. Exit 2 would block Claude Code from stopping; stdout is hook output. */
export async function runHook({ stdin, t } = {}) {
  try {
    stdin ??= process.stdin;
    const chunks = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const records = hookRecords(input, t ? { t } : {});
    if (records.length) appendUsage(projectRootOf(input.cwd), records);
  } catch {
    // Fail soft: per-role tokens become "not measured"; `claude -p --output-format json` stays exact.
  }
}

// ---- Report (SPEC D31) ----

export const PRICES_DATE = '2026-09-29';
/**
 * USD per million tokens, list prices on PRICES_DATE (platform.claude.com/docs/en/about-claude/pricing,
 * developers.openai.com/api/docs/pricing). cw5m / cw1h: Claude cache writes with a 5-minute / 1-hour lifetime.
 */
export const PRICES = Object.freeze({
  'claude-sonnet-5-5': { input: 2, cw5m: 2.5, cw1h: 4, cached: 0.2, output: 10 },
  'claude-opus-5-5': { input: 4, cw5m: 5, cw1h: 8, cached: 0.2, output: 20 },
  'claude-haiku-4-5': { input: 1, cw5m: 1.25, cw1h: 2, cached: 0.1, output: 5 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
});
export const ALIASES = Object.freeze({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5' });

export function priceOf(model) {
  if (typeof model !== 'string') return null;
  const id = ALIASES[model] ?? model;
  return PRICES[id] ?? PRICES[id.replace(/-\d{8}$/, '')] ?? null;
}

/** API-equivalent dollars of one record; null when its model has no listed price. Cache writes without a price cost input. */
export function dollarsOf(record) {
  const price = priceOf(record.model);
  if (!price) return null;
  const write = count(record.cache_write);
  const write1h = Math.min(count(record.cache_write_1h), write);
  return (count(record.input) * price.input + (write - write1h) * (price.cw5m ?? price.input) + write1h * (price.cw1h ?? price.input)
    + count(record.cached_input) * price.cached + count(record.output) * price.output) / 1e6;
}

export function dollarLine(records) {
  let total = 0;
  const unpriced = new Set();
  for (const record of records) {
    const dollars = dollarsOf(record);
    if (dollars == null) unpriced.add(record.model ?? 'unknown model');
    else total += dollars;
  }
  const left = unpriced.size ? `; left out (no listed price): ${[...unpriced].sort().join(', ')}` : '';
  return `API-equivalent at list prices on ${PRICES_DATE}: $${total.toFixed(2)}${left}`;
}

export function readUsage(projectRoot) {
  const file = usagePath(projectRoot);
  if (!fs.existsSync(file)) return [];
  return jsonl(fs.readFileSync(file, 'utf8')).filter((record) => record && typeof record === 'object');
}

/** One run's records. Hook records are cumulative snapshots: the last per (role, id, model) counts. Codex records add up. */
export function selectRun(records, run) {
  const latest = new Map();
  const additive = [];
  for (const record of records) {
    if (record?.run !== run) continue;
    if (record.source === 'hook') latest.set(JSON.stringify([record.role, record.id, record.model]), record);
    else additive.push(record);
  }
  return [...additive, ...latest.values()];
}

const ROLE_ORDER = ['orchestrator', 'recon', 'persona', 'verifier', 'triage'];
const rank = (role) => (ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);

/** Role × model rows; `input` includes cache writes (the headline folds them in); `sessions` = distinct ids. */
export function summarize(records) {
  const rows = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.role, record.model]);
    const row = rows.get(key) ?? { role: record.role, model: record.model, ids: new Set(), input: 0, cached_input: 0, output: 0 };
    row.ids.add(record.id);
    row.input += count(record.input) + count(record.cache_write);
    row.cached_input += count(record.cached_input);
    row.output += count(record.output);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(({ ids, ...row }) => ({ role: row.role, model: row.model, sessions: ids.size, input: row.input, cached_input: row.cached_input, output: row.output }))
    .sort((a, b) => rank(a.role) - rank(b.role) || String(a.role).localeCompare(String(b.role)) || String(a.model).localeCompare(String(b.model)));
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  const k = (n / 1e3).toFixed(1);
  if (n < 1e6 && Number(k) < 1000) return `${k}k`; // 999950..999999 round to "1000.0k": print them in millions
  return `${(n / 1e6).toFixed(2)}M`;
}

const HEADER = ['| role | model | sessions | input | cached input | output |', '|---|---|---|---|---|---|'];

/** Claude hook output comes from Claude Code transcripts, which carry less output than is billed (knowledge/cost.md). */
export const CLAUDE_OUTPUT_NOTE = 'Claude output and the dollar line run low: Claude Code transcripts carry less output than is billed (57 % on 2026-09-29, dollars 14 % low); `claude -p --output-format json` gives the exact total.';

export function formatReport(all, run) {
  const records = selectRun(all, run);
  if (!records.length) return `No usage records for run ${run}: tokens not measured.`;
  const rows = summarize(records);
  const lines = [...HEADER];
  for (const r of rows) lines.push(`| ${r.role} | ${r.model} | ${r.sessions} | ${formatTokens(r.input)} | ${formatTokens(r.cached_input)} | ${formatTokens(r.output)} |`);
  const totals = new Map();
  for (const r of rows) {
    const m = totals.get(r.model) ?? { sessions: 0, input: 0, cached_input: 0, output: 0 };
    m.sessions += r.sessions;
    m.input += r.input;
    m.cached_input += r.cached_input;
    m.output += r.output;
    totals.set(r.model, m);
  }
  for (const [model, m] of [...totals].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
    lines.push(`| **total** | ${model} | ${m.sessions} | ${formatTokens(m.input)} | ${formatTokens(m.cached_input)} | ${formatTokens(m.output)} |`);
  }
  lines.push('', 'Input includes cache writes; output includes reasoning tokens.');
  if (records.some((r) => r.harness === 'claude' && r.source === 'hook')) lines.push(CLAUDE_OUTPUT_NOTE);
  lines.push(rows.some((r) => r.role === 'orchestrator')
    ? 'Orchestrator: the whole conversation, recorded when a turn ends; run this report again after the conversation ends for the final figure.'
    : 'Orchestrator: not recorded yet (Claude Code records it when the conversation\'s turn ends; run this report again afterwards; the Codex main session is not measured).');
  lines.push(dollarLine(records));
  return lines.join('\n');
}

/** `report <run folder>`: the folder is `<project>/.ux-assessment/runs/<name>`; it need not exist. */
export function reportFor(runFolder) {
  const dir = path.resolve(runFolder);
  const runs = path.dirname(dir);
  if (path.basename(runs) !== 'runs' || path.basename(path.dirname(runs)) !== '.ux-assessment' || !validRun(path.basename(dir))) {
    throw new Error(`${dir} is not a run folder (<project>/.ux-assessment/runs/<name>)`);
  }
  return formatReport(readUsage(path.dirname(path.dirname(runs))), path.basename(dir));
}

// ---- Estimate (SPEC D31) ----

export const COST_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge', 'cost.md');
export const LOW_STEPS = 8;
export const VERIFY_CAP = 15;

/** The first ```yaml block of knowledge/cost.md. `yaml` is imported here only: the hook must not load it. */
export async function loadCoefficients(file = COST_FILE) {
  const block = fs.readFileSync(file, 'utf8').match(/```yaml\r?\n([\s\S]*?)```/);
  if (!block) throw new Error(`${file} has no yaml block`);
  const { default: YAML } = await import('yaml');
  return YAML.parse(block[1]);
}

const ESTIMATE_FLAGS = ['--harness', '--personas', '--cap', '--verify', '--depth'];

export function parseEstimateArgs(argv) {
  const opts = { harness: null, personas: 0, cap: 0, verify: 0, depth: 'standard' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!ESTIMATE_FLAGS.includes(flag)) throw new Error(`unknown estimate option ${JSON.stringify(flag)}`);
    if (value == null || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--harness') opts.harness = value;
    else if (flag === '--depth') opts.depth = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a whole number`);
      opts[flag.slice(2)] = n;
    }
  }
  if (!['claude', 'codex'].includes(opts.harness)) throw new Error('--harness must be claude or codex');
  if (!['quick', 'standard', 'none'].includes(opts.depth)) throw new Error('--depth must be quick, standard or none');
  if (!opts.verify && !(opts.personas > 0 && opts.cap > 0)) throw new Error('give --personas <n> and --cap <c>, or --verify <n>');
  return opts;
}

/** Low–high token rows per role. A verify estimate (`verify` > 0) is verifiers plus the verify orchestrator. */
export function estimate({ harness, personas = 0, cap = 0, verify = 0, depth = 'standard', coefficients }) {
  const table = coefficients?.[harness];
  if (!table) throw new Error(`knowledge/cost.md has no coefficients for ${harness}`);
  const rows = [];
  const perStep = (role, sessions, maxSteps) => {
    const c = table[role];
    if (!c?.per_step) return rows.push({ role, model: c?.model ?? null, sessions, measured: false });
    const steps = [Math.min(LOW_STEPS, maxSteps), maxSteps];
    const scale = (key) => steps.map((n) => sessions * n * c.per_step[key]);
    return rows.push({ role, model: c.model, sessions, measured: true, input: scale('input'), cached_input: scale('cached_input'), output: scale('output') });
  };
  const fixed = (role, key) => {
    const c = table[key];
    if (!c?.fixed) return rows.push({ role, model: c?.model ?? null, sessions: 1, measured: false });
    return rows.push({ role, model: c.model, sessions: 1, measured: true, input: c.fixed.input, cached_input: c.fixed.cached_input, output: c.fixed.output });
  };
  if (verify > 0) {
    perStep('verifier', verify, VERIFY_CAP);
    fixed('orchestrator', 'orchestrator_verify');
    return rows;
  }
  if (depth !== 'none') fixed('recon', depth === 'quick' ? 'recon_quick' : 'recon');
  perStep('persona', personas, cap);
  fixed('triage', 'triage');
  fixed('orchestrator', 'orchestrator');
  return rows;
}

const formatRange = ([lo, hi]) => (lo === hi ? formatTokens(lo) : `${formatTokens(lo)}–${formatTokens(hi)}`);

export function formatEstimate(rows) {
  const lines = [...HEADER];
  let lo = 0;
  let hi = 0;
  let priced = 0;
  const notMeasured = [];
  const unpriced = new Set();
  for (const r of rows) {
    if (!r.measured) {
      lines.push(`| ${r.role} | ${r.model ?? 'the session model'} | ${r.sessions} | not measured | not measured | not measured |`);
      notMeasured.push(r.role);
      continue;
    }
    lines.push(`| ${r.role} | ${r.model} | ${r.sessions} | ${formatRange(r.input)} | ${formatRange(r.cached_input)} | ${formatRange(r.output)} |`);
    const at = (i) => dollarsOf({ model: r.model, input: r.input[i], cache_write: 0, cache_write_1h: 0, cached_input: r.cached_input[i], output: r.output[i] });
    if (at(0) == null) { unpriced.add(r.model); continue; }
    lo += at(0);
    hi += at(1);
    priced += 1;
  }
  lines.push('', `Low: ${LOW_STEPS} steps per session (or the cap if lower); high: the cap (${VERIFY_CAP} for a verifier). Input includes cache writes.`);
  const notes = [
    notMeasured.length ? `not measured: ${notMeasured.join(', ')}` : null,
    unpriced.size ? `left out (no listed price): ${[...unpriced].sort().join(', ')}` : null,
  ].filter(Boolean);
  const dollars = priced ? `$${lo.toFixed(2)}–$${hi.toFixed(2)} (cache writes priced as input)` : 'none (no measured row has a listed price)';
  lines.push(`API-equivalent at list prices on ${PRICES_DATE}: ${dollars}${notes.length ? `; ${notes.join('; ')}` : ''}`);
  return lines.join('\n');
}

// ---- CLI ----

const USAGE = 'usage: node usage.mjs hook | report <run folder> | estimate --harness <claude|codex> '
  + '(--personas <n> --cap <c> [--depth quick|standard|none] | --verify <n>)';

export async function main(argv, { out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const [command, ...rest] = argv;
  if (command === 'report' && rest.length === 1) {
    out(reportFor(rest[0]));
    return 0;
  }
  if (command === 'estimate') {
    const opts = parseEstimateArgs(rest);
    out(formatEstimate(estimate({ ...opts, coefficients: await loadCoefficients() })));
    return 0;
  }
  throw new Error(USAGE);
}

if (isMain()) {
  if (process.argv[2] === 'hook') {
    await runHook(); // exit 0, no output, whatever happened
  } else {
    try {
      process.exitCode = await main(process.argv.slice(2));
    } catch (error) {
      process.stderr.write(`${error.message.split('\n')[0]}\n`);
      process.exitCode = 1;
    }
  }
}
