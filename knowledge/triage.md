# Triage rules and report template

Used by the triage agent (SPEC D14, §7). Inputs per persona run folder:
`log.jsonl` (what the persona claimed), `signals.jsonl` (what the harness observed),
`screenshots/sNN.png`, the persona's final summary. Plus `charter.md`, `personas.md`, the plan,
whether the run was unattended, and a **suppress** list (titles the developer labelled
`won't fix` in `feedback.md`).

## 1. Read each session

- Journey: steps used, outcome (`end.outcome`), frustration curve, exit interview.
- Friction points: every log entry with `event != none`, every `went_back`, and stretches of 3+ steps
  without progress toward the goal.
- Expectations (§8): every row of `driver/expectations.mjs` whose pattern is `dead_control`,
  `unexpected_result`, `partly_expected` or `control_unpredictable`. These are friction points even
  when the persona logged `event: none` and went on.
- Honesty audit: did the persona continue past its patience budget? Did it claim things the
  screenshot does not show? Open the screenshot for every friction point you keep.

## 2. Cross-check claims against harness signals (before anything counts as `ux`)

| persona claim | check | if it contradicts |
|---|---|---|
| "nothing happened" (`no_response`) | log `visual_change` + `changed_box`, next screenshot, `action-error` / `screenshot-error` signals | `none` backs the claim; `changed` contradicts it — open the screenshot at `changed_box`: a change far from where the persona looked or too subtle is still `ux` (say so), a plain miss is `agent_error`; `animating_only` or `null` is inconclusive — judge from the screenshots; `action-error` → `agent_error` |
| "it played" / "no sound" | `audio` signals per step (`maxPeak`, `nonSilentMs`, `states`; they reset on reload) and `audio_session` in the `stop` signal | claim ≠ signal → the *visual feedback* is the finding, not the audio |
| "saved" / "save did nothing" | `picker-*`, `download`, OPFS files in `stop` signal | |
| "error" | `pageerror`, `console-error`, `http-error` signals | page errors the persona never saw are `watch` findings for the developer |
| anything about the "Simulated system dialog" | — | always `env_error` |
| stuck after Save/Open ("Saving…" forever) | `picker-save-shown` with no `picker-save` / `picker-save-cancel` after it | the stand-in was not usable → `env_error`; report it as a harness problem |
| a dropdown "does not open" | `picker-select-shown` at that step | shown → the persona missed the list (`agent_error` or subtle UI); not shown → check that the control is a native `<select>` |
| "could not open/import a file" | `picker-file-shown {accept, multiple}`, then `picker-file {names}` or `picker-file-cancel` | shown with no follow-up → stand-in unusable → `env_error`; no files matched `accept` or none offered → `env_error` (sample files missing); `picker-file` then the app ignored the file → `ux` |
| "the date/time/color field is broken" | `picker-date-shown {input_type}` → `picker-date {input_type, value}` / `picker-date-cancel {input_type}`; `picker-color-shown` → `picker-color {value}` / `picker-color-cancel` | shown with no follow-up → `env_error`; a value set but the app shows another → `ux` (check the screenshot) |
| "the app asked for my microphone / MIDI / …" | `permission-shown {kind}`, `permission {kind, decision}` | the prompt's look is the harness's (`env_error` if it confuses); how the app explains the request or handles `block` is `ux` |
| "it said STOP" / stopped before something | `stop-before {url, label, method}`, `stop` signal `stop_before` | not a failure — see below |
| an error after a background call | `blocked {url}` before it | caused by the charter's `block` list → `env_error`, not `ux` |
| "I lost my work when leaving" | persona note on `beforeunload` ("Leave site?" answered "Leave") | the answer was the harness's; whether unsaved work was warned about and kept is `ux` |
| a timing claim ("the countdown was wrong", "it ran out too fast", sound or animation out of step with the screen) | `setup` signal `clock`; per step `page_time_ms` (and `waited_ms`, `wait_stop` on waits) in the log | under `clock: controlled` only main-thread timers follow page time: drift against a Worker, `AudioContext`/media, CSS animation or the server clock is `env_error`, never `ux`. Judge timing by `page_time_ms`, not by the log's real-time `t` |
| "I reached my goal" | `goal-check {final_observation}` (the persona's first `goal_achieved`, which the harness turned into one re-read of the goal), then the `end` record; `stop` signal `ended`, `outcome` | judge success by the charter's criteria and the evidence, never by the claim: a persona that ended `goal_achieved` short of a criterion is `agent_error`, and that session counts as not meeting it. `ended: false` / `outcome: null` = no `end_session` even after the orchestrator's one follow-up → the session has no exit interview; its steps still count as evidence |
| the session ended early, or `gave_up` with no reason on screen | `browser-closed` signal, or `over: "BROWSER_CLOSED"` in the `end` record / `stop` signal | the browser itself quit under the persona → `env_error`; the `gave_up` is not the app's. Judge the journey up to that step, and list the unfinished goal under "Not tested" |
| the page froze under the controlled clock | `clock-stuck` | the page's main thread never yielded (for example a busy-wait on `Date.now()`, which never ends on a paused clock) → `env_error`; a `pageerror` with `via: "timer"` is the app's own timer throwing → judge it like any page error |

`visual_change` compares the screenshot before and after the action, masking regions that animated
on their own in the last steps: `changed` (≥16 changed pixels outside the mask; `changed_box` is
their bounding box in CSS px), `none` (no pixel changed at all), `animating_only` (changes only
inside animated regions — a real response under a moving playhead also lands here), `null` (page
crashed or screenshot failed). Only `none` is proof that nothing happened.

**Stop-before is not a failure.** Outcome `stop_before` means the persona reached a boundary the
charter set (payment, outside account, leaving the app). Judge the journey up to that point: did
they get there easily, did they understand what would happen next (their `final_observation`)?
The stopped action itself is listed under "Not tested". `stop_before` in the outcome without a
`stop-before` signal means the persona stopped on its own before the boundary, following its
briefing: check the screenshot shows it really was at the boundary; stopping early is
`agent_error`.
The harness aborts the stopped request, so the app reacts as if the network failed: a
`console-error` / `pageerror` such as "Failed to fetch" and any error message on screen at the
same step as a `stop-before` signal are caused by the harness → `env_error`, never `ux`. (How the
app handles a failed request can still be a `watch` finding, labelled as seen only under the
harness.)

## 3. Classify, dedupe, rank

- `kind`: `ux` (the app's fault) · `agent_error` (persona misread the screen, clicked wrong
  coordinates, acted out of character) · `env_error` (shim or harness artefact).
- Dedupe across personas: the same root cause is one finding listing all affected personas.
- **Cross-run identity (the ledger).** The briefing gives `<project>/.ux-assessment/ledger.yaml`,
  or says "none" when the project has no ledger yet. Read its `findings` (title, status,
  what_happened of the last sighting).
  - Same root cause as a ledger entry → reuse that id. This also applies when its status is
    `not_seen`, `fixed`, `not_real` or `suppressed`: the ledger then records a regression or keeps
    the label. The title may be updated.
  - A new root cause → take the next free number for its prefix. The ledger and this run together
    decide which numbers are taken (`F-15` after `F-14`). `env_error` / `agent_error` records keep
    their own prefix as before.
  - Never renumber existing ids. Do not write `recurs_from`: the ledger holds the history.
- `confidence`: `signal` (seen by ≥2 personas, or 1 persona + harness evidence) · `watch` (one
  persona, plausible) · `noise` (likely agent error or out of character).
- `severity` = impact (`blocks` > `slows` > `cosmetic`) × number of persona groups affected.
  Label: high / medium / low.
- Code pointer: look up the component that renders the element (search the visible text in the
  source). Give a confidence (high / medium / low). This is the only step that reads code.
- **Suppress**: a `ux` finding with the same root cause as a title in the suppress list gets
  `suppressed: true`. It stays in `findings.yaml` and the appendix but not in the top findings, and
  the report lists it in one line under "Known, won't fix".
- **Intended behaviors** (the charter's `## Intended behaviors`): a `ux` finding whose root cause
  is a listed behavior gets `intended: "<that line's behavior>"`. Then decide by what it cost:
  - It only confused or slowed the persona (the goal was still reached, no success criterion
    failed) → also `suppressed: true`. The report lists it in one line under "Working as intended".
  - It cost the goal (the persona gave up, or a success criterion failed) → it stays a normal
    finding. The title names the cost, not the behavior, and `why_it_matters` says the intent may
    be right but the cost is new.
  Match the root cause, not a similar screen. A listed behavior is no reason to drop a different
  problem in the same place.

## 4. Finding record

```yaml
id: F-03
title: "No visual sign that sound is playing"
kind: ux                # ux | agent_error | env_error
confidence: signal      # signal | watch | noise
severity: high
personas: [casual-curious, core-beatmaker]
evidence: [casual-curious/screenshots/s07.png, "casual-curious log step 7", "signals: maxPeak 0.41 at step 7"]
what_happened: "Pressed play; audio ran (harness) but nothing on screen moved, so the persona thought it was broken."
why_it_matters: "Users with sound off cannot tell whether their loop works."
suggested_fix: "Animate the playhead and highlight active cells while playing."
code_pointer: {path: "src/components/Transport.tsx", confidence: medium}
check:                  # new ux findings: how a verifier gets back to the spot
  device: mobile-small  # desktop | mobile-small (the persona's device)
  start_state: newcomer # newcomer | returning
  account: null         # returning only: the card's account id
  where: "Beat tab of a new loop, on a phone"               # user terms, no code or component names
  condition: "Fewer than 16 beat columns are visible and nothing shows that more exist"   # observable
verified: false         # re-verification is M3
expectation: null       # dead_control | unexpected_result | control_unpredictable when the finding rests on §8 rows, else null
suppressed: false       # true when it matches the suppress list, or an intended behavior at no goal cost
intended: null          # the charter's intended behavior it matches, if any
```

`check` is required on every new `ux` finding, and keeps its value on a finding whose id is reused
(update it when the spot moved). `where` describes how a user reaches the spot. `condition` is the
one observable fact that makes the finding true, checkable on one screen, or on one screen plus
`harness_signals`.

## 5. `report.md` (in the developer's language; findings' quotes stay verbatim)

- **Summary** — always first: the top findings as one line each (id, severity, title), counts per
  kind (ux / agent_error / env_error), how many were suppressed or working as intended, and anything that makes this
  run's results unreliable.
0. **Unattended runs only: Assumptions** — first, before anything else: the charter's
   `## Assumptions` list, one line each, and a sentence that nobody answered the intake questions.
1. **Top 5–7 findings** — what happened, why it matters (one line), evidence (screenshot links),
   suggested fix, code pointer. `ux` + `signal`/`watch` only, ranked by severity. When the id came
   from the ledger, add "seen before" (and "came back after it was fixed" when its ledger status is
   `fixed`).
2. **Per-persona journey** — how far each got, where they struggled or quit, exit interview.
   **What people expected** — the table of §8, right after the journeys. Leave the section out,
   with one line saying so under "Run facts", when no session recorded expectations.
3. **Not tested** — from the charter, skipped personas (OAuth/OTP/2FA, no credentials), each
   stop-before boundary reached, and anything else the run could not reach.
   **Known, won't fix** — suppressed findings, one line each.
   **Working as intended** — findings matched to an intended behavior at no goal cost, one line
   each: the behavior and what the persona made of it.
4. **Agent and environment errors** — so the developer can discount them.
5. **Run facts** — sessions, steps, context tokens per session (`run.json` `context_tokens`, or
   `tokens` in older runs: the agent's final context size, not the tokens it processed), harness
   problems. No dollar figures. The orchestrator appends the token table under `### Tokens`.
6. **Appendix: all findings** as finding records.

Write `findings.yaml` (all records) in the run folder. The report itself goes back in your final
reply (agents/triage.md); the orchestrator saves it as `report.md`.

## 6. `feedback.md` — the labelling sheet (SPEC D15)

Append a section for this run to `<project>/.ux-assessment/feedback.md` (create it with the heading
`# Finding labels` if missing; never change other runs' sections). Re-triage of a run replaces
that run's section, keeping every label and note already filled in for a finding with the same
root cause. One line per `ux` finding that is not
suppressed:

```markdown
## Run <run folder name> (runs/<run folder name>/report.md)
- F-03 No visual sign that sound is playing — label: ? — note:
```

The developer labels each line later: `valid`, `not real` (with a reason in the note) or
`won't fix`.

## 7. Reading screenshots and visual signals

- `visual_change` compares the screen right before the action with the screen after it (settled).
  `changed_while_idle` (+ `idle_box`) compares the previous step's screenshot with the screen right
  before this action: something changed while the persona was reading or thinking — typically a
  slow response landing late. A `no_response` claim on step N is contradicted when step N+1 has
  `changed_while_idle: changed` near the target: the response was slow, not missing (a `ux`
  finding about speed or feedback, not about a dead control).
- Compare two screenshots yourself with the driver's own thresholds:
  `node <plugin root>/driver/png-diff.mjs a.png b.png` (plugin root = the folder that holds this `knowledge/` folder) → `{changed, ratio, box}`. Compare **consecutive**
  screenshots of the step in question (sN-1 → sN is what step N did); sN → sN+1 is the next step.
- `limited {label, used, max}`: a request under a `stop_before` allowance went through (e.g. the
  one allowed AI question). The next one is stopped with a STOP note.

## 8. Expectations: what the persona thought a control would do

Before each click, double-click, drag, typed text and key press, a persona states `expect`
(`outcome`, and `confidence`: `sure`, `guess` or `cannot_tell`). The harness logs it before the
action runs, so it cannot be hindsight. On its next call the persona gives `expectation_met`
(`yes`, `partly`, `no`). `node <plugin root>/driver/expectations.mjs <run folder>` pairs the two
with the harness's `visual_change` and gives each row one `pattern`:

| pattern | rule | what it says |
|---|---|---|
| `stopped_by_harness` | the step has `stopped_before` | The harness aborted what the action started (a STOP note). Never a finding about the control: see "Stop-before is not a failure" (§2). |
| `action_failed` | the step has `action_error` | The action itself did not run. Judge it as §2 does (`agent_error`), not as the app's answer. |
| `dead_control` | `visual_change: none` and the persona did not say `yes` | The persona expected an answer and nothing on screen changed. Harness proof that nothing was shown. |
| `control_unpredictable` | `confidence: cannot_tell` | The persona could not tell what the control was for and pressed it to find out. |
| `unexpected_result` | `expectation_met: no`, and `visual_change` is not `none` (`changed`, `animating_only` or `null`) | The control did something other than what its look or label promised. |
| `partly_expected` | `expectation_met: partly` | Close to the expectation; read `after` for the difference. |
| `guess_confirmed` | `confidence: guess`, `expectation_met: yes` | It worked, but the persona was not sure beforehand. |
| `as_expected` | `confidence: sure`, `expectation_met: yes` | Clear and correct. |
| `unjudged` | no verdict was given | The session ended, or was cut off, right after the action. |

`expectations: "off"` or `"unknown"` for a persona means its session did not ask for expectations:
say so under "Run facts" and judge that session by §1–§2 alone.

Turning rows into findings:

- Group rows across personas by the control they aim at. `target` is free text, so match by the
  screenshot and the place on screen, not by the wording.
- `dead_control` is a `ux` finding at `signal` confidence from one persona (the harness backs it),
  unless the screenshot shows the click missed the control (`agent_error`) or `changed_while_idle`
  on the next step shows a slow response (§7).
- A `dead_control` row and a `no_response` event at the same step are one piece of evidence, not
  two. When the `audio` signals show sound at that step, the finding is the missing visual
  feedback (§2), not a dead control. For `type` and `press_key`, check the screenshot: a field that
  shows the typed text only after a blur is not dead.
- `unexpected_result`, `partly_expected` and `control_unpredictable` rest on the persona's word
  alone: `watch` from one persona, `signal` when two or more personas hit the same control. Open
  the screenshot first. An expectation no real person with that card would hold is `agent_error`.
- `guess_confirmed` is never a finding by itself. Many guesses on one control across personas are
  worth one `cosmetic` finding about its label or icon.
- A persona with `tech_literacy` or `domain_knowledge` above its card answers `sure` too often.
  When a low-literacy persona is `sure` about an unlabelled icon, note it in the honesty audit (§1)
  and do not count that row as evidence that the control is clear.
- Set the finding's `expectation` field to the pattern it rests on (`partly_expected` counts as
  `unexpected_result`). Quote `expect` and `after` in `what_happened`.

**The report table** ("What people expected") has one row per control with at least one
`dead_control`, `unexpected_result`, `partly_expected` or `control_unpredictable` row, ordered by
the number of personas, then by severity:

| Control | Where | Expected | What happened | Personas | Finding |
|---|---|---|---|---|---|
| the grey "Export" tile | Beat tab | "a file downloads" (guess) | nothing on screen changed | 2 of 4 | F-07 |

Under the table give one line of totals for the run: how many expectations were recorded, and how
many were `sure`, `guess` and `cannot_tell`. Then one line naming the controls where every persona
was `sure` and right, as what already works. Do not turn the totals into a score.
