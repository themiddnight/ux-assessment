#!/usr/bin/env node
// Decide step: which findings of a run to fix, keep or ask the developer about. The agent proposes in
// decisions.yaml; `record` checks it (a keep needs a quote found in a file) and writes suggestions into feedback.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  DECISIONS, SECTION_RE, BULLET_ID_RE, byId, checkRunName, evidenceFor, readDecisions, readFindings, rootOf, sourceRef,
} from './ledger.mjs';
import { configPath } from './models.mjs';
import { isInside } from './paths.mjs';

/** Documents saved from outside the repo (a drive, a wiki, a ticket) so that a `keep` can cite them. */
export const SAVED_DOCS = '.ux-assessment/docs';
const CHARTER = '.ux-assessment/charter.md';
export const DEFAULT_DOCS = ['AGENTS.md', 'CLAUDE.md', 'README*', 'SPEC.md', 'PRD*', 'docs/**', `${SAVED_DOCS}/**`];
const MAX_DOCS = 200;
const DOC_EXT = /\.(md|mdx|txt|rst)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.ux-assessment']);
const ASK_OPTIONS = ['Fix it', 'Keep: leave it as it is'];
const GLOB = /\*/;
const NOT_TEXT = 'an option that is not text was dropped';

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const slashed = (p) => p.split(path.sep).join('/');
/** Project files first, then the absolute ones outside it; plain code-point order inside each. */
const compare = (a, b) => (path.isAbsolute(a) - path.isAbsolute(b)) || (a < b ? -1 : a > b ? 1 : 0);
const statFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Files below dir, `depth` folders deep at most. A symlinked folder is not followed (loops); a symlinked file is a file. */
function walk(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) out.push(...walk(full, depth - 1)); }
    else if (e.isFile() || (e.isSymbolicLink() && statFile(full))) out.push(full);
  }
  return out;
}

/** `*` stays inside a folder name, `**` crosses folders; nothing else is special. */
function globRegex(segments) {
  const last = segments.length - 1;
  const body = segments.map((seg, i) => (seg === '**' ? (i === last ? '.*' : '(?:[^/]+/)*')
    : `${seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*')}${i === last ? '' : '/'}`)).join('');
  return new RegExp(`^${body}$`);
}

/** Absolute paths of the files a pattern names: a file, a folder (recursive) or a glob. Any extension. */
function expand(root, pattern) {
  const segments = String(pattern).replace(/\\/g, '/').split('/');
  const first = segments.findIndex((s) => GLOB.test(s));
  if (first < 0) {
    const target = path.resolve(root, pattern);
    const rel = slashed(path.relative(root, target));
    if (isInside(root, target) && rel !== SAVED_DOCS && !rel.startsWith(`${SAVED_DOCS}/`) && rel.split('/').some((s) => SKIP_DIRS.has(s))) return [];
    if (statFile(target)) return [target];
    return fs.existsSync(target) ? walk(target, Infinity) : [];
  }
  const rest = segments.slice(first);
  const base = path.resolve(root, segments.slice(0, first).join('/') || (path.isAbsolute(pattern) ? path.sep : '.'));
  const re = globRegex(rest);
  return walk(base, rest.includes('**') ? Infinity : rest.length - 1).filter((f) => re.test(slashed(path.relative(base, f))));
}

/** Product documents for the patterns: sorted, one per real file, relative to the project (outside it: absolute). */
export function resolveDocs(project, patterns) {
  const root = path.resolve(project);
  const warnings = [];
  const shown = new Map(); // path as shown → absolute
  for (const pattern of patterns) {
    const hits = expand(root, pattern);
    const docs = hits.filter((f) => DOC_EXT.test(f));
    if (!docs.length && !DEFAULT_DOCS.includes(pattern)) {
      const named = !GLOB.test(pattern) && hits.length === 1 && hits[0] === path.resolve(root, pattern);
      warnings.push(named ? `product_docs: "${pattern}" is not a document (.md, .mdx, .txt or .rst), skipped`
        : `product_docs: "${pattern}" matches no document`);
    }
    for (const abs of docs) shown.set(isInside(root, abs) ? slashed(path.relative(root, abs)) : slashed(abs), abs);
  }
  const seen = new Set();
  const files = [...shown.keys()].sort(compare).filter((f) => {
    const real = fs.realpathSync(shown.get(f));
    return !seen.has(real) && seen.add(real);
  });
  if (files.length > MAX_DOCS) {
    warnings.push(`product_docs: ${files.length} documents found, ${files.length - MAX_DOCS} left out (the limit is ${MAX_DOCS}); narrow product_docs`);
    files.length = MAX_DOCS;
  }
  return { files, warnings };
}

