import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimate, formatEstimate, parseEstimateArgs, loadCoefficients } from '../usage.mjs';

const USAGE = fileURLToPath(new URL('../usage.mjs', import.meta.url));
const COEFFICIENTS = {
  claude: {
    persona: { model: 'sonnet', per_step: { input: 1700, cached_input: 20500, output: 350 } },
    verifier: { model: 'sonnet', per_step: { input: 2400, cached_input: 47300, output: 420 } },
    recon: { model: 'opus', fixed: null },
    recon_quick: { model: 'sonnet', fixed: null },
    triage: { model: 'opus', fixed: { input: [60000, 107000], cached_input: [626000, 2340000], output: [20000, 33000] } },
    orchestrator: { model: 'sonnet', fixed: { input: [76000, 84000], cached_input: [916000, 1210000], output: [18000, 25000] } },
    orchestrator_verify: { model: 'sonnet', fixed: { input: [8000, 8000], cached_input: [1090000, 1090000], output: [4900, 4900] } },
  },
  codex: {
    persona: { model: 'gpt-6-sol', per_step: null },
    verifier: { model: 'gpt-6-sol', per_step: null },
    recon: { model: null, fixed: null },
    recon_quick: { model: null, fixed: null },
    triage: { model: null, fixed: null },
    orchestrator: { model: null, fixed: null },
    orchestrator_verify: { model: null, fixed: null },
  },
};

test('a new Claude run: recon, personas (low 8 steps, high the cap), triage, orchestrator; not measured rows say so', () => {
  const text = formatEstimate(estimate({ harness: 'claude', personas: 3, cap: 20, coefficients: COEFFICIENTS }));
  assert.equal(text, [
    '| role | model | sessions | input | cached input | output |',
    '|---|---|---|---|---|---|',
    '| recon | opus | 1 | not measured | not measured | not measured |',
    '| persona | sonnet | 3 | 40.8k–102.0k | 492.0k–1.23M | 8.4k–21.0k |',
    '| triage | opus | 1 | 60.0k–107.0k | 626.0k–2.34M | 20.0k–33.0k |',
    '| orchestrator | sonnet | 1 | 76.0k–84.0k | 916.0k–1.21M | 18.0k–25.0k |',
    '',
    'Low: 8 steps per session (or the cap if lower); high: the cap (15 for a verifier). Input includes cache writes.',
    'API-equivalent at list prices on 2026-09-29: $1.54–$2.88 (cache writes priced as input); not measured: recon',
  ].join('\n'));
});

test('depth quick uses recon_quick, none leaves recon out; a cap under 8 is both ends', () => {
  assert.equal(estimate({ harness: 'claude', personas: 1, cap: 5, depth: 'none', coefficients: COEFFICIENTS })[0].role, 'persona');
  const [recon, persona] = estimate({ harness: 'claude', personas: 1, cap: 5, depth: 'quick', coefficients: COEFFICIENTS });
  assert.deepEqual([recon.role, recon.model], ['recon', 'sonnet']);
  assert.deepEqual(persona.input, [8500, 8500]);
});

test('a verify run: verifiers at 8–15 steps and the verify orchestrator', () => {
  const text = formatEstimate(estimate({ harness: 'claude', verify: 12, coefficients: COEFFICIENTS }));
  assert.equal(text.split('\n').slice(2).join('\n'), [
    '| verifier | sonnet | 12 | 230.4k–432.0k | 4.54M–8.51M | 40.3k–75.6k |',
    '| orchestrator | sonnet | 1 | 8.0k | 1.09M | 4.9k |',
    '',
    'Low: 8 steps per session (or the cap if lower); high: the cap (15 for a verifier). Input includes cache writes.',
    'API-equivalent at list prices on 2026-09-29: $2.06–$3.61 (cache writes priced as input)',
  ].join('\n'));
});

test('Codex: nothing measured yet, so no dollar figure', () => {
  const text = formatEstimate(estimate({ harness: 'codex', personas: 3, cap: 30, coefficients: COEFFICIENTS }));
  assert.match(text, /^\| persona \| gpt-6-sol \| 3 \| not measured \| not measured \| not measured \|$/m);
  assert.match(text, /^\| triage \| the session model \| 1 \| not measured /m);
  assert.match(text, /API-equivalent at list prices on 2026-09-29: none \(no measured row has a listed price\); not measured: recon, persona, triage, orchestrator$/);
});

test('estimate options', () => {
  assert.deepEqual(parseEstimateArgs(['--harness', 'claude', '--personas', '3', '--cap', '30']),
    { harness: 'claude', personas: 3, cap: 30, verify: 0, depth: 'standard' });
  assert.deepEqual(parseEstimateArgs(['--harness', 'codex', '--verify', '4']), { harness: 'codex', personas: 0, cap: 0, verify: 4, depth: 'standard' });
  assert.throws(() => parseEstimateArgs(['--harness', 'gemini', '--verify', '1']), /--harness must be claude or codex/);
  assert.throws(() => parseEstimateArgs(['--harness', 'claude', '--personas', '3']), /give --personas <n> and --cap <c>, or --verify <n>/);
  assert.throws(() => parseEstimateArgs(['--harness', 'claude', '--personas', '2.5', '--cap', '9']), /--personas must be a whole number/);
  assert.throws(() => parseEstimateArgs(['--harness', 'claude', '--verify']), /--verify needs a value/);
  assert.throws(() => parseEstimateArgs(['--harness', 'claude', '--bogus', '1']), /unknown estimate option "--bogus"/);
  assert.throws(() => parseEstimateArgs(['--harness', 'claude', '--verify', '1', '--depth', 'deep']), /--depth must be quick, standard or none/);
});

test('knowledge/cost.md: a yaml block with every key for both harnesses, in the schema estimate reads', async () => {
  const c = await loadCoefficients();
  for (const harness of ['claude', 'codex']) {
    for (const key of ['persona', 'verifier']) {
      const entry = c[harness][key];
      assert.ok(entry && 'model' in entry && 'per_step' in entry, `${harness}.${key}`);
      if (entry.per_step) for (const k of ['input', 'cached_input', 'output']) assert.ok(Number.isFinite(entry.per_step[k]), `${harness}.${key}.${k}`);
    }
    for (const key of ['recon', 'recon_quick', 'triage', 'orchestrator', 'orchestrator_verify']) {
      const entry = c[harness][key];
      assert.ok(entry && 'model' in entry && 'fixed' in entry, `${harness}.${key}`);
      if (entry.fixed) for (const k of ['input', 'cached_input', 'output']) {
        assert.ok(entry.fixed[k].length === 2 && entry.fixed[k][0] <= entry.fixed[k][1], `${harness}.${key}.${k}`);
      }
    }
  }
});

test('CLI estimate reads knowledge/cost.md', () => {
  const r = spawnSync(process.execPath, [USAGE, 'estimate', '--harness', 'claude', '--personas', '3', '--cap', '30'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^\| persona \| sonnet \| 3 \| /m);
  const bad = spawnSync(process.execPath, [USAGE, 'estimate', '--harness', 'claude'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /give --personas <n> and --cap <c>, or --verify <n>/);
});
