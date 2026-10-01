import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RECORD_NAME, newNonce, countActs, countWebSearches, judgeSelfCheck, recordPath, readRecord, writeRecord, recordMatches, selfCheckPrompt, requireSelfCheck } from '../codex-self-check.mjs';
import { parseSelfCheckArgs, runSelfCheck } from '../codex-runner.mjs';
import { makeFakeCodex } from './fake-codex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'codex-runner.mjs');
const FEATURES_0155 = fs.readFileSync(path.join(HERE, 'fixtures', 'codex-features-0.155.txt'), 'utf8');
const POSIX_ONLY = process.platform === 'win32' && 'the fake Codex is a POSIX script; Node cannot spawn it as codex.exe';
const clean = { nonces: ['n1', 'n2', 'n3'], texts: ['all blocked', '{"type":"turn.completed"}', ''], httpRequests: 0, acts: 1, ended: true, webSearches: 0, gatePassed: true };

test('PASS needs no leak, no HTTP request, an act and an ended session, no web search, and the gate', () => {
  const ok = judgeSelfCheck(clean);
  assert.equal(ok.passed, true);
  assert.deepEqual(ok.checks.map((c) => c.name), ['feature-gate', 'no-leak', 'http-canary', 'mcp-tools', 'web-search']);
  const fails = {
    'no-leak': { texts: ['fine', '{"type":"item.completed","item":{"type":"mcp_tool_call","result":"n2"}}'] },
    'http-canary': { httpRequests: 1 },
    'mcp-tools': { acts: 0 },
    'web-search': { webSearches: 1 },
    'feature-gate': { gatePassed: false },
  };
  for (const [name, change] of Object.entries(fails)) {
    const verdict = judgeSelfCheck({ ...clean, ...change });
    assert.equal(verdict.passed, false, name);
    assert.deepEqual(verdict.checks.filter((c) => !c.ok).map((c) => c.name), [name]);
  }
  assert.equal(judgeSelfCheck({ ...clean, ended: false }).passed, false);
});

test('nonces are random and distinct', () => {
  const a = newNonce();
  assert.match(a, /^uxa-canary-[0-9a-f]{24}$/);
  assert.notEqual(a, newNonce());
});

test('acts are step log lines; invalid, refused and end lines are not', () => {
  const log = [
    JSON.stringify({ t: 1, step: null, action: { type: 'look' } }),
    JSON.stringify({ t: 2, invalid: 'x' }),
    JSON.stringify({ t: 3, refused: 'STEP_CAP_REACHED' }),
    JSON.stringify({ t: 4, step: 1, action: { type: 'click' } }),
    JSON.stringify({ t: 5, end: { outcome: 'gave_up' } }),
    'not json',
  ].join('\n');
  assert.equal(countActs(log), 2);
  assert.equal(countActs(''), 0);
});

