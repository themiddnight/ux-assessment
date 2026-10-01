// Release checks: what gets published, and what must hold before it is (spec component 10, D33).
// Shared by scripts/release.mjs and driver/test/{release,docs}.test.mjs. Node built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Tracked directories that stay in the private repository (D33). */
export const UNPUBLISHED = ['work/', 'spike/', 'docs/superpowers/plans/', '.superpowers/'];

// sha256 prefixes of the private dogfood app names, so this file names none of them.
// The last three are the separator-free spellings of the three hyphenated names.
const PRIVATE = new Set(['2d15c786fbcee91c', '49a2f8ca320fa68a', '49a4dfb44c44c638', 'aed5840ec843d0dc', 'b76b16c932de83f7',
  '572b29f17638f142', '54cad8b56236f0dc', '7ab3a52057af4705']);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const MAX_RUN = 5; // adjacent tokens joined with hyphens: `m2 acme_app.auth` is checked as `acme-app`
const MAX_PREFIX = 32; // plural and suffixed forms: every prefix of 4 to 32 characters of a token or run

/** Private names in `text`: any separator, camelCase, runs of tokens, and prefixes of both (so also plurals). */
export function privateWords(text, hashes = PRIVATE) {
  const hits = [];
  const tested = new Set();
  const test = (candidate) => {
    if (tested.has(candidate)) return;
    tested.add(candidate);
    if (hashes.has(sha(candidate))) hits.push(candidate);
  };
  const tokens = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j <= Math.min(tokens.length, i + MAX_RUN); j++) {
      const run = tokens.slice(i, j).join('-');
      test(run);
      for (let len = 4; len < Math.min(run.length, MAX_PREFIX + 1); len++) test(run.slice(0, len));
    }
  }
  return hits;
}
const namesIn = (text, hashes) => [...new Set(privateWords(text, hashes).map(sha))];

function walk(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (!entry.isDirectory()) return [child];
    return entry.name === '.git' || entry.name === 'node_modules' ? [] : walk(root, child);
  });
}

/** Repo-relative paths (forward slashes) of the files that get published: tracked files in a git checkout, every file in an export. */
export function publishableFiles(root) {
  const git = fs.existsSync(path.join(root, '.git')) ? spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }) : null;
  const all = git?.status === 0 ? git.stdout.split('\0').filter(Boolean) : walk(root);
  return all.filter((rel) => !UNPUBLISHED.some((dir) => rel.startsWith(dir)) && fs.existsSync(path.join(root, rel))).sort();
}

