// Portable replacements for the shell commands the skills and agents used (SPEC D28):
//   node probe.mjs url <url>                    "<status> <final url>"; exit 1 when nothing answers in 5 s
//   node probe.mjs now                          UTC ISO time to the second (was `date -u +%Y-%m-%dT%H:%M:%SZ`)
//   node probe.mjs fetch <url> [--max-bytes N]  status line, blank line, text body cut at N bytes (default 200000)
//   node probe.mjs deps                         "ok", or the missing packages and the install.mjs --deps-only command (exit 1)
// No dependencies: the skills may call it before `npm ci` has run.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIMEOUT_MS = 5000;
export const DEFAULT_MAX_BYTES = 200000;
const USAGE = 'usage: node probe.mjs url <url> | now | fetch <url> [--max-bytes N] | deps\n';

const DRIVER_DIR = path.dirname(fileURLToPath(import.meta.url));

async function chromiumInstalled(driverDir) {
  try {
    const { chromium } = createRequire(path.join(driverDir, 'package.json'))('playwright');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** The driver's npm packages and Playwright's Chromium: what a marketplace install lacks until `install.mjs --deps-only`. */
export async function missingDeps({ driverDir = DRIVER_DIR, chromium = chromiumInstalled } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(driverDir, 'package.json'), 'utf8'));
  const missing = Object.keys(pkg.dependencies ?? {})
    .filter((name) => !fs.existsSync(path.join(driverDir, 'node_modules', name, 'package.json')));
  if (!missing.includes('playwright') && !(await chromium(driverDir))) missing.push('playwright chromium');
  return missing;
}

export function nowIso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`not a URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http and https URLs: ${raw}`);
  return url;
}

function unreachable(url, error, timeoutMs) {
  const reason = error.name === 'TimeoutError' || error.name === 'AbortError'
    ? `no answer in ${timeoutMs / 1000} s`
    : (error.cause?.code ?? error.cause?.errors?.[0]?.code ?? error.cause?.message ?? error.message);
  return new Error(`unreachable: ${url.href} (${reason})`);
}

export async function probeUrl(raw, { timeoutMs = TIMEOUT_MS } = {}) {
  const url = checkUrl(raw);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return { status: res.status, url: res.url };
  } catch (error) {
    throw unreachable(url, error, timeoutMs);
  }
}

export async function fetchText(raw, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  const url = checkUrl(raw);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const chunks = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        size += value.length;
      }
    }
    return { status: res.status, url: res.url, text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
  } catch (error) {
    throw unreachable(url, error, timeoutMs);
  }
}

function parseFetchArgs(rest) {
  if (rest.length === 1) return { url: rest[0], maxBytes: DEFAULT_MAX_BYTES };
  if (rest.length === 3 && rest[1] === '--max-bytes' && /^[1-9]\d*$/.test(rest[2])) return { url: rest[0], maxBytes: Number(rest[2]) };
  return null;
}

export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s),
  now = () => new Date(), timeoutMs = TIMEOUT_MS, deps = missingDeps } = {}) {
  const [command, ...rest] = argv;
  const fetchArgs = command === 'fetch' ? parseFetchArgs(rest) : null;
  const valid = (command === 'now' && rest.length === 0) || (command === 'url' && rest.length === 1) || (command === 'deps' && rest.length === 0) || fetchArgs;
  if (!valid) { err(USAGE); return 2; }
  try {
    if (command === 'now') out(`${nowIso(now())}\n`);
    if (command === 'url') {
      const r = await probeUrl(rest[0], { timeoutMs });
      out(`${r.status} ${r.url}\n`);
    }
    if (command === 'fetch') {
      const r = await fetchText(fetchArgs.url, { maxBytes: fetchArgs.maxBytes, timeoutMs });
      out(`${r.status} ${r.url}\n\n${r.text}\n${r.truncated ? `[probe: truncated at ${fetchArgs.maxBytes} bytes]\n` : ''}`);
    }
    if (command === 'deps') {
      const missing = await deps();
      if (missing.length) {
        err(`missing: ${missing.join(', ')}\nrun: node "${path.join(DRIVER_DIR, '..', 'scripts', 'install.mjs')}" --deps-only, then restart Claude Code or Codex\n`);
        return 1;
      }
      out('ok\n');
    }
    return 0;
  } catch (error) {
    err(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
