// Print the native codex binary inside the global @openai/codex npm install (argument: `npm root -g`).
// The npm entry is a launcher (codex.cmd on Windows, codex.js elsewhere) that the runner refuses by design.
import fs from 'node:fs';
import path from 'node:path';

const want = process.platform === 'win32' ? 'codex.exe' : 'codex';
function find(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === want && file.includes(`${path.sep}vendor${path.sep}`)) return file;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = find(path.join(dir, entry.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}
const root = path.join(process.argv[2] ?? '', '@openai');
const hit = find(root, 8);
if (!hit) { process.stderr.write(`no ${want} under ${root}\n`); process.exit(1); }
process.stdout.write(hit);
