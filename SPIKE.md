# Spikes — results

Three spikes are recorded here: the M0 spike (this part, with its M1 follow-ups),
[Codex tool-level isolation](#codex-tool-level-isolation) and [Harness clock](#harness-clock).

M0 spike. Date: 2026-09-25. Target: the music app (a loop-based music web app, on its Vite dev server).
Spec: [SPEC.md §9 M0](SPEC.md). Verdict: **GO**, with six spec changes (see "Spec changes this spike implies").

Everything was measured on this machine (macOS, Node 26.3, Playwright 1.x with
Chromium 153 / headless shell, `@playwright/mcp` 0.0.82, Claude Code with Sonnet subagents).
The spike scripts are not published. They were throwaway code:

| File | What it is |
|---|---|
| `uxb.mjs` | Prototype browser adapter: one daemon + Chromium per persona session, HTTP-driven CLI, mechanical step cap, step log |
| `inject.js` | Init script: Web Audio tap + File System Access picker shim |
| `q5-save.mjs` | Save → new → open → reload round-trip in each picker mode |
| `repro-opfs.mjs` | Minimal repro of the Chromium crash (Q5) |
| `q7-grid.mjs` | Coordinate click / drag reliability on the piano-roll grid |
| `q1/` | `claude -p` run: two parallel subagents sharing one Playwright MCP server, plus a PreToolUse cap hook |

---

## Q1 — Isolated, parallel Playwright browsers per subagent?

**Answer: yes, but not through a shared Playwright MCP server. Use one browser process per persona.**

- **Shared Playwright MCP server: unsafe.** `claude -p` with `@playwright/mcp --headless --isolated`
  (stdio). The main agent launched two subagents in parallel, each told to open a different URL. Both
  subagents' `browser_tabs` listed **the same single page**. Subagent A's first `browser_navigate`
  failed with `net::ERR_ABORTED`: B's navigation cancelled A's navigation on the same page.
  Subagents share the parent's MCP connection, so they share one browser context.
  (`--isolated` only keeps the profile in memory. `--shared-browser-context` concerns separate
  *HTTP clients*, and subagents are not separate clients.)
- **One browser per persona: works.** `uxb start <session>` spawns a daemon that owns its own
  Chromium with its own on-disk profile. Three sessions ran in parallel and made different edits
  (BPM 121 / 122 / 123). Each kept its own state, including IndexedDB. Wall time was 7 s for all
  three.
- Other options, not needed: one Playwright MCP server per persona over HTTP (`--port`, one
  connection each) cannot be wired to a subagent from Claude Code, because subagents inherit the
  parent's MCP connections.

**Design consequence (D3):** the Playwright "adapter" is our own driver. It is the `uxb` daemon
shape, exposed to personas through a small plugin-bundled MCP server or CLI whose calls take a
`session` id. It is not `@playwright/mcp`.

## Q2 — Can the browser tool be wrapped to count steps and refuse beyond the cap?

**Answer: yes. Two mechanisms were verified and both work.**

1. **In the adapter (recommended).** The `uxb` daemon counts persona actions (`goto click dblclick drag
   type key scroll`). Observations (`shot`, `note`) are not counted. The first action past the cap
   returns `STEP_CAP_REACHED (N). Session over — write your exit interview now.` with exit code 3,
   and the refusal is logged in `log.jsonl` as `{"refused": true}`. The model cannot get around it.
2. **PreToolUse hook.** The hook payload includes **`agent_id` and `agent_type` per subagent**
   (`session_id` is shared). A hook that keys its counter on `agent_id` and exits 2 blocked each
   subagent at its 4th action (cap 3). Each subagent saw the refusal text and stopped.

Use (1) as the cap. It lives next to the session state and works without hook configuration. (2) is
a useful second guard, for example against personas using tools they should not.

Found along the way:
- Running `claude -p … --permission-mode bypassPermissions` from inside a Claude Code session was
  **blocked by the auto-mode classifier** ("Create Unsafe Agents"). A narrow `--allowedTools` list
  worked. The plugin should dispatch personas as normal subagents, not nested `claude -p`.
- The user's custom `general-purpose` agent has no MCP tools. Persona dispatch must use an agent
  type the plugin ships (`agents/persona.md`) with an explicit tool list.
- **Knowledge isolation is not enforced if personas have Bash + Read.** A persona could `cat` the
  app's source code. The persona agent must get only the browser tools, with screenshots returned
  as image content in the tool result instead of through `Read`. This favours the "small MCP
  server" option in Q1 over a Bash CLI.

## Q3 — Token cost per session with screenshot perception

**Answer: about $0.9–1.1 for a 12-action Sonnet 5 session with the current loop shape. About
$0.25–0.35 is achievable by cutting the number of requests per step.**

Setup: one persona, "Mai" (casual, low patience, sound off, came from a LINE link). It ran as a
Claude Code subagent (`claude-sonnet-5`) using `uxb` through Bash, reading screenshots with Read.
Viewport 1280×800, step cap 20, goal "make a short beat and keep it". It stopped after 11 actions
on a quit trigger ("nothing happened after Save, twice").

| Measure | Value |
|---|---|
| API requests | 48 (per step: shot + Read + action + note = 4 tool calls) |
| Context size | 51.2k tokens at the first request → 86.0k at the last |
| Cache read / cache write / output | 3,296,467 / 86,004 / 5,104 tokens |
| Cost at Sonnet 5 list prices¹ | ≈ **$0.93** (5-min cache writes) – $1.05 (1-hour cache writes) |
| Wall time | 5 min 18 s |
| Same session on Haiku 4.5 (Fast mode, D18) | ≈ half of that, estimated rather than measured |

¹ $2 per million input tokens, $10 per million output. Cache read and cache write assume the
standard 0.1× and 1.25×/2× multipliers.

**Where the tokens go:** a **fixed 51k-token overhead** on every request (Claude Code system
prompt, tool definitions, the user's global `CLAUDE.md`, the persona prompt). 48 × 51k ≈ 2.46M of
the 3.30M cache-read tokens. Screenshots and reasoning add only ~2.9k tokens per step. A 1280×800
screenshot is ≈ 1.4k tokens. **The cost is driven by the number of requests, not the images.**

Ways to lower it, in order of impact (for M1):
1. **One tool call per step.** An `act` tool that takes `{action, observation, reaction, event,
   frustration_delta}`, performs the action, logs it, and returns the next screenshot inline.
   That is 4 requests per step → 1. Estimate: 12–15 requests → ≈ $0.25–0.35 per session.
2. A persona agent definition with only that tool, so it carries less tool-schema overhead (this
   also enforces the isolation rule in Q2).
3. The session cost grows faster than linearly with steps (each request re-reads a growing
   context). Keep the step cap at ~20–30. At the current shape, 30 steps would be ≈ $2.5–3.

**Quality check on the one run.** The persona stayed inside the rules. It made 12 shot + 12 Read +
12 note + 11 action calls, with no probe/aria/file reads (checked from its transcript). The
harness numbers matched what it reported: the audio tap showed 258 s of non-silent output after it
pressed Play, and the save it attempted did reach disk. (Whether each grid click landed where it
intended was not checked independently; only the persona's own screenshots confirm it.) Its findings, sorted by the
triage categories:

- **Probably real (`ux`):** the dial labels on the landing sound-design screen
  (short sound-design terms) read as jargon to a non-musician. The persona found the
  step-grid tab far easier to approach, but only on its 3rd click. The chip with the loop's default name looks like a
  rename field, but typing into it does nothing.
- **Harness artefact (`env_error`), which triage must catch:** "Save gave zero feedback, twice".
  The OPFS shim *did* save (`picker-save` event, 29,836-byte file), but it skips the OS save
  dialog. That dialog is exactly the feedback a real Chrome user sees on a first Save. The shim
  must show a visible stand-in dialog (a simple in-page modal: "Save as: <project file> [Save]"),
  or the charter must tell triage that picker feedback is simulated. Without that, the most
  confident finding of the run was false. Silent re-saves after the first one may still be a real
  finding and need a separate check.

## Q4 — The music app: does Web Audio work under automation?

**Answer: yes, headless included.**

- Chromium was launched with `--autoplay-policy=user-gesture-required`, which was believed to be
  realistic. **Corrected in M1:** under that flag an `AudioContext` created at page load starts
  `running` with no gesture at all; Chrome's real desktop default is
  `document-user-activation-required` (see "M1 follow-ups" below). The music-app result still holds,
  because the app only creates its context after a click. It creates its `AudioContext` lazily. There is no context at page
  load, and after the first `page.mouse.click` the context is `running`. Playwright's synthetic
  input counts as a user gesture (`isTrusted: true`).
- Pressing **Play** gave a signal peak of **−10 dBFS** within 3 s (maximum 1.07 linear, so the
  master bus overshoots slightly). This happened in both the headless shell and headed Chromium,
  even though no audio device is involved.
- The harness should record `AudioContext.state` for every context. A context still `suspended`
  after the user acted is an autoplay/gesture bug and a finding in its own right.

## Q5 — The music app: how does it save, and is it automatable?

**The music app has three save paths:**

| Path | Mechanism | Automatable? |
|---|---|---|
| Autosave | IndexedDB, one slot (`body` + `source`, where `source` holds the file handle) | Yes |
| Save / Save as / Open a project file | File System Access API (`showSaveFilePicker` / `showOpenFilePicker`). Falls back to `<a download>` / `<input type=file>` when the API is missing | **Only with a shim** (below) |
| Save to and open from cloud storage | Google Drive (OAuth) | No. This is a real-world integration (D5/D6) and should be marked stop-before |

- **Native picker → false finding.** Under Playwright, `showSaveFilePicker` rejects immediately with
  `AbortError: Intercepted by Page.setInterceptFileChooserDialog()`. The music app treats that as "user
  cancelled", so **Save silently does nothing**. A persona would report "Save is broken" as a
  finding when the cause is the test environment (`env_error`).
- **Shim that keeps the app's real flow (chosen).** `inject.js` replaces only the OS dialog.
  `showSaveFilePicker` returns a *real* `FileSystemFileHandle` from the origin-private file system
  (OPFS). `showOpenFilePicker` returns the last saved one. The app's own write, permission and
  IndexedDB code runs unchanged.
  Result: BPM edited to 122 → Save → New project (120) → Open (**122**) → reload (**122**, from
  autosave). The file is readable by the harness (the project file, 29,838 bytes).
- **Plain-object shim → broken.** The first shim returned a JS object as the handle. The music app stores the
  handle in IndexedDB, the structured clone failed, and the app showed a storage-failure error. It
  looked like an app bug but was caused by the harness. Handles must be real.
- **Chromium crash, verified with a minimal repro (`repro-opfs.mjs`).** Reading a
  `FileSystemFileHandle` back from IndexedDB after a reload **kills the whole browser** in an
  incognito context (`browser.newContext()`). This happens in the headless shell, the new headless
  mode and headed mode alike. The same steps with `launchPersistentContext` (on-disk profile) work.
  **The adapter must use a persistent profile per persona.** That also gives isolation for free.
- **Fallback mode (`--fs none`) also works.** It removes the API. Save becomes a download, which
  Playwright captures. Open becomes an `<input type=file>` chooser that the harness could fill with
  `setFiles`. This tests a different UX (the Firefox/Safari path). It is useful as its own lens but
  is not the default.

## Q6 — The music app: can we detect audio output programmatically?

**Answer: yes, without any help from the app.**

`inject.js` runs before any page script and patches `AudioNode.prototype.connect`. Any connection to
an `AudioDestinationNode` is also sent to a harness-owned `AnalyserNode` for that context. Offline
contexts are skipped, and the patch never throws into the app. The analyser is polled every 50 ms
and records `maxPeak`, `nonSilentMs` (above −60 dBFS), `firstSoundAt`, `lastSoundAt` and the
context states. The harness reads these through `uxb … audio`. Personas never see them.

- On the music app: silence (−101 dBFS) before Play, −10 dBFS during playback, and a tail of −23.6 dBFS 1 s
  after Stop.
- This gives the checkable outcomes in SPEC §10 ("playback started", "time to first sound")
  without the persona hearing anything. It also allows a triage check such as "the persona said it
  was playing, but the output was silent".
- Limits: `<audio>`/`<video>` elements not routed through Web Audio are not captured (they would
  need `captureStream()`). The master volume counts, so a muted app correctly reads as silent.

## Q7 — Are drag/drop and coordinate clicks reliable on canvas/grid UIs?

**Answer: yes, mechanically.** Whether the model picks the right coordinates is measured in Q3.

- The music app's piano roll is **DOM, not canvas**. The cells are `button[aria-pressed]`, 28×28 px at
  1280×800.
- Coordinate clicks: **60/60** toggled exactly the intended cell. Tested with offsets from the cell
  centre of ±0, ±4, ±8 and ±12 px, 15 clicks each.
- Paint-drag across an empty row (10 intermediate `mouse.move`s): 1 → 5 cells filled.
- Dragging a note's right-edge resize handle 3 cells: the note grew from 1 to 4 cells.
- The adapter's `drag` must use intermediate moves. dnd-kit and similar libraries ignore a single
  jump.
- **Accessibility-tree finding:** 258 grid cells have only **33 distinct accessible names** (the
  pitch, e.g. "E5"; no step number). A screen-reader persona cannot tell steps apart, and the
  accessibility snapshot cannot be used to target cells. This is the first real finding about the
  music app from the spike.

---

## Spec changes this spike implies

1. **D3/D1 adapter:** not `@playwright/mcp`. Build a plugin-owned driver (the `uxb` shape): one
   Chromium per persona via `launchPersistentContext`, a step cap in the driver, and an init script
   for instrumentation. Expose it to personas as a small MCP server whose tools take a `session` id
   and return screenshots inline. Personas get **no Bash and no Read** (Q2 isolation).
2. **D5 safety / environment:** add an "environment shims" section to the charter. For the music app:
   `fs: shim` (OPFS-backed pickers) and Drive marked **stop-before**. Findings that come from a
   picker or harness artefact go to `env_error`, not `ux`.
3. **§10 facts about the music app to correct:**
   - The music app *does* have `CLAUDE.md` and `docs/` (including `design.md`), so recon has an intent
     source after all.
   - The main grid is DOM with poor accessible names, not canvas.
   - A Google Drive integration exists.
   - Routing by a query-string tab exists. In the MCP test, the URL of one tab landed on another, but that
     run had two agents driving one page, so the redirect is unconfirmed.
4. **Picker shim must be visible:** the shim shows an in-page stand-in for the OS dialog, so a
   persona sees the same "something happened" cue a real user does (Q3).
5. **Cost model (D12):** estimate cost per *request*, not per step. Budget ≈ $0.02–0.03 per
   request on Sonnet 5 with a ~50–90k context. Make the M1 run loop one tool call per step.
6. **§6 run loop:** the harness, not the persona, performs the initial `goto`. Harness setup
   actions must not count toward the persona's step cap. (In the spike, the harness `goto` used one
   of the 20 steps.)

---

## M1 follow-ups (2026-09-25)

Found while building the M1 driver (`driver/`). Each point is pinned by a test in `driver/test/`.

1. **Autoplay flag.** `--autoplay-policy=user-gesture-required` lets an `AudioContext` created on
   load run without any gesture. With `document-user-activation-required` (and with no flag at
   all) it stays `suspended` until the user interacts. The driver's `autoplay: gesture` mode now
   uses `document-user-activation-required`.
2. **Harness reads must not grant user activation.** Playwright's `page.evaluate` runs with
   `userGesture: true`, so the spike's per-command `probe` and `audio` reads could unlock autoplay
   that the persona never unlocked. Every harness read (audio stats, OPFS listing, `harness_eval`)
   now goes through CDP `Runtime.evaluate` with `userGesture: false`.
3. **`Input.dispatchMouseEvent: Invalid parameters` (SPEC §11).** It reproduces only with
   non-finite coordinates (NaN or Infinity, for example from `+"640,"` or a missing `y`), and such a
   call never reaches the page. None of these reproduce it: popups, `alert`/`confirm` on mousedown,
   navigation on mousedown, a tab closing itself, a renderer crash, a blocked main thread, or
   concurrent clicks. The spike's "it reached the app" was most likely an earlier action's effect.
   The driver now rejects non-integer or off-screen coordinates as `INVALID_ACTION` before any CDP
   call, without counting a step. Real action failures are logged as `action-error` signals, so
   triage can separate them from `no_response`.
4. **Crashed renderer.** CDP `Runtime.evaluate` on a crashed page never answers. That hung the
   session queue, and `stop()` hung with it. The driver now tracks a `crashed` flag and puts a 5 s
   timeout on harness evals. Persona `reload` on a crashed tab reopens it, like pressing Reload on
   Chrome's "Aw, Snap!" page.
5. **`window.close()`** only closes script-opened tabs. The driver moves the session to the
   remaining tab and tells the persona.
6. **Nested `claude -p --plugin-dir <repo>`** with a narrow `--allowedTools` list runs the plugin
   end to end: MCP tools named `mcp__plugin_ux-assessment_browser__*`, and a persona agent
   restricted to `act` and `end_session`. Smoke test on a counter page: the persona read the
   screenshots correctly and reached its goal in 3 steps, using 16.7k persona tokens ($0.61 for
   the whole nested run).

7. **Native `<select>` popups are invisible.** Chromium draws a select's popup as an OS widget
   outside the page, so screenshots never show it and coordinate clicks cannot reach it. In the
   first music-app dogfood run, two personas clicked the loop selector, saw nothing, and logged
   `not_found` / `no_response`, both false findings. `inject.js` now replaces the popup with an
   in-page list (it fires `input` and `change`; verified on the music app's React selects).
8. **Stand-ins must live in the top layer.** The music app shows a modal `<dialog>` (a saving overlay) while the
   save picker is open. The top layer paints above any z-index and makes the rest of the page
   inert, so the "Save As" stand-in was hidden. The phone persona waited 5 steps on that overlay and
   gave up: a false "save hangs" finding. Both stand-ins are now their own modal `<dialog>`,
   opened last, as OS UI would be. They also consume the Enter that confirms them; otherwise its
   keypress activated the app's Save button again once focus returned to it.
9. **`visual_change` is too coarse.** A PNG byte comparison is `true` on every step for an app
   with constant animation (the music app's meters and playhead), so it cannot separate "nothing
   responded" from "only the animation moved". Follow-up (M2): diff the changed area, or mask
   regions that animate on their own.

---

## Codex tool-level isolation

Spike of 2026-09-28. It replaces the private notes it was first written in and is the evidence for
SPEC D25.

**Question:** can a Codex persona be isolated by disabling Codex's own tools, so that the same
isolation works on Windows, which has no `sandbox-exec`?

**Setup:** macOS, `codex-cli 0.155.0-alpha.9.2` (from the ChatGPT app bundle), plain `codex exec`
with no `sandbox-exec`, and these flags:

```
--ignore-user-config --ephemeral --skip-git-repo-check --sandbox read-only
--disable shell_tool --disable unified_exec --disable view_image --disable image_generation
--disable browser_use --disable browser_use_external --disable computer_use --disable in_app_browser
--disable apps --disable plugins --disable tool_suggest --disable shell_snapshot
--disable multi_agent --disable goals
```

**Canaries:** a `canary.txt` in the working directory, a file at an absolute path outside the
working directory, and an HTTP server on `127.0.0.1:47811`. The model was told to try every tool it
had to read them.

| Run | Change | Result |
|---|---|---|
| 1 | also `--disable code_mode_host` | No canary read. But MCP tools are reachable only through code mode (`functions.exec`), so this breaks personas |
| 3 | code mode on, the driver's `mcp.mjs` attached | `mcp__ux__*` tools listed and callable; no canary read. Code-mode JS has no `process`, `require` or `Deno` |
| 4 | asked to `spawn_agent` a helper to read the files | The helper inherits the disabled tools; no canary read. `apply_patch` was rejected (read-only) |
| 5 | network | `fetch`, `XMLHttpRequest` and `WebSocket` are undefined; `import("node:http")` is unsupported; `web__run` cannot reach localhost; no canary read |

The notes record no run 2.

**Conclusion:** tool-level isolation works on macOS for this Codex version: no file read, no local
network, and the MCP tools still work. It is implemented inside Codex, so it should hold on
Windows, but that is **not verified**.

**Residual risks**
- Feature names are unstable (an alpha build; many flags are already `removed`). A new feature that
  brings a tool would be on by default. Mitigation: the runner checks `codex features list` and
  fails closed on unknown `stable true` features, or uses an allowlist.
- With `multi_agent` disabled, `collaboration.*` tools are still listed; helpers inherit the
  restrictions (run 4).
- Not tested on Windows: the Windows read-only sandbox, `codex.exe` discovery, the `apply_patch`
  policy.

**What it implied next:** Windows CI (`windows-latest`) for the driver tests without a model. A
real-model canary run on Windows needs an OpenAI API key secret or a Windows contributor.

## Harness clock

Spike of 2026-09-28 on Playwright's `page.clock`. It replaces the private notes it was first
written in and is the evidence for SPEC D22.

**Question:** can the harness own page time, so that a persona waits for a long in-app timer in one
step and deadlines run at human speed rather than LLM speed?

**Answer: yes, for timers on the page's main thread.** Tested on Playwright 1.63 (Chromium), on a
synthetic page and on the timer app's countdown page: a countdown with a recurring reminder (active
for the first 30 s, then for 5 s every 60 s). The spike scripts were not kept.

### What `page.clock` controls

Measured on the synthetic page after `clock.install()`:

| Clock | Faked | What happens |
|---|---|---|
| `Date`, `performance.now`, `setTimeout`/`setInterval`, `requestAnimationFrame` | yes | They stop when the clock is paused and advance only when the harness moves time forward |
| Web Worker timers | **no** | They keep running in real time |
| `AudioContext.currentTime` | **no** | It keeps running in real time |
| CSS animations (`document.getAnimations()`) | **no** | They keep running in real time |

### How to advance time

| Method | The timer app's countdown after 45 s | Wall time |
|---|---|---|
| `fastForward(45s)` | **12:58**, wrong | 3 ms |
| `runFor(45s)` | 12:14, correct | 200 ms |
| `runFor(1s)` × 45 | 12:14, correct | 60 ms |

- **`fastForward`** fires each due timer only once, like waking a laptop from sleep. This breaks
  countdowns that subtract 1 on every tick, which is how the timer app's countdown works. `pauseAt`
  behaves the same way. Never use either of them to skip time.
- **`runFor`** fires every tick.
  - It is fast when the page is idle.
  - It is slow when the page runs a `requestAnimationFrame` loop: 60 s took **17.6 s** of wall time
    on the synthetic page. An app with a playhead or a canvas loop makes long waits expensive.

### A wait that stops when the screen changes

The harness advanced the clock with `runFor(1000)` up to 120 times. After each second it compared
the text of `main` with its digits masked, which ignores ticking counters. It also watched a
`navigator.vibrate` stub.

| Stop | Why |
|---|---|
| +36 s | The initial active period ended; the banner went back to its idle label |
| **+91 s** | **The reminder text appeared and `vibrate` was called once**: this is the first reminder |
| +96 s | The reminder ended |

Waiting 120 s of page time took **0.4 s** of wall time.

### Paused clock between actions

These were tested while the page clock was paused: a locator click, `waitFor`, a mouse click at
coordinates, navigation, and a screenshot. All of them worked, each in under 100 ms. Playwright's
actionability checks did not hang, even though `requestAnimationFrame` was paused.

### What it implies for the design

1. **The harness owns time only for timers on the main thread.**
   - Recon must find timers in a Worker, in `AudioContext` or on a server.
   - Those timers keep running in real time and drift away from the page clock.
   - Example: the music app's audio would keep playing while its playhead stands still.
   - If this happens, triage treats it as `env_error`, or the charter keeps the clock real.
2. **Every action must advance the clock by a human amount of time.**
   - Otherwise debounces, toasts and short `setTimeout` delays never fire, and the app looks frozen.
   - The unit comes from the driver: for example, a click is about 1–2 s and typing is about 0.2 s
     per character.
3. **`wait` uses `runFor` in 1 s chunks and stops on a change.**
   - A change means one of these: the text with digits masked; a `vibrate` call; a `Notification`;
     an audio start, where the driver already has audio signals.
   - Pixel comparison is left out: CSS animations run in real time and would make it unreliable.
   - `fastForward` and `pauseAt` are never used to skip time, only `runFor`.
4. **Cost limit:** set a cap on wall time for each `wait`. When the cap is reached, report the page
   time that actually passed.
5. **Not covered by this spike** (these go under "Not tested"): the screen locking, the app going to the background, wake lock,
   and timers that cross days.
