# Intake — question bank (Guided, Quick, unattended)

Planner-only (SPEC D9, §4). Personas never see this or the answers.

## How to ask

- One round = one AskUserQuestion card with 1–4 independent questions. Each question has 2–4
  options: the recommended one first, marked "(recommended)", and **Not sure** last (→ the
  recommended default, recorded as an assumption). "Other" (free text) is built in.
- Every question carries one line on *why it is asked*, in the question text.
- Plain language, the user's language. Ask about what they know; translate to UX terms yourself
  ("Should people use this once, or come back every day?", not "Do you measure retention?").
- Skip a question recon already answered with confidence; record it as `from recon`.
- Later rounds adapt to earlier answers (e.g. no account needed → drop 6.3).
- Fill `{…}` from the app-profile and the chosen pack; never offer options in code words.
- Record every answer in the charter's *Intake record*: question, answer, source
  (`user` · `not sure → default` · `from recon` · `assumption (unattended)`).

## Round 1 — Confirm understanding

**1.1** "I understand this app is {summary} for {audience}. Is that right?"
- Why: everything else is built on this.
- Options: Yes, that's it (recommended) · Partly (say what is off in Other) · Not sure.
- Decides: app-profile summary; charter "What this app is".

**1.2** One per recon conflict, at most two: "The {docs} say {X}, but the app {does Y}. Which is
right?"
- Why: a mismatch may confuse people, or be a finding itself.
- Options: {X} · {Y} · Not sure (→ D7: behaviour from the running app, intent from the docs).
- Decides: app-profile *Conflicts*; a documented feature nobody finds becomes a scenario.

## Round 2 — Why test now

**2.1** "What made you want to test now?"
- Why: it decides what we look at hardest.
- Options: About to show it to people for the first time (recommended) · I changed something and
  want to check it · People got confused or stopped using it · Not sure.
- Decides: primary lenses — first-session value / the changed area / the drop-off point.

**2.2** Only after "changed" or "confused": "Which part?"
- Why: that part gets its own scenario.
- Options: up to three areas from recon (recent `git log --oneline -20`, main screens), in user
  words · Not sure.
- Decides: a must-have scenario.

## Round 3 — Users and goals

**3.1** "Picture one person you want using this. Who is closest?"
- Why: this becomes the main test person.
- Options: two or three archetypes from the pack and recon · Not sure.
- Decides: the core persona.

**3.2** "Are you that person yourself?"
- Why: if yes, we add someone very unlike you, so the test is not only people who think like you.
- Options: Yes · Partly (recommended) · No · Not sure.
- Decides: how far the "Not you" persona is pushed away from the developer.

**3.3** "Should people use this once, or come back often?"
- Why: returning use needs saving, reopening and an expert persona.
- Options: {recon's guess} (recommended) · Once or rarely · Every day or week · Not sure.
- Decides: *Relationship* dimension; expert persona; save/reopen lens.

**3.4** "What should a new person have done after five minutes?"
- Why: this is what counts as success in the test.
- Options: two or three candidates from app-profile "First 5 minutes" · Not sure.
- Decides: success criteria; the main scenario.

## Round 4 — Worries

**4.1** (multi-select) "Is there a part you are unsure about, or where someone already got
confused?"
- Why: those parts get their own scenarios.
- Options: up to three areas from recon, in user words · Nothing in particular.
- Decides: must-have scenarios.

**4.2** "Has anyone else used it yet?"
- Why: it tells us whether the test people are based on real users or on guesses.
- Options: No one yet (recommended) · A few friends · Real users · Not sure.
- Decides: persona `grounding` (`data` only with real users); what the report can claim.

## Round 5 — You might be missing

**5.1** (multi-select, up to two questions of 4 options) "Apps like this often trip people up
here. Which should we also check?"
- Why: common trouble spots you may not have thought of.
- Options: the pack's "You might be missing" items plus recon's, the pack's recommended ones marked
  "(recommended)".
- Decides: extra lenses and scenarios.

## Round 6 — Execution

**6.1** "Should the test people use the app at the same time, or one after another?"
- Why: at the same time is faster; one after another is needed if they share one account or data.
- Options: At the same time (recommended unless recon flags shared server state) · One after
  another · Not sure.
- Decides: `max_parallel` (3 or 1).

**6.2** "How long should each person get?"
- Why: longer finds more, but costs more.
- Options: Up to 30 actions (recommended) · Up to 15 · Up to 45 · Not sure.
- Decides: `cap` (casual personas get two thirds of it).

**6.3** Only if the app has accounts: "How do people get in?"
- Why: returning users need a test account; some logins cannot be automated.
- Options: New people sign up themselves (recommended when signup is open) · I have a test account
  (I'll put it in `.ux-assessment/secrets.local.yaml`) · Login uses Google, SMS codes or similar —
  I'll log in by hand once · Not sure.
- Decides: start states; setup sessions; `headed` manual login.

**6.4** "The test people will stop before: {stop-before list}. They never: {forbidden list}.
Stand-ins: {shims, e.g. 'a simulated Save window'}. Right?"
- Why: nothing real should happen (payments, emails, outside accounts).
- Options: Looks right (recommended) · Change something (say what in Other) · Not sure.
- When recon found something that spends the developer's money or quota (an AI API on their keys,
  SMS credits), add one question: "The app calls {service} with your key. May each test person
  use it?" Options: **Up to once each** (recommended) · Up to 3 times each · No, stop before it ·
  Not sure (→ No). → `stop_before` `max` (knowledge/charter.md).
- Decides: charter safety rules and shims → the harness config.

Perception is not asked: the driver supports screenshots only; record `screenshot`.

## Quick subset

One card (a second only if needed): **1.1**, **3.1** (with 3.2 folded in: "…and is that you?"),
**3.4**, **6.4**. Second card only for recon conflicts (**1.2**) or accounts (**6.3**).
Everything else takes its unattended default, recorded as `not sure → default`.

## Unattended defaults

Each is recorded as `assumption (unattended)`.

| q | default |
|---|---|
| 1.1 | recon's summary and audience |
| 1.2 | D7: behaviour from the running app, intent from the docs; conflict kept as a scenario if it is user-facing |
| 2.1 | about to show it to people for the first time |
| 2.2 | skipped |
| 3.1 | recon's most likely user, matched to a pack archetype |
| 3.2 | partly → include "Not you" |
| 3.3 | recon's *Relationship* dimension |
| 3.4 | recon's "First 5 minutes" |
| 4.1 | nothing named; add recon's riskiest area (jargon, hidden saving, conflicts) as one scenario |
| 4.2 | no one yet → grounding `assumption` |
| 5.1 | the pack's recommended items |
| 6.1 | parallel, `max_parallel: 3`, unless recon flags shared server state → 1 |
| 6.2 | 30 actions (casual 20) |
| 6.3 | newcomers sign up (tagged email) when signup is open without email/SMS verification; returning only with credentials already in `secrets.local.yaml`; OAuth/OTP/2FA → skipped, "Not tested" |
| 6.4 | recon's proposed tiers; every off-site navigation stops. Anything that spends the developer's money or quota (AI/LLM calls on their keys, SMS, paid APIs) is **stop-before with `max: 0`** — nobody consented — unless the arguments say `allow=<label or path>[:N]` (then `max: N`, default 1); list the stopped feature under "Not tested" |