test('web search items are counted once per item id', () => {
  const events = [
    JSON.stringify({ type: 'item.started', item: { id: 'w1', type: 'web_search' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'w1', type: 'web_search' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'w2', item_type: 'web_search' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call' } }),
  ].join('\n');
  assert.equal(countWebSearches(events), 2);
});

test('the record lives in the project, or in the temp dir; only an exact passing record matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-record-'));
  try {
    const file = recordPath(root);
    assert.equal(file, path.join(root, '.ux-assessment', RECORD_NAME));
    assert.equal(recordPath(null), path.join(os.tmpdir(), `ux-assessment-${RECORD_NAME}`));
    const record = { codex_version: '1.0', features_hash: 'abc', platform: 'linux', isolation: 'tools', passed: true, at: '2026-09-28T00:00:00.000Z' };
    writeRecord(file, record);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readRecord(file), record);
    const want = { codex_version: '1.0', features_hash: 'abc', platform: 'linux' };
    assert.equal(recordMatches(readRecord(file), want), true);
    assert.equal(recordMatches({ ...record, passed: false }, want), false);
    assert.equal(recordMatches(record, { ...want, codex_version: '1.1' }), false);
    assert.equal(recordMatches(record, { ...want, features_hash: 'def' }), false);
    assert.equal(recordMatches(record, { ...want, platform: 'win32' }), false);
    assert.equal(recordMatches(null, want), false);
    assert.equal(readRecord(path.join(root, 'missing.json')), null);
    fs.writeFileSync(path.join(root, 'bad.json'), '{');
    assert.equal(readRecord(path.join(root, 'bad.json')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the prompt names both files, the URL, a helper agent, act and end_session, and no nonce', () => {
  const prompt = selfCheckPrompt({ sessionId: 'selfcheck', cwdCanary: '/t/canary.txt', secretFile: '/p/SECRET.txt', canaryUrl: 'http://127.0.0.1:5/' });
  for (const part of ['/t/canary.txt', '/p/SECRET.txt', 'http://127.0.0.1:5/', 'helper agent', '`act`', '`end_session`', '"selfcheck"', 'gave_up']) assert.ok(prompt.includes(part), part);
  assert.doesNotMatch(prompt, /uxa-canary-/);
});

test('self-check options', () => {
  assert.deepEqual(parseSelfCheckArgs([]), { offline: false, json: false, toolsOnly: false, keep: false, projectRoot: null, model: null });
  assert.deepEqual(parseSelfCheckArgs(['--offline', '--json', '--tools-only', '--keep', '--project', '/p', '--model', 'gpt-6-sol']),
    { offline: true, json: true, toolsOnly: true, keep: true, projectRoot: path.resolve('/p'), model: 'gpt-6-sol' });
  assert.throws(() => parseSelfCheckArgs(['--project']), /--project needs a path/);
  assert.throws(() => parseSelfCheckArgs(['--bogus']), /unknown self-check option "--bogus"/);
  assert.throws(() => parseSelfCheckArgs(['--model', 'a b']), /model must match/);
  assert.throws(() => parseSelfCheckArgs(['--project', '--offline']), { message: '--project needs a path, not the option "--offline"' });
  assert.throws(() => parseSelfCheckArgs(['--model', '--json']), { message: '--model needs a model name, not the option "--json"' });
});

test('offline self-check: version, DENY list, enabled set and PASS; no model, no browser', async () => {
  const lines = [];
  const gate = async () => ({ pass: true, version: '0.155.0-alpha.9.2', deny: ['shell_tool'], featuresHash: 'abc', enabled: ['code_mode_host'], problems: [] });
  const result = await runSelfCheck({ offline: true, out: (line) => lines.push(line), resolve: () => ['/x/codex'], gate });
  assert.equal(result.passed, true);
  assert.equal(result.record, null, 'an offline pass is not a self-check record');
  assert.deepEqual(lines, ['Codex 0.155.0-alpha.9.2 (/x/codex)', 'DENY passed (1): shell_tool', 'Enabled (1): code_mode_host',
    'PASS feature-gate: every enabled feature is classified', 'PASS']);
  lines.length = 0;
  const refused = await runSelfCheck({ offline: true, out: (line) => lines.push(line), resolve: () => ['/x/codex'],
    gate: async () => ({ pass: false, version: 'v', deny: [], featuresHash: 'h', enabled: ['zz'], problems: ['p1', 'p2'] }) });
  assert.equal(refused.passed, false);
  assert.deepEqual(lines.slice(-3), ['FAIL feature-gate: p1', 'FAIL feature-gate: p2', 'FAIL']);
});

test('CLI: offline self-check against a fake Codex, PASS then FAIL on an unclassified feature', { skip: POSIX_ONLY }, async () => {
  const run = async (features, extra = []) => {
    const fake = makeFakeCodex({ features });
    try {
      return await promisify(execFile)(process.execPath, [RUNNER, 'self-check', '--offline', ...extra], { env: { ...process.env, UXA_CODEX_BIN: fake.file } })
        .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    } finally { fake.cleanup(); }
  };
  const pass = await run(FEATURES_0155);
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /^Codex 0\.155\.0-alpha\.9\.2 /);
  assert.match(pass.stdout, /DENY passed \(26\): shell_tool /);
  assert.match(pass.stdout, /\nPASS\n$/);
  const fail = await run(`${FEATURES_0155.trimEnd()}\nzz_new_tool                              stable             true\n`, ['--json']);
  assert.equal(fail.code, 1);
  const json = JSON.parse(fail.stdout);
  assert.equal(json.passed, false);
  assert.match(json.checks[0].detail, /Codex 0\.155\.0-alpha\.9\.2 enables zz_new_tool, which ux-assessment has not classified/);
  const bad = await promisify(execFile)(process.execPath, [RUNNER, 'self-check', '--bogus']).catch((e) => e);
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr.trim().split('\n').length, 1);
});

