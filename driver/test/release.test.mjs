// The release checks (spec component 10, D33): what is published, and what must hold before it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { UNPUBLISHED, ciProblems, exportTree, freshRepoProblems, githubProblems, manifestProblems, privateData,
  privateWords, publishableFiles, releaseProblems } from '../../scripts/release-lib.mjs';
import { main } from '../../scripts/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Strings the checks look for are assembled here, so this file does not trip the checks it tests.
const OWNER = 'octo';
const URL = ['https://github.com', OWNER, 'ux-assessment'].join('/');
const NOTE = `${UNPUBLISHED[0]}notes.md`;
const manifest = (extra = {}) => JSON.stringify({ name: 'ux-assessment', version: '0.3.0', license: 'MIT', repository: URL, homepage: URL, ...extra });
const good = () => ({
  LICENSE: 'MIT License\n\nCopyright (c) 2026 Pathompong Thitithan\n',
  '.claude-plugin/plugin.json': manifest(),
  '.codex-plugin/plugin.json': manifest(),
  '.claude-plugin/marketplace.json': JSON.stringify({ name: 'ux-assessment', plugins: [{ name: 'ux-assessment', source: './', version: '0.3.0' }] }),
  'driver/package.json': JSON.stringify({ name: 'ux-assessment-driver', version: '0.3.0', license: 'MIT' }),
  '.github/workflows/ci.yml': 'on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    strategy:\n      matrix:\n        os: [macos-latest, windows-latest, ubuntu-24.04]\n',
  'README.md': `# x\n\n/plugin marketplace add ${OWNER}/ux-assessment\n\nWrite to persona@example.com.\n`,
});

