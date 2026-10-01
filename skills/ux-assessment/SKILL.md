---
name: ux-assessment
description: Test a web app with simulated users before real people try it — recon, a short quiz, 3–7 personas played by subagents in real browsers, triage and a UX report. Use when the user asks to run a UX assessment, usability test, simulated-user or persona test of their web app, or invokes /ux-assessment. Also runs unattended (claude -p).
---

# ux-assessment (M3)

Plugin root = two directories above this skill's base directory; call it `$PLUGIN`.
`$PLUGIN` is a placeholder: write the absolute path in its place in every command; it is not a
shell variable (PowerShell would expand it to nothing). On Codex this skill may be reached through
a link (a symlink, or a junction on Windows), so take the base directory's real path first:
`node -p "require('fs').realpathSync(process.argv[1])" "<base directory>"`.
Check that `$PLUGIN/driver/codex-runner.mjs` exists; if it does not, stop and ask the user to rerun
`node scripts/install.mjs` in their ux-assessment checkout.

Then run `node "$PLUGIN/driver/probe.mjs" deps`. If it exits 1, stop: show the user its output
(the exact `install.mjs --deps-only` command for this install) and tell them to run it and restart
Claude Code or Codex. A marketplace install has no driver dependencies until then, and a plugin
update may need it again. This holds in unattended mode too.

**Codex entry:** On Codex, read `$PLUGIN/codex/skills/ux-assessment/SKILL.md`
and follow that workflow. The steps below use Claude Code agents, questions,
and MCP tool names. On Claude Code, continue below.

Pipeline: **state → app → recon → pack → intake → harness config → personas → plan → run
(parallel) → triage → report → labels.** Knowledge files:
`$PLUGIN/knowledge/{intake,charter,personas,triage}.md` and `$PLUGIN/knowledge/packs/*.md`. Read
each one when its step comes, not all up front.

Talk to the user in **their** language, without UX vocabulary (SPEC §1). Internal files in English.
Everything lives in `<project>/.ux-assessment/` (the project = the current working directory).
Browser tools are `mcp__plugin_ux-assessment_browser__<tool>` (below: just `<tool>`).

**Models per role** (SPEC D30). `node "$PLUGIN/driver/models.mjs" show <project>` prints the model
for each role from `.ux-assessment/config.yaml` (or the defaults) and prints warnings on stderr.
For each `ux-assessment:persona`, `verifier`, `recon` and `triage` Agent call, pass `model` = that
role's `claude` line, and leave it out when it equals the agent's own model (persona and verifier
`sonnet`, recon and triage `opus`). The Agent `model` parameter takes `sonnet`, `opus`, `haiku` or `fable`.
For any other value, including "the session model", leave it out and tell the user that the
agent's own model was used.

**Tokens** (SPEC D31). The plugin's hook writes each agent's tokens and this conversation's tokens
to `.ux-assessment/usage.jsonl`. It works only when Claude Code was started in the app repository
(the folder holding `.ux-assessment/`). Otherwise the per-role tokens show as "not measured".

## Knowledge isolation — the rule that makes results worth anything

Personas are dispatched as `ux-assessment:persona` agents. They get **only** the briefing built
from `knowledge/personas.md` → "Briefing". Never put code, routes, component or button names, the
app-profile, the charter, hints, or other personas' results into a briefing. Scenario goals are in
user language ("make a short beat and keep it"), never UI language ("click Save"). Stop-before
labels and sample file names are persona-visible too: user language only. Never name a feature
("the built-in AI"), a limit or a safety rule in a briefing: limits are enforced by the harness
(`stop_before` `max`), and the persona learns of them from the STOP note, like a real user would.

## 0. State and mode

**Unattended** — decide first, before any question. It is on when any of these holds:
- the invocation arguments contain `unattended`;
- the user says they are away, or not to ask anything;
- AskUserQuestion is not among your tools (`claude -p` has none), or a call to it returns an error
  or no answer.

Once on, it stays on for the whole run. In unattended mode every "ask" below takes its
**recommended** answer and records it in the charter as `assumption (unattended)`; nothing else
changes unless a step says so. Unattended hard rules:
- The URL must be in the arguments or request. None → stop and say so. Only `localhost` /
  `127.0.0.1` or a staging-looking URL (`staging`, `stage`, `preview`, `dev`, `test` in the host) is
  allowed; anything else → stop. Never start servers.
- Never edit `.gitignore`. Never log in by hand (see step 5).
- The report starts with the assumption list (triage is told in step 9).

