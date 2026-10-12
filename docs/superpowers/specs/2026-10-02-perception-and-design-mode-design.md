# Perception layer and design mode — design (2026-10-02)

Status: design agreed in a brainstorm on 2026-10-02. Design mode was built from the amended design of
2026-10-12 ([2026-10-12-design-mode-figma-design.md](2026-10-12-design-mode-figma-design.md)), and it has never
been run on a real Figma file. Section 4 (the instruments in app runs) and section 6 (constrained input)
are still not built. The decision numbers of section 11 are superseded by D36 to D39 in SPEC.md.

Terms: decisions D1–D33, knowledge isolation, the run loop and the finding record are defined in
[SPEC.md](../../../SPEC.md). How a persona is instructed is in `agents/persona.md`.

## 1. Problem

1. **Personas should behave more like people in app tests too.**
   - What a person looks at first.
   - Text too long to want to read, or too short to understand.
   - A control whose colour blends into what is around it.
2. **A mode for static Figma designs.**
   - Coarse criteria and no interaction: does a viewer know what a page is for, and what a control
     will do?
   - Most Figma files are static. Many have no flow lines (prototype links).

## 2. Position

This section is the basis of everything below.

- **Do not ask the model to act human.** A model sees the whole image at once, reads every word and
  never tires. Its account of "what I looked at first" is plausible fiction.
- **Measure and constrain instead.**
  - Measure with instruments. An instrument is code and makes no model call.
  - Constrain what the persona is shown, so that a limit is real and not acted.
- **Consequence.** A model always finds the low-contrast button. So an instrument must be able to
  raise a finding without any persona struggling.
- **The asymmetry.**
  - A model failing to understand is strong evidence.
  - A model understanding is weak evidence.
- **One model.** All personas are the same model. Agreement between them is never counted as
  evidence of clarity.

## 3. Architecture

Approach A is chosen: a perception layer inside the driver, shared by app runs and by a second mode
of the existing skill.

| Rejected approach | Why |
|---|---|
| A separate Figma skill | It duplicates personas, triage and the ledger, and still has to touch the driver. |
| Model-only, through the Figma MCP server | It contradicts the position, is not repeatable, spends the MCP quota and gives no flow lines. |

### Units

| Unit | Purpose | Depends on |
|---|---|---|
| `driver/perception/scene.mjs` | The scene shape: an RGBA image plus elements `{id, kind, box, text, fontSize}`. `kind` is `control`, `text`, `image` or `container`. `source` is `page`, `figma` or `image`. | nothing |
| `driver/perception/scene-page.mjs` | Builds a scene from a live page: one DOM read per step, after the screenshot. | `scene.mjs`, `driver/session.mjs` |
| `driver/perception/scene-figma.mjs` | Builds a scene from Figma node JSON plus the frame PNG. | `scene.mjs`, `pngjs` |
| `driver/perception/instruments.mjs` | Pure functions from a scene to numbers. | `scene.mjs` |
| `driver/figma.mjs` | Fetches from the Figma REST API and caches the result. | global `fetch` |
| Static session type in the driver's MCP server | Serves a scene to a viewer through two tools, `view` and `answer`. No browser is launched. | `scene.mjs`, `driver/mcp.mjs` |
| `agents/viewer.md` | The viewer agent of design mode. | the static session tools |
| `knowledge/perception.md` | Thresholds per trait and the triage rules for instrument values. | nothing |
| `knowledge/design.md` | The design-mode pipeline, the questions, judging and the report. | `knowledge/perception.md` |

- **No new npm dependency.** `pngjs` is already a dependency. `fetch` and `Intl.Segmenter` are part
  of Node.
- **The DOM read** goes through CDP with `userGesture: false`, like every other harness read (D3).
  It cannot unlock anything the persona did not.
- **Elements of a page scene.** A control is a visible element that is interactive by tag or role
  (`button`, `a[href]`, `input`, `select`, `textarea`, the ARIA widget roles) or has
  `cursor: pointer`. A text element is a visible block of text with its computed font size.
- **No screenshot, no scene.** The instruments are visual. A persona with `perception: a11y-tree`
  and a run in Fast mode get no scene, and the report lists the instruments under "Not tested".