test('full self-check through a fake Codex: no act fails mcp-tools after one retry; a leaked cwd canary fails no-leak at once; the record is written',
  { skip: POSIX_ONLY }, async () => {
    for (const mode of ['quiet', 'leak']) {
      const fake = makeFakeCodex({ features: FEATURES_0155, mode });
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-selfcheck-test-'));
      const lines = [];
      let result;
      try {
        result = await runSelfCheck({ projectRoot: project, toolsOnly: true, out: (line) => lines.push(line), resolve: () => [fake.file],
          gate: undefined, env: { ...process.env } });
        const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
        assert.deepEqual(failed, mode === 'quiet' ? ['mcp-tools'] : ['no-leak', 'mcp-tools']);
        const retries = lines.filter((line) => line.startsWith('retrying: the model did not call act'));
        assert.equal(retries.length, mode === 'quiet' ? 1 : 0, 'only a pure act miss is retried, and only once');
        if (mode === 'quiet') {
          assert.ok(fs.existsSync(result.first_evidence), 'the first attempt evidence is kept');
          assert.notEqual(result.first_evidence, result.evidence);
        }
        assert.equal(result.passed, false);
        assert.equal(result.isolation, 'tools');
        assert.deepEqual(result.usage, { input_tokens: 10, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 });
        const record = readRecord(path.join(project, '.ux-assessment', RECORD_NAME));
        assert.equal(record.passed, false);
        assert.equal(record.codex_version, '0.155.0-alpha.9.2');
        assert.ok(result.evidence && fs.existsSync(result.evidence), 'evidence is kept on FAIL');
      } finally {
        fake.cleanup();
        fs.rmSync(project, { recursive: true, force: true });
        for (const evidence of [result?.evidence, result?.first_evidence]) {
          if (!evidence) continue;
          // The evidence is <scratch>/.ux-assessment/self-check, or <scratch> itself when no session started.
          const tmpRoots = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
          const scratch = [evidence, path.resolve(evidence, '..', '..')].find((p) =>
            path.basename(p).startsWith('uxa-selfcheck-project-') && tmpRoots.includes(path.dirname(p)));
          if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
    }
  });

test('win32 and linux need a passing record for this Codex version, DENY hash and OS; darwin does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-require-'));
  const other = path.join(root, 'none.json');
  try {
    const want = { codex_version: '1.0', features_hash: 'abc' };
    const files = [recordPath(root), other];
    assert.equal(requireSelfCheck({ platform: 'darwin', env: {}, projectRoot: root, ...want, files }), 'not-required');
    for (const platform of ['win32', 'linux']) {
      assert.throws(() => requireSelfCheck({ platform, env: {}, projectRoot: root, ...want, files }),
        { message: `no passing self-check on record for Codex 1.0 on ${platform}; run: node ${path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'codex-runner.mjs')} self-check --project ${root}` });
      assert.equal(requireSelfCheck({ platform, env: { UXA_CODEX_SELF_CHECK: 'skip' }, projectRoot: root, ...want, files }), 'skipped');
    }
    writeRecord(recordPath(root), { ...want, platform: 'linux', isolation: 'tools', passed: true, at: 'x' });
    assert.equal(requireSelfCheck({ platform: 'linux', env: {}, projectRoot: root, ...want, files }), 'passed');
    assert.throws(() => requireSelfCheck({ platform: 'win32', env: {}, projectRoot: root, ...want, files }), /no passing self-check/);
    assert.throws(() => requireSelfCheck({ platform: 'linux', env: {}, projectRoot: root, codex_version: '1.1', features_hash: 'abc', files }), /Codex 1\.1 on linux/);
    assert.throws(() => requireSelfCheck({ platform: 'linux', env: {}, projectRoot: root, codex_version: '1.0', features_hash: 'def', files }), /no passing self-check/);
    writeRecord(other, { ...want, platform: 'win32', isolation: 'tools', passed: true, at: 'x' });
    assert.equal(requireSelfCheck({ platform: 'win32', env: {}, projectRoot: root, ...want, files }), 'passed', 'an extra record file passed in files counts too');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('with a project root only the project record counts; a failed or stale one never does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-require-default-'));
  try {
    const want = { codex_version: '1.0', features_hash: 'abc' };
    // No `files`: the shared temp-dir record is never consulted, so this cannot depend on what the machine's temp dir holds.
    assert.throws(() => requireSelfCheck({ platform: 'linux', env: {}, projectRoot: root, ...want }), /no passing self-check/);
    writeRecord(recordPath(root), { ...want, platform: 'linux', isolation: 'tools', passed: false, at: 'x' });
    assert.throws(() => requireSelfCheck({ platform: 'linux', env: {}, projectRoot: root, ...want }), /no passing self-check/);
    writeRecord(recordPath(root), { ...want, platform: 'linux', isolation: 'tools', passed: true, at: 'x' });
    assert.equal(requireSelfCheck({ platform: 'linux', env: {}, projectRoot: root, ...want }), 'passed');
    assert.equal(requireSelfCheck({ platform: 'linux', env: { UXA_CODEX_SELF_CHECK: 'yes' }, projectRoot: root, ...want }), 'passed', 'only "skip" skips');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a record is trusted only as a regular file owned by this user and not writable by others', { skip: process.platform === 'win32' && 'POSIX ownership and symlinks' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-record-trust-'));
  try {
    const record = { codex_version: '1.0', features_hash: 'abc', platform: 'linux', isolation: 'tools', passed: true, at: 'x' };
    const real = path.join(root, 'real.json');
    writeRecord(real, record);
    assert.deepEqual(readRecord(real), record);
    const link = path.join(root, 'link.json');
    fs.symlinkSync(real, link);
    assert.equal(readRecord(link), null, 'a symlinked record is not trusted');
    assert.equal(readRecord(real, { uid: process.getuid() + 1 }), null, 'a record owned by someone else is not trusted');
    assert.deepEqual(readRecord(real, { platform: 'win32', uid: process.getuid() + 1 }), record, 'win32 has no POSIX owner or mode to check');
    fs.chmodSync(real, 0o620);
    assert.equal(readRecord(real), null, 'a group-writable record is not trusted');
    fs.chmodSync(real, 0o602);
    assert.equal(readRecord(real), null, 'a world-writable record is not trusted');
    fs.chmodSync(real, 0o644);
    assert.deepEqual(readRecord(real), record, 'readable by others is fine');
    fs.mkdirSync(path.join(root, 'dir.json'));
    assert.equal(readRecord(path.join(root, 'dir.json')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRecord replaces a planted symlink instead of writing through it', { skip: process.platform === 'win32' && 'symlinks need privileges on win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-record-plant-'));
  try {
    const target = path.join(root, 'victim.txt');
    fs.writeFileSync(target, 'untouched\n');
    const file = recordPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file);
    const record = { codex_version: '1.0', features_hash: 'abc', platform: 'linux', isolation: 'tools', passed: true, at: 'x' };
    writeRecord(file, record);
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n');
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(readRecord(file), record);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [RECORD_NAME], 'no temp file is left behind');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the prompt opens by saying steps 4 and 5 are required, and keeps the step order', () => {
  const prompt = selfCheckPrompt({ sessionId: 'selfcheck', cwdCanary: '/t/c', secretFile: '/p/S', canaryUrl: 'http://127.0.0.1:5/' });
  assert.match(prompt, /^Steps 4 and 5 are required: the check fails without them\. Do them even if steps 1-3 are refused/);
  const order = ['1. ', '2. ', '3. ', '4. Call the `act` tool exactly once (required)', '5. Call the `end_session` tool'].map((step) => prompt.indexOf(step));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `step order ${order}`);
});