export function decideConfig(project) {
  const file = configPath(path.resolve(project));
  let doc = null;
  if (fs.existsSync(file)) {
    try { doc = YAML.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message.split('\n')[0]}`);
    }
  }
  const { decide, product_docs: docs } = isMap(doc) ? doc : {};
  const off = decide === false || /^(off|false|no)$/i.test(String(decide));
  if (decide != null && !off && decide !== true && !/^(on|true|yes)$/i.test(String(decide))) throw new Error(`decide in ${file}: must be on or off`);
  const patterns = docs == null ? DEFAULT_DOCS : typeof docs === 'string' ? [docs] : docs;
  if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) throw new Error(`product_docs in ${file}: must be a list of paths`);
  return { enabled: !off, patterns };
}

const readRunFindings = (project, run) => {
  const file = path.join(rootOf(project), 'runs', checkRunName(run), 'findings.yaml');
  if (!fs.existsSync(file)) throw new Error(`no findings.yaml for run ${run} (looked in ${file})`);
  return readFindings(fs.readFileSync(file, 'utf8'));
};

/** ux findings of the run that the agent still has to decide: not suppressed, no developer label in the ledger. */
export function todoFindings(project, run) {
  const found = readRunFindings(project, run);
  const root = rootOf(project);
  const ledgerFile = path.join(root, 'ledger.yaml');
  const ledger = fs.existsSync(ledgerFile) ? YAML.parse(fs.readFileSync(ledgerFile, 'utf8')) : null;
  const labelled = (id) => ledger?.findings?.[id]?.label?.value;
  return found.filter((f) => f.kind === 'ux' && f.suppressed !== true && !labelled(f.id)).map((f) => ({
    id: f.id, title: f.title ?? '', title_local: f.title_local ?? f.title ?? '', severity: f.severity ?? null, confidence: f.confidence ?? null,
    personas: f.personas ?? [], what_happened: f.what_happened ?? '', why_it_matters: f.why_it_matters ?? null,
    suggested_fix: f.suggested_fix ?? null, code_pointer: f.code_pointer ?? null, intended: f.intended ?? null,
    screenshots: evidenceFor(root, f.id, { sightings: [{ run, evidence: f.evidence }], check: f.check }).screenshots,
  }));
}

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 1-based lines where the quote starts, comparing with every run of whitespace as one space. */
function quoteLines(text, quote) {
  let norm = '';
  const at = []; // index in `text` of each char of `norm`
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) { if (norm && !norm.endsWith(' ')) { norm += ' '; at.push(i); } } else { norm += text[i]; at.push(i); }
  }
  const lines = [];
  for (let from = norm.indexOf(quote); from >= 0; from = norm.indexOf(quote, from + 1)) {
    lines.push(text.slice(0, at[from]).split('\n').length);
  }
  return lines;
}

/** Checks one source against its file. Returns the cleaned source, or the reason it was dropped. */
function checkSource(source, readFile, relPath) {
  const p = typeof source?.path === 'string' ? source.path.trim() : '';
  const quote = flat(source?.quote);
  if (!p || !quote) return { drop: 'source without a path or quote dropped' };
  let text;
  try { text = readFile(p); } catch (error) { return { drop: `source ${p} dropped (${error.message})` }; }
  const lines = quoteLines(text, quote);
  if (!lines.length) return { drop: `source ${p} dropped (quote not found in the file)` };
  const wanted = Number(source.line);
  return { source: { path: relPath(p), line: lines.includes(wanted) ? wanted : lines[0], quote } };
}

/**
 * The agent's decisions against the findings it had to decide. `readFile(path)` returns a file's text or throws an Error whose
 * message says why it may not be used. Every change sets `guard` and adds a warning. A guard already on an entry stays only when
 * the file was `checked` (written by `record`): in the agent's own file it is not trusted.
 */
export function checkDecisions({ decisions, todo, readFile, relPath = (p) => p, checked = false }) {
  const warnings = [];
  const wanted = new Set(todo.map((f) => f.id));
  const given = new Map();
  for (const d of decisions) {
    if (!wanted.has(d?.id)) { warnings.push(`${d?.id}: not a finding to decide in this run, dropped`); continue; }
    if (given.has(d.id)) warnings.push(`${d.id}: decided twice, the last one counts`);
    given.set(d.id, d);
  }
  const out = todo.map(({ id }) => {
    const d = given.get(id);
    if (!d) {
      warnings.push(`${id}: no decision returned`);
      return { id, decision: 'ask', reason: 'The decide agent returned no decision for this finding.', sources: [], options: [...ASK_OPTIONS], guard: 'no decision returned' };
    }
    const guards = [];
    const sources = [];
    for (const raw of Array.isArray(d.sources) ? d.sources : []) {
      const { source, drop } = checkSource(raw, readFile, relPath);
      if (drop) guards.push(drop); else sources.push(source);
    }
    let decision = d.decision;
    if (!DECISIONS.includes(decision)) { guards.push(`unknown decision ${JSON.stringify(decision)}: counted as ask`); decision = 'ask'; }
    else if (decision === 'keep' && !sources.length) {
      guards.push(Array.isArray(d.sources) && d.sources.length ? 'keep without a usable source: counted as ask' : 'keep without a source: counted as ask');
      decision = 'ask';
    }
    let options = [];
    for (const o of Array.isArray(d.options) ? d.options : []) {
      const pair = isMap(o) && Object.keys(o).length === 1 ? Object.entries(o)[0] : null; // an unquoted `- Keep: text` parses as a one-key map
      const text = typeof o === 'string' ? o : typeof pair?.[1] === 'string' ? `${pair[0]}: ${pair[1]}` : null;
      if (text != null) options.push(flat(text));
      else if (!guards.includes(NOT_TEXT)) guards.push(NOT_TEXT);
    }
    options = options.filter(Boolean);
    if (decision === 'ask' && options.length < 2) {
      options = [...ASK_OPTIONS];
      if (d.decision === 'ask') guards.push('ask with fewer than two options: the default two were used');
    }
    if (guards.length) warnings.push(`${id}: ${guards.join('; ')}`);
    return { id, decision, reason: flat(d.reason), sources, options, guard: guards.length ? guards.join('; ') : checked && typeof d.guard === 'string' ? d.guard : null };
  });
  return { decisions: out, warnings };
}

export const suggestText = (d) => (d.decision === 'keep' && d.sources?.length ? `keep (${sourceRef(d.sources[0])})` : d.decision);

/** feedback.md with a `— suggest:` segment before `— label:` on each line of the run's section that has a decision. */
export function withSuggestions(feedbackText, run, decisions) {
  const byIdMap = new Map(decisions.map((d) => [d.id, d]));
  let inRun = false;
  return String(feedbackText).split('\n').map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const section = SECTION_RE.exec(line);
    if (section) { inRun = section[1] === run; return raw; }
    if (/^\s*##(?!#)/.test(line)) { inRun = false; return raw; }
    const d = inRun ? byIdMap.get(BULLET_ID_RE.exec(line)?.[1].toUpperCase()) : null;
    const m = d && /^(.*)(\s+[—–-]{1,2}\s*label\s*:.*)$/i.exec(line);
    if (!m) return raw;
    return `${m[1].replace(/\s+[—–-]{1,2}\s*suggest\s*:.*$/i, '')} — suggest: ${suggestText(d)}${m[2]}${cr}`;
  }).join('\n');
}

/** The report's Decisions section: Needs you (with options), To fix, Kept (with the source). `titles` maps id to title_local. */
export function decisionsTable(decisions, titles = {}) {
  const row = (d, extra) => `- ${[titles[d.id] ? `${d.id} · ${titles[d.id]}` : d.id, ...extra, flat(d.reason)].filter(Boolean).join(' — ')}`;
  const groups = [
    ['Needs you', 'ask', (d) => [row(d, []), ...(d.options ?? []).map((o) => `  - ${o}`)]],
    ['To fix', 'fix', (d) => [row(d, [])]],
    ['Kept', 'keep', (d) => [row(d, d.sources?.length ? [sourceRef(d.sources[0])] : [])]],
  ];
  const blocks = groups.map(([title, value, lines]) => {
    const rows = decisions.filter((d) => d.decision === value).sort((a, b) => byId(a.id, b.id));
    return rows.length ? [`### ${title} (${rows.length})`, '', ...rows.flatMap(lines)].join('\n') : null;
  }).filter(Boolean);
  return blocks.length ? `${blocks.join('\n\n')}\n` : 'No findings to decide.\n';
}