- **A scene with `source: image`** has no elements. It comes from a PNG with no node data.
- **Name clash.** The persona card already has a `perception` field (`screenshot | a11y-tree`). It
  says how a persona observes. The perception layer is separate: it measures what was shown.

## 4. Instruments (phase 1)

Five instruments. Each takes a scene and returns numbers.

| Instrument | What it measures | Threshold |
|---|---|---|
| `contrast` | WCAG contrast ratio of text against its background, and of a control against its surroundings. | 4.5 for normal text, 3 for large text, 3 for non-text |
| `target_size` | The short side of a control. | 24 px; 44 px on a touch device |
| `text_load` | Words per text block and per screen, and the estimated reading time. | A word budget per reading style |
| `icon_only` | A control with no text inside its box. | Present or not |
| `prominence` | The rank of a control among the controls of the same screen, by area × contrast with its surroundings. | None; a rank |

Notes per instrument:

- **`contrast` is always measured from pixels, for both sources.** Declared colours are wrong under
  gradients, images and opacity.
  - Text: the background is the most frequent colour inside the element's box. The foreground is the
    most frequent colour among the remaining pixels.
  - Control: the fill is the most frequent colour inside the box. The surroundings are the most
    frequent colour in a thin ring outside the box.
  - Large text is `fontSize` of 24 px or more. The scene carries no font weight, so the WCAG rule
    for bold large text is not applied.
- **`text_load`** segments Thai with `Intl.Segmenter`, because Thai has no spaces between words.
- **`prominence`** is a stand-in for "what is seen first". It is an unvalidated heuristic. A finding
  based on it is capped at `watch` until labels support it.
- **"Text too short to understand" cannot be counted.** It belongs to the comprehension questions of
  design mode (section 5.4) and to the existing `jargon` event of app runs.

### From numbers to findings

- The values go to `perception.jsonl`, one file per session.
- **Personas never see the values.** This is knowledge isolation: the file is planner knowledge.
- Triage reads the file and applies three rules:

| Case | Result |
|---|---|
| A value below its threshold, and a persona event at the same element | A finding with confidence `signal` |
| A value below its threshold alone, on an element a persona used | A finding with confidence `watch` and `source: instrument` |
| A value below its threshold on anything else | A row in the appendix table. Not a finding. |

- "At the same element" means that the action point of the step with the event falls inside the
  element's box, or that the persona's observation quotes the element's text. Triage decides.
- **"Used" is narrow on purpose.** Without it every low-contrast caption on every visited screen
  becomes a finding, and the report turns into a lint list. An element is used when:
  - the action point of a step falls inside its box (app runs);
  - a viewer pointed at it, or it is a keyed target (design mode).
- The per-screen value of `text_load` counts as used when a persona reached that screen.
- **`prominence` never raises a finding alone.** It supports one in two cases: a persona logs
  `not_found` and then uses a control ranked outside the top 3 of its screen, or in design mode the
  keyed target is ranked outside the top 3. Whether it can stand alone waits for labels.
- Triage dedupes instrument findings as it does persona findings: one finding per element and
  instrument, listing every persona that used the element.

### Thresholds shift with traits

| Trait | Shift |
|---|---|
| Touch device (`device.viewport: mobile-small`) | `target_size` 44 px |
| Low-vision persona (`vision: low`) | `contrast` 7:1 |
| `reading_style: skim` | A lower word budget in `text_load` |

- Phase 1 adds the card field `vision: normal | low`, default `normal`. The planner sets `low` for
  a card built from the "Low vision" condition.
- The thresholds and budgets live in `knowledge/perception.md`.

### Finding record and precision

- The finding record gains `source: persona | instrument | comprehension`.
- Precision is reported per source.
- The 92 % figure (33 of 36 findings labelled real across the four dogfood apps) belongs to persona
  findings in live apps only. It says nothing about the other two sources.

## 5. Design mode (phase 2)

The name is **design mode**. The input is a Figma URL or a folder of PNGs. It is a second mode of
the existing skill, not a second skill. It reuses the persona cards, triage, the ledger, the report
and the labels.

### 5.1 Access

Facts checked against Figma's documentation on 2026-10-02. The monthly numbers are unconfirmed.

