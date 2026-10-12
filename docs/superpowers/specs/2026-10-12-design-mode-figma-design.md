# Design mode for Figma — design (2026-10-12)

Status: design agreed in a brainstorm on 2026-10-12. It is built from this document and has never
been run against a real Figma file. Every part of it is experimental.

This document amends
[the perception and design mode design of 2026-10-02](2026-10-02-perception-and-design-mode-design.md),
called "the base design" below. Where the two differ, this one wins. Sections 2, 5.2 to 5.6 and 7 of
the base design still hold unless a section here changes them.

Terms: decisions D1 to D35, knowledge isolation and the finding record are defined in
[SPEC.md](../../../SPEC.md).

## 1. What changed since the base design

| Topic | Base design | Now |
|---|---|---|
| Order of work | Instruments in app runs first, then design mode | Design mode first. App runs are not touched. |
| Instruments | For app runs and design runs | For design runs only. `scene-page.mjs` is not built. |
| Constrained input (phase 3) | An experiment | Not built. It still needs the experiment. |
| Figma MCP server | Rejected | A second way to fetch the file. Measuring stays in code. |
| Evidence before release | A keyed run on a real hi-fi file | None. The author has no Figma file. The repository says so wherever the mode is named. |
| Codex | Shared tools, unverified | Not offered. The Codex skill says so. |
| Routing | Not designed | One skill. The input decides the mode (section 2). |
| Decision numbers | D34 to D38 | D36 to D39. D34 and D35 were taken in the meantime. |

Why design mode is built without evidence: the owner wants other people to be able to try it on
their files and report back. The report form of section 10 is how a level moves from "experimental"
to "tested".

## 2. Routing

Design mode is a second mode of the `ux-assessment` skill. The skill decides before step 1 (App).

| The request holds | Mode |
|---|---|
| A URL whose host is `figma.com` or `www.figma.com` and whose path starts with `/design/`, `/file/` or `/proto/` | design |
| A path to an existing folder that holds PNG files and no `package.json`, and no URL anywhere in the request | design, PNG source |
| The word `design` | design. The skill asks for the link or the folder. |
| The word `app` | app, whatever else is given |
| Any other URL | app, as today |
| A Figma link and an app URL | The skill asks which one to run. Unattended: stop and say so. |

- The first line the skill prints names the mode and why, for example "Design mode: the request has
  a Figma link." or "App mode: no Figma link or PNG folder in the request."
- `node "$PLUGIN/driver/figma.mjs" parse-url "<words>"` does the detection, so the rule is code and
  has tests. It prints `{kind, file_key, node_id, start_node_id}` or `{kind: "none"}`. The skill runs
  it only when the request contains `figma.com`, and passes only the words that contain it, so an
  app run runs nothing new and the shell never sees the rest of the request. When the command
  fails, the run is an app run.
- A `/proto/` link is read as its file key plus its starting frame. The prototype is never opened
  in a browser. A model never drives Figma's player.
- A FigJam, Slides or community link (`/board/`, `/slides/`, `/community/`) is refused with one
  sentence that says what is supported.
- The state menu (D20) is unchanged. "Verify fixes" lists no design finding (section 8).

## 3. Sources

Three sources produce the same thing: a design snapshot on disk (section 4). Everything after the
snapshot is the same code for all three.

| Source | Needs | Gives | Missing |
|---|---|---|---|
| `rest` | A Figma token | Frames, node boxes, text, font size, prototype links, a file version | Nothing |
| `mcp` | The Figma MCP server connected to the Claude Code session | Frames and node boxes | Text, font size, prototype links, a version. An opt-in script adds the first three. |
| `png` | A folder of PNG files | One frame per file | Every node. No instrument, no link, no placeholder check. |

**Choosing.** The config key `design.source` forces one. Otherwise:

1. A PNG folder was given: `png`.
2. A token is found: `rest`.
3. The session has the Figma MCP tools: `mcp`.
4. Otherwise stop. Print how to set up a token, how to connect the MCP server, and how to export
   frames to a folder.

`rest` is preferred because a rerun reads the same file version from the cache.

### 3.1 REST

As section 5.1 of the base design. In short:

- The token comes from the environment variable `FIGMA_TOKEN`, or from `figma_token` in
  `.ux-assessment/secrets.local.yaml`. No agent is given it. No log, report or error prints it.
- Calls per run: `GET /v1/files/:key/nodes`, then `GET /v1/images/:key` once for every 50 frames
  that are kept (`IDS_PER_REQUEST`), when the link names a page, a section or a frame. One more call,
  `GET /v1/files/:key?depth=2`, when the link names no node (the user may have to pick a page) and
  for a prototype link, which needs it to find the page of its starting frame.
- **Picking frames.** `fetch` takes `--frames <id,id,...>` (ids with `:` or `-`). Only those frames
  are kept, and only their images are requested and downloaded. An id that is not a top-level frame
  of the page or section is an error before any image request. A `navigate` link whose target is not
  kept becomes `other` (section 4), and `flow_starts` and `arrows` count the kept frames only.
  Without `--frames`, a page or section of more than 24 frames (`FRAME_LIST_LIMIT`: a design run
  looks at 12 frames at most, and each frame is one image download that counts against Figma's image
  render) makes no image request. `fetch` prints
  `{file_key, version, too_many_frames, limit, frames: [{id, name, width, height, links, flow_start}]}`
  (`links` is the number of click links that navigate) and exits 4, and the caller runs it again
  with `--frames`. The rerun makes the nodes call again, because nothing was saved.
- The token goes only to the API address, in a header. A redirect from the API is an error, so the
  header is never sent on. The API host can be replaced by the environment variable
  `FIGMA_API_BASE`. Tests use it. Nothing else should. It is accepted only as an `https` address,
  `http://127.0.0.1` or `http://localhost`.
- Field names follow Figma's published REST specification: `absoluteBoundingBox`, `characters`,
  `style.fontSize`, `fills`, `visible`, `interactions[].trigger.type`,
  `interactions[].actions[]` with `type`, `destinationId` and `navigation`, and
  `flowStartingPoints` on a page. No response from the real API has been seen.

### 3.2 The Figma MCP server

The driver cannot call an MCP server. Only the orchestrator can. So the orchestrator calls the
Figma tools, saves what they return to files, and hands the files to the driver.

| Step | Tool | Saved as |
|---|---|---|
| 1 | `get_metadata` for the page or frame | `metadata.xml` |
| 2 | `download_assets` for up to 20 frames, PNG, scale 1. `get_screenshot` per frame when that tool is missing. Always a URL, never base64. | `images.json`, a map from node id to URL |
| 3, opt-in | `use_figma` with the script `driver/figma-read.js` | `nodes.json` |

Then `node "$PLUGIN/driver/figma.mjs" import-mcp` builds the snapshot and downloads the images.

- **A viewer never has a Figma tool.** Its tool list is `view` and `answer`. Frame names and layer
  names reach the orchestrator, which already holds planner knowledge.
- **Step 3 uses a tool that can change the file.** The rules for it:
  - The script is a file in this repository. The orchestrator passes it unchanged. It never writes
    one itself.
  - A test reads the script and fails when it holds a call or an assignment that could change a
    document.
  - Guided and Expert ask before each run, and say that the tool can write and that the script only
    reads. Quick does not ask and does not use it.
  - Unattended never uses it.
  - Without it, the run is the "frames only" level of section 5, and the report says so.
- **A partial `nodes.json`.** The script skips a frame it cannot find. When the file has no entry for
  some kept frame, `has.text`, `has.font_size` and `has.links` stay false for the whole snapshot,
  the importer warns with the count on stderr, and what the file did hold is still merged.
- **Quota.** A View or Collab seat gets about 20 tool calls a month. A run makes 2 to 4. The skill
  prints the count before the first call.
- **Clients.** Figma lets only catalogued clients connect. This is one reason the mode is Claude
  Code only.
- **Unknowns.** The exact XML of `get_metadata`, whether its coordinates are relative to the parent
  or to the page, and what `use_figma` returns, are taken from Figma's documentation only. The
  importer tries both readings of the coordinates and keeps the one that puts more nodes inside
  their frame.
- **Cache.** There is no version. The snapshot is keyed by the day it was fetched. `import-mcp`
  always imports again and overwrites that day's folder. The orchestrator is the one that reuses the
  saved copy: before it calls any Figma tool it looks in the cache folder of the file key for a
  snapshot whose `source` is `mcp`, and with a copy there that holds the linked frame it skips the tool calls (attended, the user chooses; unattended, it
  reuses the copy) and does not run `import-mcp`.