const decisionsFile = (project, run) => path.join(rootOf(project), 'runs', checkRunName(run), 'decisions.yaml');

function readAgentDecisions(file) {
  if (!fs.existsSync(file)) throw new Error(`no decisions.yaml in ${path.dirname(file)}; the decide agent writes it`);
  try {
    return readDecisions(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message.split('\n')[0]}`);
  }
}

/** Checks the agent's decisions.yaml, rewrites it normalized and updates the run's section of feedback.md. */
export function recordDecisions(project, run) {
  const root = path.resolve(project);
  const file = decisionsFile(root, run);
  const todo = todoFindings(root, run);
  const { list, decidedAt, checked } = readAgentDecisions(file);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const realRoot = real(root);
  const docs = new Set(resolveDocs(root, decideConfig(root).patterns).files.map((f) => real(path.resolve(root, f))));
  const readFile = (p) => {
    const abs = path.resolve(root, p);
    const at = real(abs);
    if (!at) throw new Error(isInside(root, abs) ? 'file not found' : 'not inside the project or a product document');
    if (!isInside(realRoot, at) && !docs.has(at)) throw new Error('not inside the project or a product document');
    const rel = slashed(path.relative(realRoot, at));
    if (rel.startsWith('.ux-assessment/') && rel !== CHARTER && !rel.startsWith(`${SAVED_DOCS}/`)) throw new Error('not a citable file');
    try { return fs.readFileSync(at, 'utf8'); } catch { throw new Error('cannot be read'); }
  };
  const relPath = (p) => {
    const abs = path.resolve(root, p);
    const at = real(abs) ?? abs;
    return slashed(isInside(root, abs) ? path.relative(root, abs) : isInside(realRoot, at) ? path.relative(realRoot, at) : abs);
  };
  const { decisions, warnings } = checkDecisions({ decisions: list, todo, readFile, relPath, checked });
  const doc = { run, decided_at: decidedAt ?? new Date().toISOString(), checked: true, decisions };
  fs.writeFileSync(file, `# Written by ux-assessment driver/decide.mjs record from the decide agent's decisions.yaml\n${YAML.stringify(doc, { lineWidth: 0 })}`);
  const feedback = path.join(rootOf(root), 'feedback.md');
  if (fs.existsSync(feedback)) {
    const before = fs.readFileSync(feedback, 'utf8');
    const after = withSuggestions(before, run, decisions);
    if (after !== before) fs.writeFileSync(feedback, after);
  }
  return { decisions, warnings };
}

const warn = (message) => process.stderr.write(`decide: warning: ${message}\n`);
const USAGE = 'usage: decide.mjs docs <project> | decide.mjs todo|record|table <project> --run <folder>';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, project, ...rest] = process.argv.slice(2);
  try {
    if (!['docs', 'todo', 'record', 'table'].includes(cmd) || !project) {
      throw new Error(cmd && project ? `unknown command ${cmd}\n${USAGE}` : USAGE);
    }
    const i = rest.indexOf('--run');
    const run = i >= 0 ? rest[i + 1] : null;
    if (cmd !== 'docs' && !run) throw new Error(`${cmd} needs --run <folder>`);
    if (run) checkRunName(run);
    const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    if (cmd === 'docs') {
      const { enabled, patterns } = decideConfig(project);
      json({ enabled, patterns, ...resolveDocs(project, patterns) });
    } else if (cmd === 'todo') {
      const docs = resolveDocs(project, decideConfig(project).patterns);
      for (const w of docs.warnings) warn(w);
      json({ run, findings: todoFindings(project, run), docs: docs.files });
    } else if (cmd === 'record') {
      const { decisions, warnings } = recordDecisions(project, run);
      for (const w of warnings) warn(w);
      const counts = { fix: 0, keep: 0, ask: 0 };
      for (const d of decisions) counts[d.decision] += 1;
      process.stdout.write(`${JSON.stringify({ decisions: decisions.length, counts, guards: decisions.filter((d) => d.guard).map((d) => d.id) })}\n`);
    } else {
      const { list } = readAgentDecisions(decisionsFile(project, run));
      const titles = Object.fromEntries(readRunFindings(project, run).map((f) => [f.id, f.title_local ?? f.title]));
      process.stdout.write(decisionsTable(list, titles));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
