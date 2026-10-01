---
name: ux-assessment
description: Assess a running local web app with simulated users in isolated browser sessions, then triage the evidence into a UX report. Use for UX assessments, usability tests, and persona tests in Codex.
---

# UX assessment in Codex

This is the Codex entry point for the same assessment used by Claude Code. The
plugin root is three directories above this file's real path; call it `$PLUGIN`.
`$PLUGIN` is a placeholder: write the absolute path in its place in every command;
it is not a shell variable (PowerShell would expand it to nothing). The project
is the app repository in the user's request. Write all assessment artifacts to
`<project>/.ux-assessment/`. Read shared knowledge only when needed:
`$PLUGIN/knowledge/{intake,charter,personas,triage}.md` and the selected
`$PLUGIN/knowledge/packs/*.md`. Use `$PLUGIN/SPEC.md` for the data contract.
Communicate in the user's language; internal artifacts stay in English.

## Isolation rule

Do not run persona sessions in ordinary Codex subagents. They inherit broad
file, shell, and network access. The persona sees only the briefing from
`knowledge/personas.md` and the two tools on `driver/persona-bridge.mjs`.
Run each persona with `node "$PLUGIN/driver/codex-runner.mjs" <private-job.json>`.
The runner starts a separate `codex exec` process with two layers of isolation.
On every OS it disables Codex's built-in tools (shell, files, images, browser,
plugins, helper agents, web search) and refuses to run when Codex enables a
feature ux-assessment has not classified. On macOS it also runs inside
`sandbox-exec`, which cannot read the app or plugin trees or connect directly to
the local app port. On Windows and Linux the tool layer is the only one, so the
runner also requires a passing self-check for the installed Codex version (step 6).
The persona gets one screenshot-based `act` and one `end_session` tool; the parent
owns the browser, state, and logs. Never pass code, routes, app-profile, charter,
other personas' results, or UI hints into a briefing. State files and passwords
stay under `.ux-assessment/` with owner-only permissions and outside Git.

## Workflow

1. **State and URL.** Check for an existing `.ux-assessment/`. Offer New run,
   Label findings, Verify fixes, Re-run triage, or Start over when applicable (unattended:
   `verify` in the request selects Verify fixes). Choose Quick,
   Guided, or Expert with the user; Guided is the attended default. Confirm a
   running local app URL. The Codex persona runner currently supports only
   `localhost` or `127.0.0.1`. Do not start a server in unattended mode. In
   unattended mode use the recommended answers from `knowledge/intake.md`,
   record every assumption, and never perform manual login.
2. **Recon and pack.** Inspect the app as the planner, including source when
   available, and write `.ux-assessment/app-profile.md`. Use the scope in
   `$PLUGIN/agents/recon.md`. Select a matching pack with
   `knowledge/charter.md`; otherwise make an explicitly unreviewed local pack.
3. **Intake.** Explain in plain language what simulated users can and cannot
   find. Ask the mode's questions from `knowledge/intake.md`: Guided has six
   short rounds, Quick has one or two cards, Expert lets the user edit a draft.
   Write `charter.md` and `config.yaml` from `knowledge/charter.md`, including
   the intake record and safety settings.
4. **Personas and plan.** Use `knowledge/personas.md` coverage rules and schema.
   Guided/Expert: 5–7 distinct people; Quick: core, casual, constrained (3).
   Show their goals and start states. Plan user-language scenarios, caps,
   run order, the models per role (`node "$PLUGIN/driver/models.mjs" show <project>`;
   show the user any warning it prints), and a token estimate before running:
   `node "$PLUGIN/driver/usage.mjs" estimate --harness codex --personas <n> --cap <cap>`.
   Rows it cannot measure say "not measured". The Codex main session is not
   measured (SPEC D31). Keep shared-account or shared
   database personas sequential. Store the approved plan in `plans/<date>.md`.
5. **Returning users.** Use credentials only from
   `.ux-assessment/secrets.local.yaml`. As the parent, log in through
   `Session` in `$PLUGIN/driver/session.mjs`, call `saveState`, and check
   `cookies + origins > 0`. Pass the resulting absolute path as
   `session.storageState` in the runner job. The persona briefing may include
   the user's login facts from the card, but never what the account contains.
   If OAuth/OTP requires manual login, ask in attended mode or skip and record
   it under Not tested. Never invent credentials.
