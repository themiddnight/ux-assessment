# Verify-only mode — brief, verdicts, statuses (SPEC D15)

A verifier rechecks **one** earlier finding against the current app. It is not a persona:
- it knows the finding;
- it goes straight to the spot;
- it never looks for new problems.

Knowledge isolation (SPEC §3) protects discovery, and verification is not discovery. The other
direction still holds: nothing from a verifier ever goes into a persona briefing. That covers its
brief, its reply, `verify.yaml`, `ledger.yaml` and `verify-report.md`.

The verifier's own rules and its reply format are in `agents/verifier.md`. Codex embeds that file,
because Codex verifiers cannot read this folder.

## Brief — one per finding, built from `ledger.mjs open`

```
Session id: <finding id>
Finding <id> (<severity>), last seen in run <last_seen>: <title>
What happened then: <what_happened>
Where it was: <check.where, or "not recorded: work it out from what happened and the screenshots">
What makes it true: <check.condition, or "not recorded: work it out from what happened and the screenshots">
Earlier screenshots: <absolute paths from `screenshots`, one per line, or "none (pruned): work from the text">
Device: <desktop | phone (360x640, touch)> · You start <as a new visitor | already logged in>.
You have at most 15 actions. The app is already open in front of you.
```

- Claude Code: the verifier opens the screenshot paths with `Read`.
- Codex: the runner copies the same files into its temp directory and attaches them as images, in the same order.
- Old findings have no `check`. The verifier derives the spot and the condition from `what_happened` and the screenshots.

## Session options

| option | value |
|---|---|
| `session` | the finding id (for example `F-03`) |
| `dir` | `<run>/<id>` |
| `url` | the current app origin + the path and query of `session.url`; the step-1 app URL when that is null |
| `viewport` | `session.device` |
| `cap` / patience | `15` / none |
| `safety`, `fs`, `files`, `permissions`, `clock` | from the charter (skill step 5) |
| `storage_state` | when `session.start_state` is `returning` |

## Verdicts and guards

| verdict | meaning | `at_step` |
|---|---|---|
| `reproduced` | at the spot, the condition holds | recommended |
| `not_reproduced` | at the spot, the condition does not hold | required |
| `unreachable` | could not reach the spot (expired login, cap, STOP, error, device) | none |
| `changed` | the spot was redesigned; the finding no longer applies as written; needs a human | recommended |

`node $PLUGIN/driver/verify.mjs record` reads every `<run>/<id>/summary.md`, keeps the last YAML
block that has a verdict, and writes `verify.yaml`. Its guards:
- A missing reply or block gives `unreachable`, and so does an unknown verdict.
- An `at_step` that is not a logged step with a screenshot is cleared to `null`, with a `guard` note.
- A `not_reproduced` without `at_step` counts as `unreachable` in the ledger.

A preflight `check-state` that is not `ok` means no session is started. The orchestrator writes
`<run>/<id>/summary.md` itself, containing **only** the fenced YAML block below — fences included,
nothing else in the file — because `verify.mjs record`'s `extractVerdict` requires the fence to
read a verdict:

```yaml
id: F-07
verdict: unreachable
note: "saved login expired (preflight)"
```

## Statuses (`driver/ledger.mjs`)

| status | meaning | say to the user |
|---|---|---|
| `open` | seen by a persona; not checked since | still open |
| `still_present` | the last check reproduced it | still there |
| `not_seen` | the last check did not see it (one clean run) | not seen this time; not yet confirmed fixed |
| `fixed` | not seen in ≥ 2 separate verify runs in a row | fixed (not seen in two checks) |
| `needs_review` | the last check says the spot changed | the screen changed, please look |
| `regressed` | a persona saw it again after it was fixed | came back after a fix |
| `not_real` / `suppressed` | labelled not real / won't fix | (not checked) |

Some checks do not change a status:
- `unreachable` never changes a status.
- A persona run that merely did not meet a finding counts for nothing.
- Two verdicts for one finding in one verify run count once.

## Tokens

In tokens (SPEC D31). Before the run: `node "$PLUGIN/driver/usage.mjs" estimate --harness <claude|codex> --verify <n>`
(the coefficients are in `knowledge/cost.md`). After it: `node "$PLUGIN/driver/usage.mjs" report <run folder>`.
Measured once (Claude, Sonnet verifiers, up to 15 steps): per finding about 36k input, 709k cached
input and 6.3k output tokens.