function tree(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
function repo(t, files, mail = 'persona@example.com') {
  const dir = tree(t, files);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  assert.equal(git(dir, '-c', `user.email=${mail}`, 'commit', '-q', '-m', 'init').status, 0);
  return dir;
}

test('publishableFiles: an export (no .git) is walked; unpublished directories and node_modules are left out', (t) => {
  const dir = tree(t, { ...good(), [NOTE]: 'private', 'driver/node_modules/x/index.js': '', [`${UNPUBLISHED[2]}p.md`]: 'plan' });
  assert.deepEqual(publishableFiles(dir), Object.keys(good()).sort());
  assert.deepEqual(releaseProblems(dir), []);
});

test('privateData: names by hash (in a hyphenated word, in a path), local paths, e-mail addresses, references that leave the tree', (t) => {
  const hashes = new Set([crypto.createHash('sha256').update('acme-app').digest('hex').slice(0, 16)]);
  const dir = tree(t, {
    'a.md': ['ran on m2-acme-app-auth', `at ${['', 'Users', 'someone', 'app'].join('/')}`, `or ${['~', 'Sites', 'app'].join('/')}`,
      `mail ${['someone', 'mail.test'].join('@')}`, `see ${NOTE}`, `[n](${NOTE})`, '[ok](b.md) [web](https://example.com) pkg@1.2.3 C:/work/app'].join('\n'),
    'b.md': 'fine',
    'fixtures/acme-app.txt': 'x',
    'bin.dat': Buffer.from([0, 1, 2]),
  });
  assert.deepEqual(privateData(dir, hashes).map((p) => p.replace(/ \(sha256 \w+\)/, '')), [
    'a.md:1: private name', 'a.md:2: local path', 'a.md:3: local path', 'a.md:4: e-mail address',
    'a.md:5: names a file in an unpublished directory', 'a.md:6: names a file in an unpublished directory',
    'a.md:5: link leaves the published tree', 'fixtures/acme-app.txt: private name in the path',
  ]);
});

test('manifestProblems: LICENSE, license, name, version, repository and every mention of the owner agree', (t) => {
  const problems = (change) => {
    const files = good();
    change(files);
    return manifestProblems(tree(t, files));
  };
  assert.deepEqual(problems(() => {}), []);
  assert.deepEqual(problems((f) => { delete f.LICENSE; }), ['LICENSE: missing, or not the MIT text', 'LICENSE: copyright line']);
  assert.match(problems((f) => { f['.codex-plugin/plugin.json'] = manifest({ version: '0.2.0' }); })[0], /^version differs/);
  assert.match(problems((f) => { f['.codex-plugin/plugin.json'] = manifest({ license: undefined }); })[0], /^license differs/);
  assert.match(problems((f) => { f['.codex-plugin/plugin.json'] = manifest({ homepage: 'https://example.com' }); })[0], /^repository and homepage differs/);
  assert.match(problems((f) => { f['.claude-plugin/plugin.json'] = manifest({ repository: undefined }); }).at(-1), /repository must be/);
  assert.deepEqual(problems((f) => { f['README.md'] = `clone ${URL.replace(OWNER, 'someone-else')}.git\nadd <${'owner'}>/ux-assessment\n`; }),
    [`README.md:1: repository owner someone-else, the manifest says ${OWNER}`, 'README.md:2: owner placeholder']);
});

test('ciProblems: the matrix names the three OSes and pushes trigger it', (t) => {
  const ci = good()['.github/workflows/ci.yml'];
  assert.deepEqual(ciProblems(tree(t, { '.github/workflows/ci.yml': ci.replace('macos-latest, ', '').replace('  push:\n    branches: [main]\n', '') })),
    ['ci.yml: matrix.os lacks macos-latest', 'ci.yml: no push trigger']);
});

test('exportTree: copies only tracked, publishable files of a clean checkout whose origin is not the public URL', (t) => {
  const src = repo(t, { ...good(), [NOTE]: 'private' });
  fs.writeFileSync(path.join(src, 'untracked.md'), 'scratch');
  const dest = tree(t, {});
  assert.equal(exportTree(src, dest), Object.keys(good()).length);
  assert.deepEqual(publishableFiles(dest), Object.keys(good()).sort());
  assert.ok(!fs.existsSync(path.join(dest, 'untracked.md')) && !fs.existsSync(path.join(dest, NOTE)));
  assert.throws(() => exportTree(src, dest), /is not empty/);
  assert.throws(() => exportTree(src, path.join(src, 'out')), /outside the checkout/);
  git(src, 'remote', 'add', 'origin', `${URL}.git`);
  assert.throws(() => exportTree(src, tree(t, {})), /origin of this checkout is the public repository/);
  git(src, 'remote', 'set-url', 'origin', `${URL}-private.git`);
  fs.appendFileSync(path.join(src, 'README.md'), 'half an edit\n');
  assert.throws(() => exportTree(src, tree(t, {})), /commit the tracked changes first/);
});

test('freshRepoProblems: one commit, a noreply e-mail, no unpublished directory', (t) => {
  assert.deepEqual(freshRepoProblems(tree(t, good())), ['not a git repository with a commit of its own']);
  assert.deepEqual(freshRepoProblems(repo(t, good())), ['a commit e-mail is not a GitHub noreply address']);
  const noreply = ['1+octo', 'users.noreply.github.com'].join('@');
  const fresh = repo(t, good(), noreply);
  assert.deepEqual(freshRepoProblems(fresh), []);
  fs.mkdirSync(path.join(fresh, 'spike'));
  fs.writeFileSync(path.join(fresh, 'second.md'), 'x');
  git(fresh, 'add', '-A');
  git(fresh, '-c', `user.email=${noreply}`, 'commit', '-q', '-m', 'second');
  assert.deepEqual(freshRepoProblems(fresh), ['spike/ exists in the public tree', 'history has 2 commits; the public repository starts from one']);
});

test('githubProblems: visibility, labels, private vulnerability reporting, branch protection, a green run on main', () => {
  const gh = (answers) => (args) => {
    const key = Object.keys(answers).find((k) => args.join(' ').includes(k));
    return key ? { status: 0, stdout: JSON.stringify(answers[key]) } : { status: 1, stdout: '' };
  };
  const ok = { 'repo view': { visibility: 'PUBLIC' }, 'label list': [{ name: 'bug' }, { name: 'codex-self-check' }],
    'private-vulnerability-reporting': { enabled: true }, 'branches/main/protection': { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } }, 'run list': [{ conclusion: 'success' }] };
  assert.deepEqual(githubProblems('octo/ux-assessment', gh(ok)), []);
  const loose = { ...ok, 'branches/main/protection': { allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } } };
  assert.deepEqual(githubProblems('octo/ux-assessment', gh(loose)), ['main allows force pushes', 'main allows branch deletion']);
  assert.deepEqual(githubProblems('octo/ux-assessment', gh({ ...ok, 'branches/main/protection': { url: 'x' } })), ['main allows force pushes', 'main allows branch deletion']);
  assert.deepEqual(githubProblems('octo/ux-assessment', gh({})), ['gh cannot read octo/ux-assessment: check gh auth status and the name']);
  assert.deepEqual(githubProblems('octo/ux-assessment', gh({ 'repo view': { visibility: 'PRIVATE' }, 'label list': [{ name: 'bug' }] })), [
    'octo/ux-assessment is PRIVATE, not PUBLIC', 'label codex-self-check is missing', 'private vulnerability reporting is off',
    'main has no branch protection', 'the latest ci run on main is not green']);
});