6. **Run.** For each planned persona, write a private JSON job file, mode
   `0600`, under `.ux-assessment/`. Its shape is:

   ```json
   {
     "projectRoot": "/absolute/app/repository",
     "session": {
       "id": "core",
       "dir": "/absolute/app/repository/.ux-assessment/runs/date/core",
       "url": "http://localhost:3000/",
       "viewport": "desktop",
       "cap": 30,
       "patienceBudget": 10,
       "safety": { "external_navigation": "stop", "stop_before": [] },
       "storageState": null
     },
     "briefing": "Session id: core..."
   }
   ```

   On Windows, write the paths in a job with `/` (`C:/work/app`) or escaped
   backslashes (`C:\\work\\app`); `path.resolve` accepts both.

   Leave `model` and `effort` out of the job. The runner takes them from
   `models.codex.<role>` in `.ux-assessment/config.yaml`, or else from its defaults. A job's
   `model` or `effort` wins over both. Each run appends its tokens to
   `.ux-assessment/usage.jsonl` with the run folder's name.

   Other `Session` option names are `fsMode`, `files`, `permissions`, `clock`, `goal`, and
   `autoplay`. Pass the charter's `clock` to every persona and verifier job, and to a persona
   job `goal`: its briefing's "What you want" line, verbatim (`GOAL_CHECK` quotes it back). The
   briefing follows the **Briefing** template in
   `knowledge/personas.md` exactly. Execute the runner and use its JSON result,
   `codex-result.json`, `summary.md`, `log.jsonl`, and `signals.jsonl` as the
   evidence. Treat `signals.outcome`, steps, frustration, and stop labels as
   authoritative; a final reply alone is not proof. When `signals.over` is
   `BROWSER_CLOSED`, the browser quit under the persona: add "browser closed"
   to `harness_problems` (its `gave_up` is not the app's). If a run fails, preserve
   its evidence and mark that persona Not tested. Respect `max_parallel`.

   On Windows and Linux, before the first persona: if
   `<project>/.ux-assessment/codex-self-check.json` is missing, or the runner refuses with "no
   passing self-check on record", tell the user the check costs one small model call (a few
   thousand tokens), or two if the first one skips the tools, then run `node "$PLUGIN/driver/codex-runner.mjs" self-check --project <project>`.
   Continue only if it ends with `PASS`; on `FAIL` stop and show its output. Run it again after
   every Codex update. Never set `UXA_CODEX_SELF_CHECK=skip`.
7. **Triage and report.** Run `node "$PLUGIN/driver/ledger.mjs" sync <project>` before triage and
   pass the ledger path; run it again after writing the report and after labelling. Show ledger
   statuses next to titles when labelling. Read `$PLUGIN/knowledge/triage.md` and
   `$PLUGIN/agents/triage.md`. Verify findings against screenshots and harness
   signals, distinguish app problems from harness problems, and write
   `findings.yaml`, `feedback.md`, and `<run>/report.md`. The report opens with
   assumptions in unattended mode. Summarize top findings, coverage gaps, and
   actual run metrics, including the table from
   `node "$PLUGIN/driver/usage.mjs" report <run folder>`, appended to `report.md` under
   `### Tokens`. Offer to add the run logs, screenshots, state, and
   `secrets.local.yaml` to the app's `.gitignore`; do not edit it unasked.
   Offer finding labels in attended mode and apply the label rules in the
   existing feedback file, including the Intended behaviors offer (Claude skill step 11).
8. **Verify fixes.** Follow section V of the Claude skill (V1–V5) with these Codex differences.
   V3 runs `usage.mjs estimate --harness codex --verify <n>`. V4 needs no `active-run` file: the
   runner takes the run from the session folder.
   Run each finding through the runner with `role: "verifier"`, written to a private `0600` job
   file under `.ux-assessment/`. Knowledge isolation still applies: no verifier brief, reply,
   `verify.yaml`, ledger, or verify report ever reaches a persona briefing.

   ```json
   {
     "role": "verifier",
     "projectRoot": "/absolute/app/repository",
     "session": {
       "id": "F-03",
       "dir": "/absolute/app/repository/.ux-assessment/runs/2026-09-29-verify/F-03",
       "url": "http://localhost:3000/items?view=list",
       "viewport": "mobile-small",
       "cap": 15,
       "patienceBudget": null,
       "safety": { "external_navigation": "stop", "stop_before": [] },
       "storageState": null
     },
     "briefing": "Session id: F-03\nFinding F-03 (medium), last seen in run 2026-09-28: …",
     "images": ["/absolute/app/repository/.ux-assessment/runs/2026-09-28/phone-idea-catcher/screenshots/s03.png"]
   }
   ```

   - The runner copies the images into its private temp directory and attaches them. Images
     outside `.ux-assessment/` or missing are listed in `images_skipped`.
   - The verifier additionally gets `harness_signals`. The isolation is the same as for personas.
   - The runner writes `summary.md` and `codex-result.json` in `session.dir`.
   - Run `check-state` before any returning session.
   - Record with `--cli codex`.

The Claude skill at `$PLUGIN/skills/ux-assessment/SKILL.md` contains the full
shared workflow details and output format. Its `AskUserQuestion`, Agent, and
Claude MCP tool names are Claude-specific; use Codex questions, shell, and the
runner described here for those steps.