| Need | Endpoint | Notes |
|---|---|---|
| A PNG per frame | `GET /v1/images/:key` | `scale` 0.01–4. At most 32 megapixels per image. The URLs expire after 30 days. |
| Node JSON | `GET /v1/files/:key` and `GET /v1/files/:key/nodes` | `absoluteBoundingBox`, `fills`, the `characters` of TEXT nodes, `style.fontSize` |
| Prototype links | The same node JSON | `interactions[].actions[].destinationId`, `transitionNodeID`, `flowStartingPoints` |

- All three are Tier 1 endpoints with scope `file_content:read` and the header `X-Figma-Token`.
- A personal access token lasts at most 90 days.
- Rate limits follow the file's plan and the user's seat:
  - Dev and Full seats: 10–20 requests per minute.
  - Starter files, and View and Collab seats: roughly 6–20 requests per month.

Design:

- **Token.** `driver/figma.mjs` reads it from the environment variable `FIGMA_TOKEN` or from
  `.ux-assessment/secrets.local.yaml`. It is never passed to an agent and never printed for one.
- **Calls per run.**
  - 2 when the URL names a page or a section: nodes, then images.
  - 3 when the user must first pick a page: `files?depth=2`, then nodes, then images.
- **Cache.** Keyed by file key plus version. A rerun reads the version recorded in `source.yaml` and
  makes no API call. The user asks for a refresh to fetch the current version.
- **Scale.** Frames are fetched at scale 1, so one image pixel is one frame pixel.
- **Errors.** See section 7.
- **Fallback: a folder of PNGs.** It gives the comprehension questions but no instruments and no
  placeholder check, because there are no nodes. The report says so.
- **The Figma MCP server is not used.** It gives no prototype links, has its own quota and is gated
  by a client catalog.

### 5.2 Input tiers

The user chooses how much to tell the planner. The more it is told, the more the report can say.

| Tier | The user gives | The run produces |
|---|---|---|
| `keyed` | An intent per frame, plus the correct target per goal | Verdicts, a ranking and measurable precision |
| `goal` | Goals only | The first click per frame, plus comprehension |
| `blind` | Nothing | A descriptive report with no right or wrong verdict |

- **Intents.** The planner drafts one intent line per frame from the frame name and the page name.
  - Default names such as "Frame 12" or "iPhone 14 - 3" are ignored.
  - The user confirms all intents on one card.
  - In `blind`, a frame name is a weak intent and is labelled as an assumption.
- **Correct targets.** The user gives each one in one of two ways:
  - a Figma link to the node;
  - words, which the planner resolves to a node and shows as a crop for confirmation.
- **Storage.** `.ux-assessment/design/key.yaml`. It is planner knowledge only.

```yaml
tier: keyed                    # keyed | goal | blind
frames:
  "12:34":
    name: "Checkout / Payment"
    intent: "Choose how to pay and confirm the order"
    intent_source: user        # user | frame_name
  "12:58":
    name: "Checkout / Done"
    intent: "Shows that the order went through"
    intent_source: frame_name
goals:
  - id: G1
    text: "Pay for what is in your basket with a card"   # user language, never layer names
    start_frame: "12:34"
    steps:
      - {frame: "12:34", target: "12:41"}
      - {frame: "12:58", target: "12:63"}
```

### 5.3 Viewer agent

- **Tools.** `view` and `answer` only. Isolation is enforced by tools, as for personas.
- **What a viewer never sees.** Frame names, layer names, intents, the file URL, and other frames.
- **One fresh context per persona × frame.** In one context, a later frame gives away an earlier
  one.
- **Exception: prototype links.** When the file has them, there is one context per persona × flow,
  and the harness follows the links deterministically.
  - The click point is hit-tested to a node. The node's `destinationId` names the next frame.
  - A click that hits no link is answered "nothing happened here in this design". It is not a
    finding by itself, and the flow ends there for that viewer.
  - No model chooses the next frame.
  - The click that is followed is the first click of section 5.4. `blind` has no first click, so in
    `blind` links are not followed and every frame gets a fresh context.
  - A flow starts at each entry of `flowStartingPoints`. When the URL names a section, that field is
    not in the response, and a flow starts at each linked frame that no link points to.
