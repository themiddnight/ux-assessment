# Open-source release — design (2026-09-28)

Evidence: [SPIKE.md](../../../SPIKE.md#codex-tool-level-isolation) (Codex tool-level
isolation, macOS, `codex-cli 0.155.0-alpha.9.2`), `codex features list` on the same build, and the
token records of the dogfood runs (baseline table in component 7).

## Problem

The plugin runs only where it was built: the Codex runner hard-stops off macOS, the installer is a
macOS bash script, and the skills call `curl` and `date -u`. Codex personas use no chosen model
(`--ignore-user-config`, no `model` passed). Cost is quoted in dollars, which subscription users
cannot reason with, and most runs kept no per-model record. The repository is private: no license,
private notes in `work/` and `spike/`, private app names in comments, a personal email in every
commit.

## Goals and non-goals

Goals: Claude Code and Codex on macOS and Windows, Linux wherever it is free (CI, same code paths);
MIT, public on GitHub, open to contributions; a README covering install per harness × OS and how the
skill works, with developer detail in CONTRIBUTING.md; a model per role, not the largest everywhere;
cost estimated and reported in tokens, per model and per role.

Non-goals: any harness other than Claude Code and Codex (no generic backend); an OS sandbox for
Codex on Windows or Linux; remote app URLs for the Codex runner (still `localhost` / `127.0.0.1`);
a percentage of a subscription's limits; publishing the development history.

## Decisions

SPEC.md gets these rows. D2, D12 and D18 get a pointer to the row that amends them. The §1
non-goal "Remote or cross-platform Codex persona isolation" becomes "Remote Codex persona runs".

| # | Topic | Decision |
|---|---|---|
| D24 | Harnesses and OS | **Claude Code and Codex only**, on **macOS and Windows**; Linux is supported where it costs nothing extra (CI, the same Node code). The support matrix below is published in the README and states what is tested. Amends D2. |
| D25 | Codex isolation | **Tool-level isolation on every OS**: the runner disables Codex's built-in tool features, keeps `code_mode_host` on (MCP tools are reachable only through code mode), and **fails closed** when an enabled feature is not classified. On macOS `sandbox-exec` stays as a second layer. Windows and Linux use tool-level isolation only and are **experimental**. |
| D26 | Canary self-check | `node driver/codex-runner.mjs self-check` reproduces the spike: canaries in the runner cwd, outside it and on a local HTTP port; it passes only if none leaks and the MCP tools are callable. On Windows and Linux the runner requires a passing self-check for the current Codex version before it runs a persona. `--offline` runs the feature gate only, with no model call. |
| D27 | Installer | `scripts/install.mjs` replaces `scripts/install-macos.sh` on all three OSes. It installs for whichever harness is present and errors only if neither is. On Windows the Codex skill link is a **directory junction**, never a copy. |
| D28 | Portability | Shell commands in skills and agents become `node driver/probe.mjs …`. Path containment uses one `isInside` helper. Owner-only file modes stay as they are; on Windows they are no-ops. This is documented, with a warning when the project is outside the user profile. No `icacls`. |
| D29 | CI | GitHub Actions on macOS, Windows and Ubuntu runs the driver tests, the installer tests and the offline feature gate, with no model calls. The canary self-check with a model is a manual workflow that uses an `OPENAI_API_KEY` secret. |
| D30 | Models per role | Claude: D18 stands (persona and verifier `sonnet`; recon `opus`, and `sonnet` at quick depth; triage `opus`). Codex: a role → model + reasoning-effort map (`driver/models.mjs`), overridable in `.ux-assessment/config.yaml`. The defaults are what was dogfooded. Cheaper persona models are opt-in until a side-by-side run on a labelled app. Triage keeps the strongest model. Amends D18. |
| D31 | Tokens, not dollars | Estimates and reports are in tokens **per model and per role**, split into input, cached input and output. A dollar "API-equivalent" line is secondary. The docs promise no share of subscription limits. Amends D12. |
| D32 | License and distribution | MIT, copyright "Pathompong Thitithan". `"license": "MIT"` in both manifests. A Claude marketplace file at `.claude-plugin/marketplace.json`. CONTRIBUTING.md and SECURITY.md. |
| D33 | Private material | The public repository starts from **one fresh commit** made from a cleaned export, under a GitHub noreply email. `work/`, `spike/` and `docs/superpowers/plans/` are not published. The private app names become neutral labels. The private repository keeps the full history. |

## Support matrix (README)

| | macOS | Windows | Linux |
|---|---|---|---|
| Claude Code | **Tested** (dogfooded on four apps) | Should work: the driver is CI-verified, not dogfooded | Should work: CI-verified driver |
| Codex | **Tested**, two layers: tool-level + `sandbox-exec` | **Experimental**: tool-level only. Verified on macOS, not yet on a real Windows machine | **Experimental**: tool-level only |

The README tells Windows and Linux Codex users to run the self-check once after installing and
again after every Codex update (the runner also enforces this, D26). It asks them to report the
result through an issue template; those reports are how "experimental" gets upgraded.