**State menu** (SPEC D20). No `.ux-assessment/` → full flow. It exists → ask:
**New run** (recommended; reuses app-profile, charter and personas if present — go to step 5) ·
**Label findings** (step 11) ·
**Verify fixes** (section V; only when some `runs/*/findings.yaml` exists) ·
**Re-run triage** on the last run (step 9) · **Start over** (redo
steps 2–6, overwriting app-profile, charter and personas; keep `runs/` and `feedback.md`).
Unattended: New run; Re-run triage when the arguments say `triage`; Verify fixes when they say
`verify`. Label findings needs a person — say so and stop.

**Mode** (only when intake will run). From the arguments (`quick`, `guided`, `expert`), else ask:
**Guided** (recommended; six short rounds, 5–7 personas) · **Quick** (one or two cards, 3
personas) · **Expert** (I draft the charter, you edit it). Unattended: Guided, or Quick when the
arguments say `quick`.

**Run folder** (full flow, New run, Start over). Choose the run folder name now: the date part of
`node "$PLUGIN/driver/probe.mjs" now`, plus `-2`, `-3` if `runs/<date>` already exists. Write that
name as the only line of `<project>/.ux-assessment/active-run` (create `.ux-assessment/` first if
needed). In the full flow, do this at the start of step 2, once step 1 has confirmed the app is
running; New run and Start over already have the app confirmed, so they write it here. Step 8 uses
this folder. The token hook uses the file to assign this conversation and its
agents to the run. **Re-run triage:** write the existing run folder's name there before step 9.

## 1. A running app

Ask for the URL (recommended option = what `package.json` suggests, e.g. `http://localhost:3000`).
If there is none, find the dev script (`package.json` `dev`/`start`) and **offer** to start it (Bash
`run_in_background`), then poll until the port answers. A URL that is neither localhost nor
staging-looking needs explicit confirmation (SPEC D5). Check the URL loads with
`node "$PLUGIN/driver/probe.mjs" url "<url>"` (it prints the status and the final URL, and exits 1
when nothing answers within 5 s) before going on. Unattended: the rules in step 0.

## 2. Recon

Dispatch `ux-assessment:recon` with: project root, the plugin root (`$PLUGIN`, absolute), output
`<project>/.ux-assessment/app-profile.md`, the depth, the URL. Depth: Quick mode → `quick`; Guided and
Expert → `standard` (`deep` when the arguments say so). Model: the `claude recon` line of
`models.mjs show` (see "Models per role"). At quick depth, use its `quick depth` model when the line
shows one. Unattended follows its mode. Keep only its short summary in your context.

## 3. Pack

Read the app-profile's *Dimensions*, then `knowledge/charter.md` → "Choosing a pack". Use the
curated pack in `$PLUGIN/knowledge/packs/` whose dimensions match; otherwise write an ad-hoc pack to
`.ux-assessment/packs/<name>.md`, labelled *auto-generated, unreviewed*. Read only the chosen pack.

## 4. Intake

First tell the user in two sentences what this can and cannot find (`knowledge/charter.md`).
Then, by mode, using `knowledge/intake.md`:
- **Guided**: the six rounds, one AskUserQuestion card each.
- **Quick**: the Quick subset (one or two cards).
- **Expert**: draft `.ux-assessment/charter.md` from recon, the pack and the intake defaults; tell
  the user to edit it directly; ask **I've edited it** · **Use it as is**; re-read it and continue.
- **Unattended**: no cards; the unattended defaults in `knowledge/intake.md`.

Write `.ux-assessment/charter.md` (template in `knowledge/charter.md`, including the intake record
and the harness config block) and `.ux-assessment/config.yaml`:

```yaml
adapter: playwright-driver
max_parallel: 3          # 1 when server-side state is shared (step 8)
# models: {claude: {persona: sonnet}, codex: {persona: {model: gpt-6-sol, effort: medium}}}   # only real overrides; defaults live in driver/models.mjs
mode: guided             # quick | guided | expert; add `unattended: true` when it is on
cap: 30
retention_runs: 5
```

## 5. Harness config

From the charter, per `knowledge/charter.md` → "Charter → harness config", fix the options every
persona session gets: `safety`, `fs`, `files`, `permissions`, `clock`. When the app imports files, create
`<project>/.ux-assessment/files/` with small sample files of the accepted types (absolute path →
`files`).

## 6. Personas

Read `knowledge/personas.md` and the pack's archetypes. **Guided / Expert / unattended**: 5–7 cards
by the coverage rules; show a table (who, goal, device, patience, start state) and ask **Use
these** (recommended) · **Customise** (the two multi-select questions in `knowledge/personas.md`) ·
**Quick (3)**. **Quick**: core + casual + constrained; ask **Use these** (recommended) · **Change
something** (free text → edit and show again). Write the cards to `.ux-assessment/personas.md`.
New run with existing cards: reuse them without asking.