test('release.mjs: check prints the problems and exits 1, ok exits 0, a bad command line exits 2', (t) => {
  const run = (argv, root) => {
    const lines = { out: [], err: [] };
    const code = main(argv, { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), root });
    return { code, ...lines };
  };
  const clean = tree(t, good());
  assert.deepEqual(run(['check'], clean), { code: 0, out: ['release check: ok'], err: [] });
  assert.deepEqual(run(['check', clean, '--fresh'], path.join(clean, 'elsewhere')), { code: 1, out: ['release check: 1 problem(s)'], err: ['not a git repository with a commit of its own'] });
  for (const argv of [[], ['export'], ['check', path.join(clean, 'missing')], ['check', '--github'], ['check', '--github', 'no-slash'], ['publish']]) {
    assert.equal(run(argv, clean).code, 2);
  }
});

test('this repository: the publishable set leaves out the unpublished directories', () => {
  const files = publishableFiles(ROOT);
  assert.ok(files.includes('README.md') && files.includes('driver/package.json'));
  assert.deepEqual(files.filter((rel) => UNPUBLISHED.some((dir) => rel.startsWith(dir))), []);
});

// Fix round 1: the checks fail closed. Strings the scan looks for are assembled.
const at = (a, b) => [a, b].join('@');
const hashOf = (name) => new Set([crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)]);
const scan = (t, files, hashes) => privateData(tree(t, { ...good(), ...files }), hashes).map((p) => p.replace(/ \(sha256 \w+\)/, ''));
const cli = (argv, root, gh) => {
  const lines = { out: [], err: [] };
  const code = main(argv, { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l), root, gh });
  return { code, ...lines };
};

test('release.mjs: runs through a symlinked path, and an unknown or malformed argument exits 2, never ok', (t) => {
  const clean = tree(t, good());
  const exe = path.join(ROOT, 'scripts', 'release.mjs');
  const link = path.join(tree(t, {}), 'release.mjs');
  fs.symlinkSync(exe, link);
  const ran = spawnSync(process.execPath, [link, 'bogus'], { encoding: 'utf8' });
  assert.equal(ran.status, 2);
  assert.match(ran.stderr, /usage/);
  for (const argv of [['check', clean, `--github=${OWNER}/ux-assessment`], ['check', clean, '-fresh'], ['check', clean, '--frsh'],
    ['check', clean, 'extra'], ['check', clean, clean, '--fresh'], ['check', '--github', '--fresh'], ['export', clean, '--fresh']]) {
    const r = cli(argv, clean);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err[0], /usage/);
    assert.deepEqual(r.out, []);
  }
});

test('check: a tree with no publishable file, an empty directory or a plain file is never ok', (t) => {
  const bare = tree(t, {});
  git(bare, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(bare, 'leak.md'), `at ${['', 'Users', 'someone'].join('/')}\n`);
  assert.match(privateData(bare)[0], /no publishable files/);
  const r = cli(['check'], bare);
  assert.equal(r.code, 1);
  assert.match(r.out[0], /problem/);
  const empty = cli(['check'], tree(t, {}));
  assert.equal(empty.code, 1);
  assert.ok(empty.err.some((l) => /no publishable files/.test(l)));
  assert.equal(cli(['check', path.join(bare, 'leak.md')], bare).code, 2);
});