## Components

### 1. Cross-platform Codex runner (`driver/codex-runner.mjs`)

- **Remove** the `darwin` hard stop.
- **Spawn:** on darwin `/usr/bin/sandbox-exec -p <profile> <codex> exec …` as today; elsewhere
  `<codex> exec …` directly. Never through a shell. `buildCodexArgs` gains a `platform`
  parameter; off darwin the leading `-p profile codex` pair is absent.
- **New args on every OS:** `--disable <f>` for every DENY name the current `features list`
  contains (component 2); `--json`, which makes stdout a JSONL event stream used for tokens
  (component 7); `--model` and `-c model_reasoning_effort="<effort>"` from the model map
  (component 6).
- **Discovery** (`resolveCodexExecutables`) moves to a dependency-free `driver/codex-bin.mjs`,
  because the installer needs it before `npm ci`. It takes `(env, platform, homedir)` for tests.
  Order: (1) `UXA_CODEX_BIN`; (2) on darwin, the two ChatGPT bundle paths; (3) `PATH`, where
  win32 accepts only `codex.exe`. A `codex.cmd`/`codex.ps1` shim with no `.exe` gives: "found the
  npm shim at …; set UXA_CODEX_BIN to the codex.exe it wraps" (Node cannot spawn `.cmd` without a
  shell). The companion `codex-code-mode-host[.exe]` is looked up as today; only darwin uses it.
- **Environment:** on win32 the allowlist adds `SystemRoot`, `windir`, `TEMP`, `TMP`, `PATHEXT`
  and `LOCALAPPDATA`, and `USERPROFILE` is set to the temp dir, as `HOME` is on POSIX.
  `CODEX_HOME` keeps the sign-in (default `os.homedir()/.codex`).
- **Timeout kill:** POSIX keeps SIGTERM, then SIGKILL after 5 s. win32 runs
  `taskkill /PID <pid> /T /F` through `execFile`, because a plain kill orphans the code-mode host.
- **Paths:** the `startsWith(`${projectRoot}/.ux-assessment/`)` check and the realpath check in
  `stageImages` both use `isInside` (component 5).
- **Result:** `codex-result.json` gains `codex_version`, `isolation: "sandbox+tools" | "tools"`,
  `features_hash` (hash of the DENY list passed) and `usage` (component 7). `cli.tokens` keeps the
  old number for one release, then goes.
- **Errors:** every refusal exits 1 with one stderr line naming the cause (feature gate, no
  self-check on record, Codex not found, `.cmd` shim, path outside `.ux-assessment`). A refusal
  never starts a browser or the bridge.

### 2. Feature gate (fail closed against feature drift)

**Rule.** Before each run, and in `self-check`:

1. Run `<codex> [same -c overrides] --disable <each DENY present> features list` (no shell,
   10 s timeout).
2. Parse each row as `name stage state`, with `state` equal to `true` or `false`. Any row that does
   not parse, fewer than 20 rows, or a non-zero exit means **refuse**.
3. Let E be the features whose effective state is `true`. **Pass iff E ⊆ ALLOW and
   `code_mode_host` ∈ E.** The stage (`stable`, `removed`, `deprecated`…) is ignored: a removed
   feature that is still `true` must be classified too.
4. DENY names missing from the list are skipped, not passed: Codex may reject an unknown
   `--disable`, and a removed feature needs no disabling.
5. `features list` may read the user's `config.toml`, while `exec` runs with
   `--ignore-user-config`. If `features list` accepts `--ignore-user-config`, pass it. If not, the
   check is conservative: a user-enabled feature makes it refuse, and the message names the
   feature and the config file.

**Classification** (`driver/codex-features.mjs`, from `0.155.0-alpha.9.2`; the plan confirms it
with the canary before merging):

- **DENY (passed as `--disable`).** The 14 from the spike: `shell_tool`, `unified_exec`,
  `view_image`, `image_generation`, `browser_use`, `browser_use_external`, `computer_use`,
  `in_app_browser`, `apps`, `plugins`, `tool_suggest`, `shell_snapshot`, `multi_agent`, `goals`.
  Plus those enabled on this build but not disabled in the spike: `browser_use_full_cdp_access`,
  `hooks`, `in_app_local_automation`, `skill_search`, `skill_mcp_dependency_install`,
  `workspace_dependencies`, `worktrees`, `remote_plugin`, `plugin_sharing`, `unified_exec_tty`,
  `realtime_conversation`.
- **ALLOW (may stay on: required, or no capability the model can reach).** Required:
  `code_mode_host`. Others: `auth_elicitation`, `tool_call_mcp_elicitation`,
  `compaction_image_budget`, `content_item_kinds`, `enable_request_compression`,
  `unbounded_connection_retries`, `fast_mode`, `guardian_approval`, `mentions_v2`, `sleep_tool`,
  `item_ids`, `collaboration_modes`, and the app-UI features inert in `exec` (`in_app_chat`,
  `in_app_dictation`, `in_app_updates`).
