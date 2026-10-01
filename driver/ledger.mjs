#!/usr/bin/env node
// Cross-run finding ledger (.ux-assessment/ledger.yaml): identity, history and status of every finding.
// Deterministic and idempotent; never drops the history of a run whose folder has gone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { VIEWPORTS } from './session.mjs';
import { isInside } from './paths.mjs';

export const OPEN_STATUSES = ['open', 'still_present', 'not_seen', 'regressed'];
const RUN_RE = /^(\d{4}-\d{2}-\d{2})(?:-(.+))?$/;

export function parseRunName(name) {
  const m = RUN_RE.exec(name);
  return m ? { date: m[1], suffix: m[2] ?? '' } : null;
}

/** Date, then started_at (runs without one first), then suffix ('' first, numbers numeric). */
export function compareRuns(a, b) {
  const pa = parseRunName(a.name), pb = parseRunName(b.name);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : a.name.localeCompare(b.name, 'en', { numeric: true });
  if (pa.date !== pb.date) return pa.date < pb.date ? -1 : 1;
  const ta = a.started_at ?? '', tb = b.started_at ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return pa.suffix.localeCompare(pb.suffix, 'en', { numeric: true });
}

export function normalizeLabel(raw) {
  const s = String(raw).toLowerCase().replace(/[‘’ʼ`´]/g, "'")
    .replace(/[-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '' || s === '?') return { label: null };
  if (s === 'valid') return { label: 'valid' };
  if (s === 'not real' || s === 'notreal') return { label: 'not real' };
  if (/^(known )?won'?t fix$/.test(s)) return { label: "won't fix" };
  return { label: null, unknown: String(raw).trim() };
}

const SECTION_RE = /^\s*##\s*run\s+(\S+)/i;
const LINE_RE = /^\s*[-*]\s+([A-Za-z]+-\d+)\b(.*)\s+[—–-]{1,2}\s*label\s*:\s*(.*?)\s*(?:[—–-]{1,2}\s*note\s*:\s*(.*?))?\s*$/i;
const BULLET_ID_RE = /^\s*[-*]\s+([A-Za-z]+-\d+)\b/;

export function parseFeedback(text) {
  const labels = [];
  const warnings = [];
  let run = null;
  let badHeading = false;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const section = SECTION_RE.exec(raw);
    if (section) { run = section[1]; badHeading = false; return; }
    if (/^\s*##(?!#)/.test(raw)) { run = null; badHeading = true; return; } // "###" sub-headings keep the run
    const m = LINE_RE.exec(raw);
    if (!m) {
      const bullet = BULLET_ID_RE.exec(raw);
      if (bullet && /\blabel\b/i.test(raw)) {
        warnings.push(`feedback.md line ${i + 1}: unreadable label line for ${bullet[1].toUpperCase()} (ignored)`);
      }
      return;
    }
    const id = m[1].toUpperCase();
    const { label, unknown } = normalizeLabel(m[3]);
    if (unknown) warnings.push(`feedback.md line ${i + 1}: unknown label "${unknown}" for ${id} (ignored)`);
    if (badHeading && (label || unknown)) warnings.push(`feedback.md line ${i + 1}: label for ${id} follows a non-run heading; run left unknown`);
    labels.push({ id, run, label, note: (m[4] ?? '').trim(), line: i + 1 });
  });
  return { labels, warnings };
}

/** Latest non-? label per id: later run first, then later line. Sections of unknown runs rank earliest. */
export function latestLabels(labels, runOrder) {
  const rank = (run) => (run == null ? -1 : runOrder.indexOf(run));
  const latest = new Map();
  for (const l of labels.filter((x) => x.label).sort((a, b) => rank(a.run) - rank(b.run) || a.line - b.line)) {
    latest.set(l.id, l);
  }
  return latest;
}

export function readFindings(text) {
  const doc = YAML.parse(text);
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.findings) ? doc.findings : [];
  return list.filter((f) => f && typeof f.id === 'string')
    .map((f) => ({ ...f, kind: f.kind ?? f.category ?? 'ux' }));
}

const usable = (e) => e.type === 'sighting' || e.verdict === 'reproduced' || e.verdict === 'changed'
  || (e.verdict === 'not_reproduced' && Number.isInteger(e.at_step));

export function computeStatus({ label = null, suppressed = false, events = [] }) {
  if (label === 'not real') return 'not_real';
  if (label === "won't fix" || suppressed) return 'suppressed';
  const perRun = new Map(); // last usable event of each run, in run order
  for (const e of [...events].sort((a, b) => a.order - b.order).filter(usable)) {
    perRun.delete(e.run);
    perRun.set(e.run, e);
  }
  let status = 'open';
  let clean = 0;
  let everFixed = false;
  for (const e of perRun.values()) {
    if (e.type === 'sighting') { status = everFixed ? 'regressed' : 'open'; clean = 0; }
    else if (e.verdict === 'reproduced') { status = 'still_present'; clean = 0; }
    else if (e.verdict === 'changed') { status = 'needs_review'; clean = 0; }
    else { clean += 1; status = clean >= 2 ? 'fixed' : 'not_seen'; everFixed ||= clean >= 2; }
  }
  return status;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const STATUS_WORDS = {
  open: 'open', still_present: 'still there', not_seen: 'not seen this time', fixed: 'fixed',
  needs_review: 'needs review', regressed: 'came back', not_real: 'not real', suppressed: "won't fix",
};
export const byId = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const readYaml = (file) => YAML.parse(fs.readFileSync(file, 'utf8'));
const subdirs = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : []);
const iso = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** --run is the name of a folder under .ux-assessment/runs, never a path. */
export function checkRunName(run) {
  const name = String(run ?? '');
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error(`--run takes the run folder name, such as 2026-09-29-verify, not a path (got ${JSON.stringify(name)})`);
  }
  return name;
}
const rootOf = (project) => path.join(path.resolve(project), '.ux-assessment');

function firstLogTime(runDir, warnings) {
  let min = null;
  for (const s of subdirs(runDir)) {
    const log = path.join(runDir, s, 'log.jsonl');
    if (!fs.existsSync(log)) continue;
    const first = fs.readFileSync(log, 'utf8').split('\n', 1)[0];
    try {
      const t = JSON.parse(first).t;
      if (Number.isFinite(t) && (min === null || t < min)) min = t;
    } catch {
      warnings.push(`${path.relative(path.dirname(path.dirname(runDir)), log)}: unreadable first line, ignored for run order`);
    }
  }
  return min === null ? null : iso(min);
}

function replaceRunEvents(ledger, run, field, pairs) {
  for (const entry of Object.values(ledger.findings)) entry[field] = (entry[field] ?? []).filter((e) => e.run !== run);
  for (const [id, event] of pairs) {
    const entry = (ledger.findings[id] ??= { sightings: [], verifications: [] });
    (entry[field] ??= []).push(event);
  }
}

const runOrder = (runs) => Object.entries(runs)
  .map(([name, r]) => ({ name, started_at: r.started_at ?? null })).sort(compareRuns).map((r) => r.name);

export function syncLedger(project) {
  const root = rootOf(project);
  const file = path.join(root, 'ledger.yaml');
  const warnings = [];
  const ledger = (fs.existsSync(file) ? readYaml(file) : null) ?? {};
  ledger.runs ??= {};
  ledger.findings ??= {};
  const runsDir = path.join(root, 'runs');
  for (const name of subdirs(runsDir)) {
    if (!parseRunName(name)) { warnings.push(`runs/${name}: not a YYYY-MM-DD[-suffix] name, skipped`); continue; }
    const dir = path.join(runsDir, name);
    const verifyFile = path.join(dir, 'verify.yaml');
    const findingsFile = path.join(dir, 'findings.yaml');
    try {
      if (fs.existsSync(verifyFile)) {
        const doc = readYaml(verifyFile) ?? {};
        ledger.runs[name] = { kind: 'verify',
          started_at: iso(doc.started_at) ?? ledger.runs[name]?.started_at ?? firstLogTime(dir, warnings) };
        replaceRunEvents(ledger, name, 'verifications', (doc.results ?? []).filter((r) => r?.id).map((r) => [r.id, {
          run: name, verdict: r.verdict, at_step: Number.isInteger(r.at_step) ? r.at_step : null,
          at_screenshot: r.at_screenshot ?? null, evidence: r.evidence ?? [], note: r.note ?? '',
        }]));
      } else if (fs.existsSync(findingsFile)) {
        const runJson = path.join(dir, 'run.json');
        const started = fs.existsSync(runJson) ? iso(JSON.parse(fs.readFileSync(runJson, 'utf8')).started_at) : null;
        ledger.runs[name] = { kind: 'persona',
          started_at: started ?? ledger.runs[name]?.started_at ?? firstLogTime(dir, warnings) };
        replaceRunEvents(ledger, name, 'sightings', readFindings(fs.readFileSync(findingsFile, 'utf8')).map((f) => [f.id, {
          run: name, title: f.title ?? '', kind: f.kind, severity: f.severity ?? null, confidence: f.confidence ?? null,
          personas: f.personas ?? [], evidence: f.evidence ?? [], what_happened: f.what_happened ?? '',
          check: f.check ?? null, suppressed: f.suppressed === true,
        }]));
      }
    } catch (error) {
      warnings.push(`runs/${name}: ${error.message.split('\n')[0]} (kept the ledger's earlier events for this run)`);
    }
  }
  for (const [id, e] of Object.entries(ledger.findings)) {
    if (!e.sightings?.length && !e.verifications?.length) delete ledger.findings[id];
  }
  const order = runOrder(ledger.runs);
  const feedback = path.join(root, 'feedback.md');
  if (fs.existsSync(feedback)) {
    const parsed = parseFeedback(fs.readFileSync(feedback, 'utf8'));
    warnings.push(...parsed.warnings);
    for (const [id, l] of latestLabels(parsed.labels, order)) {
      if (!ledger.findings[id]) { warnings.push(`feedback.md: label for ${id}, which no run has, ignored`); continue; }
      ledger.findings[id].label = { value: l.label, note: l.note, run: l.run };
    }
  }
  const idx = new Map(order.map((n, i) => [n, i]));
  const sortEvents = (list) => list.sort((a, b) => idx.get(a.run) - idx.get(b.run));
  const findings = {};
  for (const id of Object.keys(ledger.findings).sort(byId)) {
    const e = ledger.findings[id];
    const sightings = sortEvents(e.sightings ?? []);
    const verifications = sortEvents(e.verifications ?? []);
    const last = sightings.at(-1);
    const events = [
      ...sightings.map((s) => ({ run: s.run, order: idx.get(s.run), type: 'sighting' })),
      ...verifications.map((v) => ({ run: v.run, order: idx.get(v.run), type: 'verification', verdict: v.verdict, at_step: v.at_step })),
    ];
    findings[id] = {
      title: last?.title ?? e.title ?? '', kind: last?.kind ?? e.kind ?? 'ux', severity: last?.severity ?? e.severity ?? null,
      status: computeStatus({ label: e.label?.value ?? null, suppressed: last?.suppressed === true, events }),
      label: e.label ?? null, last_seen: last?.run ?? null, check: sightings.findLast((s) => s.check)?.check ?? null,
      sightings, verifications,
    };
  }
  const out = { version: 1, runs: Object.fromEntries(order.map((n) => [n, ledger.runs[n]])), findings };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `# Generated by ux-assessment driver/ledger.mjs sync. Labels belong in feedback.md.\n${YAML.stringify(out, { lineWidth: 0 })}`);
  fs.renameSync(tmp, file);
  return { ledger: out, warnings };
}

