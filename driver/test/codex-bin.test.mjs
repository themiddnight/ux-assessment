import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexExecutables } from '../codex-bin.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-codex-bin-'));
const touch = (file, mode = 0o755) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x', { mode }); return fs.realpathSync(file); };
const real = (p) => fs.realpathSync(p);

test('UXA_CODEX_BIN wins on every OS; the companion host is optional', () => {
  const dir = tmp();
  try {
    const bin = touch(path.join(dir, 'codex'));
    const host = touch(path.join(dir, 'codex-code-mode-host'));
    assert.deepEqual(resolveCodexExecutables({ UXA_CODEX_BIN: bin, PATH: '' }, 'linux', dir, dir), [bin, host]);
    fs.rmSync(host);
    assert.deepEqual(resolveCodexExecutables({ UXA_CODEX_BIN: bin, PATH: '' }, 'linux', dir, dir), [bin]);
    assert.throws(() => resolveCodexExecutables({ UXA_CODEX_BIN: path.join(dir, 'missing'), PATH: '' }, 'linux', dir, dir), /UXA_CODEX_BIN is not an executable file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('darwin: the ChatGPT bundles come before PATH; other OSes ignore them', () => {
  const home = tmp();
  const apps = tmp();
  const bin = tmp();
  try {
    const bundle = touch(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'));
    const onPath = touch(path.join(bin, 'codex'));
    assert.deepEqual(resolveCodexExecutables({ PATH: bin }, 'darwin', home, apps), [bundle]);
    const system = touch(path.join(apps, 'ChatGPT.app', 'Contents', 'Resources', 'codex'));
    assert.deepEqual(resolveCodexExecutables({ PATH: bin }, 'darwin', home, apps), [system]);
    // linux never looks at the ChatGPT bundles: with no PATH entry at all it must still miss them and refuse.
    assert.throws(() => resolveCodexExecutables({ PATH: '' }, 'linux', home, apps), /put codex on PATH/);
    // `bin` is a real host tmpdir path; on windows-latest it contains a drive colon, which the POSIX ':'-split
    // (used for the injected 'linux' platform) would break on, so this positive PATH-scan check is POSIX-host-only (C5).
    if (process.platform !== 'win32') assert.deepEqual(resolveCodexExecutables({ PATH: bin }, 'linux', home, apps), [onPath]);
  } finally { for (const d of [home, apps, bin]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('POSIX: a non-executable codex on PATH is skipped; nothing found names the fix', () => {
  const a = tmp();
  const b = tmp();
  try {
    touch(path.join(a, 'codex'), 0o644);
    const good = touch(path.join(b, 'codex'));
    if (process.platform !== 'win32') assert.deepEqual(resolveCodexExecutables({ PATH: `${a}:${b}` }, 'linux', a, a), [good]);
    assert.throws(() => resolveCodexExecutables({ PATH: '' }, 'linux', a, a), /^Error: Codex CLI not found; put codex on PATH or set UXA_CODEX_BIN$/);
    assert.throws(() => resolveCodexExecutables({ PATH: '' }, 'darwin', a, a), /install ChatGPT for macOS or put codex on PATH \(or set UXA_CODEX_BIN\)/);
  } finally { for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('win32: codex.exe on a ;-separated PATH, its .exe host; a bare codex is ignored; a shim is named', () => {
  const plain = tmp();
  const exe = tmp();
  const shim = tmp();
  try {
    touch(path.join(plain, 'codex'));
    const bin = touch(path.join(exe, 'codex.exe'), 0o644); // no execute bit needed on Windows
    const host = touch(path.join(exe, 'codex-code-mode-host.exe'), 0o644);
    assert.deepEqual(resolveCodexExecutables({ PATH: `${plain};${exe}` }, 'win32', plain, plain), [bin, host]);
    const cmd = touch(path.join(shim, 'codex.cmd'));
    assert.throws(() => resolveCodexExecutables({ PATH: `${plain};${shim}` }, 'win32', plain, plain),
      { message: `found the npm shim at ${path.join(shim, 'codex.cmd')}; set UXA_CODEX_BIN to the codex.exe it wraps` });
    fs.rmSync(cmd);
    touch(path.join(shim, 'codex.ps1'));
    assert.throws(() => resolveCodexExecutables({ Path: shim }, 'win32', plain, plain), /found the npm shim at .*codex\.ps1/);
    assert.throws(() => resolveCodexExecutables({ PATH: plain }, 'win32', plain, plain), /^Error: Codex CLI not found; put codex\.exe on PATH or set UXA_CODEX_BIN$/);
  } finally { for (const d of [plain, exe, shim]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('an npm JS launcher is refused with the fix, on every OS', () => {
  const dir = tmp();
  try {
    const launcher = touch(path.join(dir, 'codex.js'));
    for (const platform of ['darwin', 'linux', 'win32']) {
      assert.throws(() => resolveCodexExecutables({ UXA_CODEX_BIN: launcher, PATH: '' }, platform, dir, dir),
        { message: `found the npm launcher at ${real(launcher)}; set UXA_CODEX_BIN to the native codex binary it wraps` });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('win32: UXA_CODEX_BIN pointing straight at an npm shim is refused by name, not spawned', () => {
  const dir = tmp();
  try {
    const cmd = touch(path.join(dir, 'codex.cmd'));
    assert.throws(() => resolveCodexExecutables({ UXA_CODEX_BIN: cmd, PATH: '' }, 'win32', dir, dir),
      { message: `found the npm shim at ${real(cmd)}; set UXA_CODEX_BIN to the codex.exe it wraps` });
    const bat = touch(path.join(dir, 'codex.bat'));
    assert.throws(() => resolveCodexExecutables({ UXA_CODEX_BIN: bat, PATH: '' }, 'win32', dir, dir), /found the npm shim at .*codex\.bat/);
    const ps1 = touch(path.join(dir, 'codex.ps1'));
    assert.throws(() => resolveCodexExecutables({ UXA_CODEX_BIN: ps1, PATH: '' }, 'win32', dir, dir), /found the npm shim at .*codex\.ps1/);
    const upper = touch(path.join(dir, 'CODEX.CMD'));
    assert.throws(() => resolveCodexExecutables({ UXA_CODEX_BIN: upper, PATH: '' }, 'win32', dir, dir), /found the npm shim at .*CODEX\.CMD/i);
    // other OSes can spawn a shim script directly; only win32 refuses it by extension.
    assert.doesNotThrow(() => resolveCodexExecutables({ UXA_CODEX_BIN: cmd, PATH: '' }, 'linux', dir, dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
