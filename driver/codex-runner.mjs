#!/usr/bin/env node
// Run one persona or verifier in a separate Codex CLI process. The parent keeps all other harness access.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session } from './session.mjs';
import { ROLES, checkRole, startPersonaBridge } from './persona-bridge.mjs';
import { CONFIG_OVERRIDES, REQUIRED, runFeatureGate, CHILD_ENV_KEYS, WIN32_ENV_KEYS, pickEnv } from './codex-features.mjs';
import { resolveCodexExecutables } from './codex-bin.mjs';
import { jsonLines, newNonce, countActs, countWebSearches, judgeSelfCheck, recordPath, writeRecord, selfCheckPrompt, requireSelfCheck } from './codex-self-check.mjs';
import { isInside, stderrLine, warnOutsideProfile } from './paths.mjs';
import { EFFORTS, checkModelChoice, readModelsConfig, resolveModel, cheapWarning } from './models.mjs';
import { codexRecord, appendUsage, runOf } from './usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const AGENTS = Object.fromEntries(ROLES.map((role) => [role, path.join(PLUGIN, 'agents', `${role}.md`)]));
const MAX_IMAGES = 6;
export { EFFORTS, checkModelChoice }; // moved to driver/models.mjs (SPEC D30); re-exported for existing callers
const privateWrite = (file, value) => fs.writeFileSync(file, value, { mode: 0o600 });

function safePath(value) {
  const absolute = path.resolve(value);
  if (/[\n\r\0]/.test(absolute)) throw new Error('Paths cannot contain control characters');
  return absolute;
}

export function buildCodexArgs({ platform = process.platform, osSandbox = platform === 'darwin', profile = null, codex, temp, bridgeUrl,
  outputFile, model = null, effort = null, images = [], deny = [] }) {
  if (deny.includes(REQUIRED)) throw new Error(`${REQUIRED} must stay on: persona tools are reachable only through code mode`);
  if (osSandbox && platform !== 'darwin') throw new Error('sandbox-exec exists only on macOS');
  if (osSandbox && !profile) throw new Error('the macOS sandbox needs a profile');
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', temp,
    ...CONFIG_OVERRIDES,
    '-c', `mcp_servers.ux_persona.url=${JSON.stringify(bridgeUrl)}`,
    '-c', 'mcp_servers.ux_persona.default_tools_approval_mode="approve"'];
  for (const name of deny) args.push('--disable', name);
  // `--image <FILE>...` is variadic: always follow the last image with another flag, never with the stdin `-`.
  for (const image of images) args.push('--image', image);
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  args.push('--output-last-message', outputFile, '-');
  return osSandbox ? ['-p', profile, codex, ...args] : args;
}

export const codexCommand = ({ codex, osSandbox }) => (osSandbox ? '/usr/bin/sandbox-exec' : codex);

const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];

/**
 * The last `turn.completed` usage in the `--json` event stream, raw keys; null when there is none (never 0).
 * `codex exec` reports the thread total (codex-rs `usage_from_last_total`), so adding events would double count.
 * input_tokens includes cached tokens; reasoning_output_tokens is part of output_tokens.
 */
export function lastUsage(text) {
  let usage = null;
  for (const event of jsonLines(text)) {
    if (event?.type !== 'turn.completed' || !event.usage) continue;
    usage = Object.fromEntries(USAGE_KEYS.map((key) => [key, Number(event.usage[key] ?? 0) || 0]));
  }
  return usage;
}

/** Copy evidence into the runner temp dir: the sandbox denies reads of the project tree, also to codex itself. */
export function stageImages(images, projectRoot, temp) {
  if (!Array.isArray(images)) throw new Error('images must be a list of paths');
  const allowed = path.join(fs.realpathSync(projectRoot), '.ux-assessment');
  const dir = path.join(temp, 'evidence');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staged = [];
  const skipped = [];
  for (const image of images) {
    if (typeof image !== 'string' || !image) { skipped.push({ image, reason: 'not a path' }); continue; }
    const absolute = safePath(image);
    if (!fs.existsSync(absolute)) { skipped.push({ image, reason: 'missing' }); continue; }
    const real = fs.realpathSync(absolute);
    if (!isInside(allowed, real)) { skipped.push({ image, reason: 'outside .ux-assessment' }); continue; }
    if (!/\.png$/i.test(real)) { skipped.push({ image, reason: 'not a png' }); continue; }
    // A directory would abort the copy and a FIFO would block it forever.
    if (!fs.statSync(real).isFile()) { skipped.push({ image, reason: 'not a file' }); continue; }
    if (staged.length >= MAX_IMAGES) { skipped.push({ image, reason: `more than ${MAX_IMAGES} images` }); continue; }
    const target = path.join(dir, `${String(staged.length + 1).padStart(2, '0')}.png`);
    fs.copyFileSync(real, target);
    staged.push(target);
  }
  return { staged, skipped };
}

