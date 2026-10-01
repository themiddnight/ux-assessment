import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, warnOutsideProfile } from '../paths.mjs';

test('POSIX: strictly below the root only', () => {
  const p = path.posix;
  assert.equal(isInside('/proj/.ux-assessment', '/proj/.ux-assessment/runs/a.png', p), true);
  assert.equal(isInside('/proj/.ux-assessment', '/proj/.ux-assessment', p), false);
  assert.equal(isInside('/proj/.ux-assessment', '/proj/.ux-assessment/../top.png', p), false);
  assert.equal(isInside('/proj/.ux-assessment', '/proj/.ux-assessment-other/a.png', p), false);
  assert.equal(isInside('/proj/.ux-assessment', '/proj/.ux-assessment/..foo', p), true, 'a name starting with two dots is inside');
  assert.equal(isInside('/proj/.ux-assessment', '/PROJ/.ux-assessment/a.png', p), false, 'POSIX is case-sensitive');
});

test('win32: drive letters, case and separators', () => {
  const w = path.win32;
  assert.equal(isInside('C:\\Proj\\.ux-assessment', 'c:\\proj\\.UX-ASSESSMENT\\runs\\a.png', w), true);
  assert.equal(isInside('C:\\Proj\\.ux-assessment', 'C:/Proj/.ux-assessment/runs/a.png', w), true);
  assert.equal(isInside('C:\\Proj\\.ux-assessment', 'D:\\Proj\\.ux-assessment\\a.png', w), false);
  assert.equal(isInside('C:\\Proj\\.ux-assessment', 'C:\\Proj\\.ux-assessment\\..\\secret.png', w), false);
  assert.equal(isInside('C:\\Proj\\.ux-assessment', 'C:\\Proj\\.ux-assessment', w), false);
  assert.equal(isInside('C:\\Proj\\.ux-assessment', 'C:\\Proj\\.ux-assessment-x\\a.png', w), false);
});

test('the host path API is the default', () => {
  const root = path.resolve('some', 'root');
  assert.equal(isInside(root, path.join(root, 'a')), true);
  assert.equal(isInside(root, path.dirname(root)), false);
});

test('warnOutsideProfile: win32 only, real paths, case-insensitive, once per writer (D28)', () => {
  const lines = [];
  const warn = (line) => lines.push(line);
  const same = (p) => p;
  assert.equal(warnOutsideProfile({ root: '/srv/app', platform: 'linux', homedir: '/home/me', warn, realpath: same }), false);
  assert.equal(warnOutsideProfile({ root: 'C:\\USERS\\ME\\app', platform: 'win32', homedir: 'C:\\Users\\me', warn, realpath: same }), false);
  assert.equal(warnOutsideProfile({ root: 'C:\\Users\\me', platform: 'win32', homedir: 'C:\\Users\\me', warn, realpath: same }), false, 'the profile folder itself');
  const long = (p) => p.replace('RUNNER~1', 'runneradmin'); // what fs.realpathSync.native does to an 8.3 name
  assert.equal(warnOutsideProfile({ root: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\p', platform: 'win32', homedir: 'C:\\Users\\runneradmin', warn, realpath: long }), false);
  assert.equal(warnOutsideProfile({ root: 'D:\\a\\app', platform: 'win32', homedir: 'C:\\Users\\me', warn, realpath: same }), true);
  assert.equal(warnOutsideProfile({ root: 'E:\\other', platform: 'win32', homedir: 'C:\\Users\\me', warn, realpath: same }), false, 'once per writer');
  assert.deepEqual(lines, ["warning: D:\\a\\app is outside your user profile (C:\\Users\\me); credentials and saved logins in .ux-assessment/ are protected only by this folder's permissions"]);
});

test('warnOutsideProfile: a run folder not created yet is judged by the real path of its deepest existing parent (D28)', () => {
  // A symlink (a junction on Windows) stands in for an 8.3 short name: only the real path shows it is inside.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-paths-'));
  try {
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const alias = path.join(base, 'alias');
    fs.symlinkSync(home, alias, 'junction');
    const lines = [];
    const warn = (line) => lines.push(line);
    const root = path.join(alias, 'app', '.ux-assessment', 'runs', 'r', 'p');
    assert.equal(fs.existsSync(root), false);
    assert.equal(warnOutsideProfile({ root, platform: 'win32', homedir: home, warn }), false);
    assert.deepEqual(lines, []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