- **Tall frames.** For a frame taller than the device viewport, the first `view` returns the top
  fold only. The viewer scrolls with `view` to see more.
- **Device.** In design mode the device comes from the frame, not from the card. A frame no wider
  than the `mobile-small` viewport is a touch device with that viewport's height. Any other frame
  uses the desktop viewport height.
- **Caps.** The tool refuses further `view` calls on a frame after a cap, as the driver does for the
  step cap (D13).
- **Defaults.** 3 personas and at most 12 frames. Same-model personas add little; frames add
  coverage. When there are more frames, the planner proposes 12 and the user confirms.
- **Briefing.** Built like the persona briefing: the card, the entry context, and the goal in user
  language for `goal` and `keyed`.
- **Model.** The viewer uses the model of the persona role (D30).

### 5.4 Fixed questions per frame

Every viewer answers the same questions for every frame, through two `answer` calls: `first_look`,
then `after_reading`. Each call is structured and every field is required. The order is enforced by
the tool: `view` refuses to scroll until the `first_look` answer is recorded, so on a tall frame
the first-look answers come from the top fold alone.

| When | Question |
|---|---|
| After the first look | The purpose of the page, in one sentence, with a confidence of `sure`, `guess` or `cannot_tell`. |
| After the first look | The main action, with a point. |
| After reading | Up to 5 things that can be pressed, each with a point, what is expected to happen and a confidence. |
| After reading | The words or icons not understood, verbatim. |
| After reading | Whether the purpose changed after reading. |
| `goal` and `keyed` only | The first click for the goal, as a point plus an expectation, or `cannot_find`. |

```json
{
  "first_look": {
    "purpose": "A page where I pay for my order",
    "confidence": "guess",
    "main_action": {"what": "the wide green button at the bottom", "point": [195, 742]}
  },
  "after_reading": {
    "pressable": [
      {"point": [195, 742], "expect": "my card is charged and I see a receipt", "confidence": "guess"},
      {"point": [28, 60], "expect": "goes back to my basket", "confidence": "sure"},
      {"point": [352, 318], "expect": "no idea", "confidence": "cannot_tell"}
    ],
    "not_understood": ["PromptPay QR", "the icon with two arrows next to the total"],
    "purpose_changed": {"changed": false, "purpose": null}
  },
  "first_click": {"result": "click", "point": [195, 742], "expect": "a form for my card number"}
}
```

- Points are pixels in the frame, as in the image `view` returned.
- `first_click` is `{"result": "cannot_find"}` when the viewer sees no way to start the goal.
- In `blind`, the tool's schema has no `first_click` field.
- The example shows both calls together; `first_click` belongs to the `after_reading` call.
- **What the split is worth.** On a frame taller than one fold the split is real: the first-look
  answers were given before the rest was shown. On a frame that fits one fold both calls see the
  same image, so `purpose_changed` is recorded but triage does not use it as evidence there. The
  glance method of section 6, if it passes, makes the split real for every frame.

### 5.5 Judging

| Judge | What it decides |
|---|---|
| Deterministic, no model | Point → node hit test. The first click against the keyed target. Instruments for the pointed elements. Link following. |
| Model (triage, with planner knowledge) | The purpose against the intent: `match`, `partial` or `mismatch`. The expectation against the other frames of the file: `expected_screen_missing` when none fits. |

Finding types:

| Type | Raised when |
|---|---|
| `purpose_unclear` | The stated purpose does not match the intent, or the viewer answers `cannot_tell`. |
| `control_unpredictable` | The viewer cannot say what a control will do, or expects something the design does not do. |
| `first_click_miss` | The first click hits a node other than the keyed target, or the viewer answers `cannot_find`. |
| `expected_screen_missing` | No frame of the file fits what the viewer expected to see next. |
| Instrument types | As in section 4. |

Confidence:

- **`signal`**
  - a deterministic miss by ≥ 2 personas;
  - or a miss plus an instrument value below threshold on the same element;
  - or any `cannot_tell`.
- **`watch`**
  - one persona;
  - or a model-judged mismatch against an intent that came from a frame name.
- A model-judged mismatch against an intent the user gave follows the persona count: `watch` for
  one persona, `signal` for ≥ 2.
