# Design mode: the pipeline, then the judging and report rules (SPEC D36 to D39)

Part 1 is for the orchestrator. Part 2 is for the triage agent. Planner knowledge: a viewer never
reads this file and never gets anything from it except the briefing of step 7.

**Status. Say it wherever a result is shown.** Design mode is experimental. The code is tested
against fixtures written from Figma's documentation. It has never been run on a real Figma file,
through the real Figma API or the real Figma MCP server, and no finding of it has been checked
against real users. A step that fails is expected news. Tell the user what failed, with the exact
error text, and point to the "Design mode report" issue form of the plugin's repository. Ask them
not to attach a confidential design.

**The position behind the mode** (SPEC D38). A model sees a whole picture at once, reads every
word and never tires. So this mode does not ask a model to act tired or confused. Code measures
the screens (`knowledge/perception.md`) and judges the clicks. Viewers answer fixed questions, and
only their failures count as evidence (Part 2, "The asymmetry").

`$PLUGIN`, `<project>`, the id rule and the language rule are those of the skill. Write every
path in a command in double quotes.

# Part 1: the pipeline (orchestrator)

Pipeline: **run folder → source → snapshot → level and frames → tier → personas → sessions →
viewers → run.json → judge → triage → tell the user.**

## 1. Run folder

As the skill's section 0, "Run folder": the date part of `node "$PLUGIN/driver/probe.mjs" now`,
plus `-2`, `-3` when `runs/<date>` exists. Write the name as the only line of
`<project>/.ux-assessment/active-run`. The run folder is `<project>/.ux-assessment/runs/<name>/`.

Keep a list named **assumptions** from here on: every choice made without the user, and every
step that fell back to a lower level. It goes into `run.json` and the report.

## 2. Choose the source

Three sources write the same thing, a design snapshot on disk. Everything after the snapshot is
the same for all three.

| Source | Needs | Gives | Missing |
|---|---|---|---|
| `rest` | A Figma token | Frames, node boxes, text, font size, prototype links, a file version | Nothing |
| `mcp` | A Figma MCP server connected to this session | Frames and node boxes | Text, font size, prototype links, a version. The opt-in script of step 3b adds the first three. |
| `png` | A folder of PNG files | One frame per file | Every node: no instrument, no link, no placeholder check |

`design.source` in `<project>/.ux-assessment/config.yaml` (`rest`, `mcp` or `png`) forces one.
Otherwise take the first that works:

1. The request gave a PNG folder → `png` (step 3c).
2. Run the `fetch` command of step 3a. It looks for the token itself. Exit 0 or 3 → `rest`.
3. It stopped with "No Figma token was found." → look for Figma MCP tools (step 3b). Found → `mcp`.
4. Otherwise stop and tell the user the three ways in, in their language:
   - **A token.** In Figma: Settings, Security, Personal access tokens. Make one with the scope
     `file_content:read`. The token's user must be able to open the file. Put it in the
     environment variable `FIGMA_TOKEN` before starting Claude Code, or as the line
     `figma_token: <token>` in `.ux-assessment/secrets.local.yaml` (keep that file out of git).
   - **The Figma MCP server.** Connect it to Claude Code as Figma's own instructions say, and
     start a new session.
   - **A folder of PNG files.** In Figma select the frames, add an export setting (PNG, 1x) and
     export them into one folder. Then give that folder's path.

**The token is not yours to see.** `figma.mjs` reads it. Never read, print or pass it. Never open
`.ux-assessment/secrets.local.yaml` in design mode, never print the environment, never put the
token in a command, a file, a briefing or a message. If the user pastes a token into the chat, do
not repeat it: tell them to put it in one of the two places above.

## 3a. The REST source

```
node "$PLUGIN/driver/figma.mjs" fetch "<project>" "<link>"
```

`<link>` is the Figma link exactly as the user gave it. The cache is found by that exact text and
by the frame list (`--frames`, below): the same link with another list is another request.
A prototype link (`/proto/`) is read as its file plus its starting frame. Never open a prototype
in a browser.

| Result | Meaning | Do |
|---|---|---|
| Exit 0, one JSON line `{snapshot, source, file_key, version, frames, nodes, skipped}` | The snapshot is at `snapshot`. `"cached": true` means no API call was made: the saved copy that `design/cache/index.json` lists for this link, page and frame list was reused, and `design/source.yaml` was written again from it, so it names this file. | Go to step 4. |
| Exit 3, one JSON line `{file_key, pages: [{id, name, children}]}` | The link names no page and the file has several. | Ask the user which page. Run the command again with `--page "<id>"`. Unattended: stop and ask for a link to a page or a frame. |
| Exit 4, one JSON line `{file_key, version, too_many_frames, limit, frames: [{id, name, width, height, links, flow_start}]}` | The page or section holds more than 24 frames (`limit`). No image was requested and nothing was saved. `links` counts the click links that navigate, and `flow_start` marks a flow start. | Show the user the list by name, pick at most 12 with them (step 4 says how), and run the command again with `--frames "<id>,<id>,..."`. Unattended: the flow starts first, then the rest in the order listed, up to 12; add it to the assumptions. |
| Exit 1, "No Figma token was found." | No token. | Step 2, rule 3. |
| Exit 1, "Figma answered 403 ..." or "404 ..." | The token cannot open the file, has expired, or the link is wrong. | Stop. Give the user the advice the command printed. |
| Exit 1, "Figma is rate limiting this token ..." | The plan's quota is used up, or the wait is over 60 s. The command waits once at most. | Stop. Offer the PNG folder. |
| Exit 1, "cannot reach the Figma API ..." or "the Figma API answered ..." | Network, or an error on Figma's side. A redirect from the API is refused, so that the token stays with the host it was meant for. | Stop. Show the line. |
| Exit 2, "FIGMA_API_BASE must be ..." | The environment variable `FIGMA_API_BASE` holds an address that is not `https` or local. | Stop. Show the line. The variable is for tests. |
| Exit 1, "node ... is a ...; link a page, a section or a frame" | The link points inside a frame. | Ask for a link to the frame, its section or its page. |
| Exit 1, "no frame has an image ..." | Figma rendered nothing. The reasons are in the line. | Stop. Show the line. |
| Exit 1, "not a frame of the linked page or section: ..." | An id given to `--frames` is not a frame of the page or section, for example a node inside a frame. No image was requested. | Take the ids from the exit 4 list, or from `frames` of the link's page, and run it again. |
| Exit 2 | A usage error, such as `--page` with a link that already names a node. | Fix the command. |
| stderr "warning: ..." with exit 0 | For example, the response had no version and the fetch date stands in. | Tell the user. Add it to the assumptions. |