function loadLedger(project) {
  const file = path.join(rootOf(project), 'ledger.yaml');
  if (!fs.existsSync(file)) throw new Error(`no ledger at ${file}; run: ledger.mjs sync <project>`);
  return readYaml(file);
}

function sessionFacts(personaDir, check) {
  const setup = {};
  const signals = personaDir ? path.join(personaDir, 'signals.jsonl') : null;
  if (signals && fs.existsSync(signals)) {
    for (const line of fs.readFileSync(signals, 'utf8').split('\n')) {
      if (!line.includes('"setup"')) continue;
      try { const s = JSON.parse(line); if (s.type === 'setup') Object.assign(setup, s); } catch { /* torn harness line: other setup lines still count */ }
    }
  }
  const derived = Object.entries(VIEWPORTS).find(([, d]) =>
    d.viewport.width === setup.viewport?.width && d.viewport.height === setup.viewport?.height)?.[0];
  const storage = setup.storage_state ?? null;
  return {
    device: check?.device ?? derived ?? 'desktop',
    url: setup.url ?? null,
    start_state: check?.start_state ?? (storage ? 'returning' : 'newcomer'),
    account: check?.account ?? null,
    storage_state: storage,
  };
}

/** Evidence must stay inside .ux-assessment, also through symlinks: a verifier is shown these files. */
function insideRoot(root, id, raw, p) {
  let out = !isInside(root, p);
  if (!out && fs.existsSync(p)) out = !isInside(fs.realpathSync(root), fs.realpathSync(p));
  if (out) process.stderr.write(`ledger: warning: ${id} evidence ${JSON.stringify(raw)} is outside .ux-assessment, dropped\n`);
  return !out;
}