test('a record write that fails midway leaves no temp file behind and rethrows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-record-fail-'));
  try {
    const file = recordPath(root);
    assert.throws(() => writeRecord(file, { big: 1n }), TypeError);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('full self-check retry (injected attempts, no model)', () => {
  const gate = async () => ({ pass: true, version: '1.0', deny: ['shell_tool'], featuresHash: 'abc', enabled: ['code_mode_host'], problems: [] });
  const attemptResult = (over = {}) => ({ nonces: ['n1', 'n2', 'n3'], texts: ['nothing', '', ''], httpRequests: 0, acts: 1, ended: true,
    webSearches: 0, failure: null, dir: null, scratch: null, usage: null, ...over });
  const runWith = async (results) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-selfcheck-retry-'));
    const lines = [];
    let calls = 0;
    try {
      const result = await runSelfCheck({ projectRoot: project, toolsOnly: true, out: (line) => lines.push(line), resolve: () => ['/x/codex'], gate,
        attempt: async () => results[calls++] });
      return { result, lines, calls, record: readRecord(recordPath(project)) };
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  };

  test('0 acts with every other check passing is retried once, and the second attempt decides the record', async () => {
    const { result, lines, calls, record } = await runWith([attemptResult({ acts: 0, ended: false }), attemptResult()]);
    assert.equal(calls, 2);
    assert.equal(lines.filter((line) => line.startsWith('retrying: the model did not call act')).length, 1);
    assert.equal(result.passed, true);
    assert.equal(record.passed, true);
    assert.ok(result.checks.every((check) => check.ok));
  });

  test('the retry is judged on all five checks: a leak on the second attempt still FAILs', async () => {
    const { result, calls, record } = await runWith([attemptResult({ acts: 0 }), attemptResult({ texts: ['n2', '', ''] })]);
    assert.equal(calls, 2);
    assert.equal(result.passed, false);
    assert.equal(record.passed, false);
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ['no-leak']);
  });

  test('two act misses FAIL mcp-tools; there is no third attempt', async () => {
    const { result, calls } = await runWith([attemptResult({ acts: 0 }), attemptResult({ acts: 0 }), attemptResult()]);
    assert.equal(calls, 2);
    assert.equal(result.passed, false);
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ['mcp-tools']);
  });

  for (const [name, over] of Object.entries({
    'an HTTP canary hit': { acts: 0, httpRequests: 1 },
    'a leaked nonce': { acts: 0, texts: ['n1', '', ''] },
    'a web search': { acts: 0, webSearches: 1 },
    'a runner error': { acts: 0, failure: new Error('codex exited') },
    'an act without end_session': { acts: 1, ended: false },
  })) {
    test(`${name} on the first attempt FAILs at once, with no retry`, async () => {
      const { result, lines, calls, record } = await runWith([attemptResult(over), attemptResult()]);
      assert.equal(calls, 1);
      assert.ok(!lines.some((line) => line.startsWith('retrying')));
      assert.equal(result.passed, false);
      assert.equal(record.passed, false);
    });
  }
});

test('full self-check: the self-check role defaults to gpt-6-sol at low effort; --model replaces the model only', async () => {
  const gate = async () => ({ pass: true, version: '1.0', deny: ['shell_tool'], featuresHash: 'abc', enabled: ['code_mode_host'], problems: [] });
  const seen = [];
  const attempt = async (opts) => {
    seen.push([opts.model, opts.effort]);
    return { nonces: ['n1', 'n2', 'n3'], texts: ['nothing', '', ''], httpRequests: 0, acts: 1, ended: true, webSearches: 0,
      failure: null, dir: null, scratch: null, usage: null };
  };
  for (const model of [null, 'gpt-6-luna']) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-selfcheck-model-'));
    try {
      await runSelfCheck({ projectRoot: project, toolsOnly: true, model, out: () => {}, resolve: () => ['/x/codex'], gate, attempt });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
  assert.deepEqual(seen, [['gpt-6-sol', 'low'], ['gpt-6-luna', 'low']]);
});