- **Picking frames.** `--frames "<id>,<id>,..."` keeps only those frames and requests and downloads
  only their images. An id may be written with `:` or `-` (`12:34` or `12-34`). A link from a kept
  frame to a frame that is not kept becomes a link that cannot be followed, and the flow starts and
  arrows count the kept frames only. Each list is its own saved copy
  (`cache/<file key>/<version>-f<8 hex digits of the sorted ids>/`), next to the copy of the whole
  page (`cache/<file key>/<version>/`).
- **Refresh.** A rerun with the same link, page and frame list reads the saved copy and calls
  nothing, also after another file was fetched in between: `design/cache/index.json` remembers the
  copy of every request, and `design/source.yaml`, which only names the current source, is written
  again from the copy. The index needs the copy's `design.json` to exist. A damaged index is
  ignored with a warning on stderr and the fetch calls Figma again (add the warning to the
  assumptions). Add `--refresh` only when the user asks for the current version of the file.
  Attended, when the result says `"cached": true`, say so and offer **Use the saved copy**
  (recommended) · **Fetch the current version**. Unattended: the saved copy.
- **Calls.** One for the nodes, and one for the images of every 50 frames that are kept (one call up
  to 50 frames, two for 51 to 100; with `--frames` it is one call for the 12 you picked). One more
  call lists the pages first when the link names no node, and also for a prototype link, which needs
  it to find the page of its starting frame. So a link to a frame costs 2 calls, and a link to a page
  or a prototype costs 3 for up to 50 frames. A page or section of more than 24 frames without
  `--frames` stops after the nodes call with exit 4, and the rerun with `--frames` makes the nodes
  call again, so such a page costs one call more than that. A Starter file, or a View or Collab
  seat, may allow only a few calls a month. That number is unconfirmed.
- `skipped` counts frames without an image or a box. Step 4 lists them.

## 3b. The Figma MCP source

**This path has never been run against the real server.** The tool names, the XML of the
metadata, its coordinates and what the script returns are taken from Figma's documentation only.
Expect a failure here, and treat it as news worth a report (see "Status").

The driver cannot call an MCP server. You call the Figma tools, save what they return to files
with the Write tool, and hand the files to the driver.

1. **Find the tools.** Search with ToolSearch for `figma`. The tools belong to a Figma server the
   user connected. Never assume a server name: use the tools the search returns. You need one
   whose name ends in `get_metadata`, and one whose name ends in `download_assets` or
   `get_screenshot`. Neither pair → this source is not available (step 2, rule 4).
2. **The file and the node.** `file_key` and `node_id` come from the `parse-url` result of the
   skill's section 0 (`start_node_id` for a prototype link). No node id → ask for a link to a page
   or a frame ("Copy link to selection" in Figma). Unattended: stop and say so.
3. **A saved copy.** Look with the Glob tool for
   `<project>/.ux-assessment/design/cache/<file_key>/*/design.json`. Read each one found and keep
   those whose `source` is `mcp`. The folder name is the date of the import; take the newest. This
   source has no file version, so the copy is as old as that date. `design/source.yaml` is not
   asked here: it only names the current source, and another file may have been fetched since.
   The copy holds the frames that were imported then. When the linked frame is not among its
   `frames`, there is no saved copy for this link: continue with the next item.
   Attended: ask **Use the saved copy** (recommended; no tool call) · **Fetch again**. Unattended:
   the saved copy. With the saved copy, the snapshot is the folder of that `design.json`. Take
   `file_key` and `version` from it, not from `source.yaml`, and go to step 4.
4. **Say the call count before the first call.** One call for the metadata, one for the images
   (one per frame when only `get_screenshot` exists), and one more with the script of step 7. For
   example: "This makes 3 calls to the Figma MCP server. Figma says a View or Collab seat gets
   about 20 a month."
5. **Metadata.** Call `get_metadata` for the file and the node. Save the XML it returns, unchanged,
   to `<project>/.ux-assessment/design/cache/<file_key>/mcp/metadata.xml`.
6. **Images.** From the XML, list the ids of the frames: the `frame`, `component` and
   `component-set` elements directly under the page or the section, or the root element when the
   link names one frame. Take at most 20. More than 20 → ask the user which, or take the first 20
   unattended and add it to the assumptions. Call `download_assets` for those ids: PNG, scale 1.
   When that tool is missing, call `get_screenshot` once per frame.
   - **Always ask for a URL. Never accept base64.** Image data in your context is large and is
     not what the importer reads. If the tool can only return the image itself, stop this path
     and say so.
   - Write `mcp/images.json` beside the metadata: one JSON object, a map from node id to URL,
     `{"12:34": "https://...", "12:58": "https://..."}`. The ids are the `id` attributes of the
     XML, character for character.
   - A URL that is not `https` is refused by the importer, and a frame with no URL is skipped.
