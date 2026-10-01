# Contributing to ux-assessment

Thank you for helping. This page covers how to set up, test and change the project safely.

## Set up

You need Node.js 20 or newer with npm. Clone the repository, then run:

```
node scripts/install.mjs --deps-only
```

This installs the locked driver dependencies and Playwright Chromium, and nothing else. Check that they are in place with:

```
node driver/probe.mjs deps
```

It prints `ok`, or lists what is missing together with the command above. For a full local install for both harnesses (Claude Code and Codex), run `node scripts/install.mjs`; the README's "Install" section describes it.

On Linux, install the `fonts-thai-tlwg` package so Thai text renders in screenshots. If Chromium does not start, run `npx playwright install-deps chromium` in `driver/` (it needs sudo).

## Run the tests

```
cd driver && npm test
```

This runs every `driver/test/*.test.mjs` file, one file at a time. To run a single file:

```
cd driver && node --test --test-concurrency=1 test/<name>.test.mjs
```

What runs where:

- The `sandbox-exec` tests run on macOS only.
- The tests that use a fake Codex are POSIX-only.
- The installer tests run on all three systems. On Windows they create a real directory junction.
- Tests never touch your real `~/.codex` or `~/.claude`.

Test output must be pristine. A new warning fails review: fix it, or suppress it at the narrowest scope with a comment saying why.

The plugin manifests are validated with:

```
npx -y @anthropic-ai/claude-code plugin validate .
npx -y @anthropic-ai/claude-code plugin validate .claude-plugin/plugin.json
```

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests: macOS, Windows and Ubuntu with Node 20 (plus Node 22 on Ubuntu), the tests, the offline Codex gate, the installer, the manifest validation and `gitleaks`. It has run green on Windows and Ubuntu; macOS is in the matrix but has not run yet, because it first runs on the public repository. Two flaky failures were found and fixed on 2026-10-01, and an earlier run failed on Windows with a timeout in `driver/test/safety.test.mjs`; if the Windows job fails there, re-run it once before you dig.

## Isolation invariants

These are not negotiable:

- A persona never gets a tool beyond `act` and `end_session` (`agents/persona.md`, `driver/persona-bridge.mjs`).
- Nothing a persona produces reaches another persona's briefing, and the verifier never looks for new problems (SPEC section 3, decision D15).
- The Codex runner disables every feature in `DENY` and refuses to run when Codex enables a feature that is in neither `DENY` nor `ALLOW` (`driver/codex-features.mjs`, D25).
- A new Codex feature is classified only after a canary run (`self-check`, not `--offline`) shows it cannot reach a canary.
- Skills and agents use `node driver/probe.mjs url|now|fetch`, never curl, date -u or jq (D28, `driver/test/portability.test.mjs`).

A change that weakens one of these is a security change: say so in the pull request.

## The Codex self-check

```
node driver/codex-runner.mjs self-check --offline
```

This runs the feature gate only, with no model call. It is what CI runs.

The full check plants three canaries (in the runner folder, outside it, and on a local HTTP port), runs one real persona, and passes only if none leaks and the tools were called:

```
node driver/codex-runner.mjs self-check --json --project <app repo>
```

It writes `<app repo>/.ux-assessment/codex-self-check.json`. On macOS, `--tools-only` skips `sandbox-exec`, so you can test the Windows and Linux layer. `--model <model>` overrides the model of the `self-check` role (`gpt-6-sol` at low effort; `node driver/models.mjs show <project>` prints the map).

The manual workflow `.github/workflows/codex-canary.yml` runs the full check on macOS, Windows and Ubuntu with the `OPENAI_API_KEY` secret. It has not run yet.

## Dogfood a change

To try a change on a real app, run from the app's repository, so that `.ux-assessment/` is the app's and the token hook records, with the app's dev server on localhost:

```
claude -p "/ux-assessment unattended <app url>" --plugin-dir <checkout> --output-format json
```

This spends real tokens (a Guided unattended run with 6 personas cost about $3.83 API-equivalent; see the token section of the README and knowledge/cost.md). The JSON's `modelUsage` is the billed truth. Compare it with:

```
node <checkout>/driver/usage.mjs report <app repo>/.ux-assessment/runs/<run folder>
```

The run folder is line 1 of `.ux-assessment/active-run`. After a measured run, update `knowledge/cost.md` and name the run in its Sources table.

## Specs, plans and decisions

`SPEC.md` is the design. Decisions are numbered rows (D1 to D33) in section 2. A change that amends one adds a row and points the old row at it, as D30 amends D18. Larger designs live in `docs/superpowers/specs/`. If you change behaviour, update `SPEC.md` and the README in the same pull request.

## Pull requests

- [ ] The tests pass on your OS with no new warnings.
- [ ] The manifests validate.
- [ ] The docs are updated.
- [ ] `driver/test/docs.test.mjs` still passes (links, commands, no private names or local paths).
- [ ] `driver/test/release.test.mjs` still passes (nothing private in any file, the manifests agree).
- [ ] No curl, date -u or jq in skills or agents.
- [ ] The isolation invariants are untouched, or the pull request says why.
- [ ] No screenshots, logs or `.ux-assessment/` data from a private app.

Maintainers: the release steps are in [docs/releasing.md](docs/releasing.md).

## Reporting Windows and Linux results

Codex on Windows and Linux is experimental. A self-check report through the "Codex self-check report" issue form (`.github/ISSUE_TEMPLATE/codex-self-check.yml`) is the most useful contribution a Windows or Linux user can make. An isolation bypass goes to `SECURITY.md`, not to an issue.