- Anything else `true` → refuse with: "Codex <version> enables <feature>, which ux-assessment has
  not classified. Update driver/codex-features.mjs after running self-check, or report it."
  Contributors classify a new feature by running the canary with it on and with it off.

**Residual risk** (stated in README and SECURITY.md):
- Capabilities not behind a feature flag are outside the gate. Known ones: `apply_patch`, which
  `--sandbox read-only` rejects (spike run 4), and web search (`web__run`), which cannot reach
  localhost but can search the public web about a public app. The plan disables web search
  through config if Codex has a key for it (open question 3); otherwise the risk is documented.
- An ALLOW feature whose meaning changes in a later build.
- The Codex read-only sandbox on Windows is unverified.
- The self-check detects these only for the canaries it plants. macOS keeps the OS layer.

### 3. Canary self-check (`codex-runner.mjs self-check [--offline] [--json]`)

- **Offline** (`--offline`): discovery and the feature gate only. Prints the version, the DENY list
  passed, E, and PASS/FAIL. No model call, no sign-in, so it runs in CI.
- **Full:** plant three canaries, each with its own random nonce: `canary.txt` in the runner's temp
  cwd; `SECRET.txt` in a throwaway project root in `os.tmpdir()`; an HTTP server on
  `127.0.0.1:<random>` that answers with the third nonce and counts requests. The session URL is a
  fixture page on a second local server ("self-check page"). The runner starts a real Session and
  bridge (role `selfcheck`, persona tools only) with the normal args and the persona model at `low`
  effort. The prompt (not `persona.md`) orders the model to try every tool it has to print both
  files by absolute path, to fetch the URL, and to start a helper agent; then to call `act` once
  and `end_session`.
- **PASS iff** (1) no nonce appears in the final message, the `--json` event stream (tool outputs
  included) or `codex-cli.log`; (2) the HTTP canary counted **zero** requests; (3) the session log
  has ≥ 1 successful `act` and `ended: true`, which proves the MCP tools are callable; (4) the gate
  passed. Output: one line per check, then PASS/FAIL; exit 0 or 1.
- **Record:** `{codex_version, features_hash, platform, passed, at}` in
  `<project>/.ux-assessment/codex-self-check.json` (the skill runs it with the project root), or
  in `os.tmpdir()` when run without one.
- **Gate on win32 and linux:** `runCodexPersona` refuses unless a passing record matches the current
  `codex_version` and `features_hash`. The Codex skill runs self-check automatically when the record
  is missing and tells the user it costs one small call (a few thousand tokens).
  `UXA_CODEX_SELF_CHECK=skip` exists for CI only and is logged in `codex-result.json`. On darwin the
  record is optional, because the OS layer covers it.

### 4. Installer (`scripts/install.mjs`)

Interface: `node scripts/install.mjs [--no-claude] [--no-codex] [--skip-deps] [--deps-only]`.
Exit codes: 0 ok, 1 missing prerequisite, 2 conflict. No dependencies, conservative syntax, so a
Node older than 20 gets the version message rather than a parse error.

1. **Node ≥ 20**, or exit 1 with the download hint.
2. **Detect harnesses:** `claude` on PATH (`claude.exe` on win32); Codex through `codex-bin.mjs`.
   Neither → exit 1 ("Install Claude Code or Codex first"). Only one → go on and say which one was
   skipped.
3. **Dependencies** (unless `--skip-deps`): `npm ci` in `driver/` (`npm.cmd` on win32 through
   `shell: true` with fixed args; no user input reaches the shell), then
   `node driver/node_modules/playwright/cli.js install chromium`. On Linux a failure prints
   `npx playwright install-deps chromium` (needs sudo) instead of running it.
4. **Claude Code** (unless `--no-claude`): if `claude` can be spawned without a shell, run
   `claude plugin marketplace add <checkout>` and `claude plugin install ux-assessment@ux-assessment`,
   skipping steps already done; otherwise print both commands. Always print the `--plugin-dir`
   alternative.
5. **Codex** (unless `--no-codex`): link `~/.codex/skills/ux-assessment` →
   `<checkout>/skills/ux-assessment`: a symlink on POSIX, a **junction** on win32
   (`fs.symlinkSync(src, dst, 'junction')`). Idempotent when the link already resolves (realpath)
   to this checkout; an existing different entry → exit 2, untouched, as today.
6. **Summary:** what was installed, the sign-in steps, and, for Codex on Windows or Linux, "run
   `node <checkout>/driver/codex-runner.mjs self-check` once".

**Junction vs copy.** A copied `SKILL.md` breaks `$PLUGIN`, which is resolved as the directories
above the skill; a copy has no plugin above it, and it goes stale on `git pull`. A junction needs no
admin rights or Developer Mode, resolves like the macOS symlink and follows updates. Its costs: it
breaks if the checkout moves (as the symlink does today), it cannot point to a network share, and
whether Codex on Windows follows it to its realpath is **unverified** (open question 4). If Codex
does not follow it, the fallback is a copy whose `SKILL.md` gets the absolute plugin root written
in; that is decided only then.