function evidenceFor(root, id, entry) {
  for (const s of [...entry.sightings].reverse()) {
    const shots = (s.evidence ?? []).filter((x) => typeof x === 'string' && /\.png$/i.test(x.trim()))
      .map((x) => [x, x.trim().startsWith('runs/') ? path.join(root, x.trim()) : path.join(root, 'runs', s.run, x.trim())])
      .filter(([raw, p]) => insideRoot(root, id, raw, p)).map(([, p]) => p)
      .filter((p) => fs.existsSync(p));
    if (shots.length) return { screenshots: shots.slice(0, 4), session: sessionFacts(path.dirname(path.dirname(shots[0])), entry.check) };
  }
  return { screenshots: [], session: sessionFacts(null, entry.check) };
}

/** Open ux findings; with needsReview also the needs_review ones, which a user may Pick to recheck. */
export function openFindings(project, { needsReview = false } = {}) {
  const root = rootOf(project);
  const ledger = loadLedger(project);
  const wanted = needsReview ? [...OPEN_STATUSES, 'needs_review'] : OPEN_STATUSES;
  return Object.entries(ledger.findings)
    .filter(([, e]) => e.kind === 'ux' && e.sightings.length && wanted.includes(e.status))
    .map(([id, e]) => ({ id, title: e.title, severity: e.severity, status: e.status, last_seen: e.last_seen,
      what_happened: e.sightings.at(-1).what_happened, check: e.check, ...evidenceFor(root, id, e) }))
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || byId(a.id, b.id));
}

