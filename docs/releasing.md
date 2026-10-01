# Releasing

For the maintainer. `node scripts/release.mjs check` verifies what a machine can verify on this page;
`driver/test/release.test.mjs` runs the same rules in the test suite.

## Every release

1. Set the new version in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
   `.claude-plugin/marketplace.json` and `driver/package.json` (and its lock file). The check fails when they differ.
2. Run `cd driver && npm test`, then `node scripts/release.mjs check`. It must print `release check: ok`.
3. Merge to `main` and wait for CI to be green on macOS, Windows and Ubuntu.
4. Prove the run is green: `gh run list --repo themiddnight/ux-assessment --workflow ci --branch main --limit 1 --json status,conclusion`
   must show `completed` and `success`, and `node scripts/release.mjs check --github themiddnight/ux-assessment`
   must print `release check: ok`. Only then tag that commit (`git tag v<version>`, `git push origin v<version>`).

## First publication (one time)

The public repository starts from **one commit** made from a cleaned copy of the private one (SPEC D33).
The private repository keeps the full history and the notes that are not published (`work/`, `spike/`,
`docs/superpowers/plans/` and `.superpowers/`). Run the steps yourself, in order, one block at a time.
Each step ends with the output that proves it, or says what to look at.

The commit you publish is the merged result on the private repository's `main`. A merge to the private
`main` starts a push-triggered macOS CI run (10x minutes while private) unless the merge commit message
carries `[skip ci]`.

### Step 1: Free the name, and point the private checkout away from it

```bash
gh repo rename ux-assessment-private --repo themiddnight/ux-assessment --yes
git remote set-url origin https://github.com/themiddnight/ux-assessment-private.git
git remote -v
```

`git remote -v` must list only `-private` URLs, for every remote, fetch and push. Other clones of the
private repository, on other machines, need the same `set-url` before their next push. GitHub redirects the old name only until a new
repository takes it; after that, a push from a checkout that still uses the old URL lands in the
public repository. This step is a precondition of the export in step 2: it refuses to run while any
remote's fetch or push URL is the public repository, in any URL form. A `pushurl` setting or a second
remote that points at the public name blocks it too, so fix those as well.
The export also refuses when it finds private data in a publishable file, and when
`.claude-plugin/plugin.json` has no `repository`.

### Step 2: Check the commit you publish, then export it

On that commit, with no uncommitted changes:

Delete any earlier export directory first (`rm -rf ../ux-assessment-public`); the export refuses a
directory that is not empty, and you must never continue in a stale one.

```bash
cd driver && npm test && cd ..
node scripts/release.mjs check
node scripts/release.mjs export ../ux-assessment-public && cd ../ux-assessment-public
```

Expected: every test passes, `release check: ok`, `exported <n> files`. Every later step runs in the new
directory. If the export prints a refusal, the `cd` does not run: fix the cause in the private checkout.

### Step 3: One commit, under a GitHub noreply address

GitHub shows the address under Settings → Emails; it looks like `<id>+<login>@users.noreply.github.com`.
The public history must be exactly one commit on exactly one branch, and its message must carry no
`Co-Authored-By` trailer: `--fresh` scans the commit messages on every ref and fails on any e-mail address
that is not at `example.com` or `users.noreply.github.com`. Install `gitleaks` once with `brew install gitleaks`.

```bash
gitleaks dir .
git init -b main
git config user.name "Pathompong Thitithan"
git config user.email "<the noreply address>"
git add -A
git commit -m "ux-assessment 0.3.0"
gitleaks git .
node scripts/release.mjs check --fresh
```

Expected: `no leaks found` twice, then `release check: ok` (one commit on one branch, a noreply address, no
trailer, no unpublished directory, nothing private, the manifests agree).

### Step 4: Run the suite and the validators in the export

```bash
node scripts/install.mjs --deps-only
cd driver && npm test && cd ..
npx -y @anthropic-ai/claude-code plugin validate .
npx -y @anthropic-ai/claude-code plugin validate .claude-plugin/plugin.json
```