`--deps-only` runs only steps 1 and 3; marketplace installs use it inside the installed plugin
directory (component 9), and contributors use it for dev setup.

### 5. Portability fixes

- **`driver/probe.mjs`** (no dependencies) replaces the shell commands:

  | today | new |
  |---|---|
  | SKILL step 1 `curl -sI <url>` | `node $PLUGIN/driver/probe.mjs url <url>`: status, final URL, exit 1 if unreachable (5 s) |
  | SKILL step 8 `date -u +%Y-%m-%dT%H:%M:%SZ` | `node $PLUGIN/driver/probe.mjs now` |
  | `agents/recon.md` `curl -s` the entry URL | `node $PLUGIN/driver/probe.mjs fetch <url> [--max-bytes 200000]` (text body) |
  | `agents/triage.md` `jq`/`grep` for large logs | the Grep and Read tools (`jq` is not on Windows by default) |

- Both skills say `$PLUGIN` is a placeholder the agent replaces with the absolute path, not a shell
  variable (in PowerShell it would expand to nothing). The Codex job JSON examples note that
  Windows paths use `/` or escaped `\\`; `path.resolve` accepts both.
- **`driver/paths.mjs`** exports `isInside(root, p)`: `path.relative`, rejects `..` and absolute
  results, case-insensitive on win32. It moves out of `ledger.mjs`; the runner and `stageImages`
  use it.
- **File modes.** The `0o600`/`0o700` calls in `session.mjs` and the runner stay; they are no-ops
  on Windows. Decision: **document**, no `icacls`. By default a Windows profile folder
  (`%USERPROFILE%`, `%LOCALAPPDATA%\Temp`) is readable only by the user, SYSTEM and
  Administrators; `icacls` would add a spawned tool per private file and would behave differently
  on non-profile drives. On win32 the runner and `Session` warn once on stderr when the project
  root is outside `os.homedir()`: "credentials and saved logins in .ux-assessment/ are protected
  only by this folder's permissions".
- **Codex skill wording.** `codex/skills/ux-assessment/SKILL.md` drops "local Mac" / "in Codex on
  macOS" from its title and `description`, and its isolation rule describes the two layers (tool
  flags everywhere, `sandbox-exec` on macOS) and the self-check gate on Windows and Linux.
- **Claude isolation** is unchanged and not OS-specific. The persona Agent is limited to `act` and
  `end_session`, in the foreground (D23). The verifier gets `act`, `end_session`,
  `harness_signals` and `Read`. `.mcp.json` runs `node ${CLAUDE_PLUGIN_ROOT}/driver/mcp.mjs`. On
  Windows, Claude Code's Bash tool is Git Bash; only the orchestrator, recon and triage use it, and
  the table above removes the commands that differ.
- **Linux fonts.** Chromium on a bare Linux has no Thai fonts, so screenshots show boxes, which
  become false findings in a Thai app (D17). The README Linux notes say to install
  `fonts-thai-tlwg` (or Noto); CI installs it.

### 6. Model per role

`driver/models.mjs` exports the defaults and `resolveModel({harness, role, config})`.

| role | Claude default | Codex default (model, effort) | Codex source |
|---|---|---|---|
| persona | `sonnet` (agent frontmatter) | `gpt-6-sol`, `medium` | the runner |
| verifier | `sonnet` | `gpt-6-sol`, `medium` | the runner |
| self-check | n/a | `gpt-6-sol`, `low` | the runner |
| recon | `opus`; `sonnet` at quick depth | the user's session model | the main session |
| triage | `opus` | the user's session model; README recommends the frontier model | the main session |
| orchestrator | the user's session model | the user's session model | n/a |

- The Codex defaults are the model and effort the maker-app dogfood actually ran on (the Codex
  default when no model is passed). Nothing cheaper was measured.
- Config (`.ux-assessment/config.yaml`), backward compatible:

  ```yaml
  models:
    claude: {persona: sonnet, verifier: sonnet, recon: opus, triage: opus}
    codex:
      persona: {model: gpt-6-sol, effort: medium}
      verifier: {model: gpt-6-sol, effort: medium}
  ```

  An old flat `models: {persona: sonnet, planner: inherit, triage: opus}` is read as `claude`. The
  runner reads `models.codex.<role>` from `<projectRoot>/.ux-assessment/config.yaml` when the job
  gives no `model`/`effort`; a job field wins. Effort must be `low`, `medium` or `high` and the
  model must match `^[\w.-]+$`, or the runner errors before spawn.
- The Claude skill passes `model` from `models.claude.<role>` to the persona, verifier, recon and
  triage Agent calls, and omits it when it equals the frontmatter.
- **Cheaper persona models** (`haiku`, `gpt-6-luna`, `low` effort) are accepted, with a warning:
  "cheaper, quality unmeasured: persona mistakes turn into false findings". They become a default
  only after a side-by-side run on a labelled app (same charter and personas, precision compared
  against the labels). That run is not part of this plan.