export function buildPrompt(role, briefing, imageCount) {
  const body = fs.readFileSync(AGENTS[checkRole(role)], 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  if (role === 'persona') return `${body}\n\n## Your briefing\n\n${briefing}\n`;
  const images = imageCount
    ? `The ${imageCount} earlier evidence screenshot(s) are attached to this message, in the order the brief lists them.`
    : 'No earlier screenshots are available; work from the text.';
  return `${body}\n\n## Your finding\n\n${briefing}\n\n${images}\n`;
}

export { resolveCodexExecutables };

export function sandboxProfile({ projectRoot, bridgePort, executables = resolveCodexExecutables() }) {
  // An empty list would render `(allow process-exec )`, which allows every exec: fail closed instead.
  if (!executables.length) throw new Error('the macOS sandbox needs at least one executable');
  const roots = [projectRoot, PLUGIN, path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.agents')]
    .filter((p) => fs.existsSync(p))
    .map((p) => `(subpath ${JSON.stringify(fs.realpathSync(safePath(p)))})`).join(' ');
  return `(version 1)\n(allow default)\n(deny file-read* ${roots})\n` +
    `(deny process-exec)\n(allow process-exec ${executables.map((p) => `(literal ${JSON.stringify(p)})`).join(' ')})\n` +
    `(deny network-outbound (remote tcp "localhost:*"))\n` +
    `(allow network-outbound (remote tcp "localhost:${bridgePort}"))\n`;
}

export function validateStorageOrigin(storageState, url) {
  if (!storageState) return;
  const state = JSON.parse(fs.readFileSync(storageState, 'utf8'));
  const origins = (state.origins ?? []).map((entry) => entry.origin);
  if (origins.length && !origins.includes(new URL(url).origin)) {
    throw new Error(`storageState origin does not match entry URL origin (${new URL(url).origin}); use the same host and port used at login`);
  }
}

function waitFor(child, timeoutMs, platform) {
  return new Promise((resolveWait, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, { platform }); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveWait({ code, signal, timedOut }); });
  });
}

/** Allowlisted environment; the home is the temp dir so no personal skills or shell configuration reach a persona. */
export function buildChildEnv({ env = process.env, platform = process.platform, temp, homedir = os.homedir() }) {
  const keys = platform === 'win32' ? [...CHILD_ENV_KEYS, ...WIN32_ENV_KEYS] : CHILD_ENV_KEYS;
  const childEnv = pickEnv(env, keys);
  childEnv.HOME = temp;
  if (platform === 'win32') childEnv.USERPROFILE = temp;
  childEnv.CODEX_HOME = env.CODEX_HOME ?? path.join(homedir, '.codex'); // retain CLI sign-in
  return childEnv;
}

/** POSIX: SIGTERM, then SIGKILL after 5 s. win32: taskkill the tree, since a plain kill orphans the code-mode host. */
export function killTree(child, { platform = process.platform, run = execFile, later = (fn, ms) => setTimeout(fn, ms).unref() } = {}) {
  if (platform === 'win32') {
    // If taskkill itself fails (missing PATH entry, permission, already-gone PID), fall back to a plain kill
    // so the child is not left running with waitFor never settling.
    run('taskkill', ['/PID', String(child.pid), '/T', '/F'], (error) => { if (error) child.kill(); });
    return;
  }
  child.kill('SIGTERM');
  later(() => child.kill('SIGKILL'), 5000);
}

