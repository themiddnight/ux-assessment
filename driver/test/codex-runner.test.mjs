import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { sandboxProfile, validateStorageOrigin, buildCodexArgs, codexCommand, checkModelChoice, lastUsage, stageImages, buildPrompt, runCodexPersona, runIsolated, buildChildEnv, killTree } from '../codex-runner.mjs';
import { CONFIG_OVERRIDES, featuresHash, denyPresent, parseFeatures } from '../codex-features.mjs';
import { writeRecord, recordPath } from '../codex-self-check.mjs';
import { makeFakeCodex } from './fake-codex.mjs';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const USAGE_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FEATURES_0155 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-features-0.155.txt'), 'utf8');

test('macOS sandbox hides project files and local app port but permits bridge port', { skip: process.platform !== 'darwin' }, async () => {
  const run = async (args) => {
    try { const result = await promisify(execFile)('/usr/bin/sandbox-exec', args); return { code: 0, ...result }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const fixture = await startFixtureServer();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-sandbox-project-'));
  fs.writeFileSync(path.join(projectRoot, 'secret.txt'), 'private');
  const bridgePort = fixture.port + 1;
  try {
    // Hermetic: this test exercises the sandbox profile itself, not Codex discovery, and must not
    // depend on a real Codex install being present on the host (it is not, on a CI driver-test step).
    // sandboxProfile refuses an empty `executables` list (it would render an unfiltered allow),
    // so a placeholder path that resolves to nothing keeps process-exec denied by default.
    const profile = sandboxProfile({ projectRoot, bridgePort, executables: ['/nonexistent/uxa-test-placeholder'] });
    const allowExecutable = (executable, port = bridgePort) => sandboxProfile({ projectRoot, bridgePort: port, executables: [executable] });
    const read = await run(['-p', allowExecutable('/bin/cat'), '/bin/cat', path.join(projectRoot, 'secret.txt')]);
    assert.notEqual(read.code, 0);
    assert.equal(read.stdout, '');
    const publicRead = await run(['-p', allowExecutable('/bin/cat'), '/bin/cat', '/etc/hosts']);
    assert.equal(publicRead.code, 0, publicRead.stderr);
    const shell = await run(['-p', profile, '/bin/echo', 'should-not-run']);
    assert.notEqual(shell.code, 0);
    const curlProfile = allowExecutable('/usr/bin/curl');
    const denied = await run(['-p', curlProfile, '/usr/bin/curl', '-fsS', '--max-time', '2', fixture.url('basic.html')]);
    assert.notEqual(denied.code, 0);
    const bridgeProfile = allowExecutable('/usr/bin/curl', fixture.port);
    const allowed = await run(['-p', bridgeProfile, '/usr/bin/curl', '-fsS', '--max-time', '2', fixture.url('basic.html')]);
    assert.equal(allowed.code, 0, allowed.stderr);
  } finally {
    await fixture.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('an empty executables list is refused: it would allow every exec in the macOS sandbox', () => {
  assert.throws(() => sandboxProfile({ projectRoot: os.tmpdir(), bridgePort: 1, executables: [] }),
    { message: 'the macOS sandbox needs at least one executable' });
});

test('saved login state must match the entry URL origin', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-state-check-')), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [{ origin: 'http://localhost:5173', localStorage: [] }] }));
  assert.doesNotThrow(() => validateStorageOrigin(file, 'http://localhost:5173/'));
  assert.throws(() => validateStorageOrigin(file, 'http://127.0.0.1:5173/'), /origin does not match/);
});

test('image flags come before --output-last-message, so the variadic --image never eats the stdin marker', () => {
  const args = buildCodexArgs({ platform: 'darwin', profile: 'P', codex: '/bin/codex', temp: '/tmp/x', bridgeUrl: 'http://127.0.0.1:1/mcp/t',
    outputFile: '/tmp/x/out.txt', model: 'm', images: ['/tmp/x/evidence/01.png', '/tmp/x/evidence/02.png'] });
  assert.deepEqual(args.slice(0, 4), ['-p', 'P', '/bin/codex', 'exec']);
  assert.deepEqual(args.slice(-3), ['--output-last-message', '/tmp/x/out.txt', '-']);
  const at = args.indexOf('--image');
  assert.deepEqual(args.slice(at, at + 4), ['--image', '/tmp/x/evidence/01.png', '--image', '/tmp/x/evidence/02.png']);
  assert.ok(args[at + 4].startsWith('--'));
  assert.ok(!buildCodexArgs({ profile: 'P', codex: 'c', temp: 't', bridgeUrl: 'u', outputFile: 'o' }).includes('--image'));
});

test('evidence is copied into the runner temp dir; files outside .ux-assessment or missing are skipped', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-stage-'));
  const shot = path.join(projectRoot, '.ux-assessment/runs/2026-09-28/p/screenshots/s03.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, 'png-bytes');
  fs.writeFileSync(path.join(projectRoot, 'secret.png'), 'x');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-stage-tmp-'));
  try {
    const { staged, skipped } = stageImages(
      [shot, path.join(projectRoot, 'secret.png'), path.join(projectRoot, '.ux-assessment/runs/gone.png')], projectRoot, temp);
    assert.deepEqual(staged, [path.join(temp, 'evidence', '01.png')]);
    assert.equal(fs.readFileSync(staged[0], 'utf8'), 'png-bytes');
    assert.deepEqual(skipped.map((s) => s.reason), ['outside .ux-assessment', 'missing']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('stageImages skips escapes, non-files and extras instead of aborting the job', { skip: process.platform === 'win32' && 'mkfifo and unprivileged symlinks are POSIX-only' }, () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-stage-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-stage-tmp-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-stage-out-'));
  const shots = path.join(projectRoot, '.ux-assessment/runs/2026-09-28/p/screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const at = (name) => path.join(shots, name);
  try {
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.png'), at('link.png')); // under .ux-assessment, points outside it
    fs.writeFileSync(path.join(projectRoot, 'top.png'), 'x');
    const dotdot = `${projectRoot}/.ux-assessment/../top.png`;
    fs.writeFileSync(at('notes.txt'), 'x');
    fs.mkdirSync(at('folder.png'));
    execFileSync('mkfifo', [at('pipe.png')]); // copying a FIFO would block forever
    const good = Array.from({ length: 7 }, (_, i) => { fs.writeFileSync(at(`s0${i + 1}.png`), `png-${i + 1}`); return at(`s0${i + 1}.png`); });
    const { staged, skipped } = stageImages(
      [at('link.png'), dotdot, at('notes.txt'), at('folder.png'), at('pipe.png'), 42, ...good], projectRoot, temp);
    assert.deepEqual(skipped.map((s) => s.reason), ['outside .ux-assessment', 'outside .ux-assessment', 'not a png',
      'not a file', 'not a file', 'not a path', 'more than 6 images']);
    assert.equal(skipped.at(-1).image, good[6]);
    assert.deepEqual(staged, ['01', '02', '03', '04', '05', '06'].map((n) => path.join(temp, 'evidence', `${n}.png`)));
    assert.equal(fs.readFileSync(staged[5], 'utf8'), 'png-6');
    assert.throws(() => stageImages('s01.png', projectRoot, temp), /images must be a list of paths/);
  } finally {
    for (const d of [projectRoot, temp, outside]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('verifier prompt: agent body without frontmatter, the brief, and a note on attached images', () => {
  const prompt = buildPrompt('verifier', 'Session id: F-03', 2);
  assert.doesNotMatch(prompt, /^tools:/m);
  assert.match(prompt, /You are a \*\*verifier\*\*/);
  assert.match(prompt, /## Your finding\n\nSession id: F-03\n/);
  assert.match(prompt, /The 2 earlier evidence screenshot\(s\) are attached/);
  assert.match(buildPrompt('verifier', 'b', 0), /No earlier screenshots are available; work from the text\./);
  assert.match(buildPrompt('persona', 'b', 0), /## Your briefing\n\nb\n$/);
});

test('runner accepts only the persona and verifier roles, and never gives a persona images', async () => {
  const base = { projectRoot: '/nonexistent', briefing: 'b',
    session: { id: 'x', dir: '/nonexistent/.ux-assessment/runs/r/x', url: 'http://localhost:1/' } };
  await assert.rejects(runCodexPersona({ ...base, role: 'planner' }), /role must be "persona" or "verifier"/);
  await assert.rejects(runCodexPersona({ ...base, images: ['/x.png'] }), /only a verifier gets evidence images/);
  await assert.rejects(runCodexPersona({ ...base, role: 'verifier', images: '/x.png' }), /images must be a list of paths/);
});

test('codex args per platform: sandbox-exec pair only on macOS; DENY flags, --json and web search off everywhere', () => {
  const base = { codex: '/c/codex', temp: '/t', bridgeUrl: 'http://127.0.0.1:9/mcp/x', outputFile: '/t/out.txt', deny: ['shell_tool', 'goals'] };
  const mac = buildCodexArgs({ ...base, platform: 'darwin', profile: 'P' });
  assert.deepEqual(mac.slice(0, 4), ['-p', 'P', '/c/codex', 'exec']);
  for (const platform of ['win32', 'linux']) {
    const args = buildCodexArgs({ ...base, platform });
    assert.equal(args[0], 'exec');
    assert.ok(!args.includes('-p') && !args.includes('/c/codex'));
    assert.equal(codexCommand({ codex: '/c/codex', osSandbox: false }), '/c/codex');
  }
  const toolsOnlyMac = buildCodexArgs({ ...base, platform: 'darwin', osSandbox: false });
  assert.equal(toolsOnlyMac[0], 'exec');
  assert.equal(codexCommand({ codex: '/c/codex', osSandbox: true }), '/usr/bin/sandbox-exec');
  for (const args of [mac, toolsOnlyMac]) {
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--ignore-user-config'));
    const at = args.indexOf(CONFIG_OVERRIDES[1]);
    assert.equal(args[at - 1], '-c');
    assert.deepEqual(args.filter((a, i) => args[i - 1] === '--disable'), ['shell_tool', 'goals']);
    assert.ok(!args.includes('--model'));
    assert.ok(!args.some((a) => a.startsWith('model_reasoning_effort')));
    assert.deepEqual(args.slice(-3), ['--output-last-message', '/t/out.txt', '-']);
  }
  const chosen = buildCodexArgs({ ...base, platform: 'linux', model: 'gpt-6-sol', effort: 'low' });
  assert.equal(chosen[chosen.indexOf('--model') + 1], 'gpt-6-sol');
  assert.equal(chosen[chosen.indexOf('model_reasoning_effort="low"') - 1], '-c');
  assert.throws(() => buildCodexArgs({ ...base, platform: 'linux', deny: ['code_mode_host'] }), /code_mode_host must stay on/);
  assert.throws(() => buildCodexArgs({ ...base, platform: 'linux', osSandbox: true, profile: 'P' }), /sandbox-exec exists only on macOS/);
  assert.throws(() => buildCodexArgs({ ...base, platform: 'darwin' }), /the macOS sandbox needs a profile/);
});

test('model and effort from the job are validated before anything starts', () => {
  assert.deepEqual(checkModelChoice({}), { model: null, effort: null });
  assert.deepEqual(checkModelChoice({ model: 'gpt-6-sol', effort: 'medium' }), { model: 'gpt-6-sol', effort: 'medium' });
  assert.throws(() => checkModelChoice({ effort: 'max' }), /effort must be low, medium or high/);
  assert.throws(() => checkModelChoice({ model: 'x; rm -rf /' }), /model must match \^\[\\w\.-\]\+\$/);
  assert.throws(() => checkModelChoice({ model: 'a"b' }), /model must match/);
});

test('usage is the last turn.completed (codex exec reports the thread total), with the raw keys, or null when there is none', () => {
  const text = fs.readFileSync(path.join(USAGE_FIXTURES, 'codex-exec-events.jsonl'), 'utf8');
  const want = { input_tokens: 52000, cached_input_tokens: 41000, cache_write_input_tokens: 1000, output_tokens: 3100, reasoning_output_tokens: 1800 };
  assert.deepEqual(lastUsage(text), want);
  assert.deepEqual(lastUsage(text.replace(/\r?\n/g, '\r\n')), want);
  assert.deepEqual(lastUsage(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 2 } })),
    { input_tokens: 7, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 });
  assert.equal(lastUsage('tokens used\n1,234\n'), null);
  assert.equal(lastUsage(JSON.stringify({ type: 'turn.completed' })), null);
});

test('a gate refusal rejects before any browser or bridge starts', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-gate-refusal-'));
  const dir = path.join(projectRoot, '.ux-assessment', 'runs', 'r', 'p');
  try {
    await assert.rejects(runCodexPersona({ projectRoot, briefing: 'b', session: { id: 'p', dir, url: 'http://localhost:1/' } }, {
      resolve: () => ['/x/codex'],
      gate: async () => ({ pass: false, version: '9.9.9', deny: [], featuresHash: 'h', enabled: ['zz_new_tool'],
        problems: ['Codex 9.9.9 enables zz_new_tool, which ux-assessment has not classified. Update driver/codex-features.mjs after running self-check, or report it.'] }),
    }), /Codex 9\.9\.9 enables zz_new_tool/);
    assert.ok(!fs.existsSync(dir), 'no session was started');
    await assert.rejects(runCodexPersona({ projectRoot, briefing: 'b', effort: 'max', session: { id: 'p', dir, url: 'http://localhost:1/' } }), /effort must be low, medium or high/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('runIsolated checks model and effort before the gate, and a gate refusal is one line', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-isolated-checks-'));
  const dir = path.join(projectRoot, '.ux-assessment', 'self-check');
  let gateCalls = 0;
  const base = { role: 'persona', projectRoot, prompt: () => 'p', session: { id: 'p', dir, url: 'http://localhost:1/' }, resolve: () => ['/x/codex'] };
  try {
    const gate = async () => { gateCalls += 1; return { pass: true, version: 'v', deny: [], featuresHash: 'h', enabled: [], problems: [] }; };
    await assert.rejects(runIsolated({ ...base, effort: 'max', gate }), /effort must be low, medium or high/);
    await assert.rejects(runIsolated({ ...base, model: 'a b', gate }), /model must match/);
    assert.equal(gateCalls, 0, 'the gate never ran');
    await assert.rejects(runIsolated({ ...base, gate: async () => ({ pass: false, version: 'v', deny: [], featuresHash: 'h', enabled: [], problems: ['p1', 'p2'] }) }),
      (error) => error.message === 'p1; p2');
    assert.ok(!fs.existsSync(dir), 'no session was started');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('an invalid models.codex entry in config.yaml stops the run before the gate', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-bad-config-'));
  const dir = path.join(projectRoot, '.ux-assessment', 'runs', 'r', 'p');
  let gateCalls = 0;
  try {
    fs.mkdirSync(path.join(projectRoot, '.ux-assessment'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.ux-assessment', 'config.yaml'), 'models:\n  codex:\n    persona: {effort: max}\n');
    await assert.rejects(runCodexPersona({ projectRoot, briefing: 'b', session: { id: 'p', dir, url: 'http://localhost:1/' } }, {
      resolve: () => ['/x/codex'], gate: async () => { gateCalls += 1; return { pass: false, problems: ['unreachable'] }; },
    }), /models\.codex\.persona in .*config\.yaml: effort must be low, medium or high/);
    assert.equal(gateCalls, 0, 'the gate never ran');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a cheaper persona model from config.yaml warns once, before the gate', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-cheap-config-'));
  const dir = path.join(projectRoot, '.ux-assessment', 'runs', 'r', 'p');
  const lines = [];
  try {
    fs.mkdirSync(path.join(projectRoot, '.ux-assessment'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.ux-assessment', 'config.yaml'), 'models:\n  codex:\n    persona: {model: gpt-6-luna}\n');
    await assert.rejects(runCodexPersona({ projectRoot, briefing: 'b', session: { id: 'p', dir, url: 'http://localhost:1/' } }, {
      platform: 'linux', resolve: () => ['/x/codex'], warn: (line) => lines.push(line),
      gate: async () => ({ pass: false, version: 'v', deny: [], featuresHash: 'h', enabled: [], problems: ['stop'] }),
    }), (error) => error.message === 'stop');
    assert.deepEqual(lines, ['warning: codex persona uses gpt-6-luna medium: cheaper, quality unmeasured: persona mistakes turn into false findings']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a run through a fake Codex: DENY flags, --json, effort, usage, version and isolation in the result',
  { skip: process.platform === 'win32' && 'the fake Codex is a POSIX script; Node cannot spawn it as codex.exe' }, async () => {
    const fixture = await startFixtureServer();
    const fake = makeFakeCodex({ features: FEATURES_0155 });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-fake-run-'));
    try {
      const dir = path.join(projectRoot, '.ux-assessment', 'runs', 'r', 'p');
      fs.mkdirSync(path.join(projectRoot, '.ux-assessment'), { recursive: true });
      // The model comes from config.yaml and the effort from the job: job > config > default, field by field.
      fs.writeFileSync(path.join(projectRoot, '.ux-assessment', 'config.yaml'), 'models:\n  codex:\n    persona: {model: gpt-6-luna, effort: high}\n');
      const warnings = [];
      const result = await runCodexPersona(
        { projectRoot, briefing: 'Session id: p', effort: 'low', session: { id: 'p', dir, url: fixture.url('basic.html') } },
        { platform: 'linux', env: { ...process.env, UXA_CODEX_BIN: fake.file, UXA_CODEX_SELF_CHECK: 'skip' }, warn: (line) => warnings.push(line) });
      assert.deepEqual(warnings, [
        'warning: codex persona uses gpt-6-luna low: cheaper, quality unmeasured: persona mistakes turn into false findings',
        'UXA_CODEX_SELF_CHECK=skip: running without a self-check record (CI only)']);
      assert.equal(result.cli.code, 0);
      assert.equal('tokens' in result.cli, false, 'tokens live in result.usage; --json output has no "tokens used" line');
      assert.equal(result.summary, 'done');
      assert.deepEqual(result.usage, { input_tokens: 10, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 });
      const records = fs.readFileSync(path.join(projectRoot, '.ux-assessment', 'usage.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(records.length, 1);
      const { t: at, ...record } = records[0];
      assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(record, { harness: 'codex', role: 'persona', id: 'p', model: 'gpt-6-luna', input: 5, cache_write: 0, cache_write_1h: 0,
        cached_input: 5, output: 3, source: 'codex-json', run: 'r' });
      assert.equal(result.codex_version, '0.155.0-alpha.9.2');
      assert.equal(result.isolation, 'tools');
      assert.equal(result.self_check, 'skipped');
      assert.match(result.features_hash, /^[0-9a-f]{16}$/);
      assert.equal(result.cli.effort, 'low');
      assert.equal(result.cli.model, 'gpt-6-luna');
      const args = fake.execArgs();
      assert.equal(args[0], 'exec');
      assert.ok(args.includes('--json'));
      assert.ok(args.includes('web_search="disabled"'));
      assert.ok(args.includes('model_reasoning_effort="low"'));
      assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-6-luna']);
      assert.deepEqual(args.filter((a, i) => args[i - 1] === '--disable').length, 26);
      assert.ok(!args.includes('code_mode_host'));
      assert.match(fs.readFileSync(path.join(dir, 'codex-cli.log'), 'utf8'), /"turn\.completed"/);
    } finally {
      fake.cleanup();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      await fixture.close();
    }
  });

test('a usage.jsonl that cannot be appended costs one warning, never the run result',
  { skip: process.platform === 'win32' && 'the fake Codex is a POSIX script; Node cannot spawn it as codex.exe' }, async () => {
    const fixture = await startFixtureServer();
    const fake = makeFakeCodex({ features: FEATURES_0155 });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-fake-usage-fail-'));
    try {
      const dir = path.join(projectRoot, '.ux-assessment', 'runs', 'r', 'p');
      fs.mkdirSync(path.join(projectRoot, '.ux-assessment', 'usage.jsonl'), { recursive: true }); // a folder: the append fails
      const warnings = [];
      const result = await runCodexPersona(
        { projectRoot, briefing: 'Session id: p', session: { id: 'p', dir, url: fixture.url('basic.html') } },
        { platform: 'linux', env: { ...process.env, UXA_CODEX_BIN: fake.file, UXA_CODEX_SELF_CHECK: 'skip' }, warn: (line) => warnings.push(line) });
      assert.equal(result.summary, 'done');
      assert.equal(warnings.filter((w) => w.startsWith('warning: tokens not recorded in .ux-assessment/usage.jsonl (')).length, 1);
    } finally {
      fake.cleanup();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      await fixture.close();
    }
  });

test('child environment: an allowlist, HOME (and USERPROFILE on win32) set to the temp dir, the sign-in kept', () => {
  const env = { PATH: '/bin', HOME: '/home/me', USER: 'me', TMPDIR: '/tmp', LANG: 'en_US.UTF-8', SECRET_TOKEN: 's',
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TEMP: 'C:\\T', TMP: 'C:\\T', PATHEXT: '.EXE', LOCALAPPDATA: 'C:\\L' };
  const posix = buildChildEnv({ env, platform: 'linux', temp: '/t', homedir: '/home/me' });
  assert.deepEqual(posix, { PATH: '/bin', HOME: '/t', USER: 'me', TMPDIR: '/tmp', LANG: 'en_US.UTF-8', CODEX_HOME: path.join('/home/me', '.codex') });
  const win = buildChildEnv({ env: { ...env, CODEX_HOME: 'C:\\codex' }, platform: 'win32', temp: 'C:\\t', homedir: 'C:\\Users\\me' });
  assert.equal(win.USERPROFILE, 'C:\\t');
  assert.equal(win.HOME, 'C:\\t');
  assert.equal(win.CODEX_HOME, 'C:\\codex');
  for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'LOCALAPPDATA']) assert.equal(win[key], env[key]);
  assert.equal(win.SECRET_TOKEN, undefined);
  assert.equal(posix.SystemRoot, undefined);
});

test('timeout kill: SIGTERM then SIGKILL after 5 s on POSIX; taskkill of the whole tree on win32', () => {
  const signals = [];
  const scheduled = [];
  const child = { pid: 42, kill: (signal) => signals.push(signal) };
  killTree(child, { platform: 'linux', later: (fn, ms) => scheduled.push({ fn, ms }) });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(scheduled[0].ms, 5000);
  scheduled[0].fn();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  const calls = [];
  signals.length = 0;
  killTree(child, { platform: 'win32', run: (file, args) => calls.push([file, args]) });
  assert.deepEqual(calls, [['taskkill', ['/PID', '42', '/T', '/F']]]);
  assert.deepEqual(signals, []);
});

test('win32: a failing taskkill falls back to a plain kill so the child is never left running', () => {
  const signals = [];
  const child = { pid: 42, kill: (signal) => signals.push(signal) };
  const calls = [];
  killTree(child, { platform: 'win32', run: (file, args, callback) => { calls.push([file, args]); callback(new Error('taskkill: not found')); } });
  assert.deepEqual(calls, [['taskkill', ['/PID', '42', '/T', '/F']]]);
  assert.deepEqual(signals, [undefined]);
});

test('linux without a self-check record refuses before any browser starts; with a matching record it runs',
  { skip: process.platform === 'win32' && 'the fake Codex is a POSIX script; Node cannot spawn it as codex.exe' }, async () => {
    const fixture = await startFixtureServer();
    const fake = makeFakeCodex({ features: FEATURES_0155 });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-record-gate-'));
    const env = { ...process.env, UXA_CODEX_BIN: fake.file };
    delete env.UXA_CODEX_SELF_CHECK;
    try {
      const dir = path.join(projectRoot, '.ux-assessment', 'runs', 'r', 'p');
      const job = { projectRoot, briefing: 'Session id: p', session: { id: 'p', dir, url: fixture.url('basic.html') } };
      await assert.rejects(runCodexPersona(job, { platform: 'linux', env }), /no passing self-check on record for Codex 0\.155\.0-alpha\.9\.2 on linux/);
      assert.ok(!fs.existsSync(dir), 'no session was started');
      writeRecord(recordPath(projectRoot), { codex_version: '0.155.0-alpha.9.2', features_hash: featuresHash(denyPresent(parseFeatures(FEATURES_0155))),
        platform: 'linux', isolation: 'tools', passed: true, at: new Date().toISOString() });
      const result = await runCodexPersona(job, { platform: 'linux', env });
      assert.equal(result.self_check, 'passed');
      assert.equal(result.isolation, 'tools');
    } finally {
      fake.cleanup();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      await fixture.close();
    }
  });

test('runIsolated warns on win32 when the project is outside the user profile, before the gate (D28)', async () => {
  const lines = [];
  await assert.rejects(runIsolated({
    role: 'persona', projectRoot: 'D:\\work\\app', prompt: () => 'p',
    session: { id: 'p', dir: 'D:\\work\\app\\.ux-assessment\\runs\\r\\p', url: 'http://localhost:1/' },
    platform: 'win32', homedir: 'C:\\Users\\me', warn: (line) => lines.push(line), resolve: () => ['/x/codex'],
    gate: async () => ({ pass: false, version: 'v', deny: [], featuresHash: 'h', enabled: [], problems: ['stop'] }),
  }), (error) => error.message === 'stop');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^warning: D:\\work\\app is outside your user profile \(C:\\Users\\me\)/);
});
