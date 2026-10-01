import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENY, ALLOW, STICKY, REQUIRED, CONFIG_OVERRIDES, WIN32_ENV_KEYS, parseFeatures, parseVersion, denyPresent, evaluateGate, featuresHash, runFeatureGate } from '../codex-features.mjs';

const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-features-0.155.txt'), 'utf8');
const nameOf = (line) => line.trim().split(/\s+/)[0];
/** What Codex 0.155 prints after `--disable <names>`: those rows turn false, except the ones in `stuck`. */
function listAfter(text, names, stuck = ['unified_exec']) {
  return text.split(/\r?\n/).map((line) => (names.includes(nameOf(line)) && !stuck.includes(nameOf(line)) ? line.replace(/true$/, 'false') : line)).join('\n');
}
const addRow = (text, row) => `${text.trimEnd()}\n${row}\n`;
const dropRow = (text, name) => text.split(/\r?\n/).filter((line) => nameOf(line) !== name).join('\n');
const DENY_0155 = denyPresent(parseFeatures(FIXTURE));

test('classification is consistent: no name in two lists, code_mode_host allowed, sticky names denied', () => {
  for (const name of DENY) assert.ok(!Object.hasOwn(ALLOW, name), `${name} is in DENY and ALLOW`);
  assert.equal(REQUIRED, 'code_mode_host');
  assert.ok(Object.hasOwn(ALLOW, REQUIRED));
  assert.ok(!DENY.includes(REQUIRED));
  for (const [name, carrier] of Object.entries(STICKY)) assert.ok(DENY.includes(name) && DENY.includes(carrier));
  assert.deepEqual(CONFIG_OVERRIDES, ['-c', 'web_search="disabled"']);
});

test('the 0.155 fixture passes once every DENY feature it lists is disabled', () => {
  const rows = parseFeatures(FIXTURE);
  assert.equal(rows.length, 145);
  assert.deepEqual(rows.find((r) => r.name === 'api_key_model_discovery'), { name: 'api_key_model_discovery', stage: 'under development', enabled: false });
  assert.equal(DENY_0155.length, 26);
  assert.ok(DENY_0155.includes('shell_tool') && DENY_0155.includes('unified_exec_zsh_fork'));
  const verdict = evaluateGate(parseFeatures(listAfter(FIXTURE, DENY_0155)), { version: '0.155.0-alpha.9.2' });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.pass, true);
  assert.ok(verdict.enabled.includes(REQUIRED));
  assert.ok(verdict.enabled.includes('unified_exec'), 'unified_exec stays on and is tolerated while shell_tool is off');
});

test('an enabled feature nobody classified refuses the run, whatever its stage', () => {
  for (const row of [
    'zz_new_tool                              stable             true',
    'zz_old_tool                              removed            true',
    'zz_beta_tool                             under development  true',
  ]) {
    const verdict = evaluateGate(parseFeatures(listAfter(addRow(FIXTURE, row), DENY_0155)), { version: '9.9.9' });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.problems, [`Codex 9.9.9 enables ${nameOf(row)}, which ux-assessment has not classified. Update driver/codex-features.mjs after running self-check, or report it.`]);
  }
});

test('a DENY name missing from the list is skipped, not passed as --disable', () => {
  const text = dropRow(FIXTURE, 'goals');
  const deny = denyPresent(parseFeatures(text));
  assert.ok(!deny.includes('goals'));
  assert.equal(evaluateGate(parseFeatures(listAfter(text, deny)), { version: 'v' }).pass, true);
});

test('malformed rows or too few rows refuse; CRLF parses like LF', () => {
  assert.throws(() => parseFeatures(`${FIXTURE}something odd\n`), /cannot parse codex features list row: "something odd"/);
  assert.throws(() => parseFeatures(FIXTURE.replace(/^shell_tool .*$/m, 'shell_tool stable yes')), /cannot parse codex features list row/);
  assert.throws(() => parseFeatures(FIXTURE.split('\n').slice(0, 19).join('\n')), /gave 19 rows; expected at least 20/);
  assert.throws(() => parseFeatures(''), /gave 0 rows; expected at least 20/);
  assert.deepEqual(parseFeatures(FIXTURE.replaceAll('\n', '\r\n')), parseFeatures(FIXTURE));
});

test('code_mode_host must be on', () => {
  const verdict = evaluateGate(parseFeatures(listAfter(FIXTURE, [...DENY_0155, 'code_mode_host'])), { version: '0.155.0-alpha.9.2' });
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.problems, ['Codex 0.155.0-alpha.9.2 has code_mode_host off; persona tools are reachable only through it']);
});

test('a DENY feature that stays on refuses, except a sticky one whose carrier is present and off', () => {
  const stuck = evaluateGate(parseFeatures(listAfter(FIXTURE, DENY_0155, ['unified_exec', 'view_image'])), { version: 'v' });
  assert.deepEqual(stuck.problems, ['Codex v keeps view_image on after --disable view_image']);
  const carrierOn = evaluateGate(parseFeatures(listAfter(FIXTURE, DENY_0155, ['unified_exec', 'shell_tool'])), { version: 'v' });
  assert.deepEqual(carrierOn.problems, ['Codex v keeps shell_tool on after --disable shell_tool', 'Codex v keeps unified_exec on after --disable unified_exec']);
  const withoutCarrier = dropRow(FIXTURE, 'shell_tool');
  const carrierGone = evaluateGate(parseFeatures(listAfter(withoutCarrier, denyPresent(parseFeatures(withoutCarrier)))), { version: 'v' });
  assert.deepEqual(carrierGone.problems, ['Codex v keeps unified_exec on after --disable unified_exec']);
});

