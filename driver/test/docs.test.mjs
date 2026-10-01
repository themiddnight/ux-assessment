// Checks every claim in the published docs that a machine can check (phase 4, spec component 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { ownerOf, privateWords } from '../../scripts/release-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Every published Markdown doc this file guards.
const DOCS = ['SECURITY.md', 'CONTRIBUTING.md', 'README.md', 'docs/releasing.md'];
const TEMPLATES = ['.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/codex-self-check.yml'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const FENCE = /^```[^\n]*\n([\s\S]*?)^```[^\n]*$/gm;

/** Fenced blocks and inline code spans: the places a reader copies commands from. */
function codeOf(text) {
  const fences = [...text.matchAll(FENCE)].map((m) => m[1]);
  const spans = [...text.replace(FENCE, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...fences, ...spans];
}

/** GitHub heading anchors (duplicates ignored: the docs must not rely on `-1` suffixes). */
function headingSlugs(text) {
  return new Set([...text.replace(FENCE, '').matchAll(/^#{1,6}\s+(.+)$/gm)]
    .map((m) => m[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')));
}

/** `node <script>.mjs <args>` in code; the script may sit under `<plugin dir>/`, `<checkout>/` or `$PLUGIN/`. */
function nodeCommands(text) {
  const re = /\bnode\s+"?(?:<[^>\n]+>[\\/]|\$PLUGIN\/)?([\w./-]+\.mjs)"?([^\n|;&`]*)/g;
  return codeOf(text).flatMap((code) => [...code.matchAll(re)].map((m) => ({ script: m[1], args: m[2].trim(), line: m[0] })));
}

/** The script plus the `./` modules it imports: where its usage text and flag parsing live. */
function sourcesOf(rel) {
  const file = [path.join(ROOT, rel), path.join(ROOT, 'driver', rel)].find((f) => fs.existsSync(f));
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  const deps = [...text.matchAll(/from\s+'(\.\/[\w.-]+\.mjs)'/g)]
    .map((m) => fs.readFileSync(path.join(path.dirname(file), m[1]), 'utf8'));
  return [text, ...deps].join('\n');
}

test('docs: relative links and anchors resolve', () => {
  for (const doc of DOCS) {
    const text = read(doc);
    for (const [, target] of text.replace(FENCE, '').matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [file, anchor] = target.split('#');
      const rel = file ? path.join(path.dirname(doc), file) : doc;
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${doc}: link ${target} does not resolve`);
      if (anchor && rel.endsWith('.md')) assert.ok(headingSlugs(read(rel)).has(anchor), `${doc}: anchor ${target} not found`);
    }
  }
});

test('docs: every node command names a script that exists, with subcommands and flags it knows', () => {
  for (const doc of [...DOCS, ...TEMPLATES]) {
    for (const { script, args, line } of nodeCommands(read(doc))) {
      const source = sourcesOf(script);
      assert.ok(source, `${doc}: ${line}: no script ${script}`);
      const sub = args.split(/\s+/)[0];
      if (/^[a-z][a-z-]*$/.test(sub)) assert.match(source, new RegExp(`['"]${sub}['"]`), `${doc}: ${line}: ${script} has no subcommand ${sub}`);
      for (const [, flag] of args.matchAll(/(?:^|[\s[])(--[a-z][\w-]*)/g)) {
        assert.ok(source.includes(flag), `${doc}: ${line}: ${script} has no flag ${flag}`);
      }
    }
  }
});

test('docs: no private names, local paths, e-mail addresses or skill-forbidden commands', () => {
  for (const doc of [...DOCS, ...TEMPLATES]) {
    const text = read(doc);
    assert.deepEqual(privateWords(text), [], `${doc}: private name`);
    assert.doesNotMatch(text, /\/Users\/|~\/Sites/, `${doc}: local path`);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, `${doc}: e-mail address`);
    for (const code of codeOf(text)) {
      assert.doesNotMatch(code, /\bcurl\b|\bjq\b|\bdate\s+-u\b/, `${doc}: forbidden command in ${JSON.stringify(code.slice(0, 80))}`);
    }
  }
});

test('issue templates: valid issue forms; the self-check form asks for what upgrades "experimental"', () => {
  const config = YAML.parse(read('.github/ISSUE_TEMPLATE/config.yml'));
  assert.equal(config.blank_issues_enabled, false);
  assert.ok(config.contact_links.some((l) => l.url === `https://github.com/${ownerOf(ROOT)}/ux-assessment/security/advisories/new`));
  const TYPES = new Set(['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']);
  for (const rel of TEMPLATES.filter((f) => !f.endsWith('config.yml'))) {
    const form = YAML.parse(read(rel));
    for (const key of ['name', 'description', 'body']) assert.ok(form[key], `${rel}: ${key}`);
    const ids = new Set();
    for (const item of form.body) {
      assert.ok(TYPES.has(item.type), `${rel}: type ${item.type}`);
      if (item.type === 'markdown') { assert.ok(item.attributes?.value, `${rel}: markdown value`); continue; }
      assert.ok(item.attributes?.label, `${rel}: label`);
      assert.match(item.id, /^[a-z][a-z0-9_]*$/, `${rel}: id`);
      assert.ok(!ids.has(item.id), `${rel}: duplicate id ${item.id}`);
      ids.add(item.id);
      if (item.type === 'dropdown') assert.ok(item.attributes.options.length >= 2, `${rel}: ${item.id} options`);
      if (item.type === 'checkboxes') assert.ok(item.attributes.options.every((o) => o.label), `${rel}: ${item.id} options`);
    }
  }
  const form = YAML.parse(read('.github/ISSUE_TEMPLATE/codex-self-check.yml'));
  assert.deepEqual(form.labels, ['codex-self-check']);
  const byId = Object.fromEntries(form.body.filter((i) => i.id).map((i) => [i.id, i]));
  assert.deepEqual(byId.os.attributes.options, ['Windows', 'Linux', 'macOS']);
  assert.deepEqual(byId.result.attributes.options, ['PASS', 'FAIL']);
  for (const id of ['os', 'os_version', 'codex_version', 'node_version', 'result', 'output']) {
    assert.equal(byId[id].validations?.required, true, `${id} is required`);
  }
  assert.equal(byId.output.attributes.render, 'json');
  assert.match(byId.output.attributes.description, /self-check --json --project/);
});

test('SECURITY.md: private reporting, what counts as a bypass, the residual risks', () => {
  const text = read('SECURITY.md');
  assert.match(text, /security\/advisories\/new/);
  for (const risk of [/apply_patch/, /web search/i, /ALLOW feature/, /Windows/, /canaries it plants/]) assert.match(text, risk);
  assert.match(text, /anything beyond `act` and `end_session`/);
});

test('CONTRIBUTING.md: the sections, the commands CI runs, the isolation invariants', () => {
  const text = read('CONTRIBUTING.md');
  const headings = [...text.replace(FENCE, '').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['Set up', 'Run the tests', 'Isolation invariants', 'The Codex self-check',
    'Dogfood a change', 'Specs, plans and decisions', 'Pull requests', 'Reporting Windows and Linux results']);
  const code = codeOf(text).join('\n');
  for (const cmd of ['node scripts/install.mjs --deps-only', 'cd driver && npm test',
    'node driver/codex-runner.mjs self-check --offline', 'npx -y @anthropic-ai/claude-code plugin validate .',
    'npx -y @anthropic-ai/claude-code plugin validate .claude-plugin/plugin.json']) {
    assert.ok(code.includes(cmd), `CONTRIBUTING.md shows ${cmd}`);
  }
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /node driver\/codex-runner\.mjs self-check --offline/); // the doc and CI run the same gate
  assert.match(text, /`act` and `end_session`/);
  assert.match(text, /runs on pushes to `main` and on pull requests: macOS, Windows and Ubuntu/);
  assert.doesNotMatch(text, /not in the matrix/);
  assert.match(text, /\.github\/ISSUE_TEMPLATE\/codex-self-check\.yml/);
});

const README_HEADINGS = ['What it finds, and what it cannot', 'Support matrix', 'Not verified yet', 'Install',
  'Claude Code from the marketplace', 'From a clone (Claude Code and Codex)', 'Windows and Linux: run the Codex self-check',
  'Notes per OS', 'Use it', 'How it works', 'Pipeline', 'Knowledge isolation', 'What a persona can do',
  'Triage and evidence', 'Verify fixes', 'The clock', 'Pieces', 'Models per role', 'Tokens and subscriptions',
  'Where data goes', 'Uninstall', 'Known limits', 'Contributing and security'];

const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section ${heading}`);
  const end = text.indexOf('\n## ', start + 4);
  return text.slice(start, end < 0 ? undefined : end);
};

test('README: the sections, in order', () => {
  const headings = [...read('README.md').replace(FENCE, '').matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, README_HEADINGS);
});

test('README: honest status — nothing claims CI or a real Windows machine verified it', () => {
  const text = read('README.md');
  assert.doesNotMatch(text, /CI-verified|verified (in|by) CI|tested in CI/i);
  const status = section(text, 'Support matrix');
  for (const fact of [/ran green/i, /timed out/i, /codex-canary\.yml/, /OPENAI_API_KEY/, /not (yet )?(been )?run on a real Windows( or Linux)? machine/i, /57 %/, /Experimental/]) {
    assert.match(status, fact);
  }
  assert.match(text, /self-check is on record[^.]*feature\s+set[^.]*`features_hash`/);
  const ci = YAML.parse(read('.github/workflows/ci.yml'));
  assert.ok(ci.jobs.test.strategy.matrix.os.includes('macos-latest'));
  assert.doesNotMatch(status, /macOS is not in the CI matrix/);
  assert.match(status, /macOS is in the CI matrix and has not run yet/); // it first runs on the public repository
  assert.ok(text.includes(`https://github.com/${ownerOf(ROOT)}/ux-assessment/actions/workflows/ci.yml/badge.svg`));
  assert.match(read('knowledge/cost.md'), /57 %/); // the README figure comes from here
  assert.ok(text.includes(`/plugin marketplace add ${ownerOf(ROOT)}/ux-assessment`));
  assert.match(text, /\/plugin install ux-assessment@ux-assessment/);
});

test('README: Uninstall removes only the link, never recursively', () => {
  const text = section(read('README.md'), 'Uninstall');
  assert.doesNotMatch(text, /-Recurse|rmdir \/s|rm -rf|rm -r\b/i);
  assert.match(text, /cmd \/c rmdir "%USERPROFILE%\\\.codex\\skills\\ux-assessment"/);
});

test('README: the model table is what models.mjs shows for a project with no config', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-readme-'));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'driver', 'models.mjs'), 'show', project], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const models = section(read('README.md'), 'Models per role');
    for (const line of r.stdout.trim().split(/\r?\n/)) assert.ok(models.includes(line), `README shows: ${line}`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('README: the token tables equal knowledge/cost.md and the estimate command', async () => {
  const tokens = section(read('README.md'), 'Tokens and subscriptions');
  const cost = YAML.parse(read('knowledge/cost.md').match(/```yaml\n([\s\S]*?)```/)[1]);
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const cell = (x) => (x == null ? 'not measured' : Array.isArray(x) ? (x[0] === x[1] ? fmt(x[0]) : `${fmt(x[0])}–${fmt(x[1])}`) : fmt(x));
  for (const [harness, roles] of Object.entries(cost)) {
    for (const [role, c] of Object.entries(roles)) {
      const data = c.per_step ?? c.fixed;
      const cells = data ? [cell(data.input), cell(data.cached_input), cell(data.output)] : Array(3).fill('not measured');
      const row = `| ${[harness, role, c.model ?? 'the session model', 'per_step' in c ? 'step' : 'session', ...cells].join(' | ')} |`;
      assert.ok(tokens.includes(row), `README token row: ${row}`);
    }
  }
  const { main } = await import('../usage.mjs');
  const lines = [];
  await main(['estimate', '--harness', 'claude', '--personas', '6', '--cap', '15'], { out: (l) => lines.push(l) });
  for (const line of lines.join('\n').split('\n').filter((l) => l.startsWith('|'))) {
    assert.ok(tokens.includes(line), `README estimate row: ${line}`);
  }
});

test('docs/releasing.md: every step of the first publication names the command that proves it', () => {
  const code = codeOf(read('docs/releasing.md')).join('\n');
  const repo = `${ownerOf(ROOT)}/ux-assessment`;
  for (const cmd of [`gh repo rename ux-assessment-private --repo ${repo} --yes`, 'git remote set-url origin', 'node scripts/release.mjs check',
    'node scripts/release.mjs export ../ux-assessment-public', 'gitleaks dir .', 'gitleaks git .', 'node scripts/release.mjs check --fresh',
    `gh repo create ${repo} --public`, 'gh label create codex-self-check', 'gh label create bug', `repos/${repo}/private-vulnerability-reporting`,
    `repos/${repo}/branches/main/protection`, `node scripts/release.mjs check --github ${repo}`, 'git tag v']) {
    assert.ok(code.includes(cmd), `docs/releasing.md shows ${cmd}`);
  }
  assert.match(read('CONTRIBUTING.md'), /docs\/releasing\.md/);
});

test('docs/releasing.md: the proofs come before the steps they guard', () => {
  const code = codeOf(read('docs/releasing.md')).join('\n');
  const at = (cmd) => code.indexOf(cmd);
  const repo = `${ownerOf(ROOT)}/ux-assessment`;
  assert.ok(at('node scripts/release.mjs check --fresh') >= 0 && at('node scripts/release.mjs check --fresh') < at('gh repo create'), 'check --fresh precedes gh repo create');
  assert.ok(at('git remote -v') >= 0 && at('git remote -v') < at('node scripts/release.mjs export'), 'git remote -v precedes the export');
  const green = code.lastIndexOf(`node scripts/release.mjs check --github ${repo}`, at('git tag v0.'));
  assert.ok(green >= 0 && at('git tag v0.') >= 0, 'the green-run proof precedes git tag');
  assert.ok(at('export ../ux-assessment-public &&') >= 0, 'a failed export is not followed by the cd');
});