### 3.3 A folder of PNG files

One frame per file, in name order. The file name is planner knowledge. There are no nodes.

## 4. The design snapshot

One shape, written by all three sources. It is the only input of the scene builder, the planner
commands, the static session and the judge.

Path: `.ux-assessment/design/cache/<file key>/<version>/`, with `design.json` and `frames/<n>.png`.
For `png` the file key is `png-<hash of the folder path>`. For `mcp` and `png` the version is the
date of the fetch. A `rest` fetch with `--frames` writes to `<version>-f<8 hex digits>/`, the digits
being the start of the SHA-256 of the sorted ids joined with commas, so two selections of one file
version are two folders and neither overwrites the other.

```json
{
  "source": "rest",
  "file_key": "AbCdEf",
  "version": "2207",
  "fetched_at": "2026-10-12T09:00:00Z",
  "has": {"nodes": true, "text": true, "font_size": true, "links": true},
  "frames": [
    {
      "id": "12:34",
      "name": "Checkout / Payment",
      "page": "Mobile",
      "width": 390,
      "height": 1420,
      "image": "frames/1.png",
      "image_scale": 1,
      "links": [],
      "nodes": [
        {"id": "12:41", "type": "INSTANCE", "name": "Button / Primary", "parent": "12:34",
         "box": {"x": 24, "y": 1320, "w": 342, "h": 52},
         "text": null, "font_size": null, "image_fill": false,
         "links": [{"trigger": "click", "action": "navigate", "to": "12:58"}]}
      ]
    }
  ],
  "flow_starts": ["12:34"],
  "arrows": [{"between": ["12:34", "12:58"], "direction": "unknown"}],
  "skipped": [{"id": "12:90", "reason": "no image"}]
}
```

- A node's `box` is in frame pixels, with the frame's top-left corner as the origin. Each source
  converts at the boundary. Nothing downstream knows about page coordinates.
- A frame's own `links` are the interactions set on the frame itself, such as a splash screen that
  moves on at a click anywhere. The hit test falls back to them when no node at the point has a link.
- `image_scale` is image pixels per frame pixel. Points and boxes are always frame pixels.
- Invisible nodes and nodes with no box are dropped at the boundary.
- `has` says what the source could give. A reader never guesses from an empty field.
- `links[].trigger` is `click`, `hover`, `drag`, `timeout` or `other`. Figma's `ON_CLICK` and
  `ON_PRESS` both become `click`.
- `links[].action` is `navigate`, `back`, `overlay`, `swap`, `scroll`, `url` or `other`. `to` is a
  frame id for `navigate` and null otherwise. A `navigate` whose target is not a frame of the
  snapshot becomes `other`.
- `arrows` are the hand-drawn lines of section 5. They are a hint for the planner and nothing else.

`.ux-assessment/design/source.yaml` records the link, the source, the file key, the version and the
frames chosen. It is the record of the current source, which the pipeline reads, and there is one per
project. `.ux-assessment/design/key.yaml` is section 5.2 of the base design, unchanged.

**The index of saved copies.** `.ux-assessment/design/cache/index.json` is how `fetch` finds a saved
copy, so that going back to an earlier file needs no API call. It is an object from a request to the
copy that answered it:

```json
{
  "[\"rest\",\"https://www.figma.com/design/AbCdEf/Shop?node-id=0-1\",null,[\"1:20\",\"1:32\"]]": {
    "file_key": "AbCdEf", "version": "2207", "folder": "AbCdEf/2207-f2112e778", "fetched_at": "2026-10-12T09:00:00Z"
  }
}
```

- The key is the JSON text of `[source, link, page, sorted frame ids]`, with `null` for no page or
  no frame list. Only `rest` fetches are in it. `folder` is relative to `cache/` and has the two
  parts `<file key>/<version>[-f<hash>]`. An entry whose folder has any other shape is ignored.
- A fetch is a hit when its key is in the index and the folder holds `design.json`. On a hit
  `source.yaml` is written again from that `design.json`. `--refresh` skips the lookup and then
  replaces the entry.
