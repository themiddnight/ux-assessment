// Codex feature gate (SPEC D25): disable Codex's own tools, and refuse a run when Codex enables a feature
// nobody has classified. Classified on codex-cli 0.155.0-alpha.9.2 and npm 0.158.0; confirmed by the canary self-check.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** Passed as `--disable <name>` whenever the current `features list` contains the name. */
export const DENY = Object.freeze([
  // the spike (SPIKE.md, "Codex tool-level isolation")
  'shell_tool', 'unified_exec', 'view_image', 'image_generation', 'browser_use', 'browser_use_external', 'computer_use',
  'in_app_browser', 'apps', 'plugins', 'tool_suggest', 'shell_snapshot', 'multi_agent', 'goals',
  // enabled on 0.155.0-alpha.9.2 but not disabled in the spike
  'browser_use_full_cdp_access', 'hooks', 'in_app_local_automation', 'skill_search', 'skill_mcp_dependency_install',
  'workspace_dependencies', 'worktrees', 'remote_plugin', 'plugin_sharing', 'unified_exec_tty', 'realtime_conversation',
  'unified_exec_zsh_fork', // removed but still true: a shell variant
  // new in npm 0.158.0 (canary 2026-09-28); `--disable` turns it off
  'daemon_auto_start', // a background daemon; a one-shot `exec` does not need it
]);

/** May stay on: required, or no capability the model can reach. Each entry says why. */
export const ALLOW = Object.freeze({
  code_mode_host: 'required: MCP tools are reachable only through code mode',
  auth_elicitation: 'MCP server sign-in prompts; the bridge needs no sign-in',
  tool_call_mcp_elicitation: 'MCP elicitation during a tool call; the bridge never elicits',
  compaction_image_budget: 'context compaction; no tool',
  content_item_kinds: 'message content types; no tool',
  enable_request_compression: 'compresses requests to the model API; no tool',
  unbounded_connection_retries: 'retries to the model API; no tool',
  fast_mode: 'service speed tier; no tool',
  guardian_approval: 'approval reviewer; the only approval preset is for the bridge',
  mentions_v2: '@-mentions in the composer UI; inert in exec',
  sleep_tool: 'waits; reaches no file, process or network',
  item_ids: 'event ids (removed); no tool',
  collaboration_modes: 'UI modes (removed); no tool',
  in_app_chat: 'app UI; inert in exec',
  in_app_dictation: 'app UI; inert in exec',
  in_app_updates: 'app UI; inert in exec',
  resize_all_images: 'image preprocessing (removed); no tool',
  sqlite: 'local state database (removed); no tool',
  steer: 'TUI input steering (removed); inert in exec',
  terminal_resize_reflow: 'TUI layout (removed); inert in exec',
  tool_search_always_defer_mcp_tools: 'how MCP tools are listed (removed); the bridge tools must stay reachable',
  tui_app_server: 'TUI (removed); inert in exec',
  // new in npm 0.158.0 (canary 2026-09-28)
  guardian_reuse_parent_compaction: 'guardian context compaction; no tool',
  system_proxy_fallback: 'uses the system proxy for model API traffic; no tool',
  write_stdin_approval: "approval for writing to an exec session's stdin; the exec tools are disabled",
  // new in npm 0.159.0 (Windows CI 2026-09-29): default on only on Windows (codex-rs/features: cfg!(windows))
  secret_auth_storage: 'where CLI auth is stored when keyring storage is selected; no tool',
});

export const REQUIRED = 'code_mode_host';

/** DENY features that `features list` still reports on after `--disable` (0.155: unified_exec). Tolerated only
 *  while the feature that carries their tool is present and off. The canary proves there is no shell. */
export const STICKY = Object.freeze({ unified_exec: 'shell_tool' });

export const MIN_ROWS = 20;

/** Passed to `features list` and to `exec`: web search reaches no localhost, but it can search the public web. */
export const CONFIG_OVERRIDES = Object.freeze(['-c', 'web_search="disabled"']);

