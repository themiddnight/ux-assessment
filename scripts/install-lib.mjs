// The installer's work (SPEC D27). scripts/install.mjs checks the Node version first, then calls main().
// Dependency-free (it runs before `npm ci`). env, platform, home, spawning and output are injected so the
// tests run every OS branch on any host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isExecutableFile, resolveCodexExecutables } from '../driver/codex-bin.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXIT = Object.freeze({ ok: 0, missing: 1, conflict: 2 });
export const USAGE = 'usage: node scripts/install.mjs [--no-claude] [--no-codex] [--skip-deps] [--deps-only]';
export const PLUGIN_ID = 'ux-assessment@ux-assessment';
const FLAGS = new Set(['--no-claude', '--no-codex', '--skip-deps', '--deps-only']);

export function parseInstallArgs(argv) {
  const seen = new Set();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!FLAGS.has(arg)) throw new Error(`unknown option ${arg}\n${USAGE}`);
    seen.add(arg);
  }
  const opts = { claude: !seen.has('--no-claude'), codex: !seen.has('--no-codex'), deps: !seen.has('--skip-deps'), depsOnly: seen.has('--deps-only') };
  if (opts.depsOnly && !opts.deps) throw new Error(`--deps-only and --skip-deps together leave nothing to do\n${USAGE}`);
  if (!opts.depsOnly && !opts.claude && !opts.codex) throw new Error(`--no-claude and --no-codex together leave nothing to install\n${USAGE}`);
  return opts;
}

/** Env lookup that is case-insensitive on win32, where `Path` and `PATH` are one variable. */
export function envGet(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** First executable among `names` in the PATH directories, in PATH order (per directory, `names` order). */
function onPath(names, env, platform) {
  const dirs = (envGet(env, 'PATH', platform) ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutableFile(file, platform)) return file;
    }
  }
  return null;
}

/** 'native' when claude can be spawned without a shell; 'shim' for a win32 npm shim (claude.cmd/.ps1); null when absent. */
export function findClaude(env, platform) {
  if (platform !== 'win32') {
    const file = onPath(['claude'], env, platform);
    return file ? { kind: 'native', file } : null;
  }
  const exe = onPath(['claude.exe'], env, platform);
  if (exe) return { kind: 'native', file: exe };
  const shim = onPath(['claude.cmd', 'claude.ps1'], env, platform);
  return shim ? { kind: 'shim', file: shim } : null;
}

/** Codex counts as present when codex-bin.mjs finds it; an npm shim or launcher also counts, with a note for the runner. */
export function detectCodex({ env, platform, homedir, applications }) {
  try {
    resolveCodexExecutables(env, platform, homedir, applications);
    return { found: true, note: null };
  } catch (error) {
    return { found: /found the npm (shim|launcher)/.test(error.message), note: error.message };
  }
}

const samePath = (a, b, platform) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** ~/.codex/skills/ux-assessment (or $CODEX_HOME/skills/…) → <root>/skills/ux-assessment: a junction on win32, a symlink elsewhere. */
export function linkCodexSkill({ root, env, homedir, platform }) {
  const codexHome = envGet(env, 'CODEX_HOME', platform) || path.join(homedir, '.codex');
  const target = path.join(codexHome, 'skills', 'ux-assessment');
  const source = path.join(root, 'skills', 'ux-assessment');
  let entry = null;
  try {
    entry = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (entry) {
    let real = null;
    try { real = fs.realpathSync(target); } catch { /* a dangling link: the checkout moved */ }
    if (real && samePath(real, fs.realpathSync(source), platform)) return { status: 'kept', target, source };
    return {
      status: 'conflict', target, source,
      message: real
        ? `${target} already exists and resolves to ${real}; remove or relocate it, then rerun`
        : `${target} is a link to a folder that no longer exists (a moved checkout?); remove it, then rerun`,
    };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, platform === 'win32' ? 'junction' : 'dir'); // a junction needs no admin rights or Developer Mode
  return { status: 'created', target, source };
}

/** spawnSync without a shell; with `shell: true` only one fixed command string (no args: DEP0190, and no quoting risk). */
export function defaultRun(cmd, args = [], { cwd, shell = false, inherit = false } = {}) {
  if (shell && args.length) throw new Error('a shell command must be one fixed command string with no arguments');
  const options = { cwd, shell, windowsHide: true, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] };
  const r = shell ? spawnSync(cmd, options) : spawnSync(cmd, args, options);
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
}

