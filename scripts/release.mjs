#!/usr/bin/env node
// Maintainer tool for docs/releasing.md: `check` verifies a tree, `export` writes the publishable copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportTree, freshRepoProblems, githubProblems, releaseProblems } from './release-lib.mjs';

const USAGE = 'usage: node scripts/release.mjs check [dir] [--fresh] [--github OWNER/REPO] | export <dir>';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `null` when the command line is not one of the documented forms.
function parse(argv) {
  const [command, ...rest] = argv;
  const found = { command, dir: null, fresh: false, github: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (command === 'check' && arg === '--fresh') found.fresh = true;
    else if (command === 'check' && arg === '--github') {
      found.github = rest[++i] ?? '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(found.github)) return null;
    } else if (arg.startsWith('-') || found.dir !== null) return null;
    else found.dir = arg;
  }
  return command === 'check' || (command === 'export' && found.dir !== null) ? found : null;
}

export function main(argv, { out = console.log, err = console.error, root = HERE, gh } = {}) {
  const args = parse(argv);
  if (!args) {
    err(USAGE);
    return 2;
  }
  if (args.command === 'export') {
    try {
      out(`exported ${exportTree(root, path.resolve(args.dir))} files to ${path.resolve(args.dir)}`);
      return 0;
    } catch (e) {
      err(`release: ${e.message}`);
      return 1;
    }
  }
  const target = args.dir ? path.resolve(args.dir) : root;
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    err(`release: no directory ${target}`);
    return 2;
  }
  const problems = [...releaseProblems(target), ...(args.fresh ? freshRepoProblems(target) : []), ...(args.github ? githubProblems(args.github, gh) : [])];
  for (const problem of problems) err(problem);
  out(problems.length ? `release check: ${problems.length} problem(s)` : 'release check: ok');
  return problems.length ? 1 : 0;
}

// Compare real paths: a symlinked path to this file (/tmp, /var on macOS) must still run it.
const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
