# Perception: instruments, thresholds, and what a number may claim

Used by the orchestrator and by triage in design mode (SPEC D38). Planner knowledge: a viewer never
sees a value from this file or from `perception.jsonl`.

An instrument is code. It takes one screen of a design and returns numbers. It makes no model call.
The numbers below are the constants of the code (`driver/perception/instruments.mjs`,
`driver/perception/scene.mjs`, `driver/static-session.mjs`, `driver/design.mjs`,
`driver/figma.mjs`). A test checks that this file states the thresholds, the word budgets and the
reading speed. When the code and this file differ, the code is right.

Nothing here was calibrated on a real design or on real users. The last column of each table says
where a number comes from. "A standard" means a published accessibility rule, which is evidence
about people in general and not about this tool. "The authors' pick" means no evidence at all.

## 1. The five instruments

| Instrument | What it measures | Below its threshold when | Needs |
|---|---|---|---|
| `contrast` | Text: the most frequent colour in the element's box against the most frequent of the other colours. Control: the fill against a ring 4 px wide outside the box. Always from the pixels of the image. | the ratio is under the threshold of section 2 | nodes and an image |
| `target_size` | The short side of a control, in frame pixels. | it is under the threshold of section 2 | nodes |
| `text_load` | Words per text element and per frame, and the reading time. Thai is split into words by a dictionary segmenter. | the words of the frame are over the word budget of section 3 | text |
| `icon_only` | A control with no text of its own and no text element centred inside its box. | it is true | text |
| `prominence` | The rank of a control among the controls of its frame, by area × contrast with its surroundings. 1 is the most prominent. Equal scores share a rank. | never: it is a rank, not a threshold | nodes and an image |

- A value that cannot be measured is `null`. **A `null` is never a finding.**
- `text_load` and `icon_only` are `null` when the source gave no text (`has.text` is false).
- `contrast` and `prominence` are `null` when the frame has no image or the box lies outside it.
- A control that carries its own text, such as a text link, is measured as text.
- A control with no fill of its own, such as a ghost button or an outlined input, is not measured: its `contrast` and `prominence` are `null`. That is the case when its most frequent colour and the ring colour are within 8 levels of each other in every channel, which is one colour bucket of the image helpers. A deliberately pale fill is further apart than that and is measured.
- "Text too short to understand" cannot be counted. That is what the comprehension questions are
  for.

## 2. Thresholds

| What | Threshold | Applies to | Where the number comes from |
|---|---|---|---|
| `contrast`, normal text | 4.5 | Text under 24 px, and all text when the source gave no font size | A standard: WCAG 2 level AA for text |
| `contrast`, large text | 3 | Text of 24 px or more | A standard: WCAG 2 level AA for large text |
| `contrast`, non-text | 3 | A control without its own text, against its surroundings | The number 3 is a standard: WCAG 2.1 level AA, success criterion 1.4.11 (non-text contrast). How it is measured here is the authors' pick: the most frequent colour inside the box against the most frequent colour in a ring outside it. WCAG asks about the parts of a control that a person needs to find it, such as a border, which this does not look at. |
| `contrast`, low vision | 7 | Everything measured, for a viewer whose card says `vision: low` | The number is WCAG 2 level AAA for text. Using it for low vision, and for controls too, is the authors' pick. |
| `target_size`, default | 24 px | A control on a frame wider than 480 px | A standard: WCAG 2.2 level AA minimum target size |
| `target_size`, touch | 44 px | A control on a touch frame | A standard: WCAG 2 level AAA target size, and the same number in common phone guidelines |
| Large text | 24 px | Decides which text is "large" | A standard for regular weight. WCAG also counts bold text from about 19 px as large. The scene has no font weight, so that rule is not applied and bold text of 19 to 23 px is measured against 4.5. |

A standard says what is commonly required. It does not say that a person fails below the line or
succeeds above it.

## 3. Word budgets and reading speed

The most words one frame may hold before `text_load` is below its threshold, by the card's
`reading_style`:

| `reading_style` | Word budget per frame | Where the number comes from |
|---|---|---|
| `read-all` | 250 | The authors' pick. No evidence. |
| `skim` | 100 | The authors' pick. No evidence. |
| `icons-only` | 30 | The authors' pick. No evidence. |

Reading time is words ÷ 200 words per minute, in seconds. 200 is the authors' pick, with no
evidence, and it is the same for every language and every persona. Report a reading time as an
estimate, never as a measurement of a person.

## 4. Shifts by trait

