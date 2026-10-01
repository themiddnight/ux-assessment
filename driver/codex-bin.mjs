// Find the Codex CLI. Dependency-free: the installer (phase 2) needs it before `npm ci`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isExecutableFile(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Order: UXA_CODEX_BIN; on darwin the two ChatGPT bundles; PATH (win32: codex.exe only). Returns [codex, host?] as realpaths. */
export function resolveCodexExecutables(env = process.env, platform = process.platform, homedir = os.homedir(), applications = '/Applications') {
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const bundle = path.join('ChatGPT.app', 'Contents', 'Resources', 'codex');
  const candidates = env.UXA_CODEX_BIN
    ? [env.UXA_CODEX_BIN]
    : [...(platform === 'darwin' ? [path.join(applications, bundle), path.join(homedir, 'Applications', bundle)] : []),
        ...dirs.map((dir) => path.join(dir, exe))];
  const binary = candidates.find((candidate) => isExecutableFile(candidate, platform));
  if (!binary) {
    if (env.UXA_CODEX_BIN) throw new Error(`UXA_CODEX_BIN is not an executable file: ${env.UXA_CODEX_BIN}`);
    if (platform === 'win32') {
      const shim = dirs.flatMap((dir) => ['codex.cmd', 'codex.ps1'].map((name) => path.join(dir, name))).find((file) => fs.existsSync(file));
      if (shim) throw new Error(`found the npm shim at ${shim}; set UXA_CODEX_BIN to the codex.exe it wraps`);
    }
    throw new Error(platform === 'darwin'
      ? 'Codex CLI not found; install ChatGPT for macOS or put codex on PATH (or set UXA_CODEX_BIN)'
      : `Codex CLI not found; put ${exe} on PATH or set UXA_CODEX_BIN`);
  }
  const resolved = fs.realpathSync(binary);
  // A shim (codex.cmd/.bat/.ps1) cannot be spawned without a shell; catch it even when given explicitly via UXA_CODEX_BIN.
  if (platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(resolved)) throw new Error(`found the npm shim at ${resolved}; set UXA_CODEX_BIN to the codex.exe it wraps`);
  // The npm `codex` is a Node launcher: sandbox-exec would block its interpreter, and the host is not next to it.
  if (/\.[cm]?js$/i.test(resolved)) throw new Error(`found the npm launcher at ${resolved}; set UXA_CODEX_BIN to the native codex binary it wraps`);
  const host = path.join(path.dirname(resolved), platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host');
  return isExecutableFile(host, platform) ? [resolved, fs.realpathSync(host)] : [resolved];
}
