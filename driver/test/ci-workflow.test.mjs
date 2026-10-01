import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('ci.yml: macOS, Windows and Ubuntu, Node 20 (+22 on Ubuntu), driver tests, the offline gate and the installer, no model key', () => {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const ci = YAML.parse(text);
  const job = ci.jobs.test;
  assert.deepEqual(job.strategy.matrix.os, ['macos-latest', 'windows-latest', 'ubuntu-24.04']);
  assert.deepEqual(job.strategy.matrix.node, [20]);
  assert.deepEqual(job.strategy.matrix.include, [{ os: 'ubuntu-24.04', node: 22 }]);
  assert.doesNotMatch(text, /ubuntu-latest/); // the ubuntu-latest label migrates to Ubuntu 26 on 2026-10-19; pin the image
  const runs = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /npm ci/);
  assert.match(runs, /npm test/);
  assert.match(runs, /node driver\/codex-runner\.mjs self-check --offline/);
  const names = job.steps.map((s) => s.name ?? '');
  const installer = job.steps[names.findIndex((n) => n.startsWith('Installer'))];
  assert.ok(installer, 'an Installer step');
  assert.ok(names.indexOf(installer.name) > names.indexOf('Locate the native codex binary'), 'after UXA_CODEX_BIN is set');
  assert.equal(installer.run.replace(/\r\n/g, '\n'),
    'node scripts/install.mjs --skip-deps --no-claude\nnode scripts/install.mjs --skip-deps --no-claude\nnode .github/scripts/check-codex-link.mjs\n');
  const validate = ci.jobs.validate.steps.map((s) => s.run ?? '').join('\n');
  assert.match(validate, /plugin validate \.$/m); // the marketplace
  assert.match(validate, /plugin validate \.claude-plugin\/plugin\.json$/m);
  assert.match(runs, /fonts-thai-tlwg/);
  assert.doesNotMatch(text, /OPENAI_API_KEY|codex exec|self-check(?! --offline)/);
  assert.deepEqual(ci.on, { push: { branches: ['main'] }, pull_request: null, workflow_dispatch: null });
  assert.ok(ci.jobs.gitleaks && ci.jobs.validate);
  // A direct push to main is scanned too, not only a pull request.
  assert.equal(ci.jobs.gitleaks.if, "github.event_name == 'pull_request' || github.event_name == 'push'");
  // A hang (e.g. a leaked handle) must not burn the default 6 h job timeout across three OSes.
  assert.equal(job['timeout-minutes'], 30);
  assert.equal(ci.jobs.validate['timeout-minutes'], 10);
  assert.equal(ci.jobs.gitleaks['timeout-minutes'], 10);
});

test('codex-canary.yml: manual only, macOS, Windows and Ubuntu, the key reaches codex through stdin only, the self-check JSON is uploaded', () => {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'codex-canary.yml'), 'utf8');
  const wf = YAML.parse(text);
  assert.deepEqual(wf.on, { workflow_dispatch: null }); // forks never see the secret
  assert.deepEqual(wf.permissions, { contents: 'read' });
  const job = wf.jobs.canary;
  assert.deepEqual(job.strategy.matrix.os, ['macos-latest', 'windows-latest', 'ubuntu-24.04']);
  assert.equal(job.strategy['fail-fast'], false);
  assert.doesNotMatch(text, /ubuntu-latest/);
  assert.equal(job['timeout-minutes'], 30);
  const runs = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /npm ci/);
  assert.match(runs, /playwright\/cli\.js install/);
  assert.match(runs, /npm install -g @openai\/codex@latest/);
  assert.match(runs, /find-codex-bin\.mjs/);
  const withKey = job.steps.filter((s) => s.env?.OPENAI_API_KEY);
  assert.equal(withKey.length, 1, 'only the sign-in step sees the key');
  assert.equal(withKey[0].env.OPENAI_API_KEY, '${{ secrets.OPENAI_API_KEY }}');
  assert.match(withKey[0].run, /^printenv OPENAI_API_KEY \| "\$UXA_CODEX_BIN" login --with-api-key\s*$/);
  assert.doesNotMatch(runs, /secrets\./, 'no secret on a command line');
  const check = job.steps.find((s) => /codex-runner\.mjs self-check/.test(s.run ?? ''));
  assert.match(check.run, /^node driver\/codex-runner\.mjs self-check --json > "self-check-\$\{\{ matrix\.os \}\}\.json"\s*$/);
  const upload = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.path, 'self-check-${{ matrix.os }}.json');
});