- A fetch records every success. Because two requests of one file version can write one folder (a
  page link and a frame link, say), recording a request removes every other entry that names the
  same folder: its copy has just been replaced.
- The file is written to a temporary file and renamed, private as the other cache files are. A file
  that cannot be read, is not JSON or has another shape counts as empty and gives one warning on
  stderr. A failed write also gives a warning and never fails the fetch.
- `import-mcp` and `import-png` do not use the index: they import again every time.

## 5. What a file allows

The run reports the level it reached, per file.

| The snapshot has | Level | The run does |
|---|---|---|
| Images only (`png`) | `images` | Comprehension questions per frame |
| Nodes (`mcp` without the script) | `frames` | Plus the first click against a keyed target, and the instruments `contrast`, `target_size` and `prominence` |
| Text and font size | `static` | Plus `text_load`, `icon_only`, the large-text rule and the placeholder check |
| Hand-drawn arrows between frames | `static`, with an order hint | Plus a proposed frame order that the user confirms |
| Prototype links | `flows` | Plus one viewer per flow, moved from frame to frame by its own clicks |

- **Hand-drawn arrows.** A line, vector or arrow that is a sibling of frames, and whose box has one
  end within 40 px of one frame and the other end within 40 px of another, is recorded as an arrow
  between the two. The direction is always `unknown` today: no source reads an arrowhead. The
  harness never moves a viewer along an arrow. Confidence in this rule is low.
- **Prototype links** are followed as in section 5.3 of the base design, with these additions:
  - `navigate` on a `click` moves to the target frame. An interaction with several actions is
    several links, and the hit test takes a `navigate` or `back` link before any other `click` link.
  - `back` returns to the previous frame of this viewer.
  - Every other action answers "This opens something this test cannot show." The flow ends there
    for that viewer, and the action is listed under "Not tested".
  - A flow ends after 8 frames.
- **Controls in a frame.** A node is a control when it has a link with the trigger `click`, or when
  it is a component or an instance whose name matches a pattern of `knowledge/perception.md`
  (button, btn, input, field, checkbox, radio, toggle, switch, tab, link, chip, select, dropdown, menu
  item). A node a viewer pointed at counts as used for that viewer, but it is not turned into a
  control: its kind does not change. Confidence in the name patterns is low.

## 6. Units

| Unit | Purpose | Depends on |
|---|---|---|
| `driver/figma.mjs` | The three sources, the snapshot, the cache, and the commands `parse-url`, `fetch`, `import-mcp`, `import-png` | global `fetch`, `yaml`, `driver/paths.mjs` |
| `driver/figma-read.js` | The read-only script for `use_figma`. It is data for the orchestrator. Node never runs it. | nothing |
| `driver/perception/image.mjs` | PNG helpers: decode, encode, crop, scale down, the most frequent colour of a box, an outline around a box | `pngjs` |
| `driver/perception/scene.mjs` | A scene from one snapshot frame: its image plus elements `{id, kind, box, text, fontSize, links}`. The hit test. | `image.mjs` |
| `driver/perception/instruments.mjs` | Pure functions from a scene to numbers | `scene.mjs` |
| `driver/static-session.mjs` | One viewer's session: folds, the order of the answers, the caps, link following, the log | `scene.mjs`, `image.mjs` |
| `driver/viewer-tools.mjs` | Registers `view` and `answer` | `static-session.mjs` |
| `driver/mcp.mjs` | Gains `harness_design_start`. `harness_signals` and `harness_stop` also accept a static session. | the two above |
| `driver/design.mjs` | Planner commands: `frames`, `crop`, `judge` | `scene.mjs`, `instruments.mjs`, `image.mjs` |
| `agents/viewer.md` | The viewer agent | the tools `view` and `answer` |
| `knowledge/design.md` | The design-mode pipeline for the orchestrator and for triage | `knowledge/perception.md` |
| `knowledge/perception.md` | Thresholds, name patterns, placeholder words, and the rules from numbers to findings | nothing |

No new npm dependency. `pngjs` and `yaml` are dependencies already.

### 6.1 Scene

