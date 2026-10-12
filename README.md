# ux-assessment

[![ci](https://github.com/themiddnight/ux-assessment/actions/workflows/ci.yml/badge.svg)](https://github.com/themiddnight/ux-assessment/actions/workflows/ci.yml)

A local skill for Claude Code and Codex that runs **simulated users** in real browsers against your
web app before real people try it, then triages what they encountered into a UX report.

## What it finds, and what it cannot

It can find:

- friction: steps that are slow, confusing or easy to get wrong
- unclear purpose or copy: people cannot tell what the app is for or what a label means
- broken or confusing flows
- poor error handling
- missing states: empty, loading and error screens
- problems on a phone-sized screen or a slow network
- whether a first-time visitor sees the app's value in the first session

It cannot find:

- whether the problem your app solves is worth solving
- whether people would pay for it
- true long-term retention
- matters of aesthetic taste
- anything that needs hearing (audio)
- anything behind a step the personas were not allowed to take

It tests web apps only, including mobile viewport emulation; native mobile and desktop apps are out
of scope. The Codex runner accepts only `localhost` and `127.0.0.1` app URLs.

A second mode assesses a Figma file or a folder of PNG exports instead of a running app. It is
experimental and has never been run on a real Figma file; see
[Design mode (Figma): experimental](#design-mode-figma-experimental).

The personas are models, not people. It finds what builders tend to overlook, so you can fix it
before real users see it. It does not replace testing with real users.

## Support matrix

| | macOS | Windows | Linux |
|---|---|---|---|
| Claude Code | **Tested**: dogfooded on four apps | **Should work**: the same Node driver, whose tests pass in CI; not yet run end to end on Windows | **Should work**: the same Node driver, whose tests pass in CI; not yet run end to end on Linux |
| Codex | **Tested**, two layers: tool-level isolation + `sandbox-exec` | **Experimental**: tool-level isolation only | **Experimental**: tool-level isolation only |

"Tested" means run end to end by the author. The Codex self-check passed on macOS with Codex CLI
0.155.0-alpha.9.2 on 2026-09-29. If you use Codex on Windows or Linux, please
[run the self-check](#windows-and-linux-run-the-codex-self-check) and report the result: those
reports are what move "experimental" to "tested".

Design mode is not in this matrix. It has its own status table in
[Design mode (Figma): experimental](#design-mode-figma-experimental), and every row of it is
experimental.

### Not verified yet

- CI (macOS, Windows and Ubuntu: the driver tests, the installer with a real directory junction on
  Windows, and the offline Codex gate) runs on every push to `main` and on every pull request; the
  badge at the top shows its state. It ran green on Windows and Ubuntu on 2026-09-29 and on
  2026-10-01. macOS first ran on 2026-10-01; that day CI ran green on all three, macOS included,
  twice: on the last commit before publication and on the first public commit. Other runs failed:
  one timed out on Windows in the safety tests, and on 2026-10-01 four failures were found by CI and
  fixed: a test race on Windows, a driver defect on Ubuntu with Node 22, a driver defect on Windows
  in the download note and, after publication, a driver defect on macOS that logged a browser that
  quit as a closed tab. That is a short track record, which is why the matrix says "should work".
- `.github/workflows/codex-canary.yml`, the full self-check with a model on macOS, Windows and Ubuntu, has
  never run: it needs an `OPENAI_API_KEY` repository secret.
- Codex has not been run on a real Windows or Linux machine. On Windows, the CI installer step shows that Node
  resolves the directory junction, but whether Codex itself finds a skill linked by a junction is
  unverified.
- Claude Code token reports undercount output: in a measured run, Claude Code's transcripts held
  57 % of the output tokens that were billed.
- Claude Code on Windows and Linux has not been run end to end.

## Install

Requirements: Node.js 20+ with npm, and Claude Code, Codex, or both, signed in.

### Claude Code from the marketplace

```
/plugin marketplace add themiddnight/ux-assessment
/plugin install ux-assessment@ux-assessment
```

Claude Code installs the driver's npm packages together with the plugin. Its documentation says it
does the same for each update. The first time you run the skill, and the first time after an update that needs a newer
browser, it downloads Playwright's Chromium (`node "<plugin dir>/scripts/install.mjs"
--chromium-only`) and then continues. The skill is `ux-assessment:ux-assessment`.

If the package install did not finish (it has a 60-second limit and needs npm on your PATH), the
skill stops and prints the command that repairs it, `node "<plugin dir>/scripts/install.mjs"
--deps-only`; run it, then restart Claude Code. The automatic package install was checked on
a fresh install with Claude Code 2.1.296; a version without it asks for that command after each install or update.

### From a clone (Claude Code and Codex)

```bash
git clone https://github.com/themiddnight/ux-assessment.git
cd ux-assessment
node scripts/install.mjs
```

`node scripts/install.mjs [--no-claude] [--no-codex] [--skip-deps] [--deps-only] [--chromium-only]` installs the
locked driver dependencies (into `node_modules/` at the checkout root) and Playwright Chromium, then installs for each harness it finds and
says which one it skipped. Exit codes: 0 done, 1 a prerequisite is missing, 2 an existing install
is in the way (it is left untouched). `--deps-only` installs only the dependencies and `--chromium-only` only the browser. Rerunning it is safe. Keep the checkout in place: both
installs point to it.

- **Claude Code:** the installer adds the checkout as the `ux-assessment` marketplace and installs
  `ux-assessment@ux-assessment`, or prints the two commands when it cannot run `claude` itself. To
  try it without installing, start Claude Code with `claude --plugin-dir <checkout>`.
- **Codex:** the installer links `~/.codex/skills/ux-assessment` (or `$CODEX_HOME/skills/…`) to the
  skill folder in the checkout: a symlink on macOS and Linux, a directory junction on Windows, never
  a copy. Restart Codex afterwards. The runner finds Codex in the ChatGPT app bundle (macOS) or on `PATH`; set
  `UXA_CODEX_BIN` to the native executable for a custom or npm install.

### Windows and Linux: run the Codex self-check

From the checkout:

```bash
node driver/codex-runner.mjs self-check --json --project <app repo>
```

Run it once after installing and after every Codex update. On Windows and Linux the runner refuses
to start a persona unless a passing self-check is on record for the current Codex version, feature
set and OS (the record stores a `features_hash`), so a Codex update that changes its feature list
asks for a new self-check.
The self-check costs one small model call (two if the model skips the tools the first time). The
record is `<app repo>/.ux-assessment/codex-self-check.json`.

Then report the result: paste the JSON it printed into the "Codex self-check
report" issue form ([.github/ISSUE_TEMPLATE/codex-self-check.yml](.github/ISSUE_TEMPLATE/codex-self-check.yml)).
If a persona reads a canary, that is a security issue: report it privately as
[SECURITY.md](SECURITY.md) describes, not in a public issue.

### Notes per OS

- **Linux:** a bare Linux has no Thai fonts, so Chromium screenshots of a Thai app show boxes that
  become false findings. Install `fonts-thai-tlwg` (or Noto) first. If Chromium does not start, run
  `npx playwright install-deps chromium` in the plugin folder (needs sudo).
- **Windows:** the owner-only file modes the driver sets on `.ux-assessment/` do nothing on Windows.
  Keep app projects inside your user profile, which is private to you by default; the driver warns
  when a project is outside it.
- **Upgrading from `scripts/install-macos.sh`:** run `node scripts/install.mjs`; it accepts the link
  the old script made.

## Use it

Start your app's dev server. Then, from the app's repository (so `.ux-assessment/` lands there and
tokens are recorded):

- **Claude Code:** run `/ux-assessment`, or `/ux-assessment unattended http://localhost:5173` to take
  every recommended answer without asking; the report then opens with those assumptions.
- **Codex:** ask it to run `ux-assessment` against the running local URL.
- **Design mode (Claude Code only, experimental):** run `/ux-assessment` and paste a Figma link or the
  path of a folder of PNG files instead of a URL. See
  [Design mode (Figma): experimental](#design-mode-figma-experimental).

On a project that already has `.ux-assessment/`, it offers a menu: New run, Label findings, Verify
fixes, Re-run triage, Start over, Show results, Decide, Settings. There are three modes: Quick,
Guided (the default) and Expert (for people who would rather edit the files directly).

Three of the menu entries are also commands of their own on Claude Code. None of them opens a
browser:

| command | what it does |
|---|---|
| `/ux-assessment:result` | Shows every finding in one table, grouped by what it needs: your answer, a fix, nothing (kept), a decision, a second check. It changes no label and no decision. |
| `/ux-assessment:decide` | Proposes fix, keep or ask for each finding of the last run, or of the run you name. It already runs after every test run. |
| `/ux-assessment:settings` | Shows the settings and changes the product documents, the decide step and the models. |

On Codex, ask for the same thing by name ("show the results", "decide the findings", "settings").
To see the table without an agent, run `node driver/ledger.mjs board <app repo>` from the checkout.

Two optional keys in `.ux-assessment/config.yaml` steer the decide step:

```yaml
product_docs: [docs/, SPEC.md]   # files, folders or globs, relative to the app repo
decide: off                      # on (the default) or off: off skips the step after a run
```

Without `product_docs` it reads `AGENTS.md`, `CLAUDE.md`, `README*`, `SPEC.md`, `PRD*` and
`docs/**` (files ending in `.md`, `.mdx`, `.txt` or `.rst`, at most 200), and what is saved in
`.ux-assessment/docs/`. A document that lives outside the repo (a drive, a wiki, a ticket) is read
only once it is saved there: the decide step offers to save one you opened in the same
conversation. The offered `.gitignore` lines keep that folder out of git; remove the line to
share the copies.
`node driver/decide.mjs docs <app repo>` lists the documents it would read.

## How it works

The planner (your main session) sees your code; the personas never do.

### Pipeline

state → app → recon → pack → intake → harness config → personas → plan → run (parallel) → triage →
decide → report → labels.

- **State:** checks for an earlier `.ux-assessment/` and offers the menu.
- **App:** confirms the running URL.
- **Recon:** reads your code and the running app and writes a planner-only app profile.
- **Pack:** picks a domain pack of common problems for this kind of app.
- **Intake:** asks you a short quiz (or takes the recommended answers when unattended).
- **Harness config:** writes the charter: goals, success criteria, safety rules, environment shims.
- **Personas:** writes 3–7 persona cards.
- **Plan:** matches personas to scenarios and estimates the tokens.
- **Run:** runs the personas in parallel, each in its own browser.
- **Triage:** turns what they hit into findings with evidence.
- **Decide:** proposes, per finding, to fix it, keep it or ask you.
- **Report:** writes the report, fix tasks and a kit for testing with real people.
- **Labels:** you answer what the decide step could not, and mark which findings were real.

### Knowledge isolation

There are two kinds of knowledge, never mixed. The planner knows your code, docs, quiz answers, the
app profile and the charter. A persona knows only what a real user of that type would know: its
persona card, where it came from, its goal in the user's words, and a login if it is a returning
user. A persona gets only its briefing, written in user language, never button or route names.
Nothing one persona finds reaches another.

### What a persona can do

A persona has exactly two tools: `act` (one step = one call; it returns a screenshot) and
`end_session`. On Claude Code the persona agent is granted only these. On Codex the runner starts a
separate `codex exec` process with Codex's built-in tools turned off and, on macOS, inside
`sandbox-exec` as well. Each session has a step cap and a patience cap. Every request goes through
Playwright routing, which disables the browser's HTTP cache, so every page loads as on a first
visit; service workers are blocked when the safety config has `stop_before` or `block` patterns.

### Triage and evidence

Triage reads the persona logs, the screenshots and the harness signals (audio levels, downloads,
file pickers, page errors). It groups what the personas hit into findings, each with a severity and
evidence, and writes `report.md`. When the charter lists a behaviour as intended and it costs no
goal, triage marks it "working as intended" instead of reporting it.

After triage, a decide agent reads your product documents and the code and proposes one decision
per finding: `fix`, `keep` (a document or the code says the behaviour is on purpose, and the
persona still reached its goal) or `ask` (it is on purpose but cost a persona the goal, the
documents and the code disagree, or the possible fixes are product choices). A `keep` must quote
the line it rests on; the driver checks the quote against the file and turns an unsupported
`keep` into `ask`. The decisions are proposals. A `keep` hides nothing, and your label always
wins. The decide step has not been run on a real app yet.

You then label findings real or not in `feedback.md`, and precision is computed per run from your
labels only. The label step asks you about the `ask` findings first, then lets you accept the rest
in one answer or review them one by one. Across the four dogfood apps, 33 of 36 findings were
labelled real; those labels were all made by hand, before the decide step existed.

### Verify fixes

`/ux-assessment` → Verify fixes (or `verify` unattended) rechecks every open finding with one short
verifier session each (the skill estimates the tokens before it starts). Each gets a verdict:
reproduced, not_reproduced, unreachable or changed. The finding's status in the ledger
(`.ux-assessment/ledger.yaml`) is updated. "Not seen" once is not "fixed": that needs two separate
clean checks.

### Design mode (Figma): experimental

Design mode assesses a Figma file, or a folder of PNG exports of one, instead of a running app. No
browser opens. A viewer is an agent that sees one frame, or one flow of frames, as pictures and has
two tools, `view` and `answer`. The harness measures what it can in code (contrast, target size,
text load) and judges every click against the frame's layers. The viewers run on the model of the
persona role.

Design mode has never been run on a real Figma file. Everything in it was built from Figma's documentation and tested against fixtures the author wrote.

The fixtures are not recordings. A passing test there says the code agrees with the fixture, not
with Figma. The first section of every design report says the same, with the source and the level
the run reached.

**How to start it.** Run `/ux-assessment` and paste a Figma link (`/design/`, `/file/` or `/proto/`)
or the path of a folder of PNG files.

- The skill picks the mode from the input and says which one it picked on its first line.
- The word `design` forces design mode and asks for the link or the folder. The word `app` forces
  app mode.
- A Figma link together with an app URL: the skill asks which one to run. Unattended, it stops.
- A FigJam, Slides or Community link is refused.
- A page or section of more than 24 frames is not fetched whole. A run looks at 12 frames at most,
  and every frame is one image download that counts against Figma's image render, so the skill
  lists the frames, you pick up to 12 with it, and only those images are downloaded.
- You choose how much to tell the run. `keyed` takes an intent per frame and the right target per
  goal. `goal` takes goals only. `blind` takes nothing. The more you give, the more the report can
  say. For a target you name in words or with a Figma link, the skill shows a picture of the frame
  with that element outlined and asks you to confirm it before it keeps it.

Which source is used: the config key `design.source` forces one. Otherwise a folder of PNGs wins, then
a Figma token, then the Figma MCP server. If none is available the skill stops and prints how to set
each up.

**Status per source.** Every row is experimental.

| Source | What it needs | Highest level | Status |
|---|---|---|---|
| REST with a token | A Figma token that can open the file | `flows` when the file has prototype links, otherwise `static` | Experimental: never run on a real Figma file |
| Figma MCP server | The Figma MCP server connected to your Claude Code session | `frames` | Experimental: never run on a real Figma file |
| Figma MCP server with the read-only script | The same, and your yes before each run (see below) | `flows` when the file has prototype links, otherwise `static` | Experimental: never run on a real Figma file |
| Folder of PNGs | A folder of PNG files, one frame per file, and no `package.json` in it | `images` | Experimental: never run on a real Figma file |

What each level adds, from the lowest:

- `images`: comprehension questions for each frame.
- `frames`: the first click against a target you named, and the measured contrast, target size and
  prominence.
- `static`: text load, controls that are only an icon, the large-text rule and the placeholder check.
- `flows`: one viewer per flow, moved from frame to frame by its own clicks along the prototype links.

A level needs nodes, text, font size or links that the source has to give. The run reports the level
it reached for your file, which can be lower than the table's highest.

**Figma token.** The driver reads it from the environment variable `FIGMA_TOKEN`, or from
`figma_token` in `.ux-assessment/secrets.local.yaml`. No agent is given it.

**Figma MCP server.** The driver cannot call an MCP server, so the main session calls the Figma
tools, saves what they return to files, and hands the files to the driver.

- The `use_figma` tool can change a file. The step that uses it is asked for each run, in Guided and
  Expert mode. Quick mode never asks and never uses it, and unattended runs never use it.
- That step passes one fixed script from this repository, `driver/figma-read.js`, unchanged. It only
  reads text, font size and prototype links. A test fails if the script holds a call or an assignment
  that could change a document. That test reads the script's text; the script has not run on Figma's
  real tool. Without the step the run stops at the level `frames`, and the report says so.
- A View or Collab seat gets about 20 MCP tool calls a month (Figma's figure; the exact limit is not
  confirmed). A run makes 2 to 4. The skill prints the count before the first call.
- It works on Claude Code only. Figma lets only catalogued clients connect.
- What `get_metadata` and `use_figma` really return is taken from Figma's documentation only. If the
  importer cannot read the XML, it stops and says so.

**What it cannot say.**

- A viewer that fails to understand a frame is strong evidence that the frame is unclear. A viewer
  that understands it is weak evidence that a person will, because a model reads every word and knows
  common interface patterns.
- All viewers are one model. When they agree, that is not evidence.
- It cannot show an overlay, a variant swap, a scroll action or an animation. A prototype link of
  those kinds ends the flow for that viewer and is listed under "Not tested".
- It cannot find an empty, loading or error state that the file has no frame for.
- The prototype is never played in Figma's player. The harness follows the links itself.
- A hand-drawn arrow between frames is a hint for the order of frames and nothing else.
- A folder of PNGs has no layers: no measured values, no links and no placeholder check.

**Left out.** Verify and decide do not cover design findings: "Verify fixes" lists none and the
decide step skips them. Design mode is not offered on Codex. The token estimate does not cover design
mode yet. `node driver/usage.mjs report <run folder>` lists viewers next to personas once a run is
recorded.

**How to help.** Run it on a file you can talk about and report what happened with the "Design mode
report" issue form ([.github/ISSUE_TEMPLATE/design-mode-report.yml](.github/ISSUE_TEMPLATE/design-mode-report.yml)).
A run that failed is as useful as one that worked. Do not attach a confidential design. See
[Reporting design mode results](CONTRIBUTING.md#reporting-design-mode-results).

To see what a snapshot holds without an agent, run `node driver/design.mjs frames <snapshot folder>`
from the checkout.

### The clock

The charter has a harness option `clock: real | controlled` (default `real`). Under `controlled` the
harness owns page time: it is paused while the persona thinks, each step adds human reading time,
and `wait` can run up to 600 s, stopping early when the screen changes. This is for apps with long
in-app timers.

### Pieces

| piece | what it does |
|---|---|
| `driver/session.mjs` | One Chromium per persona, launched with a persistent profile. Enforces the step cap and patience cap, and writes the persona log (`log.jsonl`) and the harness signals (`signals.jsonl`: audio levels, file/download/picker events, page errors) |
| `driver/clock.mjs` | Harness-owned page time for `clock: controlled` (SPEC D22): paused while the persona thinks, paced with real time while the harness acts, human reading time per step, and `wait` up to 600 s that stops when the screen changes |
| `driver/inject.js` | Init script: an audio tap, plus a visible stand-in for OS file pickers backed by OPFS |
| `driver/mcp.mjs` | stdio MCP server `browser`. Persona tools are `act` (one step = one call; returns a screenshot) and `end_session`. Viewer tools (design mode) are `view` and `answer`. Harness tools are `harness_start`, `harness_design_start`, `harness_eval`, `harness_signals`, `harness_save_state` and `harness_stop` |
| `driver/persona-bridge.mjs`, `driver/codex-runner.mjs` | Short-lived two-tool MCP endpoint and isolated Codex CLI runner for one persona or verifier |
| `driver/ledger.mjs`, `driver/verify.mjs` | Cross-run finding ledger (`.ux-assessment/ledger.yaml`: identity, history, status, decision; `board` prints the results table) and verify-run helpers (`record` verifier replies into `verify.yaml`, `check-state` for saved logins) |
| `driver/figma.mjs`, `driver/figma-read.js` | Design mode, experimental. The three sources (REST, Figma MCP output, a folder of PNGs) become one design snapshot on disk; commands `parse-url`, `fetch`, `import-mcp` and `import-png`. The script is the read-only code that the main session passes to the Figma `use_figma` tool; Node never runs it |
| `driver/perception/` | Design mode. `image.mjs` (PNG helpers), `scene.mjs` (a scene from one frame, and the hit test) and `instruments.mjs` (contrast, target size, text load and the other measured values) |
| `driver/static-session.mjs`, `driver/viewer-tools.mjs` | Design mode. One viewer's session without a browser: the folds, the order of the answers, the caps, link following and the log (`design-log.jsonl`); the viewer's two tools, `view` and `answer` |
| `driver/design.mjs` | Design mode planner commands: `frames` lists the frames and the level, `crop` writes a picture of one node for you to confirm as a keyed target, `judge` judges every viewer's clicks and writes `design-results.json` and `perception.jsonl` with no model call |
| `agents/viewer.md` | The design mode viewer. Granted only `view` and `answer`; it is never given a frame name, a layer name, an intent or the file link |
| `agents/verifier.md` | Rechecks one earlier finding in a browser and returns a verdict (verify-only mode) |
| `driver/decide.mjs`, `agents/decide.md` | The decide step (SPEC D35): the agent proposes fix, keep or ask per finding from the product documents and the source; the script resolves the documents (`docs`), lists the findings to decide (`todo`), checks every quoted source (`record`) and prints the report's Decisions section (`table`) |
| `driver/png-diff.mjs` | `node driver/png-diff.mjs a.png b.png` — pixel diff of two screenshots with the harness's thresholds, for triage |
| `driver/probe.mjs` | `url`, `now`, `fetch` and `deps` for the skills and recon, in place of the curl and date commands (the same on every OS) |
| `driver/expectations.mjs` | `node driver/expectations.mjs <run folder>` — what each persona expected before an action against what happened, one pattern per expectation, for triage (SPEC D34) |
| `driver/models.mjs` | The model per role (SPEC D30): defaults, `.ux-assessment/config.yaml` overrides, `show <project>` |
| `driver/usage.mjs`, `hooks/hooks.json` | Token accounting (SPEC D31): the Claude Code hook, `report <run folder>`, `estimate`; coefficients in `knowledge/cost.md` |
| `scripts/install.mjs` | The installer: driver dependencies, the Claude Code plugin, the Codex skill link |
| `agents/persona.md` | Shared persona instructions. Claude grants only `act` and `end_session`; Codex runs with its built-in tools off, and on macOS also inside sandbox-exec |
| `agents/recon.md`, `agents/triage.md` | Planner-side agents that write the app profile and the report |
| `skills/ux-assessment/SKILL.md`, `codex/skills/ux-assessment/SKILL.md` | Shared entry and Codex workflow adapter |
| `skills/decide/`, `skills/result/`, `skills/settings/` | The three commands: decide a run, show the results table, show and change the settings |
| `knowledge/` | Plain-markdown knowledge: intake question bank, persona schema and briefing, charter template and harness-config mapping, triage rules, decide rules, and curated domain packs in `knowledge/packs/` (first: `creative-tool.md`). For design mode: `knowledge/design.md` (the pipeline) and `knowledge/perception.md` (thresholds, name patterns and the rules from numbers to findings) |

## Models per role

On Claude Code, personas and verifiers use `sonnet`, recon uses `opus` (`sonnet` at quick depth), and
triage and decide use `opus`. On Codex, each role maps to a model and a reasoning effort. You can override any
role per project in `.ux-assessment/config.yaml` under `models`. A cheaper persona model is opt-in,
and choosing one prints a warning: "cheaper, quality unmeasured: persona mistakes turn into false
findings". To see the map for a project, run `node driver/models.mjs show <app repo>`. For a project
with no config it prints:

```
claude persona: sonnet (default)
claude verifier: sonnet (default)
claude recon: opus (default); quick depth: sonnet
claude triage: opus (default)
claude decide: opus (default)
claude orchestrator: the session model (default)
codex persona: gpt-6-sol medium (default)
codex verifier: gpt-6-sol medium (default)
codex self-check: gpt-6-sol low (default)
codex recon: the session model (default)
codex triage: the session model (default)
codex orchestrator: the session model (default)
```

## Tokens and subscriptions

Tokens are what the vendors meter. The plugin reports tokens per model and per role, split into
input, cached input and output, plus one secondary "API-equivalent at list prices" dollar line.
Larger models use up subscription limits faster, but no vendor publishes a formula, so the plugin
shows no share of a subscription's limits.

- Estimate before a run: `node driver/usage.mjs estimate --harness claude --personas 6 --cap 15`
- Report after a run: `node driver/usage.mjs report <app repo>/.ux-assessment/runs/<run folder>`

The measured coefficients ("step" figures are per persona step, "session" figures per session):

| harness | role | model | per | input | cached input | output |
|---|---|---|---|---|---|---|
| claude | persona | sonnet | step | 3.2k | 29.5k | 350 |
| claude | verifier | sonnet | step | 2.4k | 47.3k | 420 |
| claude | recon | opus | session | not measured | not measured | not measured |
| claude | recon_quick | sonnet | session | not measured | not measured | not measured |
| claude | triage | opus | session | 60.0k–143.0k | 626.0k–2.34M | 20.0k–36.2k |
| claude | orchestrator | sonnet | session | 76.0k–131.0k | 916.0k–1.53M | 18.0k–43.0k |
| claude | orchestrator_verify | sonnet | session | 8.0k | 1.09M | 4.9k |
| codex | persona | gpt-6-sol | step | 2.6k | 24.5k | 290 |
| codex | verifier | gpt-6-sol | step | not measured | not measured | not measured |
| codex | recon | the session model | session | not measured | not measured | not measured |
| codex | recon_quick | the session model | session | not measured | not measured | not measured |
| codex | triage | the session model | session | not measured | not measured | not measured |
| codex | orchestrator | the session model | session | not measured | not measured | not measured |
| codex | orchestrator_verify | the session model | session | not measured | not measured | not measured |

Where they come from: the Claude persona input figures from a Guided unattended run on the timer app
on 2026-09-29 (6 personas, 51 steps, Sonnet personas and Opus triage), which `claude -p` billed at
$3.83 API-equivalent, and the persona output figure (350 per step) from a 15-step one-persona rerun
on the music app; the verifier from 13 findings on the music app; triage from four sessions on
the guide, music and timer apps; the Codex persona from one `core` persona run of 10 steps on the
timer app. `knowledge/cost.md` lists every source.

An example estimate, for 6 personas with a 15-step cap:

```
node driver/usage.mjs estimate --harness claude --personas 6 --cap 15

| role | model | sessions | input | cached input | output |
|---|---|---|---|---|---|
| recon | opus | 1 | not measured | not measured | not measured |
| persona | sonnet | 6 | 153.6k–288.0k | 1.42M–2.65M | 16.8k–31.5k |
| triage | opus | 1 | 60.0k–143.0k | 626.0k–2.34M | 20.0k–36.2k |
| decide | opus | 1 | not measured | not measured | not measured |
| orchestrator | sonnet | 1 | 76.0k–131.0k | 916.0k–1.53M | 18.0k–43.0k |

Low: 8 steps per session (or the cap if lower); high: the cap (15 for a verifier). Input includes cache writes.
API-equivalent at list prices on 2026-09-29: $2.04–$4.18 (cache writes priced as input); not measured: recon
```

Caveats:

- Claude Code undercounts output: its transcripts held 57 % of the billed output in the measured
  run. The report prints a caveat.
- Start Claude Code in the app repository (where `.ux-assessment/` lives), or the per-role figures
  show as "not measured".
- The Codex main session (recon, triage, orchestration) is not measured yet.
- Design mode is not in the estimate: `estimate` has no figure for a viewer.
- Recon on Claude Code is not measured on its own.

## Where data goes

Everything a run writes is in `<app repo>/.ux-assessment/`:

```
.ux-assessment/
├── config.yaml        # adapter, max_parallel, models, retention, mode defaults, product_docs, decide
├── app-profile.md     # planner-only
├── charter.md         # goals, success criteria, safety rules, environment shims
├── personas.md        # persona cards
├── packs/             # project-specific domain packs
├── plans/             # persona × scenario matrix + token estimate
├── runs/              # one folder per run: report, decisions, fix tasks, logs, screenshots
├── design/            # design mode: source.yaml, key.yaml, cache/ (frames fetched from Figma)
├── ledger.yaml        # cross-run finding identity, history and status
├── feedback.md        # finding labels
├── docs/              # product documents saved from outside the repo, for the decide step
├── usage.jsonl        # token records
└── secrets.local.yaml # test credentials
```

Nothing leaves your machine except the model calls your own harness makes, and nothing is written
into the plugin checkout. Design mode is the one exception, described next.

**Design mode.**

- The driver sends your Figma token only in the `X-Figma-Token` header of a call to the Figma API,
  `https://api.figma.com`. It follows no redirect from that API, and it sends the token to no image
  host. It reads the token from `FIGMA_TOKEN` or from `.ux-assessment/secrets.local.yaml`, and it
  reaches no agent and no log. The variable `FIGMA_API_BASE`, which tests use to name another API
  address, is accepted only as an `https` address, `http://127.0.0.1` or `http://localhost`.
- Frames are cached under `.ux-assessment/design/cache/`, with an `index.json` that remembers which
  copy answered which request, so going back to an earlier file calls Figma no more. A design may be
  confidential, so keep that folder out of git.
- Image downloads go to the hosts that Figma returns, over `https` only. When `FIGMA_API_BASE` is
  set, an image address on `http://127.0.0.1` is also allowed, for tests.
- A viewer's model call carries the frame as a picture, so the design reaches your model vendor, as a
  persona's screenshots do.

Keep these out of git:

```
.ux-assessment/runs/*/*/screenshots/
.ux-assessment/runs/*/*/log.jsonl
.ux-assessment/runs/*/*/design-log.jsonl
.ux-assessment/runs/*/*/signals.jsonl
.ux-assessment/runs/*/*/downloads/
.ux-assessment/state/
.ux-assessment/secrets.local.yaml
.ux-assessment/usage.jsonl
.ux-assessment/docs/
.ux-assessment/design/cache/
.ux-assessment/active-run
.ux-assessment/codex-self-check.json
```

The last line is a per-machine record. Commit the rest: `report.md`, `decisions.yaml`, `ledger.yaml`, `feedback.md`,
the charter and the personas. Test credentials for returning-user personas go in
`.ux-assessment/secrets.local.yaml`, and saved logins in `.ux-assessment/state/`.

## Uninstall

Claude Code:

```bash
claude plugin uninstall ux-assessment@ux-assessment
claude plugin marketplace remove ux-assessment
```

Codex on macOS and Linux (removes the symlink only):

```bash
rm ~/.codex/skills/ux-assessment
```

Codex on Windows (removes the junction only):

```bat
cmd /c rmdir "%USERPROFILE%\.codex\skills\ux-assessment"
```

Never delete the link recursively: a recursive delete can follow the junction into your checkout
and delete it. If you set `CODEX_HOME`, the link is under `$CODEX_HOME/skills/` instead. Then delete
the checkout if you cloned it. Assessment data stays in each app's `.ux-assessment/`; delete that
folder to remove it.

## Known limits

- What it cannot find is listed in [What it finds, and what it cannot](#what-it-finds-and-what-it-cannot).
- The Codex runner accepts local URLs only (`localhost` and `127.0.0.1`).
- Web search is a known residual risk for Codex personas; see [SECURITY.md](SECURITY.md).
- Headless Chromium reports notification permission as denied even when it was granted, so every
  `new Notification` counts as an alert attempt.
- A persona that stops without calling `end_session` has no exit interview, and triage may count
  it as an environment error rather than a UX finding.
- When the browser itself quits during a session, that session ends there: it is not reopened, and
  triage counts it as an environment error (`browser-closed` signal).
- Claude Code and Codex on Windows and Linux: see [Not verified yet](#not-verified-yet).
- Design mode has never been run on a real Figma file, and every part of it is experimental: see
  [Design mode (Figma): experimental](#design-mode-figma-experimental).

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, how to [run the tests](CONTRIBUTING.md#run-the-tests),
  and how to report a Windows or Linux self-check.
- [SECURITY.md](SECURITY.md): report isolation bypasses privately.
- [SPEC.md](SPEC.md): the design and its decisions.
- [SPIKE.md](SPIKE.md): the evidence it rests on.
- [LICENSE](LICENSE): MIT.
