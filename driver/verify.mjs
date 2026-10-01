#!/usr/bin/env node
// Verify-run helpers: verifier replies -> verify.yaml (with guards), and a saved-login check before a session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { byId, checkRunName } from './ledger.mjs';
import { count } from './usage.mjs';

export const VERDICTS = ['reproduced', 'not_reproduced', 'unreachable', 'changed'];
const ID_RE = /^[A-Z]+-\d+$/;

export function extractVerdict(text) {
  const blocks = [...String(text).matchAll(/```ya?ml[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
  for (const body of blocks) {
    try {
      const doc = YAML.parse(body);
      if (doc && typeof doc === 'object' && 'verdict' in doc) return doc;
    } catch { /* not a valid block: try the one before */ }
  }
  return null;
}

const warn = (message) => process.stderr.write(`verify: warning: ${message}\n`);

function stepLines(dir) {
  const file = path.join(dir, 'log.jsonl');
  if (!fs.existsSync(file)) return null; // gitignored: absent on a fresh clone
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((e) => 'step' in e && 'screenshot' in e);
}

function tokensOf(dir) {
  // session.json: `context_tokens` (the Agent result's final context size); older runs wrote `tokens`.
  // codex-result.json: `usage` of the last turn.completed (input includes cached input).
  for (const [name, pick] of [['session.json', (j) => j.context_tokens ?? j.tokens], ['codex-result.json', (j) => (j.usage ? count(j.usage.input_tokens) + count(j.usage.output_tokens) : undefined)]]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    let json;
    // Orchestrators hand-write these; one bad file must not stop the whole run from being recorded.
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      warn(`${file.split(path.sep).join('/')} is not valid JSON; tokens left empty (${error.message})`);
      return null;
    }
    const n = pick(json ?? {});
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readPrevious(out) {
  if (!fs.existsSync(out)) return null;
  // Abort rather than overwrite: its started_at, cli and url could not be recovered afterwards.
  try { return YAML.parse(fs.readFileSync(out, 'utf8')); } catch (error) {
    throw new Error(`cannot read the earlier verify.yaml at ${out} (${error.message.split('\n')[0]}); fix or delete it, then record again`);
  }
}

export function recordVerifyRun(project, run, { cli = null, url = null, startedAt = null } = {}) {
  const runDir = path.join(path.resolve(project), '.ux-assessment', 'runs', checkRunName(run));
  if (!fs.existsSync(runDir)) throw new Error(`no run folder ${runDir}`);
  const out = path.join(runDir, 'verify.yaml');
  const previous = readPrevious(out);
  const before = new Map((Array.isArray(previous?.results) ? previous.results : []).filter((r) => r?.id).map((r) => [r.id, r]));
  const ids = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name).sort(byId);
  let first = null;
  const results = ids.map((id) => {
    const dir = path.join(runDir, id);
    const summary = path.join(dir, 'summary.md');
    const reply = fs.existsSync(summary) ? extractVerdict(fs.readFileSync(summary, 'utf8')) : null;
    const logged = stepLines(dir);
    const lines = logged ?? [];
    const prev = before.get(id);
    for (const l of lines) if (Number.isFinite(l.t) && (first === null || l.t < first)) first = l.t;
    const guards = [];
    const r = { id, verdict: 'unreachable', at_step: null, at_screenshot: null, evidence: [], note: '', guard: null,
      steps: logged ? lines.filter((l) => l.step != null).length : prev?.steps ?? 0, tokens: tokensOf(dir) };
    if (!reply) {
      r.guard = fs.existsSync(summary) ? 'no verdict block in the verifier reply' : 'no verifier reply';
      return r;
    }
    if (reply.id && reply.id !== id) guards.push(`reply names ${reply.id}; recorded under its session folder ${id}`);
    r.evidence = Array.isArray(reply.evidence) ? reply.evidence.map(String) : [];
    r.note = String(reply.note ?? '');
    if (!VERDICTS.includes(reply.verdict)) {
      guards.push(`unknown verdict ${JSON.stringify(reply.verdict)}`);
    } else {
      r.verdict = reply.verdict;
      if (reply.at_step != null) {
        const n = Number(reply.at_step);
        const line = Number.isInteger(n) && n >= 0 ? lines.find((l) => (l.step ?? 0) === n && l.screenshot) : null;
        if (line) { r.at_step = n; r.at_screenshot = `${id}/${line.screenshot}`; }
        else if (!logged && prev?.at_step === n && prev.at_screenshot) { r.at_step = n; r.at_screenshot = prev.at_screenshot; } // checked when first recorded
        else guards.push(`at_step ${JSON.stringify(reply.at_step)} is not a step with a screenshot in ${id}/log.jsonl`);
      } else if (r.verdict === 'not_reproduced') {
        guards.push('not_reproduced without at_step');
      }
    }
    r.guard = guards.length ? guards.join('; ') : null;
    return r;
  });
  const doc = {
    run,
    started_at: startedAt ?? previous?.started_at ?? (first === null ? new Date().toISOString() : new Date(first).toISOString()),
    cli: cli ?? previous?.cli ?? null,
    url: url ?? previous?.url ?? null,
    results,
  };
  fs.writeFileSync(out, `# Written by ux-assessment driver/verify.mjs record from each <id>/summary.md\n${YAML.stringify(doc, { lineWidth: 0 })}`);
  return doc;
}

export function checkStorageState(file, url, now = Date.now()) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: 'missing' };
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'unreadable' }; }
  const target = new URL(url);
  const origins = (state.origins ?? []).map((o) => o.origin);
  if (origins.length && !origins.includes(target.origin)) return { ok: false, reason: 'origin_mismatch' };
  const mine = (state.cookies ?? []).filter((c) => {
    const domain = String(c.domain ?? '').replace(/^\./, '');
    return target.hostname === domain || target.hostname.endsWith(`.${domain}`);
  });
  const timed = mine.filter((c) => Number(c.expires) > 0);
  const future = timed.filter((c) => c.expires * 1000 > now);
  if (mine.length && timed.length === mine.length && !future.length) return { ok: false, reason: 'expired' };
  const soonest = future.length ? Math.min(...future.map((c) => c.expires)) : null;
  return { ok: true, expires_at: soonest === null ? null : new Date(soonest * 1000).toISOString() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
  try {
    if (cmd === 'record') {
      const run = opt('--run');
      if (run) checkRunName(run);
      if (!args[0] || !run) throw new Error('usage: verify.mjs record <project> --run <folder> [--cli claude|codex] [--url <url>]');
      const doc = recordVerifyRun(args[0], run, { cli: opt('--cli'), url: opt('--url') });
      const verdicts = {};
      for (const r of doc.results) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      process.stdout.write(`${JSON.stringify({ results: doc.results.length, verdicts, guards: doc.results.filter((r) => r.guard).map((r) => r.id) })}\n`);
    } else if (cmd === 'check-state') {
      if (!args[0] || !args[1]) throw new Error('usage: verify.mjs check-state <state.json> <url>');
      process.stdout.write(`${JSON.stringify(checkStorageState(args[0], args[1]))}\n`);
    } else {
      throw new Error('usage: verify.mjs record|check-state …');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