```js
{
  frame: '12:34', width: 390, height: 1420,
  image: {width, height, data},        // RGBA, or null when the frame has no image
  imageScale: 1,
  has: {nodes, text, font_size, links},
  elements: [{id, parent, kind, box: {x, y, w, h}, text, fontSize, links}],
}
```

- `kind` is `control`, `text`, `image` or `container`, by the rules of section 5.
- `hitTest(scene, point)` returns `{element, control, link}`. `element` is the deepest element that
  holds the point. `control` is the nearest control at or above it. `link` is the `click` link of the
  nearest element at or above it that has one: a `navigate` or `back` link when it has one, else its
  first `click` link. Without one, it is the same choice among the `click` links of the frame. Each is
  null when there is none.

### 6.2 Instruments

Section 4 of the base design, for design runs only. One change follows from `has`:

- `text_load` and `icon_only` return `null` when `has.text` is false.
- The large-text rule is not applied when `has.font_size` is false. Text is measured against 4.5.
- A `null` is never a finding.
- A control with no fill of its own (a ghost button, an outlined input) has `contrast` and
  `prominence` of `null`: its most frequent colour is its surroundings, so there is nothing to measure.
- With `vision: low` the contrast threshold is 7 for every element measured, controls as well as
  text. The 7 is WCAG 2 level AAA for text; using it for controls too is the authors' pick.

The card field `vision: normal | low` is added to `knowledge/personas.md` with the default `normal`.
App runs ignore it.

### 6.3 The static session

Started by the orchestrator with `harness_design_start`. No browser is launched.

| Input | Meaning |
|---|---|
| `session`, `dir` | As for `harness_start` |
| `design` | The absolute path of the snapshot folder |
| `frame` | The id of the frame to show first |
| `follow_links` | `true` for a flow. The default is `false`. |
| `first_click` | `true` for the tiers `goal` and `keyed`. The default is `false`. |
| `views_per_frame` | The cap on `view` calls per frame. The default is 12. |

- **Device.** A frame at most 480 px wide is a touch device. This replaces the 360 px of the base
  design, which would have called every current phone frame a desktop.
- **Fold.** The fold height is the frame width × 16 ÷ 9 on a touch device and × 5 ÷ 8 otherwise,
  and never more than the frame height.
- **Image size.** A fold wider or taller than 1568 px, or with more than 1,150,000 pixels, is scaled
  down before it is served. The session keeps the scale and maps every point back to frame pixels.
- **`view {session, scroll}`.** `scroll` is `down`, `up` or absent. It returns the fold as an image
  and one line of text, such as "Screen 1. You see the top part; there is more below."
- **`answer {session, first_look}`** or **`answer {session, after_reading}`**. The fields are those
  of section 5.4 of the base design. Points are pixels of the image last returned.
- **Order.** The codes follow the driver's `CODE: message` form, and a refusal is an error result.

| Call | When it is refused | Code |
|---|---|---|
| `answer` | Before the first `view` of the frame | `LOOK_FIRST` |
| `view` with `scroll` | Before `first_look` is recorded | `ANSWER_FIRST` |
| `answer` with `after_reading` | Before `first_look` | `ANSWER_FIRST` |
| `answer` | The same part twice for one frame | `ALREADY_ANSWERED` |
| `view` | After the cap | `VIEW_CAP_REACHED` |
| any | After the session is over | `SESSION_ENDED` |

- **After `after_reading`.** Without `follow_links` the session is over. With it, the first click
  is hit-tested and the session either shows the next frame ("A new screen is showing. Call view.")
  or ends with the sentence of section 5.
- **Files.** `<dir>/design-log.jsonl` and `<dir>/screenshots/vNN.png`, one image per `view`. The
  log has one line per event, each with `t`, `type` (`start`, `view`, `answer`, `navigate`, `end`)
  and `frame`. An `answer` line holds the answer with every point in frame pixels. Both files are
  written private, as the session files of an app run are.
- **The name `log.jsonl` is not used.** Code that reads app runs treats any folder with that file
  as a persona session.

### 6.4 Planner commands

- `node "$PLUGIN/driver/design.mjs" frames <snapshot folder>` prints the frames, the share of
  placeholder text in each, the flows, the arrows, and the level of section 5.