**Start states.** Newcomers need nothing. Returning cards (`start_state: returning`): credentials live in
`.ux-assessment/secrets.local.yaml` (format in `knowledge/personas.md`). For each account used:
1. Password login: `harness_start` with `session: setup-<account>`,
   `dir: <project>/.ux-assessment/state/setup-<account>`, `url: <login_url>` and the charter's
   `safety`; log in with `act` (fill `observation`/`reaction` with "setup", `event: none`,
   `frustration_delta: 0`); when the app shows you are logged in, `harness_save_state` with
   `path: <project>/.ux-assessment/state/<account>.json`; check `cookies + origins > 0`;
   `harness_stop`.
2. OAuth / OTP / 2FA: ask the user to log in by hand. `harness_start` as above plus `headed: true`
   and `safety: {external_navigation: "allow"}`; tell them to log in in the window that opens and
   answer **Logged in** · **Skip these personas**; then `harness_save_state` and `harness_stop`.
   Unattended: skip those personas and list them under "Not tested".
3. No credentials in the file: attended → ask the user to add them (recommended) or skip the
   persona; unattended → skip and list under "Not tested". Never invent credentials.

Personas then start with `storage_state: <that .json>`. A setup session is not a persona run.

## 7. Plan

Scenarios per SPEC D12 (Quick: one per persona) from the charter's success criteria, the worries
and the pack's scenario templates, in the persona's own words. Write `.ux-assessment/plans/<date>.md`:
the persona × scenario table, step caps, parallel or sequential, safety rules, the models per role
(`node "$PLUGIN/driver/models.mjs" show <project>`; show the user any warning it prints), and a
**token estimate** (SPEC D31):
`node "$PLUGIN/driver/usage.mjs" estimate --harness claude --personas <n> --cap <cap>`, plus
`--depth quick` after a quick recon, or `--depth none` when this run reused the app-profile. The
estimate prices the default role models; overrides in `config.yaml` are not reflected yet. Put its
table and its API-equivalent line in the plan. Tell the user three things: tokens are what the
vendors meter; larger models use up subscription limits faster, and no vendor publishes a formula
for that; and the main session's model drives the fixed part (the orchestrator row was measured
with a Sonnet main session).

Ask: **Run it** (recommended) · **Trim** · **Stop here**.

## 8. Run — parallel, up to `max_parallel`

Run folder: `<project>/.ux-assessment/runs/<name>/` (absolute path), where `<name>` is the line in
`<project>/.ux-assessment/active-run`. Do not pick a new date or suffix here.
**Sequential** (`max_parallel: 1`) when server-side state is shared — one test account for several
personas, or a shared database personas could change for each other — as recon/charter flag it.
Otherwise take the personas in batches of `max_parallel` (default 3). For each batch:

1. For each persona, `harness_start`: `session: <persona id>`, `dir: <run folder>/<persona id>`,
   `url`, `viewport` (card `device.viewport`), `cap`, `patience_budget`, `fs`, `files`,
   `permissions`, `clock`, `safety`, `goal` (the briefing's "What you want" line, verbatim: the
   plan's scenario, not the card's `goal` — the harness quotes it back in `GOAL_CHECK`), and `storage_state` for returning personas.
