# Decide rules — fix, keep or ask (SPEC D35)

Used by the decide agent (`agents/decide.md`), and by the Codex main session, which has no decide
agent. After triage, each open finding of a run gets one decision:
- `fix`: repair it;
- `keep`: it is on purpose, leave it;
- `ask`: the developer has to choose.

You propose. The developer decides. A decision never changes a finding, its status or its label.

Decide happens after discovery, so knowledge isolation (SPEC §3) does not limit what you read. The
other direction still holds: nothing the decide step reads or writes ever goes into a
persona briefing. That covers the product documents, the code you read, `decisions.yaml` and the
Decisions section of the report.

## Inputs

- The list from `decide.mjs todo`: the findings to decide (`id`, `title`, `severity`, `confidence`,
  `personas`, `what_happened`, `why_it_matters`, `suggested_fix`, `code_pointer`, `intended`, the
  screenshot paths) and `docs`, the product documents.
- The charter: its success criteria say what "reached the goal" means, and its
  `## Intended behaviors` lines are the developer's own statements.
- The project source.

`$PLUGIN` below is the plugin root: the folder that holds this `knowledge/` folder.

Decide every finding in the list, and only those. You do not judge whether a finding is real:
triage did that, and the developer's label settles it.

## What to look for, per finding

1. **What the documents say.** Search the product documents for the behavior the finding is about
   (the feature, the screen, the words on screen). Read the lines around each hit.
2. **What the code says.** Read the code around `code_pointer`, and what decides the behavior
   (a condition, a setting, a route guard). Code says a behavior is on purpose only when it states
   the intent: a comment, a named option, constant or flag, or a test that asserts the behavior.
   That the code behaves this way is not a statement of intent. Every bug is what the code does.
3. **What it cost.** Did a persona in `personas` miss its goal because of this? Read
   `what_happened` and `why_it_matters`, the outcomes in `<run folder>/run.json` and the charter's
   success criteria. A finding whose `intended` is set cost the goal: triage would have suppressed
   it otherwise.
4. Open a screenshot only when the text does not tell you what the persona saw.

## The tests, in order

Stop at the first test that gives an outcome.

1. **Do the sources disagree?** A document says one thing and the code does another, or two
   documents say different things about this behavior. → `ask`. The reason names both sides, and
   `sources` cites each side.
2. **Is it on purpose?** A document line, a charter Intended behaviors line or the code (as
   defined above) says the behavior is intended.
   - It cost a persona the goal, or you cannot tell → `ask`. A document says what was intended. It
     does not say the intent is right, and a goal that was lost is new information for the
     developer. This is never `keep`.
   - The persona still reached its goal → `keep`, with the source.
3. **Is the fix a product choice?** Nothing says the behavior is on purpose. List the fixes a
   developer could make, starting from `suggested_fix`.
   - The candidate fixes differ as product choices → `ask`, with the choices as `options`.
   - There is one obvious repair → `fix`.

### A product choice

A fix is a product choice when it changes one of these:
- **who can do what**: a sign-in wall, a role, a limit, a paid tier, what a guest may see or keep;
- **what the app asks of the user**: a required step, field, permission, confirmation or payment
  that is added or removed;
- **what is promised**: text that says what the product does, a price, a guarantee, what data is
  kept or deleted.

One obvious repair is not a product choice: a missing label, missing feedback after an action, a
dead control, an error message that does not say what to do, a control hidden on a small screen,
text that cannot be read. Two ways to build the same repair (a message under the field or a
notice at the top) are not a product choice either: that is `fix`.

When you cannot say which side a fix is on, ask this: would the developer be surprised to find it
changed without being asked? Yes → `ask`.

## Sources

A source is one line that you opened with Read in this session.

- `path`: relative to the project root, with forward slashes.
- `line`: the line number.
- `quote`: the text of that line, or a part of it, copied character for character. Keep it short:
  one sentence or one clause, at most about 120 characters. No paraphrase, no ellipsis, no two
  lines joined into one.

`keep` requires at least one source. Give sources on `ask` too when you have them, and both sides
when the sources disagree. `fix` needs none.

`node "$PLUGIN/driver/decide.mjs" record` reads every cited file and looks for the quote in it. It
corrects a wrong line number. It drops a source whose file is missing, or lies outside the project
and the product documents, or does not contain the quote. A `keep` left without a source becomes
`ask`, and the report says so. A guessed quote therefore gains nothing: when you have not read a
line that says the behavior is on purpose, the outcome is not `keep`.

## What you must not do

- Do not change a finding: its title, severity, text or id stay as triage wrote them.
- Do not drop a finding. One you leave out is recorded as `ask` with "no decision returned".
- Do not decide a finding that is not in the list. `record` drops it.
- Do not quote text you did not read.
- Do not edit any file except `<run folder>/decisions.yaml`. You do not fix code, edit the charter
  or touch `feedback.md`.
- Do not look for new problems.

## `decisions.yaml`

Write `<run folder>/decisions.yaml`. Everything in it is English.

```yaml
run: 2026-10-12
decided_at: 2026-10-12T09:30:00Z
decisions:
  - id: F-03
    decision: keep
    reason: "The PRD limits export to signed-in users, and both personas finished their beat without exporting."
    sources:
      - {path: docs/prd.md, line: 42, quote: "Export is for signed-in users"}
    options: []
    guard: null
  - id: F-04
    decision: fix
    reason: "Nothing on screen moves while the loop plays; animate the playhead."
    sources: []
    options: []
    guard: null
  - id: F-05
    decision: ask
    reason: "The README promises that projects are saved automatically, but the code saves only on the Save button, and one persona lost a project."
    sources:
      - {path: README.md, line: 18, quote: "Your work is saved automatically"}
      - {path: src/project/store.ts, line: 77, quote: "// save only when the user asks"}
    options:
      - "Save automatically, as the README says"
      - "Keep: saving stays manual, and the README is corrected"
    guard: null
```

- `run`: the run folder's name. `decided_at`: the output of `node "$PLUGIN/driver/probe.mjs" now`.
- `decision`: `fix`, `keep` or `ask`. Any other value is recorded as `ask`.
- `reason`: one sentence a developer can act on. For `fix`, the repair. For `keep`, what the
  source says and that the goal was reached. For `ask`, what has to be chosen and why you could
  not choose it.
- `options`: for `ask` only, two or three choices, one line each, each a thing the developer can
  do. When leaving the app as it is is one of them, write it last and start it with `Keep:`.
  Empty for `fix` and `keep`.
- `guard`: always `null`. `record` sets it when it changed your decision.