- `node "$PLUGIN/driver/design.mjs" crop <snapshot folder> --frame <frame id> --node <node id> --out <png file>`
  writes the picture the user confirms a keyed target by, and prints one JSON line
  `{out, frame, node, box}`. The picture is the part of the frame image around the node: the node's
  box plus 48 frame pixels on each side, cut at the frame, with `image_scale` honoured. A 3-pixel
  outline is drawn just outside the node's box (inside it on a side where the box touches the edge
  of the picture), red or cyan by which contrasts more with the most frequent colour under the
  outline. `--out` is written as given, with its folders made, private as the other run files are.
  It refuses with one line and exit 1 when `--out` is missing, the snapshot has no nodes, the frame
  or the node is unknown, the frame has no image or the node lies outside it. The orchestrator
  shows the picture with the Read tool and asks for a yes, for a target given in words and for one
  given as a link, and keys nothing unattended.
- `node "$PLUGIN/driver/design.mjs" judge <run folder> --design <snapshot folder> [--key <key.yaml>]`
  reads every viewer folder, the snapshot and the key. It writes `design-results.json` and
  `perception.jsonl` into the run folder. Without `--key` it judges as the tier `blind`. It is the
  deterministic judge of section 5.5 of the base design: the hit test of every point, the first
  click against the keyed target, the links followed, and the instrument values with the "used"
  rule. Each frame entry of a viewer also carries `screenshots`: the `image` paths of the `view`
  lines of that visit, in order, relative to the run folder with forward slashes
  (`<viewer>/screenshots/v01.png`), so that triage can tell which picture shows which frame. It
  makes no model call. Triage reads its two files and never the raw logs.

## 7. The pipeline

`knowledge/design.md` holds the steps. In short:

1. Route (section 2). Start a run folder as for an app run.
2. Fetch or import the snapshot (section 3). Show the level from `design.mjs frames`.
3. Choose frames: at most 12. A page of more than 24 frames is chosen from the list that `fetch`
   prints, before any image is downloaded. Choose the tier and write `key.yaml`. Unattended uses the existing
   `key.yaml`, or the tier `blind`.
4. Personas: the cards of `personas.md`, or 3 new ones. Recon is skipped. There is no source to
   read.
5. Run the viewers: one `harness_design_start` plus one `ux-assessment:viewer` agent per persona ×
   frame, or per persona × flow. The model is that of the persona role (D30).
6. `design.mjs judge`, then triage with `knowledge/design.md`. The report layout is section 5.6 of
   the base design.
7. Labels, the ledger and the board work as for an app run.

`run.json` gains `kind: "design"`, `source`, `level` and `tier`. It has no `url`.

The decide step is skipped. It reads the app's source, and a design has none.

## 8. Changes to shared code

App runs behave as before. These are the only edits to code that app runs use:

| File | Change |
|---|---|
| `driver/mcp.mjs` | Three more tools are listed. `harness_signals` and `harness_stop` look in a second registry too. |
| `driver/ledger.mjs` | A run whose `run.json` says `kind: "design"` is recorded as `kind: design`. Its findings carry that kind. The board marks them "(design)". |
| `driver/verify.mjs` | Open findings of a design run are not offered for a recheck. |
| `driver/decide.mjs` | Findings of a design run are not listed as to decide. |
| `knowledge/triage.md` | The finding record gains `source: persona \| instrument \| comprehension`. A record without it is read as `persona`. |
| `knowledge/personas.md` | The card field `vision`. |

## 9. Error handling

Section 7 of the base design, plus:

| Situation | Behaviour |
|---|---|
| The link is not a design, file or prototype link | Stop with one sentence that names what is supported. |
| `import-mcp` gets XML it cannot read | Stop. Say that the MCP source has never been run against the real server, and point to the report form. |
| An image URL is not `https` | Refuse it. The frame is skipped and listed. |
| An image cannot be downloaded | The frame is skipped and listed. |
| `nodes.json` is not the shape `figma-read.js` returns | It is ignored with a warning. The run continues at the level `frames`. |
| The snapshot has no frame with an image | Stop. |
| A viewer points outside the image | The answer is refused with `INVALID_ANSWER` and nothing is recorded. |

## 10. Status and how it is marked

Nothing here has run against Figma. The repository says so in each place a reader meets the mode:

- **README.** A section "Design mode (Figma): experimental" with one row per source and level. Every
  row says "Experimental: never run on a real Figma file".
