// CI: after `node scripts/install.mjs --skip-deps --no-claude`, the Codex skill entry must be a link (a junction on
// Windows, which Node reports as a symbolic link) that resolves to this checkout's skill. The Node half of open question 4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const link = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'ux-assessment');
const want = fs.realpathSync(path.resolve('skills', 'ux-assessment'));
const got = fs.realpathSync(link);
const same = process.platform === 'win32' ? got.toLowerCase() === want.toLowerCase() : got === want;
if (!fs.lstatSync(link).isSymbolicLink() || !same || !fs.existsSync(path.join(link, 'SKILL.md'))) {
  console.error(`${link} resolves to ${got}; expected a link to ${want} with a SKILL.md`);
  process.exit(1);
}
console.log(`${link} -> ${got}`);
