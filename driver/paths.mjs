import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** True when `p` is strictly below `root` (never `root` itself). `..` and another drive are outside. Case-insensitive on win32. */
export function isInside(root, p, pathApi = path) {
  const fold = (value) => (pathApi === path.win32 ? value.toLowerCase() : value);
  const rel = pathApi.relative(fold(pathApi.resolve(root)), fold(pathApi.resolve(p)));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

/** The shared default writer: one function, so the runner and its Session warn once between them. */
export const stderrLine = (line) => { process.stderr.write(`${line}\n`); };

// realpathSync.native expands 8.3 short names (C:\Users\RUNNER~1 → C:\Users\runneradmin); the JS realpath does not.
// A run folder may not exist yet (Session creates it on launch): resolve the deepest existing parent and re-append
// the rest. A win32 path seen on a POSIX host (tests inject platform: 'win32') is not a host path: left as is.
function realpathOrSelf(p) {
  if (!path.isAbsolute(p) && path.win32.isAbsolute(p)) return p;
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...rest); } catch { /* not there yet: try the parent */ }
    const parent = path.dirname(head);
    if (parent === head) return p;
    rest.unshift(path.basename(head));
    head = parent;
  }
}

const warnedBy = new WeakSet();

/**
 * SPEC D28: the 0o600/0o700 modes are no-ops on Windows, where a folder inside the user profile is private
 * to the user by default. Warns once per `warn` function when `root` is outside the profile. True when it warned.
 */
export function warnOutsideProfile({ root, platform = process.platform, homedir = os.homedir(), warn = stderrLine, realpath = realpathOrSelf }) {
  if (platform !== 'win32' || warnedBy.has(warn)) return false;
  const home = path.win32.resolve(realpath(homedir)).toLowerCase();
  const at = path.win32.resolve(realpath(root)).toLowerCase();
  if (at === home || isInside(home, at, path.win32)) return false;
  warnedBy.add(warn);
  warn(`warning: ${root} is outside your user profile (${homedir}); credentials and saved logins in .ux-assessment/ are protected only by this folder's permissions`);
  return true;
}