- Agreement between viewers that a frame is clear raises nothing and proves nothing (section 2).
- `expected_screen_missing` says the file has no such frame. It does not say the product lacks the
  screen.

In `blind` there is no purpose verdict, except `cannot_tell`. The report prints a "what viewers
understood" table, and the designer labels it.

Design findings carry `source: comprehension` or `source: instrument`.

### 5.6 Report

In order:

1. **What this mode can and cannot say.** The asymmetry, the tier used, and "N viewers, one model".
2. **Top findings.**
3. **Per-frame table.** The intent, what viewers said, the first look against after reading, and
   the first click.
4. **Measured values.**
5. **Not tested.** Placeholder frames, skipped frames, the limits of a PNG-only run, interaction,
   and states such as empty, loading and error.
6. **Appendix.**

A frame whose text is more than 30 % placeholder skips the comprehension questions. Placeholder text
is lorem ipsum and default labels such as "Label", "Button" and "Heading". The instruments still
run on it.

### 5.7 File layout

Under `.ux-assessment/design/`:

| Path | Holds | Git |
|---|---|---|
| `source.yaml` | File key, version, `fetched_at`, frames, flows | Committed |
| `key.yaml` | The tier, intents and goals (section 5.2) | Committed |
| `cache/<key>/<version>/` | `nodes.json` and the frame PNGs | Gitignored. The design may be confidential. |

Runs use `runs/<date>/`, as app runs do, with `kind: design` in the run's record.

### 5.8 Status

- **Experimental** until two real files are labelled.
- **Gate.** Comprehension-finding precision ≥ 70 % on the first labelled hi-fi file. Otherwise the
  questions are revised before release. The author proposed the number; no evidence is behind it.
- **Codex.** The tools are shared, but design mode on Codex counts as unverified until it is
  dogfooded there.

## 6. Constrained input (phase 3)

Experiment first, build after. There are three methods, and each is adopted or dropped on its own.

| Method | What changes in the image | The want it serves |
|---|---|---|
| Glance | The first look is the image downscaled to 1/4 and scaled back up. The full image follows. | "What is seen first" |
| Low vision | The contrast of the image is reduced for a low-vision persona. | "Colour blends in" |
| Skim mask | Text blocks longer than N words are blurred for `reading_style: skim`. | "Text too long to want to read" |

Why a skim mask:

- Today a skim persona is told to read only headings. The model has already read every word and
  cannot unread it.
- Blurring makes the loss real. Information buried in a long paragraph is missing, the way it is
  for a person who skims.
- Limit: people skim partially. Blurring a whole block is coarser than that.

The persona is never told that the image is altered, as with the clock of D22.

### The experiment

The code is throwaway and does not go into the public repository.

- **Screens.** 6–10 screens the user has labelled. Problem screens are mixed with clean ones.
- **Questions.** The fixed questions of section 5.4.
- **Runs.** 5 runs per screen per condition, each in a fresh context. The conditions are the
  unaltered image and each method.
- **Pass rule, fixed before the results are seen.** Against the unaltered image, the correct-answer
  rate drops by ≥ 30 points on problem screens and by ≤ 10 points on clean ones.
- **A method that fails is not built.** The instruments then stand alone for that want.
- The thresholds are the author's choice.

### If a method passes

It lands in the screenshot path of `driver/session.mjs` and of the static session: the image is
altered after capture and before it is returned. The stored screenshot and the instruments keep the
unaltered image. Low vision is keyed on the card field `vision: low`, the skim mask on
`reading_style: skim` with the text blocks of the scene, and the glance on the first look of a
session or frame. With the glance, the first-look answers of section 5.4 are given before the full
image is shown.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| Figma answers 429 with `Retry-After` ≤ 60 s | Wait once for that time and retry. |
| Figma answers 429 with a longer `Retry-After`, or 429 again after the wait | Stop. Print how to export the frames by hand into a folder of PNGs. |
| Figma answers 403 or 404 | Stop. Print how to make a token with the scope `file_content:read`, and that the token's user must be able to open the file. |
| No token is found | Stop with the same message as 403. |
| The image URL of a node is null | The frame is skipped and listed under "Not tested". |
| A frame is over Figma's 32-megapixel limit | Figma returns it scaled down. The harness stores the real scale, serves the image in viewport-sized tiles and maps every point back to frame coordinates. |
| A fold image is larger than the viewer model accepts at full size | The harness scales it down itself before serving it and stores the scale, so that points still map back. The model API never rescales an image silently. The limit is a driver constant per model. |
| An element has no measurable background | The value is `null`. A `null` is never a finding. |
| The DOM read of a step fails | Logged as a signal. The step continues with no scene. |
| A viewer ends without all answers | One follow-up from the orchestrator, with no hint. Still missing: the frame is recorded as incomplete for that viewer. This mirrors D23. |