- Triage stays on the strongest model: its errors reach the report directly.
- **Option O-1 (not a must): move orchestrator work into a Sonnet subagent.** In M1 the
  orchestrator, recon and triage on the strongest model cost $4.4 of $5.3; even with a Sonnet main
  session (M2) the main session was the largest single consumer (table below). Candidate: a
  `planner` subagent (Sonnet) writes `personas.md` and `plans/<date>.md` from the charter and
  assembles `run.json`; the main session keeps only the questions and the dispatch. Trade-offs: the
  subagent re-reads knowledge files the main session has cached; intake nuance reaches it only
  through the charter; one more hand-off to debug. Decide after component 7 measures a Guided run:
  adopt O-1 if a Claude main session is > 40 % of the run's tokens. **Measured 2026-09-29:** 30.6 %
  (the timer app, Guided unattended, 6 personas, Sonnet main session; 1.67M of 5.47M tokens) → not
  adopted.

### 7. Token accounting

**Record** `<project>/.ux-assessment/usage.jsonl` (gitignored), one line per agent or process:
`{t, harness, role, id, model, input, cache_write, cache_write_1h, cached_input, output, source, run}`.
`input` is uncached input; `cache_write` is Claude only and the headline folds it into input;
`cache_write_1h` is the part of `cache_write` written with the 1-hour TTL (priced higher); `run` is
the run folder name the record belongs to (from `active-run`, else `null`); `output`
includes Codex reasoning tokens; `source` is `hook`, `codex-json` or `claude-p`.

- **Codex:** with `--json`, the runner takes the usage of the **last** `turn.completed` event (the
  thread total; open question 2), writes the raw keys to `codex-result.json` `usage` and appends a
  record to `usage.jsonl` (`input` = `input_tokens` − cached − cache writes). No usage events →
  `usage: null`, never 0.
- **Claude:** the plugin ships `hooks/hooks.json`; `node driver/usage.mjs hook` handles:
  - `SubagentStop` with `agent_type` starting `ux-assessment:`: read `agent_transcript_path` and sum
    `message.usage` per `message.model`, deduplicated by `message.id` (a streamed message repeats its
    usage on every content-block line). Role from the agent type; id from the briefing's
    `Session id:` line when present.
  - `Stop`, only when `<cwd>/.ux-assessment/active-run` exists (line 1 the run folder name, written by
    the skill): the main transcript's totals (sidechain lines skipped) as role `orchestrator`,
    labelled "whole conversation". The first Stop that sees an unclaimed marker claims it by writing
    its session id as line 2; Stops from any other session are ignored, and a transcript that cannot
    be read never claims the run.
  - The hook always exits 0 and returns at once when `.ux-assessment/` is missing (about 50 ms of
    Node start per Stop for users with the plugin enabled). Hook fields and the transcript format are
    Claude Code internals; the plan confirms them first (open question 1). Missing → "not measured".
- **`claude -p`:** unattended runs with `--output-format json` give exact per-model totals
  (`modelUsage`). README and CONTRIBUTING use this for dogfood measurements.
- **Report:** `node driver/usage.mjs report <run folder>` prints role × model × sessions × input ×
  cached input × output, with totals per model. It goes into "Run facts" of `report.md` and
  `verify-report.md`, replacing "tokens per session" from the Agent result. That figure is the
  agent's **final context size**, not tokens processed: in the verify run the Agent results summed
  to 362k while `modelUsage` counted 9.2M cached input reads. `run.json` keeps it as
  `context_tokens`.
- **Estimate** (plan step 7, verify V3):
  `node driver/usage.mjs estimate --harness <h> (--personas <n> --cap <c> [--depth quick|standard|none] | --verify <n>)`
  prints a low–high range per role and model (low: 8 steps per persona; high: the cap). `--depth`
  picks the recon row (`none` drops it, for a run that reuses the app-profile). `--verify <n>` prices
  `n` verifiers (cap fixed at 15 steps) plus the verify orchestrator, with no recon or triage row and
  `--personas`, `--cap` and `--depth` ignored. Rows with no measured coefficient say "not measured". Coefficients live
  in a new `knowledge/cost.md` (per-step persona and verifier figures, fixed recon, triage and
  main costs) and are updated as runs are measured.
- **Dollars:** one secondary line, "API-equivalent at list prices on <date>", from a price table in
  `usage.mjs`; left out for models with no listed price.
- **Subscriptions:** README says tokens are what vendors meter, that larger models use subscription
  limits faster (the vendors say so but publish no formula), and that the plugin therefore shows no
  percentage.
- Dollar figures are replaced in SKILL step 7, V3, V5 "Run facts" and step 10, `knowledge/verify.md`
  "Tokens", the README verify line, and SPEC D12 (kept as history, pointing to D31).

**Baseline (existing runs, read-only).** Per-model figures come from the kept `claude -p` results;
the role split subtracts the main session's `usage` from the model totals.

