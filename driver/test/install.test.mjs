import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseInstallArgs, findClaude, defaultRun, installClaude, marketplacePointsTo, USAGE } from '../../scripts/install-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'scripts', 'install.mjs');
const SKILL = fs.realpathSync(path.join(ROOT, 'skills', 'ux-assessment'));
const DRIVER = path.join(ROOT, 'driver');
const noSpawn = () => { throw new Error('unexpected spawn'); };

function box({ claude = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-install-'));
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  if (claude) {
    const file = path.join(bin, claude);
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o755);
  }
  return { base, home, bin, skill: path.join(home, '.codex', 'skills', 'ux-assessment'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// In-process run with a temporary home and PATH. Codex is "present" through UXA_CODEX_BIN = this node binary
// (an executable file that is neither a shim nor a launcher); it is never spawned.
async function install(b, { argv = ['--skip-deps'], codex = true, env = {}, platform = process.platform, run = noSpawn } = {}) {
  const out = [];
  const err = [];
  const code = await main({
    argv, platform, homedir: b.home, root: ROOT, applications: path.join(b.base, 'Applications'), run,
    env: { PATH: b.bin, ...(codex ? { UXA_CODEX_BIN: process.execPath } : {}), ...env },
    out: (line) => out.push(line), err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function recorder(statusFor = () => 0) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, shell: opts.shell === true, cwd: opts.cwd });
    return { status: statusFor(cmd, args), stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('options', () => {
  assert.deepEqual(parseInstallArgs([]), { claude: true, codex: true, deps: true, depsOnly: false });
  assert.deepEqual(parseInstallArgs(['--no-claude', '--skip-deps']), { claude: false, codex: true, deps: false, depsOnly: false });
  assert.deepEqual(parseInstallArgs(['--deps-only']), { claude: true, codex: true, deps: true, depsOnly: true });
  assert.deepEqual(parseInstallArgs(['--help']), { help: true });
  assert.throws(() => parseInstallArgs(['--force']), /^Error: unknown option --force\nusage: /);
  assert.throws(() => parseInstallArgs(['--no-claude', '--no-codex']), /nothing to install/);
  assert.throws(() => parseInstallArgs(['--deps-only', '--skip-deps']), /nothing to do/);
});

test('Codex only: links the skill (a junction on Windows), says Claude Code was skipped; a rerun keeps it', async () => {
  const b = box();
  try {
    let r = await install(b);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '');
    assert.match(r.out, /Claude Code: skipped \(no `claude` on PATH\)/);
    assert.match(r.out, /Codex: skill linked at /);
    assert.equal(fs.realpathSync(b.skill), SKILL);
    assert.ok(fs.lstatSync(b.skill).isSymbolicLink(), 'a link (Node reports a junction as a symbolic link), never a copy');
    r = await install(b);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Codex: skill already linked at /);
  } finally {
    b.cleanup();
  }
});

test('Codex on Linux or Windows: the summary asks for the self-check', async () => {
  const b = box();
  try {
    // Create the link with the host platform first: the link type follows `platform`, and a 'dir' symlink needs
    // privileges on a Windows host. The injected platforms below then find it and keep it.
    assert.equal((await install(b)).code, 0);
    for (const platform of ['linux', 'win32']) {
      const r = await install(b, { platform });
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /is experimental: run `node ".+codex-runner\.mjs" self-check` once now and after every Codex update/);
    }
    const r = await install(b, { platform: 'darwin' });
    assert.doesNotMatch(r.out, /self-check/);
  } finally {
    b.cleanup();
  }
});

test('an existing different entry is left untouched: exit 2', async () => {
  const b = box();
  try {
    fs.mkdirSync(b.skill, { recursive: true });
    fs.writeFileSync(path.join(b.skill, 'SKILL.md'), 'mine');
    const r = await install(b);
    assert.equal(r.code, 2);
    assert.match(r.err, /already exists and resolves to .+; remove or relocate it, then rerun/);
    assert.equal(fs.readFileSync(path.join(b.skill, 'SKILL.md'), 'utf8'), 'mine');
  } finally {
    b.cleanup();
  }
});

test('a link left by a moved checkout is reported, not followed or replaced: exit 2', async () => {
  const b = box();
  try {
    const old = path.join(b.base, 'old-checkout', 'skills', 'ux-assessment');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(path.dirname(b.skill), { recursive: true });
    fs.symlinkSync(old, b.skill, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(path.join(b.base, 'old-checkout'), { recursive: true });
    const r = await install(b);
    assert.equal(r.code, 2);
    assert.match(r.err, /is a link to a folder that no longer exists \(a moved checkout\?\); remove it, then rerun/);
    assert.ok(fs.lstatSync(b.skill).isSymbolicLink(), 'the stale link is left for the user');
  } finally {
    b.cleanup();
  }
});

test('the link install-macos.sh made (same target, unresolved path) is accepted',
  { skip: process.platform === 'win32' && 'a symlink needs privileges on Windows; the junction rerun covers it' }, async () => {
    const b = box();
    try {
      fs.mkdirSync(path.dirname(b.skill), { recursive: true });
      fs.symlinkSync(path.join(ROOT, 'skills', 'ux-assessment'), b.skill);
      const r = await install(b);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Codex: skill already linked at /);
    } finally {
      b.cleanup();
    }
  });

test('CODEX_HOME moves the skill link, as it moves the runner sign-in', async () => {
  const b = box();
  try {
    const codexHome = path.join(b.base, 'codex-home');
    const r = await install(b, { env: { CODEX_HOME: codexHome } });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.realpathSync(path.join(codexHome, 'skills', 'ux-assessment')), SKILL);
    assert.ok(!fs.existsSync(b.skill));
  } finally {
    b.cleanup();
  }
});

test('neither harness: exit 1 and nothing is created', async () => {
  const b = box();
  try {
    const r = await install(b, { codex: false });
    assert.equal(r.code, 1);
    assert.match(r.err, /^Install Claude Code or Codex first: no `claude` on PATH; Codex CLI not found/);
    assert.ok(!fs.existsSync(path.join(b.home, '.codex')));
  } finally {
    b.cleanup();
  }
});

function fakeClaude({ markets = [], plugins = [], fail = null, pluginListStdout = null } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const line = args.join(' ');
    calls.push({ cmd, line, shell: opts.shell === true });
    if (fail && line.startsWith(fail)) return { status: 1, stdout: '', stderr: `boom: ${fail}\nsecond line` };
    if (line === 'plugin marketplace list --json') return { status: 0, stdout: JSON.stringify(markets), stderr: '' };
    if (line === 'plugin list --json') return { status: 0, stdout: pluginListStdout ?? JSON.stringify(plugins), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';

test('Claude Code only: adds this checkout as a marketplace and installs the plugin, never through a shell', async () => {
  const b = box({ claude: CLAUDE });
  try {
    const { run, calls } = fakeClaude();
    const r = await install(b, { codex: false, run });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(calls.map((c) => c.line), [
      'plugin marketplace list --json', `plugin marketplace add ${ROOT}`, 'plugin list --json', 'plugin install ux-assessment@ux-assessment']);
    assert.ok(calls.every((c) => c.cmd === path.join(b.bin, CLAUDE) && !c.shell));
    assert.match(r.out, /Claude Code: plugin ux-assessment@ux-assessment installed from /);
    assert.match(r.out, /Codex: skipped \(Codex CLI not found/);
    assert.ok(r.out.includes(`claude --plugin-dir "${ROOT}"`));
  } finally {
    b.cleanup();
  }
});

test('Claude Code rerun: nothing is added or installed again', async () => {
  const b = box({ claude: CLAUDE });
  try {
    const { run, calls } = fakeClaude({
      markets: [{ name: 'ux-assessment', source: 'directory', path: ROOT, installLocation: ROOT }],
      plugins: [{ id: 'ux-assessment@ux-assessment', version: '0.2.0', installPath: path.join(b.base, 'cache') }],
    });
    const r = await install(b, { codex: false, run });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(calls.map((c) => c.line), ['plugin marketplace list --json', 'plugin list --json']);
    assert.match(r.out, /Claude Code: plugin ux-assessment@ux-assessment already installed from /);
  } finally {
    b.cleanup();
  }
});

test('a Claude marketplace named ux-assessment from elsewhere is a conflict: exit 2, untouched; Codex still links', async () => {
  const b = box({ claude: CLAUDE });
  try {
    const { run, calls } = fakeClaude({ markets: [{ name: 'ux-assessment', source: 'github', repo: 'someone/ux-assessment', installLocation: path.join(b.base, 'elsewhere') }] });
    const r = await install(b, { run });
    assert.equal(r.code, 2);
    assert.match(r.err, /Claude Code: a marketplace named ux-assessment already exists and is not this checkout; remove it with `claude plugin marketplace remove ux-assessment`, then rerun/);
    assert.deepEqual(calls.map((c) => c.line), ['plugin marketplace list --json']);
    assert.equal(fs.realpathSync(b.skill), SKILL);
  } finally {
    b.cleanup();
  }
});

test('a Claude marketplace named ux-assessment with no location is a conflict too (fail closed): exit 2, untouched', async () => {
  const b = box({ claude: CLAUDE });
  try {
    const { run, calls } = fakeClaude({ markets: [{ name: 'ux-assessment', source: 'github', repo: 'someone/ux-assessment' }] });
    const r = await install(b, { codex: false, run });
    assert.equal(r.code, 2);
    assert.match(r.err, /Claude Code: a marketplace named ux-assessment already exists and is not this checkout; remove it with `claude plugin marketplace remove ux-assessment`, then rerun/);
    assert.deepEqual(calls.map((c) => c.line), ['plugin marketplace list --json']);
  } finally {
    b.cleanup();
  }
});

test('a failing claude command prints the manual commands: exit 1', async () => {
  const b = box({ claude: CLAUDE });
  try {
    const { run, calls } = fakeClaude({ fail: 'plugin marketplace add' });
    const r = await install(b, { codex: false, run });
    assert.equal(r.code, 1);
    assert.match(r.err, /Claude Code: `claude plugin marketplace add` failed \(boom: plugin marketplace add\); run these to install the plugin:/);
    assert.ok(r.out.includes(`  claude plugin marketplace add "${ROOT}"`));
    assert.ok(!calls.some((c) => c.line.startsWith('plugin install')), 'no plugin install after a failed marketplace add');
  } finally {
    b.cleanup();
  }
});

test('Claude Code: a project-scoped install elsewhere does not count; the user-scope install runs', async () => {
  const b = box({ claude: CLAUDE });
  try {
    const { run, calls } = fakeClaude({
      markets: [{ name: 'ux-assessment', source: 'directory', path: ROOT, installLocation: ROOT }],
      plugins: [{ id: 'ux-assessment@ux-assessment', scope: 'project', projectPath: path.join(b.base, 'elsewhere') }],
    });
    const r = await install(b, { codex: false, run });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(calls.map((c) => c.line), ['plugin marketplace list --json', 'plugin list --json', 'plugin install ux-assessment@ux-assessment']);
    assert.match(r.out, /Claude Code: plugin ux-assessment@ux-assessment installed from /);
  } finally {
    b.cleanup();
  }
});

test('Claude Code: a disabled user-scope install is not reinstalled; the enable command is printed', async () => {
  const b = box({ claude: CLAUDE });
  try {
    const { run, calls } = fakeClaude({
      markets: [{ name: 'ux-assessment', source: 'directory', path: ROOT, installLocation: ROOT }],
      plugins: [{ id: 'ux-assessment@ux-assessment', scope: 'user', enabled: false }],
    });
    const r = await install(b, { codex: false, run });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(calls.map((c) => c.line), ['plugin marketplace list --json', 'plugin list --json']);
    assert.match(r.out, /Claude Code: plugin ux-assessment@ux-assessment is installed but disabled; run `claude plugin enable ux-assessment@ux-assessment`/);
    assert.doesNotMatch(r.out, /already installed/);
  } finally {
    b.cleanup();
  }
});

test('a failing or non-JSON `claude plugin list --json` prints the manual commands: exit 1, no install', async () => {
  for (const options of [{ fail: 'plugin list --json' }, { pluginListStdout: 'not json' }, { pluginListStdout: '{}' }]) {
    const b = box({ claude: CLAUDE });
    try {
      const { run, calls } = fakeClaude({ markets: [{ name: 'ux-assessment', source: 'directory', path: ROOT }], ...options });
      const r = await install(b, { codex: false, run });
      assert.equal(r.code, 1, JSON.stringify(options));
      assert.match(r.err, /Claude Code: `claude plugin list --json` failed; run these to install the plugin:/);
      assert.ok(r.out.includes('  claude plugin install ux-assessment@ux-assessment'));
      assert.ok(!calls.some((c) => c.line.startsWith('plugin install')));
    } finally {
      b.cleanup();
    }
  }
});

test('marketplacePointsTo: path, installLocation or source.path; null without a location', () => {
  assert.equal(marketplacePointsTo({ name: 'ux-assessment', path: ROOT }, ROOT, process.platform), true);
  assert.equal(marketplacePointsTo({ name: 'ux-assessment', installLocation: ROOT }, ROOT, process.platform), true);
  assert.equal(marketplacePointsTo({ name: 'ux-assessment', source: { source: 'directory', path: ROOT } }, ROOT, process.platform), true);
  assert.equal(marketplacePointsTo({ name: 'ux-assessment', source: 'github', installLocation: path.join(os.tmpdir(), 'uxa-nowhere') }, ROOT, process.platform), false);
  assert.equal(marketplacePointsTo({ name: 'ux-assessment' }, ROOT, process.platform), null);
});

test('installClaude: a shim is never spawned', () => {
  assert.deepEqual(installClaude({ root: ROOT, claude: { kind: 'shim', file: 'C:\\npm\\claude.cmd' }, run: noSpawn, platform: 'win32' }),
    { status: 'manual', reason: 'C:\\npm\\claude.cmd cannot be started without a shell' });
});

test('findClaude: on win32 a claude.exe anywhere on Path wins; an npm shim alone is not spawnable', () => {
  const b = box();
  try {
    const later = path.join(b.base, 'later');
    fs.mkdirSync(later);
    fs.writeFileSync(path.join(b.bin, 'claude.cmd'), '');
    const env = { Path: `${b.bin};${later}` }; // win32 env keys are case-insensitive
    assert.deepEqual(findClaude(env, 'win32'), { kind: 'shim', file: path.join(b.bin, 'claude.cmd') });
    fs.writeFileSync(path.join(later, 'claude.exe'), '');
    assert.deepEqual(findClaude(env, 'win32'), { kind: 'native', file: path.join(later, 'claude.exe') });
    assert.equal(findClaude({ PATH: b.bin }, 'linux'), null);
  } finally {
    b.cleanup();
  }
});

test('win32 with only the npm shim: nothing is spawned, the commands are printed', async () => {
  const b = box({ claude: 'claude.cmd' });
  try {
    const r = await install(b, { platform: 'win32', codex: false });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /claude\.cmd cannot be started without a shell; run these to install the plugin:/);
    assert.ok(r.out.includes(`  claude plugin marketplace add "${ROOT}"`));
  } finally {
    b.cleanup();
  }
});

test('dependencies: npm ci, then Playwright Chromium through node; win32 runs npm.cmd as one fixed shell string', async () => {
  const b = box();
  try {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const { run, calls } = recorder();
      const r = await install(b, { argv: ['--deps-only'], platform, codex: false, run });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(calls[0], platform === 'win32'
        ? { cmd: 'npm.cmd ci', args: [], shell: true, cwd: DRIVER }
        : { cmd: 'npm', args: ['ci'], shell: false, cwd: DRIVER });
      assert.deepEqual(calls[1], { cmd: process.execPath, args: [path.join(DRIVER, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], shell: false, cwd: DRIVER });
      assert.equal(calls.length, 2, '--deps-only runs only the dependency step');
    }
    assert.ok(!fs.existsSync(path.join(b.home, '.codex')), '--deps-only needs no harness and links nothing');
  } finally {
    b.cleanup();
  }
});

test('Linux: a Chromium failure prints the install-deps command instead of running it', async () => {
  const b = box();
  try {
    const { run, calls } = recorder((cmd, args) => (args.includes('chromium') ? 1 : 0));
    const r = await install(b, { argv: ['--deps-only'], platform: 'linux', codex: false, run });
    assert.equal(r.code, 1);
    assert.match(r.err, /run `npx playwright install-deps chromium` in .+driver \(needs sudo\), then rerun/);
    assert.ok(!calls.some((c) => c.args.includes('install-deps') || c.cmd.includes('install-deps')));
  } finally {
    b.cleanup();
  }
});

test('an npm ci failure stops before any harness step: exit 1, no link', async () => {
  const b = box();
  try {
    const { run } = recorder((cmd) => (cmd.startsWith('npm') ? 1 : 0));
    const r = await install(b, { argv: [], run });
    assert.equal(r.code, 1);
    assert.match(r.err, /npm ci failed in .+driver/);
    assert.ok(!fs.existsSync(b.skill));
  } finally {
    b.cleanup();
  }
});

test('npm missing: the spawn error is part of the npm ci failure message', async () => {
  const b = box();
  try {
    const run = (cmd) => (cmd.startsWith('npm') ? { status: null, stdout: '', stderr: 'spawnSync npm ENOENT' } : { status: 0, stdout: '', stderr: '' });
    const r = await install(b, { argv: ['--deps-only'], platform: 'linux', codex: false, run });
    assert.equal(r.code, 1);
    assert.match(r.err, /npm ci failed in .+driver \(spawnSync npm ENOENT\); /);
  } finally {
    b.cleanup();
  }
});

test('defaultRun refuses arguments together with a shell (DEP0190, quoting)', () => {
  assert.throws(() => defaultRun('npm.cmd ci', ['x'], { shell: true }), /one fixed command string/);
});

test('an unknown option exits 1 with the usage line', async () => {
  const b = box();
  try {
    const r = await install(b, { argv: ['--force'] });
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(USAGE));
  } finally {
    b.cleanup();
  }
});

test('entry: --help under this Node; an older Node gets the version message, not a SyntaxError', () => {
  let r = spawnSync(process.execPath, [ENTRY, '--help'], { encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr], [0, USAGE, '']);
  r = spawnSync(process.execPath, ['--import', 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"18.19.0"})', ENTRY, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'ux-assessment needs Node.js 20 or newer (found 18.19.0). Download it from https://nodejs.org/\n');
  const src = fs.readFileSync(ENTRY, 'utf8');
  assert.doesNotMatch(src, /\?\.|\?\?|^\s*import\s|^\s*await\s/m, 'conservative syntax: no optional chaining, nullish coalescing, static import or top-level await');
});

test('end to end: the real CLI with a temporary home links the skill (a real junction on Windows)', () => {
  const b = box();
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX_HOME|UXA_CODEX_BIN|HOME|USERPROFILE)$/i.test(key)));
    Object.assign(env, { HOME: b.home, USERPROFILE: b.home, UXA_CODEX_BIN: process.execPath });
    const r = spawnSync(process.execPath, [ENTRY, '--skip-deps', '--no-claude'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(fs.realpathSync(b.skill), SKILL);
  } finally {
    b.cleanup();
  }
});

test('scripts/install-macos.sh is a two-line stub that points to install.mjs and exits 1',
  { skip: process.platform === 'win32' && 'a bash script' }, () => {
    const stub = path.join(ROOT, 'scripts', 'install-macos.sh');
    assert.equal(fs.readFileSync(stub, 'utf8').trimEnd().split('\n').length, 2);
    const r = spawnSync('/bin/bash', [stub], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /use `node scripts\/install\.mjs`/);
  });
