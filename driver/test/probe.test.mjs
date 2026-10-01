import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, nowIso, missingDeps } from '../probe.mjs';
import { startFixtureServer } from './fixture-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, '..', 'probe.mjs');

async function probe(argv, opts = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), ...opts });
  return { code, out: out.join(''), err: err.join('') };
}

async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('url: status and final URL after redirects; a 404 still answers; a closed port is unreachable', async () => {
  const server = await startFixtureServer();
  try {
    let r = await probe(['url', server.url('basic.html')]);
    assert.deepEqual([r.code, r.out, r.err], [0, `200 ${server.url('basic.html')}\n`, '']);
    r = await probe(['url', server.url(`redirect?to=${encodeURIComponent(server.url('basic.html'))}`)]);
    assert.deepEqual([r.code, r.out], [0, `200 ${server.url('basic.html')}\n`]);
    r = await probe(['url', server.url('missing.html')]);
    assert.deepEqual([r.code, r.out], [0, `404 ${server.url('missing.html')}\n`]);
  } finally {
    await server.close();
  }
  const port = await closedPort();
  const r = await probe(['url', `http://127.0.0.1:${port}/`]);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, new RegExp(`^unreachable: http://127\\.0\\.0\\.1:${port}/ \\(.+\\)\\n$`));
});

test('url: a server that never answers times out as unreachable', async () => {
  const server = await startFixtureServer();
  try {
    const r = await probe(['url', server.url('hang')], { timeoutMs: 200 });
    assert.equal(r.code, 1);
    assert.equal(r.err, `unreachable: ${server.url('hang')} (no answer in 0.2 s)\n`);
  } finally {
    await server.close();
  }
});

test('url and fetch accept only http and https; bad usage exits 2', async () => {
  let r = await probe(['url', 'file:///etc/passwd']);
  assert.deepEqual([r.code, r.err], [1, 'only http and https URLs: file:///etc/passwd\n']);
  r = await probe(['url', 'not a url']);
  assert.deepEqual([r.code, r.err], [1, 'not a URL: not a url\n']);
  for (const argv of [[], ['url'], ['bogus'], ['now', 'x'], ['fetch'], ['fetch', 'http://x/', '--max-bytes', '0'], ['fetch', 'http://x/', '--max-bytes', 'ten']]) {
    r = await probe(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /^usage: node probe\.mjs/);
  }
});

test('now: UTC ISO time to the second', async () => {
  assert.equal(nowIso(new Date('2026-09-29T08:15:02.345Z')), '2026-09-29T08:15:02Z');
  const r = await probe(['now'], { now: () => new Date('2026-01-02T03:04:05.000Z') });
  assert.deepEqual([r.code, r.out, r.err], [0, '2026-01-02T03:04:05Z\n', '']);
});

test('fetch: status line, blank line, body; truncated at --max-bytes', async () => {
  const server = await startFixtureServer();
  const body = fs.readFileSync(path.join(HERE, 'fixtures', 'basic.html'));
  try {
    let r = await probe(['fetch', server.url('basic.html')]);
    assert.deepEqual([r.code, r.err], [0, '']);
    assert.equal(r.out, `200 ${server.url('basic.html')}\n\n${body.toString('utf8')}\n`);
    r = await probe(['fetch', server.url('basic.html'), '--max-bytes', '10']);
    assert.equal(r.out, `200 ${server.url('basic.html')}\n\n${body.subarray(0, 10).toString('utf8')}\n[probe: truncated at 10 bytes]\n`);
  } finally {
    await server.close();
  }
});

test('CLI: runs as a script and prints nothing on stderr', () => {
  const r = spawnSync(process.execPath, [PROBE, 'now'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
  assert.equal(r.stderr, '');
});

function fakeDriver(t, installed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { yaml: '^2', playwright: '^1' } }));
  for (const name of installed) {
    fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), '{}');
  }
  return dir;
}

test('deps: names missing packages, then a missing Chromium, else nothing', async (t) => {
  let dir = fakeDriver(t, []);
  assert.deepEqual(await missingDeps({ driverDir: dir, chromium: async () => true }), ['yaml', 'playwright']);
  dir = fakeDriver(t, ['yaml']);
  assert.deepEqual(await missingDeps({ driverDir: dir, chromium: async () => true }), ['playwright']);
  dir = fakeDriver(t, ['yaml', 'playwright']);
  assert.deepEqual(await missingDeps({ driverDir: dir, chromium: async () => false }), ['playwright chromium']);
  assert.deepEqual(await missingDeps({ driverDir: dir, chromium: async () => true }), []);
});

test('deps CLI: ok and exit 0, or the --deps-only command and exit 1', async () => {
  let r = await probe(['deps'], { deps: async () => [] });
  assert.deepEqual([r.code, r.out, r.err], [0, 'ok\n', '']);
  r = await probe(['deps'], { deps: async () => ['playwright chromium'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /^missing: playwright chromium\nrun: node ".+install\.mjs" --deps-only, then restart Claude Code or Codex\n$/);
  r = await probe(['deps', 'x']);
  assert.equal(r.code, 2);
});

test('deps: the real driver has its dependencies (CI installs them before the tests)', () => {
  const r = spawnSync(process.execPath, [PROBE, 'deps'], { encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'ok\n', '']);
});

test('the shared skill preamble runs the dependency check before the Codex redirect', () => {
  const skill = fs.readFileSync(path.join(HERE, '..', '..', 'skills', 'ux-assessment', 'SKILL.md'), 'utf8');
  const check = skill.indexOf('node "$PLUGIN/driver/probe.mjs" deps');
  assert.ok(check > 0 && check < skill.indexOf('**Codex entry:**'));
  assert.match(skill, /--deps-only/);
});
