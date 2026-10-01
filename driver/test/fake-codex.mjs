// A POSIX stand-in for the Codex CLI: `--version`, `features list [--disable …]` (unified_exec stays on, as on 0.155),
// and `exec`, which prints JSONL events and writes the last message. Mode `leak` also prints ./canary.txt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = fs.readFileSync(path.join(__dirname, 'mode.txt'), 'utf8').trim();
const line = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.155.0-alpha.9.2\\n');
} else if (args[0] === 'features') {
  const off = args.filter((a, i) => args[i - 1] === '--disable');
  const text = fs.readFileSync(path.join(__dirname, 'features.txt'), 'utf8');
  process.stdout.write(text.split(/\\r?\\n/).map((l) => {
    const name = l.trim().split(/\\s+/)[0];
    return off.includes(name) && name !== 'unified_exec' ? l.replace(/true$/, 'false') : l;
  }).join('\\n'));
} else if (args[0] === 'exec') {
  fs.writeFileSync(path.join(__dirname, 'exec-args.json'), JSON.stringify(args));
  process.stdin.resume();
  process.stdin.on('end', () => {
    const leak = mode === 'leak' ? fs.readFileSync('canary.txt', 'utf8').trim() : '';
    line({ type: 'thread.started', thread_id: 't1' });
    line({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'tried ' + leak } });
    line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3 } });
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'done');
  });
} else {
  process.exitCode = 2;
}
`;

export function makeFakeCodex({ features, mode = 'quiet' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-fake-codex-'));
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'features.txt'), features);
  fs.writeFileSync(path.join(dir, 'mode.txt'), mode);
  return {
    file: fs.realpathSync(file),
    dir,
    execArgs: () => JSON.parse(fs.readFileSync(path.join(dir, 'exec-args.json'), 'utf8')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