// Single source for both the gate's env and the child persona's env (driver/codex-runner.mjs `buildChildEnv`),
// so there is one allowlist to review, not two that can drift apart.
export const CHILD_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'CODEX_HOME']);
/** Vars a win32 Codex process needs to start at all (profile dir, temp dir, executable resolution). */
export const WIN32_ENV_KEYS = Object.freeze(['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'LOCALAPPDATA']);
const GATE_ENV_KEYS = Object.freeze(['PATH', 'LANG', ...WIN32_ENV_KEYS]);

/** Case-insensitive pick: Windows stores `Path`, and a plain-object copy of `process.env` loses that. Result keys
 *  use the canonical casing from `keys`. */
export function pickEnv(env, keys) {
  const byLower = new Map(Object.keys(env).map((key) => [key.toLowerCase(), key]));
  const result = {};
  for (const key of keys) {
    const actual = byLower.get(key.toLowerCase());
    if (actual !== undefined && env[actual] !== undefined) result[key] = env[actual];
  }
  return result;
}

const ROW = /^(\S+)\s+(\S.*?)\s+(true|false)$/;

export function parseFeatures(text) {
  const rows = String(text).split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const m = ROW.exec(line.trim());
    if (!m) throw new Error(`cannot parse codex features list row: ${JSON.stringify(line.trim())}`);
    return { name: m[1], stage: m[2], enabled: m[3] === 'true' };
  });
  if (rows.length < MIN_ROWS) throw new Error(`codex features list gave ${rows.length} rows; expected at least ${MIN_ROWS}`);
  return rows;
}

export function parseVersion(text) {
  const m = /codex-cli\s+(\S+)/.exec(String(text));
  if (!m) throw new Error(`cannot read the Codex version from ${JSON.stringify(String(text).trim())}`);
  return m[1];
}

export function denyPresent(rows) {
  const names = new Set(rows.map((r) => r.name));
  return DENY.filter((name) => names.has(name));
}

/** Pass iff every enabled feature is ALLOW (or STICKY with its carrier off) and code_mode_host is enabled. Stage is ignored. */
export function evaluateGate(rows, { version = 'unknown' } = {}) {
  const state = new Map(rows.map((r) => [r.name, r.enabled]));
  const enabled = rows.filter((r) => r.enabled).map((r) => r.name);
  const problems = [];
  if (state.get(REQUIRED) !== true) problems.push(`Codex ${version} has ${REQUIRED} off; persona tools are reachable only through it`);
  for (const name of enabled) {
    if (Object.hasOwn(ALLOW, name)) continue;
    if (Object.hasOwn(STICKY, name) && state.get(STICKY[name]) === false) continue;
    problems.push(DENY.includes(name)
      ? `Codex ${version} keeps ${name} on after --disable ${name}`
      : `Codex ${version} enables ${name}, which ux-assessment has not classified. Update driver/codex-features.mjs after running self-check, or report it.`);
  }
  return { pass: problems.length === 0, enabled, problems };
}

export const featuresHash = (deny) => crypto.createHash('sha256').update([...deny].sort().join('\n')).digest('hex').slice(0, 16);

function execCodex(file, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) { resolve(String(stdout)); return; }
      const first = String(stderr ?? '').trim().split(/\r?\n/)[0] || error.message;
      reject(new Error(`${error.killed ? 'timed out' : `exit ${error.code}`}: ${first}`));
    });
  });
}

/** `features list` rejects --ignore-user-config, so it runs with an empty CODEX_HOME: the verdict is what `exec` gets. */
export async function runFeatureGate({ codex, run = execCodex, env = process.env, timeoutMs = 10000 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-codex-home-'));
  const gateEnv = pickEnv(env, GATE_ENV_KEYS);
  gateEnv.CODEX_HOME = home; // fresh and empty: never the user's, so a [features] entry in config.toml cannot decide the gate
  const call = async (args, what) => {
    try { return await run(codex, args, { env: gateEnv, timeoutMs }); }
    catch (error) { throw new Error(`codex ${what} failed: ${error.message}`); }
  };
  try {
    const version = parseVersion(await call(['--version'], '--version'));
    const deny = denyPresent(parseFeatures(await call(['features', 'list', ...CONFIG_OVERRIDES], 'features list')));
    const rows = parseFeatures(await call(['features', 'list', ...CONFIG_OVERRIDES, ...deny.flatMap((name) => ['--disable', name])], 'features list --disable'));
    return { version, deny, featuresHash: featuresHash(deny), ...evaluateGate(rows, { version }) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