7. **Text and links, opt-in.** The tool `use_figma` runs a script inside the file. **It can
   change the file.** The script this plugin passes only reads.
   - Guided and Expert: ask before each run, in the user's language: "To read the text and the
     prototype links I can run a script inside your Figma file with the tool `use_figma`. That
     tool is able to change a file. The script I pass only reads: it is the file
     `driver/figma-read.js` of the plugin, and you can read it first. Without it the run measures
     less." Options: **Skip it** (recommended) · **Run the read-only script**.
   - Quick mode and unattended: never ask, never use it.
   - The code you pass is the content of `$PLUGIN/driver/figma-read.js`, read with the Read tool,
     with one change: the whole line `const FRAME_IDS = [];` becomes
     `const FRAME_IDS = ["12:34", "12:58"];` with the frame ids of step 6. Change nothing else.
     **Check each id before it goes into that line.** An id is only digits, colons and semicolons
     (the pattern `^[0-9:;]+$`). The ids come from a file you do not control, and the line becomes
     code that runs inside the file. Drop any id that does not match, and add the dropped ids to
     the assumptions.
     **Never write or edit Plugin API code yourself**, not to fix an error, not to wrap it, not to
     add a field. If the tool rejects the script, skip this step and add it to the assumptions.
   - Save what the tool returns, unchanged, as `mcp/nodes.json`. Do not tidy it, unwrap it or
     reformat it.
8. **Import.**

   ```
   node "$PLUGIN/driver/figma.mjs" import-mcp "<project>" --key "<file_key>" --metadata "<mcp>/metadata.xml" --images "<mcp>/images.json" --nodes "<mcp>/nodes.json"
   ```

   Leave `--nodes` out when step 7 did not run. It prints the same JSON line as `fetch`.

| Result | Meaning | Do |
|---|---|---|
| stderr "warning: ... is not the shape driver/figma-read.js returns; continuing without it" | `nodes.json` was ignored. | The run continues at the level `frames`. Add it to the assumptions. The report says so. |
| stderr "warning: nodes.json has no entry for N of M frames ..." | The script found some frames and not others. The text, font size and links it did read are kept, but the snapshot marks them as not read. | The run continues at the level `frames`. Add it to the assumptions. The report says so. |
| Exit 1, "... holds no frame this importer can read." | The XML is not what the importer expects. | Stop. Say that this source has never been run against the real server. Point to the report form. Offer the token or the PNG folder. |
| Exit 1, "... is not a JSON map from node id to image URL" | `images.json` is wrong. | Fix the file from the tool's reply. Do not call the tool again for it. |
| Exit 1, "no frame has an image (...)" | Every image was refused or could not be downloaded. Whether these URLs can be downloaded outside the Figma session is unknown. | Stop. Show the reasons. Offer the PNG folder. |

The files under `mcp/` hold the design's names. They stay under `design/cache/`, which is kept
out of git.

## 3c. The PNG source

```
node "$PLUGIN/driver/figma.mjs" import-png "<project>" "<folder>"
```

One frame per `.png` file of the folder, in name order (`2.png` before `10.png`). Sub-folders are
not read. The frame ids are `png-1`, `png-2`, ... and a frame's name is its file name, which is
planner knowledge. There are no nodes, so the level is `images`. It prints the same JSON line as
`fetch`. It stops when the folder has no PNG file or a file is not a PNG. Run it again on every
run: it is cheap and reads the folder as it is now.

## 4. Level and frames

```
node "$PLUGIN/driver/design.mjs" frames "<snapshot>"
```

`<snapshot>` is the `snapshot` path of step 3. Save the JSON it prints to
`<run folder>/frames.json` with the Write tool: triage reads it.

| Field | Meaning |
|---|---|
| `level` | What the snapshot allows. See the table below. |
| `has` | What the source gave: `nodes`, `text`, `font_size`, `links`. Never guess these from an empty field. |
| `frames[]` | `id`, `name`, `page`, `width`, `height`, `touch` (at most 480 px wide), `words`, `placeholder_share`, `controls`, `links` (click links). `words` and `placeholder_share` are `null` without text. |
| `flows[]` | `{start, frames}`: a flow start and the frames its click links reach, start first. |
| `arrows[]` | `{between: [id, id], direction: "unknown"}`: hand-drawn lines between two frames. |
| `order_hint` | `true` when there are arrows. The field is absent when there are none. |
| `skipped[]` | Frames left out of the snapshot, with the reason. |

| `level` | The snapshot has | The run does |
|---|---|---|
| `images` | Images only | The comprehension questions per frame. No instrument, no click verdict. |
| `frames` | Nodes | Plus the first click against a keyed target, and `contrast`, `target_size`, `prominence`. |
| `static` | Text and font size | Plus `text_load`, `icon_only`, the large-text rule and the placeholder check. |
| `flows` | Prototype links from a flow start | Plus viewers moved from frame to frame by their own first click. |

Tell the user, in plain words: the source, the level, what that level cannot do, and the skipped
frames. Then choose the frames:

- **At most 12.** Three personas on twelve frames is 36 viewers. More frames add coverage; more
  personas add little, because every viewer is the same model.