export function installDeps({ root, platform, run, execPath = process.execPath, out }) {
  const driver = path.join(root, 'driver');
  out(`Installing the driver dependencies in ${driver} (npm ci, then Playwright Chromium)…`);
  // win32: npm is npm.cmd, which Node spawns only through a shell. The string is fixed; no user input reaches it.
  const npm = platform === 'win32'
    ? run('npm.cmd ci', [], { cwd: driver, shell: true, inherit: true })
    : run('npm', ['ci'], { cwd: driver, inherit: true });
  // With inherited stdio, stderr holds only a spawn error (e.g. "spawnSync npm ENOENT" when npm is missing), which printed nothing above.
  if (npm.status !== 0) return { ok: false, message: `npm ci failed in ${driver}${npm.stderr ? ` (${npm.stderr.trim()})` : ''}; fix the error above, then rerun` };
  const cli = path.join(driver, 'node_modules', 'playwright', 'cli.js');
  const chromium = run(execPath, [cli, 'install', 'chromium'], { cwd: driver, inherit: true });
  if (chromium.status !== 0) {
    return { ok: false, message: platform === 'linux'
      ? `Playwright could not install Chromium. Linux may lack its system libraries: run \`npx playwright install-deps chromium\` in ${driver} (needs sudo), then rerun`
      : 'Playwright could not install Chromium; fix the error above, then rerun' };
  }
  return { ok: true };
}

export function claudeCommands(root) {
  return [`claude plugin marketplace add "${root}"`, `claude plugin install ${PLUGIN_ID}`];
}