test('exportTree: any remote, fetch or push, in any URL form, that is the public repository is refused, and so is a manifest without one', (t) => {
  const forms = [`${URL}/`, `${URL}.git`, `ssh://${at('git', 'github.com')}/${OWNER}/ux-assessment.git`, `https://token${'@'}github.com/${OWNER}/ux-assessment.git`,
    `${at('git', 'alias')}:${OWNER}/ux-assessment.git`, `git://github.com/${OWNER}/ux-assessment`, `https://www.github.com/${OWNER}/ux-assessment`,
    URL.toUpperCase()];
  for (const form of forms) {
    const src = repo(t, good());
    git(src, 'remote', 'add', 'upstream', form);
    assert.throws(() => exportTree(src, tree(t, {})), /public repository URL/, form);
  }
  const split = repo(t, good());
  git(split, 'remote', 'add', 'origin', `${URL}-private.git`);
  git(split, 'remote', 'set-url', '--push', 'origin', `${URL}.git`);
  assert.throws(() => exportTree(split, tree(t, {})), /public repository URL/);
  const bare = repo(t, { ...good(), '.claude-plugin/plugin.json': manifest({ repository: undefined }) });
  assert.throws(() => exportTree(bare, tree(t, {})), /public repository/);
});

test('exportTree: refuses a checkout whose scan finds a problem', (t) => {
  const src = repo(t, { ...good(), 'leak.md': `at ${['', 'Users', 'someone'].join('/')}\n` });
  assert.throws(() => exportTree(src, tree(t, {})), /1 problem/);
});

test('privateData: an address is reported whatever follows it', (t) => {
  const mail = at('me', 'gmail.com');
  assert.deepEqual(scan(t, { 'a.md': `_${mail}_\n${mail}1\n${mail}\n${at('persona', 'example.com')}\n` }),
    ['a.md:1: e-mail address', 'a.md:2: e-mail address', 'a.md:3: e-mail address']);
});

test('privateData: a reference into an unpublished directory is found in prose, code and links, in every form', (t) => {
  const p = (...parts) => parts.join('/');
  const lines = [p('.', 'work', 'n.md'), p('..', 'work', 'n.md'), p('', 'repo', 'work', 'n.md'), p('.', 'docs', 'superpowers', 'plans', 'x.md'),
    ['work', 'n.md'].join('\\'), p('.superpowers', 'x.md'), `// see ${p('.', 'spike', 'a.js')}`];
  const found = scan(t, { 'src/c.js': lines.join('\n') }).filter((l) => l.startsWith('src/c.js'));
  assert.deepEqual(found, lines.map((_, i) => `src/c.js:${i + 1}: names a file in an unpublished directory`));
  assert.deepEqual(scan(t, { 'docs/superpowers/specs/s.md': `${p('..', 'plans', '2026-x.md')}\n` }),
    ['docs/superpowers/specs/s.md:1: names a file in an unpublished directory']);
  const links = [`[t](${p('..', 'work', 'n.md')} "title")`, `[r]: ${p('..', 'work', 'n.md')}`, `<a href="${p('..', 'work', 'n.md')}">x</a>`,
    `[t](${p('..', '..', 'outside.md')})`, '[t](missing.md)', '[ok](../README.md "fine") [web](https://example.com "w")'];
  const out = scan(t, { 'docs/a.md': links.join('\n\n') }).filter((l) => l.startsWith('docs/a.md') && /link/.test(l));
  assert.equal(out.length, 5);
  assert.deepEqual(scan(t, { 'docs/ok.md': '[ok](../README.md "fine")\n\nwork/ and C:/work/app and src/work/x.js\n' }), []);
});

test('privateWords: the name is found as a plural, in other spellings and in a longer word; unrelated words are not', () => {
  const acme = hashOf('acme-app');
  for (const text of ['acme-apps', 'acme_app', 'AcmeApp', 'acme app', 'acme.app', 'ACMEApp', 'x/acme-app/y']) {
    assert.ok(privateWords(text, acme).length > 0, text);
  }
  const zork = hashOf('zork');
  for (const text of ['zorks', 'zork2', 'zorkApp', 'Zork']) assert.ok(privateWords(text, zork).length > 0, text);
  assert.deepEqual(privateWords('acme and an app, zor', new Set([...acme, ...zork])), []);
  assert.ok(privateWords('acmeapp', hashOf('acmeapp')).length > 0);
});