| Trait | Where it comes from | Shift |
|---|---|---|
| Touch device | The frame, not the card: a frame at most 480 px wide is a touch device | `target_size` 44 px instead of 24 px |
| `vision: low` | The card, through `viewer.json` | `contrast` 7 for every element measured |
| `reading_style` | The card, through `viewer.json` | The word budget of section 3 |

A viewer folder without `viewer.json` is measured as `vision: normal` and `reading_style:
read-all`. The judge measures a frame once for each combination its viewers have, so one element
can have several lines in `perception.jsonl`.

## 5. Other numbers the harness uses

| Number | Meaning | Where it comes from |
|---|---|---|
| 480 px | A frame at most this wide is a touch device (a phone). Wider is a desktop. | The authors' pick. No evidence. Whether it separates phones from tablets is an open question. |
| 16:9 and 8:5 | The fold: a touch frame shows width × 16 ÷ 9 of its height at once, a desktop frame width × 5 ÷ 8, and never more than the frame. | The authors' pick. |
| 1568 px | A picture wider or taller than this is scaled down before a viewer gets it. | The authors' pick. No evidence that it suits the viewer's model. |
| 1,150,000 pixels | A picture with more pixels than this (width × height) is scaled down before a viewer gets it, so a fold of 1440 × 900 is served at 1356 × 848. | The authors' pick. It is the authors' reading of the model's image limit and has not been checked against the model. |
| 12 | Most `view` calls on one frame. | The authors' pick. |
| 8 | Most frames in one flow. | The authors' pick. |
| 30 % | A frame whose text is more than this share placeholder words skips the comprehension questions. | The authors' pick. |
| 40 px | A hand-drawn line ends "at" a frame when its end is within this distance. | The authors' pick. Confidence in the arrow rule is low. |
| Top 3 | A `prominence` rank outside the top 3 can support a finding (section 8). | The authors' pick. |

## 6. Which node is a control

A node is a control when one of these holds:

1. It has a prototype link with the trigger `click`.
2. It is a component, an instance or a component set, and its name matches a pattern below.

A node a viewer pointed at counts as used for that viewer, whatever its kind.

Name patterns, matched as whole words without regard to case. `menuItem`, `Menu_Item` and
`menu-item` all read as `menu item`:

`button`, `btn`, `input`, `field`, `checkbox`, `radio`, `toggle`, `switch`, `tab`, `link`, `chip`,
`select`, `dropdown`, `menu item`

The list is the authors' pick. No evidence. A file that names its components in another language,
or by another convention, has few controls by rule 2. Then `target_size`, `icon_only` and
`prominence` cover few elements. Say so in the report when a frame has many nodes and almost no
controls.

Other kinds: a text node is `text`, a node with an image fill is `image`, anything else is
`container`.

## 7. Placeholder text

A text is placeholder when, trimmed and in lower case, it is one of these words alone, with an
optional number after it ("Button 2"):

`label`, `button`, `heading`, `text`, `title`, `placeholder`

or when it holds one of these phrases anywhere: `lorem ipsum`, `dolor sit amet`.

`placeholder_share` of a frame is its placeholder words over all its words. It is `null` when the
source gave no text or the frame has no words. The words and phrases are the authors' pick. A real
label that reads "Title" counts as placeholder.

## 8. From numbers to findings

`design.mjs judge` writes one line per element and per frame to `perception.jsonl`, with `below`
(the instruments under their threshold), `used`, `used_by` and `keyed`. Triage applies these rules
and no others:

| Case | Result |
|---|---|
| A value below its threshold, and a comprehension miss at the same element | A finding with confidence `signal` |
| A value below its threshold alone, on an element that was used | A finding with confidence `watch` and `source: instrument` |
| A value below its threshold on anything else | A row in the appendix table. Not a finding. |
| A `null` | Nothing |

- **Used** is narrow on purpose. An element is used when a viewer pointed at it, or when it is a
  keyed target. The `text_load` of a frame is used when a viewer reached the frame. Without this
  rule every faint caption becomes a finding and the report turns into a lint list.
- **"At the same element"** means that the viewer's point hit the element or its control, or that
  the viewer's `not_understood` quotes the element's text.
- **`prominence` never raises a finding alone.** It supports a `first_click_miss` when the keyed
  target is ranked outside the top 3 of its frame. It is an unvalidated stand-in for "what is seen
  first". A sentence that rests on it says "ranked N of M by size and contrast", never "people do
  not see it".
- One finding per element and instrument. List every persona whose viewer used the element.
- A finding that rests on a word budget, the reading speed or a name pattern says in
  `why_it_matters` that the number is the authors' pick.