/** One isolated Codex run: gate, browser, bridge, `codex exec`. A gate refusal throws before anything starts. */
export async function runIsolated({ role, prompt, projectRoot, session: sessionOpts, images = [], model = null, effort = null,
  timeoutMs = 480000, platform = process.platform, toolsOnly = false, plant = null, env = process.env, requireRecord = true,
  resolve = () => resolveCodexExecutables(env, platform), gate = (opts) => runFeatureGate({ ...opts, env }),
  homedir = os.homedir(), warn = stderrLine }) {
  checkModelChoice({ model, effort });
  warnOutsideProfile({ root: projectRoot, platform, homedir, warn });
  const [codex, ...companions] = resolve();
  const verdict = await gate({ codex });
  if (!verdict.pass) throw new Error(verdict.problems.join('; ')); // one stderr line
  const selfCheck = requireRecord
    ? requireSelfCheck({ platform, env, projectRoot, codex_version: verdict.version, features_hash: verdict.featuresHash })
    : 'running';
  if (selfCheck === 'skipped') warn('UXA_CODEX_SELF_CHECK=skip: running without a self-check record (CI only)');
  const osSandbox = platform === 'darwin' && !toolsOnly;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-codex-'));
  fs.chmodSync(temp, 0o700);
  const outputFile = path.join(temp, 'last-message.txt');
  const cliLog = path.join(sessionOpts.dir, 'codex-cli.log');
  let session, bridge;
  try {
    plant?.(temp);
    session = await Session.start({ ...sessionOpts, platform, homedir, warn });
    bridge = await startPersonaBridge(session, { role });
    const profile = osSandbox ? sandboxProfile({ projectRoot, bridgePort: bridge.port, executables: [codex, ...companions] }) : null;
    if (profile) privateWrite(path.join(temp, 'sandbox.sb'), profile);
    privateWrite(outputFile, '');
    const { staged, skipped } = role === 'verifier' ? stageImages(images, projectRoot, temp) : { staged: [], skipped: [] };
    const args = buildCodexArgs({ platform, osSandbox, profile, codex, temp, bridgeUrl: bridge.url, outputFile, model, effort,
      images: staged, deny: verdict.deny });
    const childEnv = buildChildEnv({ env, platform, temp });
    const child = spawn(codexCommand({ codex, osSandbox }), args, { cwd: temp, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const logFd = fs.openSync(cliLog, 'w', 0o600);
    fs.fchmodSync(logFd, 0o600);
    const log = fs.createWriteStream(null, { fd: logFd, autoClose: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.stdin.end(prompt({ temp, imageCount: staged.length }));
    const cli = await waitFor(child, timeoutMs, platform);
    log.end();
    await new Promise((resolveFinish) => log.once('finish', resolveFinish));
    const summary = fs.readFileSync(outputFile, 'utf8').trim();
    const cliText = fs.readFileSync(cliLog, 'utf8');
    const signals = await session.signals();
    return {
      cli: { ...cli, model, effort }, summary, signals, log: cliLog, images_skipped: skipped,
      codex_version: verdict.version, isolation: osSandbox ? 'sandbox+tools' : 'tools', features_hash: verdict.featuresHash,
      usage: lastUsage(cliText), self_check: selfCheck,
    };
  } finally {
    await bridge?.close();
    await session?.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function runCodexPersona(job, { platform = process.platform, env = process.env, resolve, gate, warn } = {}) {
  const role = checkRole(job.role ?? 'persona');
  if (role === 'persona' && job.images?.length) throw new Error('only a verifier gets evidence images; a persona sees the app only');
  if (job.images != null && !Array.isArray(job.images)) throw new Error('images must be a list of paths');
  if (typeof job.briefing !== 'string' || !job.briefing.trim()) throw new Error('briefing is required');
  const jobChoice = checkModelChoice({ model: job.model, effort: job.effort });
  const projectRoot = safePath(job.projectRoot);
  const sessionOpts = { ...job.session, dir: safePath(job.session.dir) };
  if (!isInside(path.join(projectRoot, '.ux-assessment'), sessionOpts.dir)) throw new Error('session dir must be under project .ux-assessment');
  // job > config.yaml models.codex.<role> > default, field by field (SPEC D30). An invalid config errors before spawn.
  const { model, effort } = resolveModel({ harness: 'codex', role, config: readModelsConfig(projectRoot), job: jobChoice });
  const cheap = cheapWarning({ harness: 'codex', role, model, effort });
  if (cheap) (warn ?? stderrLine)(cheap);
  const target = new URL(sessionOpts.url);
  if (!['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('Codex persona runner currently supports local app URLs');
  validateStorageOrigin(sessionOpts.storageState, sessionOpts.url);
  const result = await runIsolated({
    role, projectRoot, session: sessionOpts, images: job.images ?? [], model, effort, timeoutMs: job.timeoutMs ?? 480000, platform, env,
    prompt: ({ imageCount }) => buildPrompt(role, job.briefing, imageCount),
    ...(resolve ? { resolve } : {}), ...(gate ? { gate } : {}), ...(warn ? { warn } : {}),
  });
  recordCodexUsage({ projectRoot, sessionDir: sessionOpts.dir, role, id: sessionOpts.id ?? null, model, usage: result.usage, warn: warn ?? stderrLine });
  return result;
}

/** One usage.jsonl line per Codex process (SPEC D31). A failed write costs the record, never the run's result. */
function recordCodexUsage({ projectRoot, sessionDir, role, id, model, usage, warn }) {
  const record = codexRecord(usage, { role, id, model, run: runOf(projectRoot, sessionDir) });
  if (!record) return;
  try {
    appendUsage(projectRoot, [record]);
  } catch (error) {
    warn(`warning: tokens not recorded in .ux-assessment/usage.jsonl (${error.message.split('\n')[0]})`);
  }
}

const SELF_CHECK_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ux-assessment self-check</title></head>'
  + '<body><h1>ux-assessment self-check</h1><p>This page only proves that the persona tools work.</p><button type="button">Continue</button></body></html>';

function listen(handler) {
  return new Promise((resolveListen, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen({
      port: server.address().port,
      close: () => { server.closeAllConnections(); return new Promise((done) => server.close(done)); },
    }));
  });
}

export function parseSelfCheckArgs(argv) {
  const opts = { offline: false, json: false, toolsOnly: false, keep: false, projectRoot: null, model: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') opts.offline = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--tools-only') opts.toolsOnly = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--project') {
      if (!argv[i + 1]) throw new Error('--project needs a path');
      if (argv[i + 1].startsWith('--')) throw new Error(`--project needs a path, not the option ${JSON.stringify(argv[i + 1])}`);
      opts.projectRoot = safePath(argv[++i]);
    } else if (arg === '--model') {
      if (argv[i + 1]?.startsWith('--')) throw new Error(`--model needs a model name, not the option ${JSON.stringify(argv[i + 1])}`);
      opts.model = checkModelChoice({ model: argv[++i] ?? '' }).model;
    } else {
      throw new Error(`unknown self-check option ${JSON.stringify(arg)}; use --offline, --json, --tools-only, --keep, --project <root>, --model <model>`);
    }
  }
  return opts;
}

const printChecks = (checks, passed, out) => {
  for (const check of checks) out(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  out(passed ? 'PASS' : 'FAIL');
};

/** SPEC D26. Offline: discovery and the gate only. Full: three canaries, one real persona run, the PASS rule, a record. */
export async function runSelfCheck({ offline = false, projectRoot = null, toolsOnly = false, keep = false, model = null,
  platform = process.platform, env = process.env, out = (line) => process.stdout.write(`${line}\n`),
  resolve = () => resolveCodexExecutables(env, platform), gate = (opts) => runFeatureGate({ ...opts, env }), timeoutMs = 300000,
  attempt = selfCheckAttempt } = {}) {
  const executables = resolve();
  const verdict = await gate({ codex: executables[0] });
  out(`Codex ${verdict.version} (${executables[0]})`);
  out(`DENY passed (${verdict.deny.length}): ${verdict.deny.join(' ')}`);
  out(`Enabled (${verdict.enabled.length}): ${verdict.enabled.join(' ')}`);
  const isolation = platform === 'darwin' && !toolsOnly ? 'sandbox+tools' : 'tools';
  const base = { codex_version: verdict.version, features_hash: verdict.featuresHash, platform, isolation, deny: verdict.deny, enabled: verdict.enabled };
  if (offline || !verdict.pass) {
    const checks = verdict.pass
      ? [{ name: 'feature-gate', ok: true, detail: 'every enabled feature is classified' }]
      : verdict.problems.map((problem) => ({ name: 'feature-gate', ok: false, detail: problem }));
    printChecks(checks, verdict.pass, out);
    const record = offline ? null : recordPath(projectRoot);
    if (record) writeRecord(record, { codex_version: verdict.version, features_hash: verdict.featuresHash, platform, isolation, passed: false, at: new Date().toISOString() });
    return { ...base, passed: verdict.pass, checks, record, evidence: null, first_evidence: null, usage: null };
  }

  // Role `self-check`: gpt-6-sol at low effort. `--model` replaces the model; the effort stays the role's.
  const choice = resolveModel({ harness: 'codex', role: 'self-check', job: { model } });
  const attemptOpts = { executables, verdict, model: choice.model, effort: choice.effort, toolsOnly, platform, env, timeoutMs };
  const judge = (run) => {
    const judged = judgeSelfCheck({ nonces: run.nonces, texts: run.texts, httpRequests: run.httpRequests, acts: run.acts,
      ended: run.ended, webSearches: run.webSearches, gatePassed: true });
    if (run.failure) judged.checks.push({ name: 'runner', ok: false, detail: run.failure.message.split('\n')[0] });
    return { checks: judged.checks, passed: judged.passed && !run.failure };
  };
  const evidenceOf = (run) => (run.dir && fs.existsSync(run.dir) ? run.dir : run.scratch);
  let run = await attempt(attemptOpts);
  let judged = judge(run);
  let firstEvidence = null;
  // At low effort the model sometimes stops before the tool steps. Retry once, only for that pure miss: no runner
  // error, no act call, and every other check passed. The retry has fresh nonces and is judged on all five checks.
  if (!run.failure && run.acts === 0 && judged.checks.every((check) => check.ok || check.name === 'mcp-tools')) {
    firstEvidence = evidenceOf(run);
    out(`retrying: the model did not call act (first attempt evidence: ${firstEvidence})`);
    run = await attempt(attemptOpts);
    judged = judge(run);
  }
  const { checks, passed } = judged;
  printChecks(checks, passed, out);
  const record = recordPath(projectRoot);
  writeRecord(record, { codex_version: verdict.version, features_hash: verdict.featuresHash, platform, isolation, passed, at: new Date().toISOString() });
  out(`Record: ${record}`);
  const kept = !passed || keep;
  const evidence = kept ? evidenceOf(run) : null;
  if (kept) out(`Evidence: ${evidence}`);
  else if (run.scratch) fs.rmSync(run.scratch, { recursive: true, force: true });
  return { ...base, passed, checks, record, evidence, first_evidence: firstEvidence, usage: run.usage ?? null };
}

/** One full self-check attempt: fresh nonces, canaries and scratch project, one real persona run. Returns what the PASS rule judges. */
async function selfCheckAttempt({ executables, verdict, model, effort, toolsOnly, platform, env, timeoutMs }) {
  const nonces = [newNonce(), newNonce(), newNonce()];
  let httpRequests = 0;
  let canary, page, scratch = null, dir = null;
  let result = null;
  let failure = null;
  try {
    canary = await listen((req, res) => { httpRequests += 1; res.writeHead(200, { 'content-type': 'text/plain' }).end(nonces[2]); });
    page = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SELF_CHECK_PAGE); });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-selfcheck-project-'));
    const secretFile = path.join(scratch, 'SECRET.txt');
    fs.writeFileSync(secretFile, `${nonces[1]}\n`, { mode: 0o600 });
    dir = path.join(scratch, '.ux-assessment', 'self-check');
    try {
      result = await runIsolated({
        role: 'persona', projectRoot: scratch, model, effort, timeoutMs, platform, toolsOnly, env, requireRecord: false,
        session: { id: 'selfcheck', dir, url: `http://127.0.0.1:${page.port}/`, viewport: 'desktop', cap: 5 },
        plant: (temp) => fs.writeFileSync(path.join(temp, 'canary.txt'), `${nonces[0]}\n`, { mode: 0o600 }),
        prompt: ({ temp }) => selfCheckPrompt({ sessionId: 'selfcheck', cwdCanary: path.join(temp, 'canary.txt'), secretFile, canaryUrl: `http://127.0.0.1:${canary.port}/` }),
        resolve: () => executables, gate: async () => verdict,
      });
    } catch (error) {
      failure = error;
    }
  } finally {
    // Close both servers even when setup throws: an open server keeps the CLI from ever exiting.
    await canary?.close();
    await page?.close();
  }
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const cliText = read(path.join(dir, 'codex-cli.log'));
  const stepLog = read(path.join(dir, 'log.jsonl'));
  return { nonces, texts: [result?.summary, cliText, stepLog], httpRequests, acts: countActs(stepLog), ended: result?.signals?.ended === true,
    webSearches: countWebSearches(cliText), failure, dir, scratch, usage: result?.usage ?? null };
}

const RESULT_KEYS = ['cli', 'signals', 'images_skipped', 'codex_version', 'isolation', 'features_hash', 'usage', 'self_check'];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'self-check') {
      const opts = parseSelfCheckArgs(process.argv.slice(3));
      const result = await runSelfCheck({ ...opts, out: opts.json ? () => {} : undefined });
      if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.passed ? 0 : 1;
    } else {
      const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
      const result = await runCodexPersona(job);
      const record = Object.fromEntries(RESULT_KEYS.map((key) => [key, result[key] ?? null]));
      privateWrite(path.join(job.session.dir, 'summary.md'), result.summary + '\n');
      privateWrite(path.join(job.session.dir, 'codex-result.json'), JSON.stringify(record, null, 2) + '\n');
      process.stdout.write(JSON.stringify({ ...record, summaryFile: path.join(job.session.dir, 'summary.md') }) + '\n');
      if (result.cli.code !== 0 || !result.signals.ended) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message.split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}