Expected: every test passes and both validators report success. A failure here is a fix in the private
checkout (see "If a step fails"), not in this directory.

### Step 5: Publish, then set up the repository

Run this in the export directory (`../ux-assessment-public`). Any commit made there after step 3 means:
go back to step 2. Before the first command, prove the state:

```bash
git remote -v
node scripts/release.mjs check --fresh
```

Expected: `git remote -v` prints nothing, and `release check: ok`. Only then run the block below.

The first command in it cannot be undone. The branch protection blocks force pushes and branch deletion on
`main` only: no required reviews and no required checks yet.

```bash
gh repo create themiddnight/ux-assessment --public --source . --remote origin --push --description "Simulated users for your web app: a Claude Code and Codex skill that runs personas in real browsers and triages what they hit."
gh label create codex-self-check --repo themiddnight/ux-assessment --color 5319e7 --description "A Codex self-check result from Windows or Linux" --force
gh label create bug --repo themiddnight/ux-assessment --color d73a4a --description "Something is not working" --force
gh api -X PUT repos/themiddnight/ux-assessment/private-vulnerability-reporting
gh api -X PUT repos/themiddnight/ux-assessment/branches/main/protection --input - <<'JSON'
{"required_status_checks": null, "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null, "allow_force_pushes": false, "allow_deletions": false}
JSON
```

Expected: the repository exists and `main` is pushed; the last command prints the protection settings.

### Step 6: Wait for the first CI run on `main`, then tag

It is the first run on macOS. If a job is red, the repository is already public, so the fix is an ordinary
commit on public `main` (the same noreply identity, no `Co-Authored-By` trailer), ported back to the
private repository. Do not re-export, and never force-push. Do not tag until the run is green.

First prove the run is green. This block does not tag anything:

```bash
gh run list --repo themiddnight/ux-assessment --workflow ci --branch main --limit 1 --json databaseId,status,conclusion
gh run watch <databaseId from above> --repo themiddnight/ux-assessment --exit-status
node scripts/release.mjs check --github themiddnight/ux-assessment
```

Expected: `completed` and `success`, then `release check: ok` (public, both labels, private vulnerability
reporting on, `main` protected, the latest CI run on `main` green). `gh run list` exits 0 for a running or a
red run, so read its output.

Only when the run above is green, tag:

```bash
git tag v0.3.0
git push origin v0.3.0
```

### Step 7: Install it the way a user does

On a clean machine or account, in Claude Code: `/plugin marketplace add themiddnight/ux-assessment`, then
`/plugin install ux-assessment@ux-assessment`, then the `--deps-only` step from the README, and run one
assessment. Optional, with your own key (one small model call per OS):

```bash
gh secret set OPENAI_API_KEY --repo themiddnight/ux-assessment
gh workflow run codex-canary.yml --repo themiddnight/ux-assessment
```

### Step 8: Update what the first green macOS run makes false

Once the first CI run on `main` is green on macOS, one commit on public `main` (noreply identity, no
trailer) updates every claim that says macOS has not run: `README.md` (the "Not verified yet" bullet
about macOS, near lines 56-57, and the CI bullet's "Windows and Ubuntu only" and "on Windows and
Ubuntu", near lines 49-52),
`CONTRIBUTING.md` (the CI sentence, near line 51), and the assertion in `driver/test/docs.test.mjs`
(near lines 174-175) that pins the "has not run yet" sentence. Run the docs tests, then push the commit
to `main` and port it back to the private repository.

From here the public repository is the primary one; private notes live outside it.

## If a step fails

- Before step 5: a fix is made in the private checkout and exported again from step 2 (delete the old
  export directory first). Never commit a fix in the export: it would break the one-commit history.
  After step 5 the repository is public: see step 6, a fix is an ordinary commit on public `main`.
- The repository was created but the push failed: from the export, run `git push -u origin main`.
- Something private is found after publishing: make the repository private or delete it in the GitHub
  settings. A force push does not unpublish it, and it is blocked. Then start again from step 2.
- Recovery never needs a force push to the public repository.