const DIRS = UNPUBLISHED.map((d) => d.replace(/\/$/, '').replace(/[.]/g, '\\.').replace(/\//g, '[/\\\\]')).join('|');
// A bare or absolute path into an unpublished directory; `C:/work/x` and `src/work/x` are not one.
const BARE = new RegExp(`(?<![\\w/\\\\.-])(?<!:(?=[/\\\\]))((?:[\\w.-]*[/\\\\])*?)(?:${DIRS})[/\\\\][\\w.-]+`, 'g');
const RELATIVE = /(?<![\w/\\.-])(?<!:(?=[/\\]))(?:\.{1,2}[/\\])+[\w./\\-]+/g;
const inUnpublished = (posix) => UNPUBLISHED.some((dir) => `${posix}/`.startsWith(dir) || posix.startsWith(dir));
const MAIL = /[\w.+-]+@(?!(?:example\.com|users\.noreply\.github\.com)(?![\w-]|\.[A-Za-z]))[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/;
const FENCE = /^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm;

/** The text in `line`, written in the file `rel` (or in a commit message, `rel` = ''), that names a file in an unpublished directory, or null. */
function namesUnpublished(rel, line) {
  for (const m of line.matchAll(BARE)) {
    if (m[1] === '' || /^[/\\]/.test(m[1]) || m[1].split(/[/\\]/).filter(Boolean).every((seg) => seg === '.' || seg === '..')) return m[0];
  }
  for (const [token] of line.matchAll(RELATIVE)) {
    if (inUnpublished(path.posix.join(path.posix.dirname(rel), token.replace(/\\/g, '/')))) return token;
  }
  return null;
}

/** The rules, other than the names, that a line of text must pass, as labels. Never the matched text itself (R4): a sha256 prefix of it. */
function lineProblems(rel, line) {
  const labels = [];
  const local = line.match(/\/Users\/[A-Za-z][^\s"'`)>\]]*|~\/Sites\/[^\s"'`)>\]]*/);
  if (local) labels.push(`local path (sha256 ${sha(local[0])})`);
  const mail = line.match(MAIL);
  if (mail) labels.push(`e-mail address (sha256 ${sha(mail[0])})`);
  const unpublished = namesUnpublished(rel, line);
  if (unpublished !== null) labels.push(`names a file in an unpublished directory (sha256 ${sha(unpublished)})`);
  return labels;
}

function textOf(root, rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  return buf.includes(0) ? null : buf.toString('utf8').replace(/\r\n/g, '\n');
}

/** Link targets of a Markdown or HTML text: inline (with an optional title), reference definitions, href and src. */
function linkTargets(text) {
  const bare = text.replace(FENCE, '');
  return [...bare.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+[^)]*)?\)/g), ...bare.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s.*)?$/gm),
    ...bare.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Private names, local paths, e-mail addresses, and references that leave the published tree. */
export function privateData(root, hashes = PRIVATE) {
  const files = publishableFiles(root);
  if (!files.length) return [`no publishable files in the tree (a git checkout with nothing tracked, or an empty directory)`];
  const problems = [];
  for (const rel of files) {
    for (const hash of namesIn(rel, hashes)) problems.push(`${rel}: private name in the path (sha256 ${hash})`);
    const text = textOf(root, rel);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => {
      for (const hash of namesIn(line, hashes)) problems.push(`${rel}:${i + 1}: private name (sha256 ${hash})`);
      for (const label of lineProblems(rel, line)) problems.push(`${rel}:${i + 1}: ${label}`);
    });
    if (!rel.endsWith('.md')) continue;
    for (const target of linkTargets(text)) {
      const file = target.split(/[#?]/)[0].replace(/\\/g, '/');
      if (!file || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      const to = (file.startsWith('/') ? path.posix.normalize(file.slice(1)) : path.posix.join(path.posix.dirname(rel), file)).replace(/\/$/, '');
      if (to.startsWith('..') || !files.some((f) => f === to || f.startsWith(`${to}/`))) {
        const line = text.split('\n').findIndex((l) => l.includes(target)) + 1;
        problems.push(`${rel}:${line}: link (sha256 ${sha(target)}) leaves the published tree`);
      }
    }
  }
  return problems;
}

/** The GitHub owner: the one place it is written is `repository` in the Claude manifest. */
export function ownerOf(root) {
  const { repository } = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  return /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/ux-assessment$/.exec(repository ?? '')?.[1] ?? null;
}

/** LICENSE, the manifests and every mention of the repository agree. */
export function manifestProblems(root) {
  const problems = [];
  const json = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const claude = json('.claude-plugin/plugin.json');
  const codex = json('.codex-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  const driver = json('driver/package.json');
  const entry = market.plugins?.[0] ?? {};
  const same = (what, values) => {
    if (new Set(Object.values(values)).size !== 1) problems.push(`${what} differs: ${JSON.stringify(values)}`);
  };
  const license = fs.existsSync(path.join(root, 'LICENSE')) ? textOf(root, 'LICENSE') : '';
  if (!license.startsWith('MIT License\n')) problems.push('LICENSE: missing, or not the MIT text');
  if (!license.includes('\nCopyright (c) 2026 Pathompong Thitithan\n')) problems.push('LICENSE: copyright line');
  same('license', { LICENSE: 'MIT', claude: claude.license, codex: codex.license, driver: driver.license });
  same('name', { claude: claude.name, codex: codex.name, marketplace: market.name, entry: entry.name });
  same('version', { claude: claude.version, codex: codex.version, entry: entry.version, driver: driver.version });
  if (!/^\d+\.\d+\.\d+$/.test(claude.version ?? '')) problems.push(`version ${claude.version} is not x.y.z`);
  const owner = ownerOf(root);
  if (!owner) return [...problems, '.claude-plugin/plugin.json: repository must be the https URL of the GitHub repository'];
  same('repository and homepage', { claudeRepository: claude.repository, claudeHomepage: claude.homepage, codexRepository: codex.repository, codexHomepage: codex.homepage });
  for (const rel of publishableFiles(root)) {
    (textOf(root, rel) ?? '').split('\n').forEach((line, i) => {
      if (/<owner\b>/.test(line)) problems.push(`${rel}:${i + 1}: owner placeholder`);
      for (const [, name] of line.matchAll(/(?:github\.com[/:]|marketplace add )([\w<>.-]+)\/ux-assessment\b/g)) {
        if (name !== owner) problems.push(`${rel}:${i + 1}: repository owner ${name}, the manifest says ${owner}`);
      }
    });
  }
  return problems;
}

/** CI runs on the three OSes the README names, on pushes to main and on pull requests. */
export function ciProblems(root) {
  const text = textOf(root, '.github/workflows/ci.yml');
  const os = (/^\s*os:\s*\[([^\]]*)\]/m.exec(text)?.[1] ?? '').split(',').map((s) => s.trim());
  const problems = ['macos-latest', 'windows-latest', 'ubuntu-24.04'].filter((name) => !os.includes(name)).map((name) => `ci.yml: matrix.os lacks ${name}`);
  if (!/^on:\n(?:  .*\n)*?  push:/m.test(text)) problems.push('ci.yml: no push trigger');
  return problems;
}

// A check that cannot run (a missing manifest, an empty directory) is a problem, not a stack trace.
const guarded = (what, check, root) => {
  try { return check(root); } catch (e) { return [`${what}: cannot check (${e.code ?? e.message})`]; }
};
export const releaseProblems = (root) => [...guarded('scan', privateData, root), ...guarded('manifest', manifestProblems, root), ...guarded('ci', ciProblems, root)];

// `owner/repo` of a remote URL in any form (https, ssh, scp-like, git, a host alias, a trailing slash or `.git`), lower-cased.
const repoPath = (url) => {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/*$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
};

/** Copy the publishable files of a clean checkout into an empty directory outside it. Returns the file count. */
export function exportTree(root, dest) {
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (!path.relative(root, path.resolve(dest)).startsWith('..')) throw new Error('the export directory must be outside the checkout');
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('commit the tracked changes first: the export copies the working tree');
  const owner = ownerOf(root);
  if (!owner) throw new Error('.claude-plugin/plugin.json has no repository URL, so the public repository is unknown: set it first');
  const publicPath = `${owner}/ux-assessment`.toLowerCase();
  // Any remote, fetch or push URL: a push from this checkout to the public repository would publish the private history.
  for (const line of git('config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$').stdout.split('\n').filter(Boolean)) {
    const [key, ...value] = line.split(' ');
    if (repoPath(value.join(' ')) !== publicPath) continue;
    const name = key.replace(/^remote\.(.*)\.(?:url|pushurl)$/, '$1');
    throw new Error(`${name === 'origin' ? 'origin' : `remote ${name}`} of this checkout is the public repository URL: rename the private repository and run git remote set-url first`);
  }
  const found = releaseProblems(root);
  if (found.length) throw new Error(`the release check finds ${found.length} problem(s): run node scripts/release.mjs check and fix them first`);
  const files = publishableFiles(root);
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(dest, rel));
  }
  return files.length;
}

/** The exported directory after `git init` and one commit. */
export function freshRepoProblems(dir) {
  const problems = UNPUBLISHED.filter((d) => fs.existsSync(path.join(dir, d))).map((d) => `${d} exists in the public tree`);
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  const count = fs.existsSync(path.join(dir, '.git')) ? git('rev-list', '--count', 'HEAD') : { status: 1 };
  if (count.status !== 0) return [...problems, 'not a git repository with a commit of its own'];
  const all = git('rev-list', '--count', '--all').stdout.trim();
  if (all !== '1') problems.push(`history has ${all} commits; the public repository starts from one`);
  if (git('status', '--porcelain').stdout.trim()) problems.push('uncommitted or untracked files');
  if (git('log', '--all', '--format=%ae%n%ce').stdout.trim().split('\n').some((mail) => !mail.endsWith('@users.noreply.github.com'))) {
    problems.push('a commit e-mail is not a GitHub noreply address');
  }
  // The messages are public too: body and trailers get the same rules as the files.
  const labels = new Set(git('log', '--all', '--format=%B').stdout.replace(/\r\n/g, '\n').split('\n').flatMap((line) => (privateWords(line).length ? ['private name'] : []).concat(lineProblems('', line))));
  for (const label of labels) problems.push(`commit message: ${label}`);
  return problems;
}

/** GitHub settings of the published repository (`gh` must be signed in). */
export function githubProblems(repo, gh = (args) => spawnSync('gh', args, { encoding: 'utf8' })) {
  const api = (args) => {
    const r = gh(args);
    try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
  };
  const info = api(['repo', 'view', repo, '--json', 'visibility']);
  if (!info) return [`gh cannot read ${repo}: check gh auth status and the name`];
  const problems = info.visibility === 'PUBLIC' ? [] : [`${repo} is ${info.visibility}, not PUBLIC`];
  const labels = api(['label', 'list', '--repo', repo, '--limit', '200', '--json', 'name']) ?? [];
  for (const name of ['bug', 'codex-self-check']) if (!labels.some((l) => l.name === name)) problems.push(`label ${name} is missing`);
  if (api(['api', `repos/${repo}/private-vulnerability-reporting`])?.enabled !== true) problems.push('private vulnerability reporting is off');
  const protection = api(['api', `repos/${repo}/branches/main/protection`]);
  if (!protection) problems.push('main has no branch protection');
  else {
    if (protection.allow_force_pushes?.enabled !== false) problems.push('main allows force pushes');
    if (protection.allow_deletions?.enabled !== false) problems.push('main allows branch deletion');
  }
  const [run] = api(['run', 'list', '--repo', repo, '--workflow', 'ci', '--branch', 'main', '--limit', '1', '--json', 'conclusion']) ?? [];
  if (run?.conclusion !== 'success') problems.push('the latest ci run on main is not green');
  return problems;
}