export function verifyTable(project, run) {
  checkRunName(run);
  const ledger = loadLedger(project);
  const rows = Object.entries(ledger.findings).sort(([a], [b]) => byId(a, b))
    .flatMap(([id, e]) => e.verifications.filter((v) => v.run === run).map((v) => ({ id, e, v })));
  if (!rows.length) throw new Error(`no verifications for run ${run} in the ledger; run sync first`);
  const cell = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');
  const lines = ['| Finding | Verdict | Status now | Evidence | Note |', '|---|---|---|---|---|'];
  for (const { id, e, v } of rows) {
    const verdict = v.verdict === 'not_reproduced' && v.at_step == null
      ? 'not_reproduced (no step: counted as unreachable)'
      : `${v.verdict}${v.at_step != null ? ` (step ${v.at_step})` : ''}`;
    const shot = v.at_screenshot ? `[screenshot](${v.at_screenshot})` : '';
    lines.push(`| ${id} ${cell(e.title)} | ${verdict} | ${STATUS_WORDS[e.status] ?? e.status} | ${shot} | ${cell(v.note)} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function statusLines(project) {
  const ledger = loadLedger(project);
  return Object.entries(ledger.findings).map(([id, e]) => `${id}\t${e.kind === 'ux' ? e.status : e.kind}\t${e.title}\n`).join('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, project, ...rest] = process.argv.slice(2);
  try {
    if (!project) throw new Error('usage: ledger.mjs sync|status <project> | ledger.mjs open <project> [--needs-review] | ledger.mjs table <project> --run <folder>');
    if (cmd === 'sync') {
      const { ledger, warnings } = syncLedger(project);
      for (const w of warnings) process.stderr.write(`ledger: warning: ${w}\n`);
      process.stdout.write(`${Object.keys(ledger.findings).length} findings, ${Object.keys(ledger.runs).length} runs\n`);
    } else if (cmd === 'open') {
      process.stdout.write(`${JSON.stringify(openFindings(project, { needsReview: rest.includes('--needs-review') }), null, 2)}\n`);
    } else if (cmd === 'status') {
      process.stdout.write(statusLines(project));
    } else if (cmd === 'table') {
      const i = rest.indexOf('--run');
      if (i < 0 || !rest[i + 1]) throw new Error('table needs --run <folder>');
      process.stdout.write(verifyTable(project, rest[i + 1]));
    } else {
      throw new Error(`unknown command ${cmd}`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