- **Leave out placeholder frames.** A frame with `placeholder_share` over 0.3 (30 %) gets no
  viewer: its words are filler, so answers about it mean nothing. List it in `not_tested` as
  "placeholder text". The instruments still measure it when it is keyed.
- A flow (step 6) counts every frame it reaches.
- Attended: propose the frames (flow frames first, then the rest in the snapshot's order), by
  name, and ask **Use these** (recommended) · **Change** (free text). Unattended: the first 12
  that are not placeholder frames; add it to the assumptions.
- **A page of more than 24 frames (REST, exit 4)** is chosen before there is a snapshot, from the
  list the command printed: `links` and `flow_start` stand in for what `design.mjs frames` would
  show, and the placeholder share is not known yet. Attended: propose at most 12, the flow starts
  first and then the rest in the order listed, by name, and ask the same question. Unattended: the
  flow starts first, then the order listed, up to 12, and the choice goes into the assumptions.
  Then run `fetch` again with `--frames "<id>,<id>,..."` (step 3a). This step then runs on the
  snapshot of those frames, where the placeholder frames are left out as above.
- **Arrows are an order hint and never a route.** When `order_hint` is true, propose a frame
  order from the arrows and ask the user to confirm or correct it. The direction of an arrow is
  unknown. Use the confirmed order for the report's per-frame table and for the entry context of
  step 7. No viewer is ever moved along an arrow. Unattended: do not use the arrows.

## 5. Tier and `key.yaml`

The user chooses how much to tell the planner. The more it is told, the more the report can say.

| Tier | The user gives | The run produces |
|---|---|---|
| `keyed` | A goal, and the correct thing to press on each frame of it. Needs nodes: not offered at the level `images`. | A hit or a miss per first click, by code |
| `goal` | Goals only | The first click per frame, without a verdict, plus comprehension |
| `blind` | Nothing | A descriptive report with no right or wrong |

Attended: ask **Goal** (recommended) · **Keyed** · **Blind**, in plain words. Unattended: the tier
of an existing `<project>/.ux-assessment/design/key.yaml` whose frame ids are in this snapshot;
otherwise `blind`. Write `<project>/.ux-assessment/design/key.yaml`. It is planner knowledge only.

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
    text: "Pay for what is in your basket with a card"   # user language, never a frame or layer name
    start_frame: "12:34"
    steps:
      - {frame: "12:34", target: "12:41"}                # goal tier: {frame: "12:34"}, no target
      - {frame: "12:58", target: "12:63"}
```

- **Intents.** Draft one line per chosen frame from its frame name and page name: what the screen
  is for, in user language. Ignore default names: "Frame 12", "iPhone 14 - 3", "Desktop - 1",
  "Screenshot ...", a bare number. Such a frame gets no intent; leave it out of `frames:`.
  - `keyed`: show every intent on one card and let the user confirm or rewrite them. A line the
    user saw and kept, or rewrote, is `intent_source: user`.
  - `goal`, `blind`, and unattended: nobody confirms. Every drafted intent is
    `intent_source: frame_name`. It is a weak intent, and the report labels it an assumption.
- **Goals** (`goal` and `keyed`). Ask what a person comes to do, in their words. `text` never
  holds a frame name, a layer name or a button label. `start_frame` is where the goal begins.
  `steps` lists the frames of the goal in order. Each frame takes one goal at most.
- **Targets** (`keyed`). The correct thing to press on each step's frame. The user gives it in
  one of two ways:
  - **A Figma link to the node.** Run `node "$PLUGIN/driver/figma.mjs" parse-url "<link>"`. Its
    `node_id` is the target.
  - **Words** ("the green Pay button"). Find the node among that frame's `nodes` in
    `<snapshot>/design.json` by its `name` and `text`. Use the Grep tool: the file is large, do
    not read it whole.
  - Either way, check that the id is a node of that frame in `design.json`. The frame's own id is
    not a target. Prefer the control (the button) over the text inside it; both count as a hit.
  - **Show the user what was keyed, and wait for a yes.** For a target given in words and for one
    given as a link, run
    `node "$PLUGIN/driver/design.mjs" crop "<snapshot>" --frame "<frame id>" --node "<node id>" --out "<run folder>/key/<n>.png"`,
    with `<n>` counting the targets from 1. It writes the frame around the node with a red or cyan
    outline on the node, and prints `{out, frame, node, box}`. Open the picture at `out` with the
    Read tool and ask **Yes, that one** (recommended) · **No, another one**. On a no, find another
    node and show that one. A target is written to `key.yaml` only after a yes.
  - The command exits 1 with one line when it cannot make the picture: the frame has no image, or
    the snapshot has no nodes. Then describe the node instead: its name, its text, its size and
    where it sits in the frame (from `box`), and give the path of the frame image
    (`<snapshot>/frames/<n>.png`) so the user can look.
  - **Unattended never keys a new target.** It takes the targets of an existing `key.yaml`, as above.

## 6. Personas and sessions

**Personas.** Read `$PLUGIN/knowledge/personas.md`. Reuse `<project>/.ux-assessment/personas.md`
when it exists. Otherwise make 3 cards (core, casual, constrained) from what the user says about
who the product is for; ask that in one question. Unattended: draw them from what the frame names
suggest, with `grounding: assumption`, and add it to the assumptions. Show the table and ask
**Use these** (recommended) · **Change something**. Write the cards to `personas.md`.

- **Recon is skipped.** There is no source to read and no app to open. Do not dispatch
  `ux-assessment:recon`. There is no charter and no pack.
- `vision: low` on a card built from a low-vision condition; otherwise `normal`.
- The device comes from the frame, never from the card: a frame at most 480 px wide is a phone.

**Sessions.** One session is one viewer agent with a fresh context. In one context a later frame
would give away an earlier one.

| Case | Sessions | `follow_links` | `first_click` |
|---|---|---|---|
| The level is `flows`, the tier is `goal` or `keyed`, and a goal's `start_frame` is the `start` of a flow | One per persona × such goal, starting on that frame | `true` | `true` |
| Every other chosen frame | One per persona × frame | `false` | `true` when a goal lists the frame (as `start_frame` or in `steps`), else `false` |
| The tier is `blind` | One per persona × frame, whatever the level | `false` | `false` |

- `follow_links` needs `first_click`: the click that is followed is the first click. The harness
  refuses the first without the second.
- In a flow the harness moves the viewer by its own first click, by code. No model chooses the
  next frame. A flow ends after 8 frames, at a click that hits no link, or at a link that is not
  a plain move or a step back.
- A frame that a flow session covers gets no session of its own.
- **Viewer id** = session id = folder name: `<persona id>--f<NN>` for a frame (`NN` is its
  two-digit place among the chosen frames), `<persona id>--<goal id in lower case>` for a flow
  (`casual-curious--f03`, `casual-curious--g1`). Never put a frame name or a frame id in it.

Write the plan to `<project>/.ux-assessment/plans/<run name>.md`: the table viewer id, persona,
frame id, flow or frame, goal id; the source, the level and the tier; the models
(`node "$PLUGIN/driver/models.mjs" show "<project>"`). No token estimate exists for a design run:
tell the user the number of viewer sessions instead, and that each is short. Ask **Run it**
(recommended) · **Trim** · **Stop here**.

## 7. The viewer briefing

Build it from this template and nothing else. It is the viewer's whole world.

```
Session id: <viewer id>

Who you are:
<persona card YAML without `grounding`, `device`, `perception`, `patience_budget`, `quit_triggers`, `start_state`, `account`>

You are on <a phone | a computer>.
How you got here: <entry context>
<if first_click>What you want: <the goal's `text`, in full>
After you have read the screen, say where you would press first to do that.</if>

The screen is already in front of you. Start with a look.
```

- "a phone" for a frame at most 480 px wide, otherwise "a computer".
- **Entry context.** For the first frame of a goal, and for a frame with no goal: the card's
  `entry_point`. For a later frame of a goal: one sentence, in user language, about what the
  person has just done, taken from the goal's `text` ("You have chosen what to buy and asked to
  pay"). Never take it from a frame name.

| A briefing holds | A briefing must never hold |
|---|---|
| The session id | A frame name, a page name or a frame id |
| The card | A layer or component name, or any text read from the snapshot |
| The entry context | An intent |
| The goal in user language, for `goal` and `keyed` | A target, or a hint about where anything is |
| | The Figma link, the file name, a file path, the folder of the run |
| | Another frame, another viewer's answer, a measured value |
| | The words "Figma", "frame", "layer", "prototype", "mock-up" |

## 8. Run the viewers

Take the sessions in batches of `max_parallel` (`config.yaml`, default 3). Viewers share no
state, so every batch can run in parallel. Tools are `mcp__plugin_ux-assessment_browser__<tool>`.
For each batch:

1. For each viewer, `harness_design_start`: `session: <viewer id>`,
   `dir: <run folder>/<viewer id>` (absolute), `design: <snapshot>` (absolute), `frame: <frame id>`,
   `follow_links` and `first_click` from step 6. No browser opens. It answers with the `device`.
   It fails when the frame has no image or the id is already open.
2. Write `<run folder>/<viewer id>/viewer.json` with the Write tool, before the judge runs:
   `{"vision": "normal", "reading_style": "skim"}`, both from the card. `vision` is `normal` or
   `low`. `reading_style` is `read-all`, `skim` or `icons-only`. Without the file the judge
   measures that viewer as `normal` and `read-all`.
3. Issue all the batch's Agent calls **in one message**: `subagent_type: "ux-assessment:viewer"`,
   prompt = the briefing only, `run_in_background: false`. Model: the `claude persona` line of
   `models.mjs show`; leave `model` out when it is `sonnet`.
4. Only once a viewer's Agent call has returned its final reply, call `harness_signals` with its
   session id. When `over` is `null`, answers are missing: send that same agent **one** follow-up
   (SendMessage to its agent id): "Your session is not finished: an answer is still missing. Give
   it now with the answer tool, then reply with your summary." Nothing else: no hint about the
   screen or the goal. Never send a second one. Save the final reply to
   `<run folder>/<viewer id>/summary.md`. Note `context_tokens` and the duration from the Agent
   result.
5. `harness_stop` each session, always, also when the viewer failed. It closes the session and
   then returns the signals. Copy `over`, `frames_shown` and `views` into `run.json` from that
   result, not from the viewer's reply. `over` is `answered`, `cannot_find`, `no_link`,
   `unsupported` or `frame_cap`. It is `stopped` when the viewer never finished, even after the
   follow-up: write `"over": "stopped"` and add `"answers missing"` to its `harness_problems`.
   The judge then shows that visit with `complete: false` and `ended: stopped`.

Do not open the screenshots yourself, and do not read `design-log.jsonl`. If a session fails for
a harness reason, record it and continue.

## 9. `run.json`

Write `<run folder>/run.json` before the judge and before any `ledger.mjs sync`. The ledger reads
`"kind": "design"` from it; without it the run's findings are treated as an app run's and are
offered for a recheck in a browser.

```json
{"kind": "design", "date": "...", "started_at": "...", "source": "rest", "level": "static", "tier": "goal",
  "file_key": "...", "version": "...", "mode": "...", "unattended": false, "assumptions": [],
  "sessions": [{"viewer": "casual-curious--f03", "persona": "casual-curious", "frame": "12:34", "flow": false,
    "over": "answered", "frames_shown": 1, "views": 2, "context_tokens": 0, "tool_uses": 0, "duration_s": 0,
    "harness_problems": []}],
  "not_tested": []}
```

- There is no `url`.
- `started_at` is the ISO time the first batch started (`node "$PLUGIN/driver/probe.mjs" now`).
- `not_tested`: placeholder frames, frames left out by the limit of 12, skipped frames, and what
  the source could not give.

## 10. Judge

```
node "$PLUGIN/driver/design.mjs" judge "<run folder>" --design "<snapshot>" --key "<project>/.ux-assessment/design/key.yaml"
```

No model call. It reads every viewer folder (a sub-folder with a `design-log.jsonl`), the
snapshot and the key, and writes `design-results.json` and `perception.jsonl` into the run
folder. It prints `{results, perception, viewers, frames, elements}`. Without `--key` it judges
as `blind`, so always pass it.

| stderr | Meaning | Do |
|---|---|---|
| "warning: key target ... is not an element of frame ..." | A target of `key.yaml` is not in the snapshot. Its clicks are judged `miss`. | Fix `key.yaml` (step 5) and run the judge again. Unattended: add it to the assumptions. |
| "warning: ... line N is not JSON and was skipped" | A damaged log line. | Add the viewer to `harness_problems`. |
| "... viewer.json: vision must be ..." or "reading_style must be ..." (exit 1) | A wrong value in step 8.2. | Fix that file and run the judge again. |
| "no viewer folder with a design-log.jsonl ..." (exit 1) | No session ran. | Stop. |

The judge can be run again at any time. It overwrites its two files.

## 11. Triage

First run `node "$PLUGIN/driver/ledger.mjs" sync "<project>"`. Dispatch `ux-assessment:triage`
(model: the `claude triage` line) with:

- the sentence **"This is a design run."**;
- the run folder, the project root and the plugin root;
- the rules: this file (`$PLUGIN/knowledge/design.md`, Part 2), `$PLUGIN/knowledge/perception.md`,
  and `$PLUGIN/knowledge/triage.md` for the sections Part 2 names;
- the snapshot folder, and the paths of `personas.md`, `design/key.yaml` and the plan;
- the ledger path, the report language, whether the run was unattended, and the suppress list
  (the titles labelled `won't fix` in `feedback.md`, or "none").

It writes `findings.yaml` and this run's section of `feedback.md`, and returns the report as its
final reply. Save that reply verbatim to `<run folder>/report.md`. Run
`node "$PLUGIN/driver/usage.mjs" report "<run folder>"` and append its output under a
`### Tokens` heading at the end of `report.md` ("not measured" is an answer too). Then run
`ledger.mjs sync` again.

**The decide step is skipped.** It reads the app's source, and a design has none. Do not run the
skill's step 9b, and do not dispatch `ux-assessment:decide`.

## 12. Tell the user

In their language:

1. First, again: this mode is experimental and unvalidated, the source, the level reached, the
   tier, and "N viewers, one model".
2. The top findings, one line each: `F-03 · <title_local>`, with severity and whether it was
   measured by code or understood by a viewer.
3. What was not tested, and where the report is.
4. The tokens per model, from the `### Tokens` table.

Then offer the `.gitignore` lines of the skill's step 10 (unattended: list them, never edit).
`.ux-assessment/design/cache/` matters most here: it holds the design, which may be confidential.

Labels, the ledger and the board work as for an app run:

- **Label findings** is the skill's step 11. A design finding has no decision, so each is
  reviewed one by one. Then `node "$PLUGIN/driver/ledger.mjs" sync "<project>"`.
- **Show results** is unchanged. The board marks a design finding "(design)" and lists it under
  "Not decided yet" until it is labelled, and the board's last line tells the user to label it.
- **Verify fixes** lists no design finding, and **Decide** refuses a design run.

# Part 2: judging and the report (triage)

You are told "This is a design run." Follow this part and `knowledge/perception.md`. From
`knowledge/triage.md` use only: §3 for `kind`, severity, the suppress list and the ledger; §4 for
the fields of a finding record; §6 for `feedback.md`. Its §1, §2, §7 and §8 are for app runs:
there is no `log.jsonl`, no `signals.jsonl` and no `expectations.mjs` here.

## T1. Inputs

| File | Holds | Use |
|---|---|---|
| `<run>/design-results.json` | Per viewer and frame: the answers, the hit of every point, the first-click verdict, where the viewer moved, how the session ended. Per frame: the intent and the instrument values of used elements. `not_simulated`. | Evidence |
| `<run>/perception.jsonl` | One line per element and per frame, for each way of looking: the values, the thresholds, `below`, `used`, `used_by`, `keyed`. | Evidence |
| `<run>/run.json` | Which viewer is which persona, the source, the level, the tier, the assumptions, `not_tested`. | Context |
| `<run>/frames.json` | Every frame of the snapshot: name, page, size, `placeholder_share`, flows, arrows. | Planner context |
| `design/key.yaml`, `personas.md` | Intents, goals, targets; the cards. | Planner context |
| `<snapshot>/design.json` | Names, text and links of nodes. | Look up one element id with Grep. Never read it whole. |
| `<run>/<viewer>/screenshots/vNN.png` | What the viewer was shown, one picture per look. | Open the ones you cite. Take the path from `screenshots` of the visit. |

**Never read `design-log.jsonl`.** The judge has already turned the raw logs into the two
evidence files, with every point hit-tested by code. Your own reading of a raw point is not
evidence. A viewer's `summary.md` is its own account after the fact: do not use it as evidence.

`design-results.json` in short:

- `viewers[].frames[]`: `frame`, `screenshots` (the pictures of that visit in the order the viewer
  looked, each `<viewer>/screenshots/vNN.png` relative to the run folder), `complete`, `first_look` (`purpose`, `confidence`,
  `main_action` with `element` and `control`), `after_reading` (`not_understood`,
  `purpose_changed`), `pressable_hits[]` (`element`, `control`, `expect`, `confidence`),
  `first_click` (`result`, `point`, `hit`, `target`, `verdict`), `moved_to`, `ended`. Every point
  is in frame pixels. `element` and `control` are `null` when the source gave no nodes.
- `first_click.verdict` is `hit`, `miss`, `cannot_find` or `no_target` (no keyed target on that
  frame, or the source gave no nodes).
- `frames[]`: `intent`, `intent_source`, `viewers_pointed`, `instrument_findings[]` (an element
  that was used and is below a threshold: `instrument`, `value`, `threshold`, `viewers`, `keyed`).
- `viewers` in these files are viewer ids. Map them to personas with `run.json`. A finding's
  `personas` lists persona ids.

## T2. The asymmetry

| What the evidence shows | What it is worth |
|---|---|
| A viewer failed: `cannot_tell`, `cannot_find`, a `miss`, a purpose that does not fit the intent | Strong. The model had the whole picture and every word, and still failed. |
| A viewer understood | Weak. A model reads everything and never tires. A person may still fail. |
| Several viewers agree that a screen is clear | Nothing. All viewers are one model. Agreement between them is never evidence. |
| An instrument value below its threshold | A measurement. It stands without any viewer struggling, within the limits of T4. |

Never write that a screen "is clear", "works" or "tested well". Write what viewers said and what
was measured. The number of personas that failed raises confidence (T5). The number that
succeeded never lowers it.

## T3. What you judge, and what the code already judged

| Judge | Decides |
|---|---|
| Code (`design.mjs judge`). Take it as given. | Which element a point hit. `hit` or `miss` against the keyed target. Where a first click led. The instrument values and `used`. |
| You, with planner knowledge | The stated purpose against the intent: `match`, `partial` or `mismatch`. What a viewer expected against the other frames of the file. |

Finding types (the record's `type`):

| `type` | Raised when | `source` |
|---|---|---|
| `purpose_unclear` | The stated purpose does not fit the intent (`mismatch`), or the viewer answered `cannot_tell`. | `comprehension` |
| `control_unpredictable` | A viewer could not say what a control does (`cannot_tell`), or expected something the design does not do. | `comprehension` |
| `first_click_miss` | The verdict is `miss` or `cannot_find`. | `comprehension` |
| `expected_screen_missing` | No frame of `frames.json` fits what the viewer expected to see next. | `comprehension` |
| `contrast`, `target_size`, `text_load`, `icon_only` | The instrument rules of T4. | `instrument` |

- `expected_screen_missing` says the file has no such frame. It does not say the product lacks
  the screen. Say exactly that.
- `ended: no_link` ("nothing happened here") is not a finding by itself. A design often links
  only the main path.
- `ended: unsupported` and `frame_cap` go under "Not tested". `ended: stopped` with
  `complete: false` is a viewer that did not finish: use the answers it gave, and list it under
  Run facts.
- `not_understood` entries support a `purpose_unclear` or `control_unpredictable` finding at the
  element they quote. Many viewers listing the same word is one finding about that word.
- **A frame that fits one fold.** There both answers saw the same picture, so `purpose_changed`
  is not evidence. A frame fits one fold when its height is at most width × 16 ÷ 9 (`touch`) or
  width × 5 ÷ 8 (otherwise), from `frames.json`.
- **A placeholder frame** (`not_simulated` has `placeholder_frame` for it): ignore every
  comprehension answer about it. Instrument values still count.
- **In `blind`** there is no purpose verdict except `cannot_tell`, and no first click. Print the
  "what viewers understood" table (T7) and let the designer label it.
- A viewer that answered against its card (a card with `tech_literacy: low` that is `sure` about
  an unlabelled icon) is `kind: agent_error`, as in an app run. It is never evidence that the
  control is clear.

## T4. Instrument rules

The thresholds and the full rules are in `knowledge/perception.md` §8. In short:

| Case | Result |
|---|---|
| A value below its threshold, and a comprehension miss at the same element | One finding, confidence `signal` |
| A value below its threshold alone, on an element that was **used** | A finding with confidence `watch` and `source: instrument` |
| A value below its threshold on an element nobody used | A row in the "Measured values" table. Not a finding. |
| A `null` | Nothing. A `null` is never a finding. |

- **Used** means a viewer pointed at the element, or it is a keyed target. The judge has decided
  it: `used` in `perception.jsonl`, and `instrument_findings` lists exactly the used elements
  below a threshold.
- **`prominence` never raises a finding alone.** `prominence_rank` supports a `first_click_miss`
  when the keyed target is ranked outside the top 3 of its frame. Nothing else.
- One finding per element and instrument, listing every persona whose viewer used it. The same
  element measured for two ways of looking (`vision`, `reading_style`) is still one finding: say
  for whom it is below the line.
- A finding that rests on a word budget, the reading speed or a control found by a name pattern
  says so, and says that the number is the authors' pick with no evidence.

## T5. Confidence

| Evidence | `confidence` |
|---|---|
| A `miss` or `cannot_find` by the viewers of 2 or more personas, same frame and goal | `signal` |
| A `miss` or `cannot_find`, plus an instrument value below its threshold on the keyed target | `signal` |
| Any `cannot_tell`, from one persona or more | `signal` |
| A purpose `mismatch` against an intent with `intent_source: user`, 2 or more personas | `signal` |
| The same, one persona | `watch` |
| A purpose `mismatch` against an intent with `intent_source: frame_name` | `watch`, whatever the count. The intent is an assumption. |
| Anything else seen by one persona | `watch` |
| An instrument value alone, on a used element | `watch` |

Severity is as in `knowledge/triage.md` §3: impact (`blocks` > `slows` > `cosmetic`) × the number
of personas. A first click that cannot be found blocks. An instrument value alone is never high.

## T6. The finding record

The record of `knowledge/triage.md` §4, with these differences:

```yaml
id: F-21
title: "The pay button is not where people press first"
title_local: "..."
kind: ux                # ux | agent_error | env_error
source: comprehension   # instrument | comprehension. Every design finding has one of the two.
type: first_click_miss  # T3
confidence: signal
severity: high
personas: [casual-curious, core-shopper]
frame: "12:34"
element: "12:41"        # the element id, or null for a finding about the whole frame
evidence: [casual-curious--f03/screenshots/v01.png, "design-results: casual-curious--f03 first_click miss, hit 12:77, target 12:41", "perception: 12:41 prominence_rank 5 of 6"]
what_happened: "..."
why_it_matters: "..."
suggested_fix: "..."
suppressed: false
```

- **`source` is required**: `instrument` when the finding stands on a measured value alone,
  `comprehension` otherwise. A finding with both a miss and a value is `comprehension`, and its
  evidence lists the value.
- **Evidence paths** point at `<viewer>/screenshots/vNN.png`, relative to the run folder. In a
  one-frame session `v01.png` is the first look. In a flow session take the path from the
  `screenshots` of the visit to that frame in `design-results.json`. Every finding in the top list has a screenshot or a
  measured value behind it.
- **No `code_pointer`.** A design has no source. **No `check`** either: nothing can recheck a
  design finding.
- **Ids.** Read the ledger: `runs.<name>.kind` says which runs were design runs.
  - The same root cause as a ledger entry whose sightings are **all** in design runs → reuse
    that id.
  - Anything else → the next free number, counted over the whole ledger and this run.
  - **Never reuse the id of a finding from an app run.** Not even for the same problem seen in
    the design of the same screen. The ledger takes a finding's kind from the last run that saw
    it. A reused app id would turn that app finding into a design finding, and it would drop out
    of Verify fixes and Decide.
- Wherever a finding is named, write `F-03 · <title_local>`, never the id alone.
- Write all records to `<run folder>/findings.yaml`, and this run's section of `feedback.md` as
  `knowledge/triage.md` §6 says.

## T7. The report

In the developer's language. Quotes of on-screen text stay verbatim. Name a frame by its name
from `frames.json`: the reader is the designer. Your final reply is the report and nothing else.
An unattended run's report puts the assumptions of `run.json` inside section 1.

1. **What this run can and cannot say.** Always first. It states, in this order:
   - Design mode is experimental. It has never been validated against a real Figma file or
     against real users. Its findings are leads to check, not results.
   - The source (`rest`, `mcp` or `png`, in plain words), the level reached, and what that level
     left out.
   - The tier, and what it allows: `keyed` gives verdicts, `goal` gives first clicks without a
     verdict, `blind` only describes.
   - "N viewers, one model": the number of viewer sessions, the number of personas, and that all
     of them are the same model, so their agreement proves nothing.
   - The asymmetry of T2, in two sentences.
   - What could not be tested: every entry of `not_simulated`, the skipped frames, the
     placeholder frames, states such as empty, loading and error, and interaction (typing,
     dragging, hover, animation, overlays, anything that needs a running product).
   - The assumptions, when there are any.
2. **Top findings.** 5 to 7, `ux` with `signal` or `watch`, by severity: `F-03 · <title_local>`,
   what happened, why it matters, the evidence, a suggested fix, and its `source` in plain words
   ("measured by code" or "from what viewers understood"). Mark an id that came from the ledger
   "seen before".
3. **Per-frame table.** One row per frame in play, in the confirmed order when there is one:

   | Frame | Intent | What viewers said it is for | First look against after reading | First click |
   |---|---|---|---|---|

   Mark an intent with `intent_source: frame_name` "(assumed from the name)". In `blind` this is
   the "what viewers understood" table, and the first-click column is left out.
4. **Measured values.** One table: frame, element (its name or text from `design.json`),
   instrument, value, threshold, used or not, and the finding when there is one. Under it, one
   line on where the thresholds come from (`knowledge/perception.md`): which are standards and
   which are the authors' picks.
5. **Not tested.** The list of section 1 in full, plus each flow that ended at a link the test
   cannot show, and **Known, won't fix** (suppressed findings, one line each).
6. **Appendix.** Agent and environment errors. Run facts: the sessions, the viewers that did not
   finish, harness problems. Every finding as a record. The orchestrator appends the token table
   under `### Tokens`.

Precision is reported per `source`. No number exists yet for `instrument` or `comprehension`
findings. The precision measured on app runs says nothing about them: never quote it for a design
run.
