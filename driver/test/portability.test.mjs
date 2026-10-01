import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'); // Windows checkouts may be CRLF

function markdownFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(dir, entry.name); // forward slashes in failure messages on every OS
    if (entry.isDirectory()) return markdownFiles(rel);
    return entry.name.endsWith('.md') ? [rel] : [];
  });
}

test('skills and agents call no curl, date -u or jq (D28)', () => {
  const files = ['skills', 'agents', 'codex'].flatMap(markdownFiles);
  assert.ok(files.length >= 6, `found ${files.length} markdown files`);
  for (const rel of files) {
    const text = read(rel);
    assert.doesNotMatch(text, /\bcurl\b/, `${rel} mentions curl`);
    assert.doesNotMatch(text, /\bdate -u\b/, `${rel} mentions date -u`);
    assert.doesNotMatch(text, /\bjq\b/, `${rel} mentions jq`);
  }
});

test('both skills say $PLUGIN is a placeholder; the entry skill resolves its real path and fails closed', () => {
  const claude = read('skills/ux-assessment/SKILL.md');
  const codex = read('codex/skills/ux-assessment/SKILL.md');
  for (const text of [claude, codex]) assert.match(text, /`\$PLUGIN` is a placeholder/);
  assert.match(claude, /node -p "require\('fs'\)\.realpathSync\(process\.argv\[1\]\)" "<base directory>"/);
  assert.match(claude, /`\$PLUGIN\/driver\/codex-runner\.mjs` exists; if it does not, stop/);
  assert.match(claude, /node "\$PLUGIN\/driver\/probe\.mjs" url "<url>"/);
  assert.match(claude, /node "\$PLUGIN\/driver\/probe\.mjs" now/);
  assert.match(claude, /Dispatch `ux-assessment:recon` with: project root, the plugin root \(`\$PLUGIN`, absolute\)/);
  assert.match(codex, /On Windows, write the paths in a job with `\/`/);
});

test('the Codex install reaches the realpath and fail-closed check before the Codex entry redirect', () => {
  // The Codex install links its skill to skills/ux-assessment, so a Codex agent reads this file
  // first; it must resolve $PLUGIN before it follows the redirect to the Codex workflow.
  const claude = read('skills/ux-assessment/SKILL.md');
  const realpath = claude.indexOf('realpathSync');
  const failClosed = claude.indexOf('if it does not, stop');
  const entry = claude.indexOf('**Codex entry:**');
  assert.ok(realpath > 0 && failClosed > 0 && entry > 0, 'all three passages are present');
  assert.ok(realpath < entry, 'the realpath command comes before the Codex entry paragraph');
  assert.ok(failClosed < entry, 'the fail-closed check comes before the Codex entry paragraph');
});

test('recon fetches with probe.mjs; triage reads large logs with Grep and Read', () => {
  const recon = read('agents/recon.md');
  assert.match(recon, /the plugin root/);
  assert.match(recon, /node <plugin root>\/driver\/probe\.mjs fetch "<url>"/);
  assert.match(read('agents/triage.md'), /the Grep tool .* Read with `offset`\/`limit`/);
});

test('every node $PLUGIN command quotes the path (a Windows profile may contain spaces)', () => {
  for (const rel of ['skills/ux-assessment/SKILL.md', 'codex/skills/ux-assessment/SKILL.md']) {
    const text = read(rel);
    assert.match(text, /node "\$PLUGIN\//, `${rel} has quoted node "$PLUGIN/..." commands`);
    assert.doesNotMatch(text, /node \$PLUGIN\//, `${rel} has an unquoted node $PLUGIN/ command`);
  }
});