test('version and hash', () => {
  assert.equal(parseVersion('codex-cli 0.155.0-alpha.9.2\n'), '0.155.0-alpha.9.2');
  assert.throws(() => parseVersion('garbage'), /cannot read the Codex version from "garbage"/);
  assert.match(featuresHash(['b', 'a']), /^[0-9a-f]{16}$/);
  assert.equal(featuresHash(['b', 'a']), featuresHash(['a', 'b']));
  assert.notEqual(featuresHash(['a']), featuresHash(['a', 'b']));
});

test('runFeatureGate: version, the plain list, then the list with each present DENY disabled, under an empty CODEX_HOME', async () => {
  const calls = [];
  const run = async (file, args, { env }) => {
    calls.push({ file, args, env, homeEntries: fs.readdirSync(env.CODEX_HOME) });
    if (args[0] === '--version') return 'codex-cli 0.155.0-alpha.9.2\n';
    return listAfter(FIXTURE, args.filter((a, i) => args[i - 1] === '--disable'));
  };
  const gate = await runFeatureGate({ codex: '/x/codex', run, env: { PATH: '/bin', CODEX_HOME: '/home/me/.codex', SECRET: 's' } });
  assert.equal(gate.pass, true);
  assert.equal(gate.version, '0.155.0-alpha.9.2');
  assert.deepEqual(gate.deny, DENY_0155);
  assert.equal(gate.featuresHash, featuresHash(DENY_0155));
  assert.deepEqual(calls.map((c) => c.args), [
    ['--version'],
    ['features', 'list', ...CONFIG_OVERRIDES],
    ['features', 'list', ...CONFIG_OVERRIDES, ...DENY_0155.flatMap((n) => ['--disable', n])],
  ]);
  for (const c of calls) {
    assert.equal(c.file, '/x/codex');
    assert.notEqual(c.env.CODEX_HOME, '/home/me/.codex', 'the user config.toml must not decide the gate');
    assert.deepEqual(c.homeEntries, []);
    assert.equal(c.env.SECRET, undefined);
    assert.equal(c.env.PATH, '/bin');
  }
  assert.ok(!fs.existsSync(calls[0].env.CODEX_HOME), 'the empty CODEX_HOME is removed afterwards');
});

test('runFeatureGate env: case-insensitive win32 vars pass through; HOME/USER/SECRET never reach codex', async () => {
  const calls = [];
  const run = async (file, args, { env }) => {
    calls.push({ file, args, env, homeEntries: fs.readdirSync(env.CODEX_HOME) });
    if (args[0] === '--version') return 'codex-cli 0.155.0-alpha.9.2\n';
    return listAfter(FIXTURE, args.filter((a, i) => args[i - 1] === '--disable'));
  };
  // Windows stores `Path`, not `PATH`; a plain object copy of process.env loses case-insensitivity.
  const env = { Path: 'C:\\bin', HOME: 'C:\\Users\\me', USER: 'me', SECRET: 's',
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TEMP: 'C:\\T', TMP: 'C:\\T', PATHEXT: '.EXE', LOCALAPPDATA: 'C:\\L' };
  await runFeatureGate({ codex: '/x/codex', run, env });
  for (const c of calls) {
    assert.equal(c.env.PATH, 'C:\\bin');
    for (const key of WIN32_ENV_KEYS) assert.equal(c.env[key], env[key]);
    assert.equal(c.env.HOME, undefined);
    assert.equal(c.env.USER, undefined);
    assert.equal(c.env.SECRET, undefined);
    assert.notEqual(c.env.CODEX_HOME, undefined);
    assert.deepEqual(c.homeEntries, []);
  }
});

test('runFeatureGate refuses when Codex fails or prints something else', async () => {
  const failing = async (file, args) => { if (args[0] === '--version') return 'codex-cli 1\n'; throw new Error('exit 1: Error: Unknown feature flag: x'); };
  await assert.rejects(runFeatureGate({ codex: 'c', run: failing, env: {} }), /codex features list failed: exit 1: Error: Unknown feature flag: x/);
  const secondFails = async (file, args) => {
    if (args[0] === '--version') return 'codex-cli 1\n';
    if (args.includes('--disable')) throw new Error('exit 1: boom');
    return FIXTURE;
  };
  await assert.rejects(runFeatureGate({ codex: 'c', run: secondFails, env: {} }), { message: 'codex features list --disable failed: exit 1: boom' });
  const short = async (file, args) => (args[0] === '--version' ? 'codex-cli 1\n' : 'a stable true\n');
  await assert.rejects(runFeatureGate({ codex: 'c', run: short, env: {} }), /gave 1 rows; expected at least 20/);
});

test('secret_auth_storage (on by default on Windows since npm 0.159) is allowed', () => {
  const row = 'secret_auth_storage                      stable             true';
  const verdict = evaluateGate(parseFeatures(listAfter(addRow(FIXTURE, row), DENY_0155)), { version: '0.159.0' });
  assert.deepEqual(verdict.problems, []);
  assert.ok(verdict.enabled.includes('secret_auth_storage'));
});

test('the npm 0.158 fixture passes too (the build CI installs)', () => {
  const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-features-0.158.txt'), 'utf8');
  const deny = denyPresent(parseFeatures(text));
  const verdict = evaluateGate(parseFeatures(listAfter(text, deny)), { version: '0.158.0' });
  assert.deepEqual(verdict.problems, []);
});