2. Issue all the batch's persona Agent calls **in one message** (`subagent_type:
   "ux-assessment:persona"`, prompt = the briefing only, `run_in_background: false`). Each has its
   own session. Pass `run_in_background: false` explicitly — Claude Code may otherwise run the agent
   in the background and return at once, while the persona is still acting.
3. Only once a persona's Agent call has returned its final reply (never on an "agent launched"
   result, a progress note or a handback while it may still be acting), call `harness_signals`. If `ended` is `false` and the reply does not
   report `UNKNOWN_SESSION` or `SESSION_STOPPED`, the persona skipped `end_session`: send that same
   agent **one** follow-up (SendMessage to its agent id; load SendMessage with ToolSearch if it is
   deferred): "You have not called end_session, so your session does not count yet. Call
   end_session now, then reply with your summary." Nothing else: no hint about the app or the
   goal. Never send a second one; if it still has not ended, `outcome` stays `null` and
   `harness_problems` gets `"no end_session"`. Then save each final reply to `<dir>/summary.md`;
   note its `context_tokens` and its duration (both calls together when there was a follow-up).
   `context_tokens` is the token figure in the Agent result: the agent's final context size, not
   the tokens it processed. The hook records the processed tokens.
4. `harness_stop` each session (returns the final signals) — always, also if the persona failed.
   Copy `outcome`, `steps`, `frustration` and `stop_before` into `run.json` from that result, not
   from the persona's reply (`outcome: null` = the persona never called `end_session`). For sound,
   read `audio_session` (the whole session); `audio` covers only the last page load, so it reads
   silent after a reload — that is not a harness problem. When `over` is `BROWSER_CLOSED`, the
   browser quit under the persona: add `"browser closed"` to `harness_problems` (its `gave_up` is
   not the app's).

Do not open screenshots yourself; triage does. If a session fails for a harness reason, record it
and continue. Then write `<run folder>/run.json`:

```json
{"date": "…", "started_at": "…", "url": "…", "mode": "…", "unattended": false, "sessions": [{"persona": "…",
  "outcome": "…", "stop_before": null, "steps": 0, "frustration": 0, "context_tokens": 0, "tool_uses": 0,
  "duration_s": 0, "harness_problems": []}], "not_tested": []}
```

`started_at` is the ISO time the first batch started (`node "$PLUGIN/driver/probe.mjs" now`); the ledger
orders same-day runs by it.

## 9. Triage

First run `node "$PLUGIN/driver/ledger.mjs" sync <project>` (show any stderr warning to the user).
Dispatch `ux-assessment:triage` with: run folder, project root, `$PLUGIN/knowledge/triage.md`,
paths of charter, personas and plan, the ledger path `<project>/.ux-assessment/ledger.yaml`, the
report language (the user's), whether the run was unattended (then the report opens with the
charter's assumption list), and **suppress**: the titles labelled `won't fix` in
`.ux-assessment/feedback.md` (none → "none"). It writes `findings.yaml`
and this run's section of `feedback.md`, and **returns the report as its final reply** (Claude Code
does not let subagents write report files): save that reply verbatim, as it is, to `<run folder>/report.md` with Write. Its first section,
"Summary", is what you tell the user in step 10. After saving `report.md`, run
`node "$PLUGIN/driver/usage.mjs" report <run folder>` and append its output verbatim to `report.md`
under a `### Tokens` heading at the end of its Run facts section ("not measured" is an answer too). The orchestrator figure is recorded only when the conversation's turn ends, so it may be missing here; say the user can run `node "$PLUGIN/driver/usage.mjs" report <run folder>` again afterwards for it.
Then run `ledger.mjs sync <project>` again.

## 10. Tell the user

In their language: the top findings (one line each, with severity), where the report is, what was
not tested, and the tokens used per model (the `### Tokens` table). Say that the orchestrator row
keeps growing until this conversation ends, and that the plugin reports tokens, not a share of a
subscription. Then **offer** (ask, do not edit) to add to
`.gitignore` — unattended: never edit it, list the lines in the final message instead:

```
.ux-assessment/runs/*/*/screenshots/
.ux-assessment/runs/*/*/log.jsonl
.ux-assessment/runs/*/*/signals.jsonl
.ux-assessment/runs/*/*/downloads/
.ux-assessment/state/
.ux-assessment/secrets.local.yaml
.ux-assessment/usage.jsonl
.ux-assessment/active-run
```

Finally, attended: offer **Label findings now** · **Later**.

## 11. Label findings (SPEC D15, minimal)

Read `.ux-assessment/feedback.md` and pick the lines with `label: ?`. First run `node "$PLUGIN/driver/ledger.mjs" status <project>` and show each finding's ledger status next to its
title, in plain words (knowledge/verify.md → Statuses), for example "F-03 … (not seen this
time)". Walk them with AskUserQuestion,
at most 4 findings per card, one question each: the finding's title and a one-line what happened;
options **Valid** · **Not real** · **Known, won't fix** (free text via "Other" goes into the note; ask
"why not real?" in the note for Not real). Write each line back as
`- F-03 <title> — label: valid|not real|won't fix — note: <text>`. Then report, per run,
precision = valid / (valid + not real), and that won't-fix titles will be suppressed next time.
Then run `ledger.mjs sync <project>` so the labels reach the ledger.
When a note says the behavior is on purpose (by design, intended, leads to sign-up, …), ask once per
such finding: **Add to Intended behaviors** · **No**. On yes, append a line to the charter's
`## Intended behaviors` (template in `knowledge/charter.md`; add the heading if missing):
`- <behavior in user terms> — why: <the note> — source: label F-07 (run <name>)`. Later triage then
lists it as working as intended unless it costs a persona the goal.
Labels persist across runs: a later `?` does not clear them; to undo "not real" or "won't fix", write `valid`.