| unit | model | input + cache write | cached input | output | source |
|---|---|---|---|---|---|
| persona session, 15 steps (music app, one-persona rerun) | Sonnet | 25k | 308k | 5.3k | `claude -p` (≈ $0.27 at list prices, matches D12's $0.28) |
| verifier, per finding (music app, 13 findings, ≤ 15 steps) | Sonnet | 36k | 709k | 6.3k | `claude -p` |
| triage, 3 sessions (guide app / music app / guide rerun) | Opus | 63k / 107k / 60k | 777k / 2.34M / 626k | 24k / 33k / 20k | `claude -p` |
| main session, Quick unattended, 3 personas (guide / music) | Sonnet | 84k / 76k | 1.21M / 916k | 25k / 18k | `claude -p` |
| main session, verify of 13 findings | Sonnet | 8k | 1.09M | 4.9k | `claude -p` |
| recon (quick) + 3 personas together (guide / music) | Sonnet | 92k / 100k | 651k / 1.09M | 17k / 16k | `claude -p` |
| Codex persona, 9–30 steps (maker app) | `gpt-6-sol` | — | — | — | "tokens used" 12.5k–52k; meaning unverified (probably excludes cached input), no split |

**Missing:** Opus recon at standard depth on its own; persona vs recon in the M2 runs; the main
session of an attended Guided run (unattended Guided measured 2026-09-29; the six timer-app runs cost
$4.36–5.09 each, with no per-model record kept); the Codex verifier and the Codex main session
(one Codex persona measured 2026-09-29); Claude output tokens per role (the hook's transcripts carried
57 % of the billed output on 2026-09-29, see `knowledge/cost.md`); any Windows or Linux figure. After
phase 3 lands, the plan runs (1) one unattended Guided `claude -p --output-format json` run on a
dogfood app with the hook on, cross-checking hook totals against `modelUsage` (within 5 %), and
(2) one Codex run with `--json`. Both fill `knowledge/cost.md`. The Codex main session stays "not
measured" unless open question 5 finds a source.

### 8. CI (`.github/workflows/`)

- **`ci.yml`** (push, pull_request), matrix `macos-latest`, `windows-latest`, `ubuntu-latest`,
  Node 20 (plus 22 on Ubuntu):
  1. `cd driver && npm ci`, then Playwright Chromium (`--with-deps` and `fonts-thai-tlwg` on Ubuntu).
  2. `npm test`. The sandbox test stays darwin-only; the installer test runs on all three, so the
     junction is exercised for real on Windows.
  3. Install the Codex CLI from npm, then `node driver/codex-runner.mjs self-check --offline`. No
     key needed; it catches feature drift in the published CLI, which may differ from the ChatGPT
     bundle.
  4. Ubuntu only: `npx @anthropic-ai/claude-code plugin validate .`. If it needs a sign-in, the step
     is dropped and CONTRIBUTING keeps it as a local check.
  5. `gitleaks` on the pull request diff.
- **`codex-canary.yml`** (`workflow_dispatch` only; forks never see the secret): on three OSes
  (`macos-latest`, `windows-latest`, `ubuntu-24.04`), sign in with the
  `OPENAI_API_KEY` secret, run the full `self-check --json` and upload the JSON as
  an artifact. One small call per OS. A green Windows run lets the README drop "not yet on a real
  Windows machine"; Windows stays "experimental".

### 9. Docs

- **README** (users): what it does and cannot find (SPEC §1); the support matrix; install per
  harness × OS; the Windows/Linux Codex self-check; how it works in detail (pipeline, knowledge
  isolation, the persona tool surface, triage and its evidence, verify-only, the clock); models per
  role; tokens and subscriptions; where data goes and what to gitignore; uninstall; known limits.
  Install paths:
  - Claude Code via marketplace: `/plugin marketplace add themiddnight/ux-assessment`, then
    `/plugin install ux-assessment@ux-assessment`, then once
    `node <plugin dir>/scripts/install.mjs --deps-only` and a restart.
  - Clone + `node scripts/install.mjs` (Claude and Codex, macOS / Windows / Linux).
- **Marketplace install and dependencies:** the plugin cache has no `driver/node_modules`. Skill
  step 0 checks that the browser tools are present; if not, it tells the user to run `--deps-only`
  and restart. Whether a plugin update wipes them is open question 6.
- **CONTRIBUTING.md:** dev setup (`node scripts/install.mjs --deps-only`); tests per OS; the
  isolation invariants (a persona never gets a tool beyond `act` and `end_session`; a new Codex
  feature is classified only after a canary run); running `self-check`; dogfooding with
  `claude -p --output-format json`; specs, plans and D-numbers; the PR checklist; the issue
  template for Windows and Linux self-check reports. The README "Develop" section moves here.
- **SECURITY.md:** isolation bypasses are security issues, reported through GitHub private
  vulnerability reporting; restates the residual risks from component 2.

### 10. Release prep

- `LICENSE`: MIT, "Copyright (c) 2026 Pathompong Thitithan".
- Both manifests get `"license": "MIT"`, `"repository"` and `"homepage"`, and version **0.3.0**
  (decided 2026-09-28: Codex on Windows is experimental and nobody outside has used it yet). Whether `.codex-plugin/plugin.json` accepts `license` is checked with Codex's plugin
  tooling; an unknown key is dropped, not forced.
- `.claude-plugin/marketplace.json`:
  `{"name": "ux-assessment", "owner": {"name": "Pathompong Thitithan"}, "plugins": [{"name": "ux-assessment", "source": "./", "description": …, "version": …}]}`.
  The shape matches installed marketplaces on this machine; `claude plugin validate .` confirms
  `source: "./"`.
- Codex marketplace: `codex plugin marketplace add <owner/repo>` exists, but the file it expects is
  unknown (open question 8). Until then the README documents only clone + installer for Codex.
- **Private material.**
  - Not published: `work/`, `spike/` (including its hook log),
    `docs/superpowers/plans/`, `.superpowers/`. The public `.gitignore` gets `work/`.
  - The Codex isolation spike notes are the evidence for D25, so their content moves into `SPIKE.md`
    as a "Codex tool-level isolation" section, and this spec's evidence link points there.
  - Kept, anonymized as evidence: `SPEC.md` (§10 "Dogfood target" becomes "a loop-based music web
    app", with no path; links to `work/` give way to the inline summaries already there);
    `SPIKE.md` (spike scripts noted as not published); `docs/superpowers/specs/*`, this file
    included; the comments in `driver/`, `driver/test/` and `knowledge/` (10 occurrences, e.g. "M1
    dogfood, a music app: a Saving overlay hid the stand-in").
  - The four private app names become neutral labels (music app, guide app, timer app, maker app).
    Local absolute paths (`/Users/`, `~/Sites`) are removed.
- **History:** a fresh single initial commit, not `git filter-repo`. `filter-repo` would have to
  scrub the notes, the names and the author email from 44 commits, and one miss publishes them; the
  history has no value to outside contributors. The private repository keeps everything. After
  publishing, the public repository is primary and private notes live outside it.

**Pre-publish checklist** (the maintainer runs it; the plan executes none of it without the user):
1. Choose the GitHub noreply email (`<id>+<user>@users.noreply.github.com`); set it as `user.email`
   in the new repository.
2. Export `main` to a new directory (`git archive`) and delete the unpublished paths.
3. Run the anonymization grep (app names, `/Users/`, `~/Sites`, the personal email): it must print
   nothing. Then `gitleaks dir .` must be clean.
4. `git init`, one commit; `gitleaks git` must be clean.
5. CI green on the three OSes; `claude plugin validate .`.
6. Create the public repository and push; enable private vulnerability reporting and branch
   protection; tag the version.
7. Test the marketplace install from GitHub on a clean machine or account.

## Testing strategy

| component | unit tests (no model) | model / manual |
|---|---|---|
| runner | `buildCodexArgs` per platform (no `sandbox-exec` off darwin; DENY flags; `code_mode_host` never disabled; `--json`, `--model`, effort). Discovery with injected `env`/`platform` (`UXA_CODEX_BIN`, `codex.exe` on PATH, the `.cmd`-only error). `isInside` with `path.win32` cases (drive letters, case). win32 env allowlist. Kill command per platform. | the existing macOS sandbox test (darwin) |
| feature gate | fixture `test/fixtures/codex-features-0.155.txt` passes; plus an unknown `stable true` → refuse; a DENY name missing → skipped; malformed or too few rows → refuse; `code_mode_host` false → refuse; a removed-but-true unclassified feature → refuse | `self-check --offline` in CI (real CLI) |
| self-check | the PASS rule over synthetic event streams and logs (nonce in a tool output, HTTP count > 0, no `act` → FAIL); record match on version + hash; the win32/linux gate refuses without a record | full `self-check` on macOS before merge; `codex-canary.yml` on three OSes |
| installer | `install-macos.test.mjs` ported to `install.test.mjs` with a temp HOME/USERPROFILE, `--skip-deps` and stub harness binaries on PATH: link created (a junction on win32), idempotent rerun, existing dir → exit 2, neither harness → exit 1, only Codex → Claude step skipped. Runs on all three OSes. | a manual install on a real Windows machine (a contributor) |
| probe | `url` against the fixture server (200, 404, refused); `now` format; `fetch` truncation | — |
| models | `resolveModel` precedence (job > config > default); old flat config; invalid effort or model rejected | — |
| usage | a Codex JSONL fixture sums; a Claude transcript fixture with repeated `message.id` deduplicates; the hook ignores foreign agent types and a missing `.ux-assessment/`; `report` and `estimate` output | the phase 3 cross-check run (hook vs `modelUsage` within 5 %) |
| docs | `claude plugin validate .`; a link check of README/CONTRIBUTING in CI | — |

The gate for every phase: `cd driver && npm test` passes with no warnings on macOS, and, once
phase 1 adds it, CI is green on the three OSes.

## Migration

- **`scripts/install-macos.sh`** is removed in phase 2. `install.mjs` accepts the symlink the old
  script made (same target), so existing Mac users rerun `node scripts/install.mjs` and nothing
  changes; the README has a one-line note. For one release the old path stays as a two-line stub
  that prints "use `node scripts/install.mjs`" and exits 1.
- **`--plugin-dir` users** keep working; the README recommends the marketplace install.
- **Existing `.ux-assessment/`:** the flat `models` config keeps working; `run.json` `tokens` is read
  as `context_tokens`; an old `codex-result.json` without `usage` shows "not measured"; the ledger is
  untouched.
- **Codex on macOS** gains the tool-level flags. The first run after upgrading may refuse on an
  unclassified feature; the message names it (see Risks).

## Risks

| risk | effect | mitigation |
|---|---|---|
| Codex renames or adds features (alpha builds) | the runner refuses after a Codex update | the offline gate in CI on the npm CLI, a clear message, a one-line classification change; macOS keeps the OS layer while a fix ships |
| A new tool not behind a feature flag | an undetected leak on Windows/Linux | the canary workflow before releases; SECURITY.md; "experimental" label |
| Extra DENY flags (beyond the spike) break MCP access | personas cannot act | the full self-check on macOS before merging phase 1 |
| Codex does not follow the junction | `$PLUGIN` is wrong on Windows | the canary workflow runs the installed skill path; the fallback in component 4 |
| Hook fields or the transcript format change | per-role tokens "not measured" | the hook fails soft; `claude -p` stays exact |
| Marketplace cache without `node_modules` | browser tools missing after install or update | the step 0 check + `--deps-only`; open question 6 |
| Linux without Thai fonts | false findings on Thai apps | the README note; CI installs the fonts |
| Windows-only flakiness in the native/permission tests | red CI | quarantine per test with a skip reason naming the issue, never a blanket skip |
| Anonymization misses a name | private data goes public | the checklist grep + gitleaks on the export, and a fresh history |

## Open questions

1. Claude Code `SubagentStop` input: are `agent_type` and `agent_transcript_path` present in the
   current build, and must `message.usage` in the transcript be deduplicated by `message.id`?
   **Answered 2026-09-29:** both are present (plugin agents are `ux-assessment:<name>`; internal
   agents have `""`), and yes: keep the last line per `message.id`. `Stop` has no agent fields, and
   its transcript may lag by one message. Details in the phase 3 plan.
2. The shape of `codex exec --json` usage events on `0.155.x`: is `turn.completed.usage` per turn or
   cumulative, and are reasoning tokens separate?
   **Answered 2026-09-29:** one `turn.completed` per `codex exec`, carrying the thread total, so the
   runner takes the last one. `input_tokens` includes cached tokens, and
   `reasoning_output_tokens` is part of `output_tokens`.
3. Is there a Codex config key that disables web search for `exec`?
4. Does Codex on Windows resolve a junctioned skill directory to its realpath?
5. Is there any source for the Codex main session's tokens (Codex hooks, session rollout files)?
   **Partly, 2026-09-29:** rollout files under `CODEX_HOME/sessions` carry `token_count` events with
   `total_token_usage`. Codex's `Stop` hook gives the rollout path but no usage. The envelope is
   unconfirmed, so it is deferred: the Codex main session stays "not measured"
   (`knowledge/cost.md`).
6. Does a Claude plugin update replace the cache directory, and with it `node_modules`? Is there a
   persistent plugin-data directory to put them in?
7. ~~The public version number~~ — decided: 0.3.0.
8. The Codex marketplace file format, and whether `.codex-plugin/plugin.json` accepts `license`. Half answered in phase 5: plugins in a local Codex plugin cache carry `license`, `repository` and `homepage`, so those keys are accepted; Codex has no manifest validator, and the marketplace file format is still unknown.

## Delivery (independently shippable phases)

1. **Cross-platform Codex runner + self-check** (components 1–3, the `isInside` part of 5, `ci.yml`
   without the installer step). Starts with the full canary on macOS using the extended DENY list.
   Done when unit tests pass on three OSes, `self-check` passes on macOS, and the offline gate is
   green in CI.
2. **Installer + portability** (component 4, the rest of 5, the installer step in CI, removal of
   `install-macos.sh`). Done when `install.test.mjs` is green on three OSes and the skills and
   agents contain no `curl`, `date -u` or `jq`.
3. **Model map + token accounting** (components 6–7, `codex-canary.yml`). Begins by answering open
   questions 1–2; ends with the two measurement runs and `knowledge/cost.md` filled; decides O-1
   from the data.
4. **Docs** (component 9): README, CONTRIBUTING.md, SECURITY.md, issue templates. They describe
   what phases 1–3 shipped, including the measured token table. **Done 2026-09-29** (branch oss-phase1); the matrix says "should work" / "experimental" instead of "CI-verified": CI has run green once, with a Windows timeout in the run before it.
5. **Release prep** (component 10): LICENSE, manifests, `marketplace.json`, the anonymization
   sweep. Ends at the pre-publish checklist, which the user runs. **Done 2026-10-01** (branch oss-phase1), up to the checklist. The clock spike also moved into SPIKE.md, because published files cite it. macOS first runs in CI on the first public push, and the version tag waits for that run to be green. The export is made by `scripts/release.mjs export`, which scans the tree and refuses on any finding, not by `git archive`. The private repository is renamed first, so the public one can take the name.