function listJson(run, file, args) {
  const r = run(file, args);
  if (r.status !== 0) return null;
  try {
    const value = JSON.parse(r.stdout);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const firstLine = (r) => (r.stderr || r.stdout || `exit ${r.status}`).trim().split(/\r?\n/)[0];

/** Whether a listed marketplace is this checkout: true / false, or null when the entry names no location. */
export function marketplacePointsTo(entry, root, platform) {
  const places = [entry.path, entry.installLocation, entry.source && typeof entry.source === 'object' ? entry.source.path : null]
    .filter((value) => typeof value === 'string' && value !== '');
  if (!places.length) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const mine = real(root);
  return places.some((p) => { const r = real(p); return r !== null && mine !== null && samePath(r, mine, platform); });
}

/**
 * Runs `claude plugin …` with an argument array and no shell, skipping the steps already done.
 * Fails closed: a marketplace named ux-assessment that is not provably this checkout (elsewhere, or no location) is never replaced.
 */
export function installClaude({ root, claude, run, platform }) {
  if (claude.kind !== 'native') return { status: 'manual', reason: `${claude.file} cannot be started without a shell` };
  const markets = listJson(run, claude.file, ['plugin', 'marketplace', 'list', '--json']);
  if (!markets) return { status: 'failed', reason: '`claude plugin marketplace list --json` failed' };
  const entry = markets.find((m) => m && m.name === 'ux-assessment');
  if (entry && marketplacePointsTo(entry, root, platform) !== true) {
    return { status: 'conflict', reason: 'a marketplace named ux-assessment already exists and is not this checkout; remove it with `claude plugin marketplace remove ux-assessment`, then rerun' };
  }
  let changed = false;
  if (!entry) {
    const r = run(claude.file, ['plugin', 'marketplace', 'add', root]);
    if (r.status !== 0) return { status: 'failed', reason: `\`claude plugin marketplace add\` failed (${firstLine(r)})` };
    changed = true;
  }
  const plugins = listJson(run, claude.file, ['plugin', 'list', '--json']);
  if (!plugins) return { status: 'failed', reason: '`claude plugin list --json` failed' };
  // `claude plugin install` defaults to user scope; a project-scoped install from another project does not load here.
  const mine = plugins.find((p) => p && p.id === PLUGIN_ID && (p.scope ?? 'user') === 'user');
  if (mine && mine.enabled === false) return { status: 'disabled' };
  if (!mine) {
    const r = run(claude.file, ['plugin', 'install', PLUGIN_ID]);
    if (r.status !== 0) return { status: 'failed', reason: `\`claude plugin install\` failed (${firstLine(r)})` };
    changed = true;
  }
  return { status: changed ? 'installed' : 'kept' };
}

// claudeCommands() is quoted for display only; it is never executed.
function claudeStep({ root, claude, run, platform, out, err }) {
  const result = installClaude({ root, claude, run, platform });
  if (result.status === 'installed' || result.status === 'kept') {
    out(`Claude Code: plugin ${PLUGIN_ID} ${result.status === 'installed' ? 'installed' : 'already installed'} from ${root}`);
    return EXIT.ok;
  }
  if (result.status === 'disabled') {
    out(`Claude Code: plugin ${PLUGIN_ID} is installed but disabled; run \`claude plugin enable ${PLUGIN_ID}\` to load it`);
    return EXIT.ok;
  }
  if (result.status === 'conflict') {
    err(`Claude Code: ${result.reason}`);
    return EXIT.conflict;
  }
  (result.status === 'failed' ? err : out)(`Claude Code: ${result.reason}; run these to install the plugin:`);
  for (const command of claudeCommands(root)) out(`  ${command}`);
  return result.status === 'failed' ? EXIT.missing : EXIT.ok;
}

function codexStep({ root, env, homedir, platform, codex, out, err }) {
  const link = linkCodexSkill({ root, env, homedir, platform });
  if (link.status === 'conflict') {
    err(`Codex: ${link.message}`);
    return EXIT.conflict;
  }
  out(`Codex: skill ${link.status === 'created' ? 'linked' : 'already linked'} at ${link.target} -> ${link.source}`);
  if (codex.note) out(`Codex: ${codex.note}`);
  if (platform !== 'darwin') {
    out(`Codex on ${platform === 'win32' ? 'Windows' : 'Linux'} is experimental: run \`node "${path.join(root, 'driver', 'codex-runner.mjs')}" self-check\` once now and after every Codex update.`);
  }
  out('Codex: restart Codex and sign in to it before running an assessment.');
  return EXIT.ok;
}

export async function main({ argv = process.argv.slice(2), env = process.env, platform = process.platform, homedir = os.homedir(),
  root = ROOT, applications = '/Applications', run = defaultRun, execPath = process.execPath,
  out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  let opts;
  try {
    opts = parseInstallArgs(argv);
  } catch (error) {
    err(error.message);
    return EXIT.missing;
  }
  if (opts.help) {
    out(USAGE);
    return EXIT.ok;
  }
  if (opts.depsOnly) {
    const deps = installDeps({ root, platform, run, execPath, out });
    if (!deps.ok) { err(deps.message); return EXIT.missing; }
    out(`Driver dependencies installed in ${path.join(root, 'driver')}.`);
    return EXIT.ok;
  }
  const claude = opts.claude ? findClaude(env, platform) : null;
  const codex = opts.codex ? detectCodex({ env, platform, homedir, applications }) : { found: false, note: null };
  if (!claude && !codex.found) {
    const why = [opts.claude ? 'no `claude` on PATH' : null, opts.codex ? codex.note : null].filter(Boolean).join('; ');
    err(`Install Claude Code or Codex first: ${why}`);
    return EXIT.missing;
  }
  if (opts.claude && !claude) out('Claude Code: skipped (no `claude` on PATH).');
  if (opts.codex && !codex.found) out(`Codex: skipped (${codex.note}).`);
  if (opts.deps) {
    const deps = installDeps({ root, platform, run, execPath, out });
    if (!deps.ok) { err(deps.message); return EXIT.missing; }
  }
  let code = EXIT.ok;
  if (claude) {
    code = Math.max(code, claudeStep({ root, claude, run, platform, out, err }));
    out(`Claude Code: or, without installing, start it with claude --plugin-dir "${root}"`);
    out('Claude Code: sign in with `claude auth login` if you have not.');
  }
  if (codex.found) code = Math.max(code, codexStep({ root, env, homedir, platform, codex, out, err }));
  return code;
}