## V. Verify fixes (SPEC D15 verify-only)

Rechecks the open findings of earlier runs against the app as it is now: one short verifier
session per finding. What it saw goes into `.ux-assessment/ledger.yaml`. Read
`$PLUGIN/knowledge/verify.md` first. Verifiers know the finding, and that is fine because they do
not discover. Nothing from a verifier ever goes into a persona briefing. You need a running app
(step 1, same unattended rules) and the harness config of step 5 from the existing charter. You do
not need recon, intake, personas or a plan.

**V1. Sync.** Run `node "$PLUGIN/driver/ledger.mjs" sync <project>`. For every stderr warning (for
example an unknown label in feedback.md), tell the user what it means before going on.

**V2. Pick.** `node "$PLUGIN/driver/ledger.mjs" open <project>` prints the findings to check as JSON.
If it prints none, say so and stop.
- Attended, ask: **All open** (recommended) · **High and medium only** · **Pick**. For Pick, use
  multi-select by title, at most 4 per card; Pick may also offer the `needs_review` findings
  (`ledger.mjs open <project> --needs-review` lists them too).
- Unattended: all open.

**V3. Tokens.** Run `node "$PLUGIN/driver/usage.mjs" estimate --harness claude --verify <n>` and
give the result in one line: the verifier token range, the orchestrator row, and the API-equivalent
line. Attended: ask **Go** · **Cancel**.

**V4. Run.** The run folder is `<project>/.ux-assessment/runs/<date>-verify/` (absolute). Use
`-verify-2`, `-verify-3` if it already exists. Write its name (e.g. `2026-09-29-verify`) as the only
line of `<project>/.ux-assessment/active-run`. Take the findings in batches of
`max_parallel` (1 when server-side state is shared). For each finding in a batch:
1. **Returning start** (`session.start_state: returning`):
   - The state file is `session.storage_state`, or else `<project>/.ux-assessment/state/<check.account>.json`.
   - Run `node "$PLUGIN/driver/verify.mjs" check-state <file> <url>`.
   - If it is not `ok` and the run is attended with a password account in `secrets.local.yaml`,
     refresh the state with step 5's setup session and check again.
   - If it is still not `ok`, or the account is OAuth/OTP, or the run is unattended: write
     `<run>/<id>/summary.md` containing **only** the fenced YAML preflight block from
     knowledge/verify.md — fences included, nothing else in the file — using the reason in the
     note. Skip the session.
2. `harness_start` with the options in knowledge/verify.md → "Session options": `session: <id>`,
   `dir: <run>/<id>`, `cap: 15`, no `patience_budget`.
3. Issue all the batch's verifier calls **in one message**: `subagent_type: "ux-assessment:verifier"`,
   prompt = the Brief from knowledge/verify.md, with the absolute `screenshots` paths,
   `run_in_background: false` (as in step 8.2).
4. A verifier whose final reply came without `end_session` gets the same single follow-up as a persona (step 8.3), under the same rule: only after its Agent call has returned. Save each final reply verbatim to `<run>/<id>/summary.md`. Write `<run>/<id>/session.json` as
   `{"context_tokens": …, "tool_uses": …, "duration_s": …}` from the Agent result.
5. `harness_stop` every session, also when the verifier failed.

**V5. Record and report.**
1. Run `node "$PLUGIN/driver/verify.mjs" record <project> --run <run folder name, e.g. 2026-09-29-verify> --cli claude --url <app url>`.
   It writes `verify.yaml`. Each id under `guards` is a verifier that did not back its claim; name
   those findings in the report.
2. Run `ledger.mjs sync <project>` (handle warnings as in V1). Then run
   `ledger.mjs table <project> --run <run folder name, e.g. 2026-09-29-verify>`.
3. Write `<run>/verify-report.md` with these sections:
   - **Summary** first, in the user's language: how many findings were checked, the count per
     verdict, and each status change in plain words.
   - The table, verbatim.
   - **Needs a look**: the `changed` findings, with their screenshot.
   - **Could not check**: the `unreachable` and guarded findings, with the reason.
   - **Run facts**: sessions, and the output of `node "$PLUGIN/driver/usage.mjs" report <run folder>`
     verbatim (tokens per role and model, with the API-equivalent line).
4. Tell the user the Summary. Say plainly that "not seen this time" is not "fixed": a finding
   counts as fixed only after two separate checks did not see it. Offer a second check later for
   the `not_seen` ones.