test('freshRepoProblems: .superpowers, every ref and the commit message are checked', (t) => {
  const noreply = at('1+octo', 'users.noreply.github.com');
  const fresh = repo(t, { ...good(), [['.superpowers', 'x.md'].join('/')]: 'x' }, noreply);
  assert.deepEqual(freshRepoProblems(fresh), ['.superpowers/ exists in the public tree']);
  const other = repo(t, good(), noreply);
  git(other, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(other, 'b.md'), 'x');
  git(other, 'add', '-A');
  git(other, '-c', `user.email=${at('me', 'gmail.test')}`, 'commit', '-q', '-m', 'side');
  git(other, 'checkout', '-q', 'main');
  assert.deepEqual(freshRepoProblems(other), ['history has 2 commits; the public repository starts from one', 'a commit e-mail is not a GitHub noreply address']);
  const msg = repo(t, good(), noreply);
  fs.appendFileSync(path.join(msg, 'README.md'), 'more\n');
  git(msg, '-c', `user.email=${noreply}`, 'commit', '-q', '--amend', '-a', '-m', `fix\n\nat ${['', 'Users', 'someone'].join('/')}\n\nCo-Authored-By: A <${at('a', 'gmail.com')}>`);
  assert.deepEqual(freshRepoProblems(msg).map((p) => p.replace(/ \(sha256 \w+\)/, '')), ['commit message: local path', 'commit message: e-mail address']);
});

test('privateData: a problem line never echoes the matched text, only file:line and a sha256 prefix (R4)', (t) => {
  const hashes = hashOf('acme-app');
  const sha16 = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
  const p = (...parts) => parts.join('/');
  const secrets = [p('..', 'acme-app', 'n.md'), p('.', 'work', 'acme-app-notes.md'), p('', 'Users', 'someone', 'app'), at('someone', 'mail.test')];
  const files = { 'a.md': [`[x](${secrets[0]})`, `see ${secrets[1]}`, `at ${secrets[2]}`, `mail ${secrets[3]}`].join('\n') };
  const problems = privateData(tree(t, { ...good(), ...files }), hashes);
  assert.ok(problems.length >= 5, problems.join('\n'));
  for (const line of problems) for (const raw of [...secrets, 'acme-app', 'someone', 'notes.md']) assert.ok(!line.includes(raw), `${line} echoes ${raw}`);
  assert.ok(problems.some((l) => l.startsWith('a.md:1: link ') && l.includes(`(sha256 ${sha16(secrets[0])})`) && l.endsWith('leaves the published tree')), problems.join('\n'));
  assert.ok(problems.some((l) => l.startsWith('a.md:4: e-mail address (sha256 ')), problems.join('\n'));
});

test('privateData: a reference after a colon is found, a drive-letter path is not', (t) => {
  const lines = [`git show HEAD:${['work', 'notes.md'].join('/')}`, `path:${['work', 'notes.md'].join('/')}`, `main:${['docs', 'superpowers', 'plans', 'p.md'].join('/')}`, 'C:/work/app'];
  assert.deepEqual(scan(t, { 'src/d.js': lines.join('\n') }).filter((l) => l.startsWith('src/d.js')),
    [1, 2, 3].map((n) => `src/d.js:${n}: names a file in an unpublished directory`));
});

test('this repository: nothing private in any publishable file', () => {
  assert.deepEqual(privateData(ROOT), []);
  for (const rel of ['knowledge/cost.md', 'docs/superpowers/specs/2026-09-28-open-source-release-design.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, rel), 'utf8'), /\bfilm\b/i, `${rel}: the timer app's old label`);
  }
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(ignore, /^work\/$/m);
  assert.match(ignore, /^\.superpowers\/$/m);
});

test('this repository: LICENSE, the manifests and every mention of the owner agree', () => {
  assert.deepEqual(manifestProblems(ROOT), []);
});

test('this repository: ready to publish — no private data, manifests agree, CI covers macOS, Windows and Ubuntu', () => {
  assert.deepEqual(ciProblems(ROOT), []);
  assert.deepEqual(releaseProblems(ROOT), []);
});