## 8. Testing

CI makes no model call.

1. Synthetic PNGs with known colours: the measured contrast is within ±0.1 of the computed ratio.
2. Word counts for Thai and for English text.
3. Hit testing: a point to the element or node that contains it, including nested boxes.
4. A Figma JSON fixture becomes the expected scene.
5. A fake HTTP server answers 403, 404 and 429 with `Retry-After`. Each produces the behaviour of
   section 7.
6. Cache hits: a second run against the fake server makes no request.
7. Static sessions through MCP: `view` and `answer`, the top fold and scrolling, the refusal to
   scroll before the `first_look` answer, and the caps.
8. The "used" rule: a fixture session where only the acted-on element becomes a finding and the
   rest land in the appendix.
9. The docs test covers the new knowledge files and the viewer agent.

Model-dependent behaviour is not tested in CI. It is shown only by dogfood runs with labels.

## 9. Phases

Three phases. Each gets its own implementation plan.

| Phase | Builds | Then |
|---|---|---|
| 1 | The instruments, in app runs | A rerun on an app that already has labels, to compare the instrument findings with them |
| 2 | Design mode, experimental | A `keyed` run on a real hi-fi file, with labels |
| 3 | The constrained-input experiment | Only what passed is built |

## 10. Non-goals

- A model choosing the next frame (a paper-prototype walkthrough).
- Verify-only for design mode.
- The Figma MCP server.
- OCR for PNG folders.
- A real saliency model.
- Wireframes with placeholder text.

## 11. SPEC.md changes when built

Proposed decisions:

| # | Topic | Decision |
|---|---|---|
| D34 | Measure and constrain | The harness measures with instruments and constrains what a persona is shown. It never asks the model to role-play a human limit. |
| D35 | Instruments and `source` | Five instruments write `perception.jsonl`. Triage turns values into findings, and every finding carries `source: persona \| instrument \| comprehension`. |
| D36 | Design mode | A second mode of the skill for a Figma URL or a folder of PNGs, with the tiers `keyed`, `goal` and `blind` and an isolated viewer per persona × frame. |
| D37 | Figma access and cache | REST only, with a token that no agent sees, 2–3 calls per run and a cache keyed by file key plus version. |
| D38 | Constrained input | Glance, low vision and skim mask are each built only after passing an experiment with a pass rule fixed in advance. |

Specs stay in this repository. Implementation plans are not published (D33).

## 12. Open questions

- The exact monthly limit of Figma's low tier: 6 or 20.
- Whether view-only sharing of a file allows API reads.
- How accurate pixel contrast is on small anti-aliased text.
- How controls are found in a Figma frame beyond pointed elements, prototype-linked nodes and
  component-name patterns. Confidence in all three is low.
- N for the skim mask, the word budget per reading style and the reading speed behind the estimated
  reading time.
- Whether `prominence` correlates with labels.

Simplest rules written above where the brainstorm left a detail open:

- Section 4: large text is 24 px or more, with no rule for bold text. The card field `vision`
  arrives in phase 1, not phase 3.
- Section 5.3: the device of a frame comes from its width. The number behind the `view` cap. How a
  flow starts when the URL names a section. A flow ends at a click with no link. No link following
  in `blind`. How the planner picks 12 frames when there are more.
- Section 3: how a page scene picks its controls and text elements.
- Section 4: the top-3 rank that lets `prominence` support a finding.
- Section 7: the full-size image limit per viewer model is not measured yet.
- Section 5.5: a model-judged mismatch against a user-given intent counts by persona, like a
  deterministic miss.
- Section 7: no token is treated like 403.