- **Every design report.** Its first section says the same, with the source and the level reached.
- **The skill.** The first message of a design run says the mode is experimental.
- **CONTRIBUTING.** A section on how to report a design-mode run.
- **An issue form**, `.github/ISSUE_TEMPLATE/design-mode-report.yml`. It asks for the source, the
  level, the plugin version, what worked, what failed, and the error text. It asks the reporter not
  to attach confidential designs.
- **A row moves to "Tested"** as section 5.8 of the base design says: two real files with labels,
  and a comprehension precision of at least 70 % on the first hi-fi one. A source or a level that
  merely ran without error is described as "ran once", with the report that says so.

## 11. Testing

CI makes no model call and no network call beyond the local machine.

1. `image.mjs`: synthetic PNGs with known colours. Crop, scale down, the most frequent colour, and the outline of a box.
2. `instruments.mjs`: the measured contrast is within ±0.1 of the computed ratio. Word counts for
   Thai and English. `null` when the snapshot lacks text.
3. `scene.mjs`: a snapshot fixture becomes the expected scene. The hit test on nested boxes.
4. `figma.mjs parse-url`: each kind of link, and each refusal.
5. `figma.mjs fetch` against a fake HTTP server: a REST fixture becomes the expected snapshot. 403,
   404 and 429 with `Retry-After` behave as written. A second run makes no request, also after
   another file was fetched in between, and a damaged index gives a warning and a new fetch. `--frames`
   keeps those frames and requests only their images, and a page of more than 24 frames without it
   exits 4 with the list and no image request. The token is in no output.
6. `figma.mjs import-mcp`: an XML fixture with parent-relative coordinates and one with page
   coordinates give the same snapshot. A `nodes.json` fixture adds text and links.
7. `figma.mjs import-png`: a folder becomes a snapshot at the level `images`.
8. `figma-read.js`: the file holds no call or assignment from a deny list of document-changing
   names.
9. The static session through the real MCP server: the fold and scrolling, every refusal of
   section 6.3, link following across three frames, `back`, an unsupported action, and the log.
10. `design.mjs crop`: the size of the picture, the outline on the node, the margin cut at the frame, and every refusal.
11. `design.mjs judge`: a fixture run gives the expected `design-results.json`, including the
    "used" rule and the `screenshots` of each visit.
12. The ledger: a design run is recorded as `kind: design`, and its findings are in neither the
    verify list nor the decide list.
13. The docs tests cover the new headings, the new commands, the issue form and the viewer agent.

The fixtures are written from Figma's documentation. They are not recordings. A test that passes
says the code agrees with the fixture, not with Figma.

## 12. Non-goals

- Driving Figma's prototype player in a browser.
- Design mode on Codex.
- Instruments in app runs, and the constrained-input methods.
- Verify and decide for design findings.
- A model choosing the next frame.
- OCR for PNG folders.
- Overlays, component swaps, scroll actions and animation in a prototype.

## 13. SPEC.md changes

| # | Topic | Decision |
|---|---|---|
| D36 | Design mode | A second mode of the skill for a Figma link or a folder of PNGs, chosen from the input. Viewers have two tools, `view` and `answer`, and see one frame or one flow. Experimental, Claude Code only. |
| D37 | Design sources | Three sources (`rest`, `mcp`, `png`) write one snapshot. The token reaches no agent. The MCP server is a transport only, and its writing tool is opt-in with a fixed read-only script. |
| D38 | Measure, do not role-play | In design mode the harness measures with instruments and judges clicks in code. Every finding carries `source`. Agreement between viewers is never evidence. |
| D39 | Design runs in the ledger | A design run is `kind: design`. Its findings are labelled and shown on the board, and are left out of verify and decide. |

## 14. Open questions

Those of section 12 of the base design, plus:

- What `get_metadata` and `use_figma` really return.
- `design.source` is an instruction to the orchestrator in `knowledge/design.md`. No code reads it.
- Whether the temporary image URLs of the MCP server can be downloaded without a session.
- Whether a fold of 1568 px is the right limit for the viewer's model, and whether 1,150,000 pixels
  is the right area limit. Neither number has been checked against the model.
- Whether 480 px separates phone frames from tablet frames well enough.
