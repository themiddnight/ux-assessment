// Runs every test/*.test.mjs, one file at a time. Node 20's --test does not expand globs (Node 21 does),
// and a bare --test would also run the helpers in test/. Extra arguments go to node --test and,
// for a repeated flag such as --test-timeout, override the default below (Node keeps the last one).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(dir, name));
// On Node 20, --test-timeout bounds each *file* (run in its own subprocess), not just each
// individual test() call: controlled-clock.test.mjs alone sums to ~84 s locally across its
// intentional real-time waits, well past the single slowest test (~23 s). 150 s clears that
// with margin for a slower CI machine, while still failing a leaked handle fast instead of
// waiting for the 30 min job cap.
const result = spawnSync(process.execPath,
  ['--test', '--test-concurrency=1', '--test-timeout=150000', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
