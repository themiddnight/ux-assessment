// What each persona expected before an action, against what happened (SPEC D34):
//   node expectations.mjs <run folder>     JSON: per persona, one row per expectation, with counts
// The triage agent reads this in place of pairing log lines by hand. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIDENCE = ['sure', 'guess', 'cannot_tell']; // session.mjs CONFIDENCE; not imported, so this file loads without the driver's packages

/** One pattern per expectation. What the harness saw comes first: only `visual_change: none` proves nothing happened. */
export function patternOf({ confidence, visual_change, met, stopped_before, action_error }) {
  if (stopped_before) return 'stopped_by_harness'; // the app never got to answer
  if (action_error) return 'action_failed'; // the action itself did not run
  if (visual_change === 'none' && met !== 'yes') return 'dead_control';
  if (confidence === 'cannot_tell') return 'control_unpredictable';
  if (met === 'no') return 'unexpected_result';
  if (met === 'partly') return 'partly_expected';
  if (met === 'yes') return confidence === 'guess' ? 'guess_confirmed' : 'as_expected';
  return 'unjudged';
}

/** Rows of one session's log: the expectation of a step, the harness's visual result, and the verdict the next call gave. */
export function pairExpectations(entries) {
  const rows = new Map();
  for (const e of entries) {
    const verdict = e.expectation_met ?? e.end?.expectation_met;
    const row = verdict && rows.get(verdict.step);
    if (row) {
      row.met = verdict.met;
      row.after = e.end ? e.end.final_observation ?? null : e.reaction ?? null;
    }
    if (typeof e.step === 'number' && e.expect) {
      rows.set(e.step, {
        step: e.step, action: e.action?.type ?? null, target: e.action?.target ?? null, expect: e.expect.outcome, confidence: e.expect.confidence,
        visual_change: e.visual_change ?? null, screenshot: e.screenshot ?? null, met: null, after: null,
        ...(e.stopped_before ? { stopped_before: e.stopped_before } : {}), ...(e.action_error ? { action_error: e.action_error } : {}),
      });
    }
  }
  return [...rows.values()].map((row) => ({ ...row, pattern: patternOf(row) }));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((text) => {
    try { return [JSON.parse(text)]; } catch { return []; } // a line cut short by a killed session
  });
}

/** Every persona folder of a run (a folder with a log.jsonl), in name order. */
export function summarizeRun(runDir) {
  const personas = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(runDir, d.name, 'log.jsonl')))
    .map((d) => d.name).sort()
    .map((persona) => {
      const rows = pairExpectations(readJsonl(path.join(runDir, persona, 'log.jsonl')));
      const setup = readJsonl(path.join(runDir, persona, 'signals.jsonl')).find((s) => s.type === 'setup' && typeof s.expectations === 'boolean');
      const patterns = {};
      for (const row of rows) patterns[row.pattern] = (patterns[row.pattern] ?? 0) + 1;
      return {
        persona, expectations: setup ? (setup.expectations ? 'on' : 'off') : 'unknown',
        confidence: Object.fromEntries(CONFIDENCE.map((c) => [c, rows.filter((row) => row.confidence === c).length])),
        patterns, rows,
      };
    });
  return { personas };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runDir, ...rest] = process.argv.slice(2);
  if (!runDir || rest.length) {
    process.stderr.write('usage: node expectations.mjs <run folder>\n');
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(summarizeRun(runDir), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
