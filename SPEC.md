# ux-assessment — Plugin Spec (v1)

Status: design agreed via grilling session, 2026-09-25. M0 spike done 2026-09-25 (GO) — see
[SPIKE.md](SPIKE.md); its spec changes are folded in below. M1 walking skeleton done and dogfooded
on the music app 2026-09-25. M2 done 2026-09-25 and dogfooded
unattended on two apps. A local Codex adapter
completed Guided intake and an authenticated dogfood on the maker app on 2026-09-27.
Owner: Pathompong Thitithan. Target runtimes: Claude Code plugin and a local macOS Codex skill.

---

## 1. Purpose

Solo developers and power users can now build whole apps with AI, but often lack UX/UI/product
knowledge. `ux-assessment` lets them run **simulated users (personas, played by subagents)** against
their app **before real people try it**, to catch the problems builders typically overlook and cut
the "ship → feedback → fix → re-ship" loop.

### Audience
- Primary: developers with **no UX background**. Every step must be usable without UX vocabulary.
- Secondary: people with UX knowledge (Expert mode — edit files directly).

### What it can and cannot find (must be stated to the user during intake)
- CAN: usability friction, unclear purpose/copy, broken or confusing flows, poor error handling,
  missing states (empty/loading/error), mobile/slow-network issues, first-session value clarity.
- CANNOT: whether the problem is worth solving, willingness to pay, true long-term retention,
  aesthetic taste, anything requiring hearing (audio), anything behind steps that were not allowed.

### Non-goals (v1)
- Native mobile / desktop apps (web only, including mobile viewport emulation).
- Remote Codex persona runs.
- Multi-user real-time collaboration tests (two personas in the same session).
- Formal benchmark suite (see D16).

---

## 2. Decisions (from grilling)

| # | Topic | Decision |
|---|---|---|
| D1 | Surfaces | **Web only** (+ responsive/mobile viewport). Browser control behind an adapter so other surfaces can be added later. |
| D2 | Harness | **Claude Code plus local macOS Codex.** Keep knowledge (domain packs, dimensions, persona schema) as plain markdown/YAML separate from platform orchestration. The original Claude implementation remains; the Codex adapter uses an isolated CLI persona runner. See the 2026-09-27 design addendum. Amended by D24. |
| D3 | Browser + execution | **Plugin-owned Playwright driver** is the default adapter (not `@playwright/mcp`: parallel subagents share its one page — SPIKE Q1). One Chromium per persona via `launchPersistentContext` (on-disk profile; incognito contexts crash when a file handle is read back from IndexedDB — SPIKE Q5), an init script for harness instrumentation (audio tap, picker shim), step cap in the driver. Harness reads of the page never grant user activation (CDP `userGesture: false`), so they cannot unlock autoplay the persona did not. Exposed to personas as a small plugin-bundled MCP server whose tools take a `session` id and return screenshots inline. **Claude in Chrome** optional adapter (always sequential; acts as the user's real account — warn). Planner recommends parallel vs sequential and perception mode, **and Guided mode asks the user directly**, phrased by consequence, with the recommendation attached. Perception is **per persona** (screen-reader persona always uses the accessibility tree). Run modes: **Full** (per-persona perception) and **Fast** (snapshot-only; report must state visual issues were not checked). `max_parallel` in config. |
| D4 | Getting a running app | Ask for URL first; if none, planner finds the dev script (e.g. `npm run dev`) and **offers** to start it. |
| D5 | Side effects / safety | Recon detects real-world integrations (payments, email/SMS, webhooks, external APIs, prod-looking connection strings). Charter gets **safety rules** with 3 tiers: **allowed** / **stop-before** (persona reaches the final step, records experience, stops) / **forbidden**. Non-localhost, non-staging-looking URLs need explicit confirmation. Persona-created data is tagged (e.g. `ux-sim+<persona>@example.com`). Charter also lists **environment shims** — harness replacements for things automation cannot drive (e.g. OS file pickers → OPFS-backed handles that keep the app's own save code path). A shim must show the persona a **visible stand-in** for the UI it replaces (e.g. an in-page "Save as" dialog), otherwise its silence becomes a false finding (SPIKE Q3). Findings caused by a shim or harness artefact are `env_error`, never `ux`. |
| D6 | Auth | Recon detects auth. Each persona gets a **start state**: *newcomer* (no account, signs up — tests onboarding) or *returning* (test account with data). Test credentials in a local gitignored file. Flag OAuth / OTP / 2FA early as not automatable (needs test mode or manual login + saved session). Persona only knows "you have an account, password is X", not what data it contains. |
| D7 | Source conflicts | "What the app does / how it behaves": **running app > code > docs**. "Who it's for / intent": **docs/instructions > code**. Conflicts are never silently resolved — they are logged in app-profile and become quiz confirmation questions (and possibly findings, e.g. documented feature that personas cannot find). |
| D8 | Recon depth | Targeted, ordered, budgeted, run in an explore subagent; main context receives only the summarized app-profile. Order: (1) instructions & docs (`CLAUDE.md`, `AGENTS.md`, `README`, `docs/`, specs) → (2) manifest/dependencies (integrations) → (3) route/page map → (4) user-facing strings (i18n, copy) → (5) forms, validation, auth, integration config → (6) crawl the running app's main routes with screenshots. Skip internal business logic, tests, build config. Depth: quick / standard / deep. Route detection supports popular JS frameworks (Next.js, React Router, SvelteKit, Nuxt); otherwise fall back to link crawling. |
| D9 | Intake (quiz) shape | Rounds by topic; each round is one card with 1–4 independent questions; later rounds adapt to earlier answers; skip what recon already inferred. Every question: recommended option, free-text "Other" (built in to AskUserQuestion), and "Not sure" (→ default, labelled as assumption). One line per question explaining *why it is asked*. Modes: **Quick / Guided (default) / Expert**. See §4. |
| D10 | Domain packs | Hybrid: small set of **curated packs** + planner generates an **ad-hoc pack** when none fits, saved in `.ux-assessment/packs/` and labelled *auto-generated, unreviewed*. User can promote an ad-hoc pack to permanent. |
| D11 | Personas | Default **5–7**, chosen by coverage rules (§5), **core user always included**. Selection UI: "Use recommended set / Customise / Quick (3)". Customise = two multi-select questions (≤4 options each, tool limit; recommended ones labelled "(recommended)" since pre-ticking is not supported). Free text can describe extra personas; planner converts to cards. Each persona labelled with grounding source; contrast check merges near-duplicates; user approves. |
| D12 | Scenarios | Planner derives **2–4 goal scenarios** (from first-5-minutes goal, concerns, core loop) + **1 free-exploration scenario** ("you got this link from X, have a look"). Written in the **user's language**, never button/route names. Selective persona × scenario pairing (not a full matrix). Plan shows the matrix, session count and a **cost range**; user approves or trims. Estimate cost **per request**, not per image: a fixed ~50k-token context overhead dominates (SPIKE Q3 — one 11-action Sonnet session ≈ $0.93–1.05 at 4 requests/step). Actual cost is recorded to improve later estimates. M1 music-app run: persona sessions ≈ $0.28 each (Sonnet, one call per step), while recon + triage + orchestration on the strongest model cost ≈ $4.4 of $5.3: quote the fixed overhead separately. M2 unattended runs with a Sonnet main session, 3 parallel personas and Opus triage: $2.3–3.3 per run (Opus triage ≈ $1.0–1.8 of it). Amended by D31 (tokens, not dollars); the dollar figures here are history. |
| D13 | Run loop | Structured step loop (§6). Frustration increases on **defined events**. Quit on budget / quit trigger / success / step cap. **Step cap enforced mechanically** by the persona browser driver (refuses with `STEP_CAP_REACHED`), not by prompt; a PreToolUse hook keyed on `agent_id` is an optional second guard. Harness setup actions (initial navigation, start state) do not count toward the cap. Session ends with an **exit interview**. |
| D14 | Triage & report | Separate triage agent (not a persona). Dedupe; confidence **Signal / Watch / Noise**; severity = impact × number of persona groups affected; **re-verify top findings** with a fresh subagent; map findings to likely components/files (with confidence); separate **"agent error"** category. Report contents in §7. |
| D15 | Feedback & reruns | User labels findings **valid / not real (reason) / known, won't fix**. "Not real" → planner adjusts personas/charter/pack notes and logs why; a note saying the behavior is on purpose is offered as a charter **Intended behaviors** line, which triage then lists as *working as intended* unless it costs a persona the goal. "Won't fix" suppressed next time. Rerun compares with previous run: **fixed / still present / new**; **verify-only** mode reruns only sessions that found issues. "Fixed" requires ≥2 clean reruns; report distinguishes *not seen this run* from *confirmed fixed*. **M3 verify-only:** one short verifier session per open finding (not persona reruns), verdicts reproduced / not_reproduced / unreachable / changed; `.ux-assessment/ledger.yaml` holds cross-run identity and status (open / still_present / not_seen / fixed / needs_review / regressed). |
| D16 | Evaluating the plugin | **Dogfood on real apps only** (no benchmark apps in v1). Mitigations: track the "not real" rate across runs as a precision signal; optional Expert step where the dev writes down known issues *before* a run (not shown to the planner) and compares after, as a rough recall signal. |
| D17 | Language | Quiz & report in the plugin user's language. Personas read the UI in the app's language, with **native language and UI-language proficiency as persona traits**. Internal logs in English (verbatim on-screen text kept as-is). v1 tuned for **Thai and English** (Thai names/addresses/ID formats, B.E./C.E. dates, arriving via LINE links). |
| D18 | Models | Planner / recon / triage: strongest available. Personas: **Sonnet** default, **Haiku** in Fast mode. Re-verification: Sonnet. Configurable. Never use a weaker model as a shortcut for low-skill personas — low skill must come from traits. Amended by D30. |
| D19 | Storage | `.ux-assessment/` at project root. **Commit**: app-profile, charter, personas, plans, project packs, run summaries. **Gitignore**: screenshots, raw step logs, credentials. Offer (ask, don't auto-edit) to add `.gitignore` entries. Keep last N runs of screenshots/logs. |
| D20 | Commands | One main entry `/ux-assessment` that detects state (no folder → full flow; folder exists → menu: new run / rerun to verify fixes / label findings / edit personas / resume). Sub-commands for experts: `recon`, `intake`, `personas`, `plan`, `run`, `triage`, `feedback`. All state in files → resumable across sessions. |
| D21 | Build order | M0 spike → M1 walking skeleton → M2 → M3 (§9). |
| D22 | Time | Charter harness option `clock: real \| controlled` (default `real`). Under `controlled` the harness owns page time (Playwright `context.clock`): paused while the persona thinks, paced with real time while the harness works, +2 s human time per step, and `wait` up to 600 s that stops early when the screen changes. One rule for all apps; recon keeps `real` when the timers that matter run in a Worker, `AudioContext`/media or on the server. Drift from those clocks is `env_error`. Design: [docs/superpowers/specs/2026-09-28-harness-clock-design.md](docs/superpowers/specs/2026-09-28-harness-clock-design.md). |
| D23 | Ending a session | A persona's first `end_session` with `goal_achieved` is answered `GOAL_CHECK` (re-read your goal, quoted verbatim from the briefing's "What you want" when `harness_start` got `goal`; call again if every part is done) and logged as a `goal-check` signal; the next call records any outcome. Persona and verifier Agent calls run in the foreground (`run_in_background: false`; run 4 found Claude Code backgrounding them, so a follow-up reached a persona still acting). A persona or verifier whose Agent call has returned without `end_session` gets one follow-up from the orchestrator ("call end_session now"), no app or goal hint; still missing → `outcome: null`. Triage judges success by the charter's criteria, never by the claim. Evidence: timer-app runs 2026-09-28 (3/12 sessions without `end_session`, 3/6 early `goal_achieved`). |
| D24 | Harnesses and OS | **Claude Code and Codex only**, on **macOS and Windows**; Linux is supported where it costs nothing extra (CI, the same Node code). The support matrix is published in the README and states what is tested. Amends D2. |
| D25 | Codex isolation | **Tool-level isolation on every OS**: the runner disables Codex's built-in tool features, keeps `code_mode_host` on (MCP tools are reachable only through code mode), and **fails closed** when an enabled feature is not classified (`driver/codex-features.mjs`). On macOS `sandbox-exec` stays as a second layer. Windows and Linux use tool-level isolation only and are **experimental**. |
| D26 | Canary self-check | `node driver/codex-runner.mjs self-check` reproduces the spike: canaries in the runner cwd, outside it and on a local HTTP port; it passes only if none leaks and the MCP tools are callable. On Windows and Linux the runner requires a passing self-check for the current Codex version before it runs a persona. `--offline` runs the feature gate only, with no model call. |
| D27 | Installer | `scripts/install.mjs` replaces `scripts/install-macos.sh` on all three OSes. It installs for whichever harness is present and errors only if neither is. On Windows the Codex skill link is a **directory junction**, never a copy. |
| D28 | Portability | Shell commands in skills and agents become `node driver/probe.mjs …`. Path containment uses one `isInside` helper. Owner-only file modes stay as they are; on Windows they are no-ops. This is documented, with a warning when the project is outside the user profile. No `icacls`. |
| D29 | CI | GitHub Actions on macOS, Windows and Ubuntu runs the driver tests, the installer tests and the offline feature gate, with no model calls (macOS first runs on the public repository). The canary self-check with a model is a manual workflow that uses an `OPENAI_API_KEY` secret (phase 3). |
| D30 | Models per role | Claude: D18 stands (persona and verifier `sonnet`; recon `opus`, and `sonnet` at quick depth; triage `opus`). Codex: a role → model + reasoning-effort map (`driver/models.mjs`), overridable in `.ux-assessment/config.yaml`. The defaults are what was dogfooded. Cheaper persona models are opt-in until a side-by-side run on a labelled app. Triage keeps the strongest model. Amends D18. |
| D31 | Tokens, not dollars | Estimates and reports are in tokens **per model and per role**, split into input, cached input and output. A dollar "API-equivalent" line is secondary. The docs promise no share of subscription limits. Amends D12. |
| D32 | License and distribution | MIT, copyright "Pathompong Thitithan". `"license": "MIT"` in both manifests. A Claude marketplace file at `.claude-plugin/marketplace.json`. CONTRIBUTING.md and SECURITY.md. |
| D33 | Private material | The public repository starts from **one fresh commit** made from a cleaned export, under a GitHub noreply email. `work/`, `spike/` and `docs/superpowers/plans/` are not published. The private app names become neutral labels. The private repository keeps the full history. |

---

## 3. Core principle: knowledge isolation

Two knowledge tiers, never mixed:

- **Planner knowledge**: code, docs, instructions, quiz answers, app-profile, charter.
- **Persona knowledge**: only what a real user of that type would know — persona card, entry context
  (where they came from, what they heard about the app), their goal in user language, credentials if
  they are a returning user. **No code, routes, selectors, component names, or app-profile.**

Consequences:
- Scenario text must be written in user language ("make a short beat and save it"), not UI language.
- Personas perceive only the rendered page (screenshot, or accessibility tree for AT personas).
- Isolation is enforced by **tools, not prompts**: the persona agent (plugin-shipped `agents/persona.md`)
  gets only the persona browser tools — no Bash, Read, Grep or web tools — because with Bash + Read a
  persona can read the app's source (SPIKE Q2). Harness-only tools (audio levels, save events, DOM
  probes) are never exposed to personas.
- The accessibility snapshot may be used by the *tool layer* to target clicks, but persona reasoning
  is based on what it perceives in its own mode.

---

## 4. Pipeline & intake

```
recon ─► intake ─► personas ─► plan ─► run ─► triage ─► report ─► feedback ─┐
  ▲                  [gate]     [gate]                                       │
  └──────────────────────────────── rerun / verify-only ◄──────────────────┘
```

### Intake rounds (Guided mode)

| Round | Content | Decides |
|---|---|---|
| 1. Confirm understanding | "I understand this app is … for … — correct?" + conflicts from recon | app-profile is right |
| 2. Why test now | pre-launch / after feature change / people complain or drop off | primary lenses |
| 3. Users & goals | who you want to use it (describe one real person), **are you the target user yourself?**, one-off vs habitual, what should they achieve in the first 5 minutes | persona range, success criteria |
| 4. Worries | anything you're unsure about or where someone got confused | must-have scenarios |
| 5. You might be missing | planner-proposed checklist from domain pack + recon (multi-select, recommended labelled) | extra lenses |
| 6. Execution | parallel vs sequential, perception mode, depth, test accounts, confirm safety rules | config |

~10–15 questions across ~6 cards. **Quick**: round 1 + short round 3 + short round 6. **Expert**: skip quiz, draft `charter.md` for direct editing.

Ask about what the dev knows, translate to UX concepts internally. Examples:
- not "Who is the target persona?" → "Picture one person you want using this. What do they do, when would they open the app?"
- not "Do you measure retention?" → "Should people use this once, or come back every day?"

### App dimensions (planner infers; drive question bank + lenses)
- Relationship: one-off / habitual / creative tool
- Stakes: low / money / health / personal data
- Core loop: form filling / creating / consuming / collaborating
- User expertise: beginner / domain professional
- Access: signup required / usable immediately

---

## 5. Personas

### Coverage rules (default set)
1. **Core user** — matches the dev's description (always included)
2. **"Not you"** — maximally different from the dev, especially if the dev is the target user
3. **Casual / low motivation** — low patience budget (measures pull to keep going)
4. **Low tech literacy**
5. **Constrained** — small screen / slow network / accessibility (chosen by app risk)
6. **Expert / power user** — when the app has repeated use

Quick mode: core + casual + constrained.

### Customise UI (two multi-select questions)
- "Who will use it?": Not you · Casual user · Low tech literacy · Expert
- "Under what conditions?": Small phone screen · Slow network · Screen reader · Low vision
- Descriptions for "Not you" and "Casual" must state the consequence of leaving them out.

### Persona card schema
```yaml
id: casual-curious
label: "Curious visitor, low commitment"
grounding: assumption          # data | quiz | assumption
goal: "Saw a friend's post, wants to see what this is"
motivation: casual             # intrinsic | curious | forced | casual
domain_knowledge: none         # none | some | expert
tech_literacy: medium          # low | medium | high
native_language: th
ui_language_proficiency: {en: low, th: native}
patience_budget: 6             # frustration points before quitting
reading_style: skim            # read-all | skim | icons-only
perception: screenshot         # screenshot | a11y-tree
device: {viewport: mobile-small, network: normal}
context: "On the bus, sound off, interrupted often"
mental_model: "Has used simple phone music apps"
entry_point: "Tapped a link in a LINE group, no explanation"
start_state: newcomer          # newcomer | returning
quit_triggers: ["asked to sign up before seeing anything", "nothing happens after tapping"]
```

---

## 6. Run loop (per persona session)

Before the first step the **harness** opens the entry URL and sets up the start state; the persona
begins on the rendered page. These setup actions do not count toward the step cap.

Each step is **one tool call** (`act`): the persona sends its log fields plus one action, and the
tool performs it, logs it, and returns the next observation inline. (The spike's 4 calls per step —
look, read image, act, log — made 4× the requests, and requests drive cost; SPIKE Q3.)

Each step:
1. **Observe** (screenshot or a11y tree per persona)
2. **Think aloud** in character
3. **Act** — exactly one action
4. **Log** to file: `observation` (FACT), `reaction` (REACTION), `action`, `frustration_delta`, `event`

Frustration events (defined, not vibes): no visible response after action · error shown · had to go
back · could not find target after N looks · asked for the same info twice · unexplained jargon.

Stop when: frustration ≥ patience budget · quit trigger · goal achieved · **step cap (tool-enforced)**
· stop-before action reached.

Harness signals logged alongside the persona's claims, for triage to cross-check: audio output
(peak/non-silent time per `AudioContext`, context state), save/download/picker events, page errors.

Exit interview: explain in own words what the app is for · would you come back, with a concrete
reason · what confused you most.

Step log entry:
```json
{"step": 7, "observation": "Grid of squares, no labels, a play icon top-left",
 "reaction": "No idea what the squares do", "action": {"type": "click", "target": "top-left square"},
 "event": "no_response", "frustration_delta": 1, "screenshot": "s07.png"}
```

---

## 7. Triage & report

Finding record:
```yaml
id: F-03
title: "No visual sign that sound is playing"
kind: ux            # ux | agent_error | env_error (shim / harness artefact)
confidence: signal  # signal | watch | noise
severity: high      # impact (blocks / slows / cosmetic) × persona groups affected
personas: [casual-curious, low-literacy]
evidence: [runs/2026-09-25/casual-curious/s07.png]
why_it_matters: "Users with sound off or no headphones cannot tell whether their loop works."
suggested_fix: "Animate the playhead and highlight active cells while playing."
code_pointer: {path: "src/components/Transport.tsx", confidence: medium}
check:                  # new ux findings: how a verifier gets back to the spot
  device: mobile-small  # desktop | mobile-small (the persona's device)
  start_state: newcomer # newcomer | returning
  account: null         # returning only: the card's account id
  where: "Beat tab of a new loop, on a phone"               # user terms, no code or component names
  condition: "Fewer than 16 beat columns are visible and nothing shows that more exist"   # observable
verified: true      # re-run by a fresh subagent reproduced it
```

`report.md` sections:
1. **Top 5–7** prioritized findings (what happened, why it matters in one line, evidence, fix, code pointer)
2. Per-persona journey summary (how far, where they quit, exit interview)
3. **Not tested** (stop-before actions, visual issues in Fast mode, OAuth, audio, etc.)
4. Appendix: all findings
5. `fix-tasks.md` — each finding as a task ready to hand to a coding agent
6. `real-user-kit.md` — tasks, questions and things to watch when testing with real people

---

## 8. File layout

```
.ux-assessment/
├── config.yaml            # adapter, max_parallel, models, retention, mode defaults
├── app-profile.md         # planner-only
├── charter.md             # goals, lenses, success criteria, safety rules, environment shims, "you might be missing"
├── personas.md            # persona cards
├── packs/                 # project-specific / auto-generated domain packs
├── plans/<date>.md        # persona × scenario matrix + cost estimate
├── runs/<date>/
│   ├── report.md  fix-tasks.md  real-user-kit.md   # committed
│   ├── <persona>/log.jsonl                          # gitignored
│   └── <persona>/screenshots/                       # gitignored
├── runs/<date>-verify[-N]/  # verify-only: verify.yaml, verify-report.md (committed), <finding id>/ sessions (gitignored like persona sessions)
├── ledger.yaml            # cross-run finding identity, history and status (written by driver/ledger.mjs; committed)
├── feedback.md            # finding labels + resulting changes
├── usage.jsonl            # token records per agent or process (driver/usage.mjs; gitignored)
├── active-run             # the run folder the token hook assigns records to (gitignored)
└── secrets.local.yaml     # test credentials, gitignored
```

---

## 9. Milestones

### M0 — Spike (go / no-go) — DONE 2026-09-25, **GO** ([SPIKE.md](SPIKE.md))
- [x] Isolated parallel browsers per subagent — yes, one Chromium per persona; a shared Playwright MCP server is unsafe.
- [x] Step counting + refusal beyond the cap — yes, in the driver (and optionally a hook on `agent_id`).
- [x] Token cost per screenshot session — ≈ $0.93–1.05 (Sonnet 5, 11 actions, 48 requests); target ≈ $0.25–0.35 with one call per step.
- [x] The music app's Web Audio under automation — works, headless included. (M1 correction: the realistic policy is `--autoplay-policy=document-user-activation-required`, Chrome's default; the spike's `user-gesture-required` lets audio start without a gesture — SPIKE "M1 follow-ups".)
- [x] The music app's save — IndexedDB autosave + File System Access pickers + Google Drive; pickers automatable only via the OPFS shim.
- [x] Detect audio output — yes, generic `AudioNode.connect` tap into an analyser, no app cooperation.
- [x] Coordinate clicks / drags on the grid — reliable (60/60 clicks; paint-drag and resize-drag work with stepped moves).

### M1 — Walking skeleton (dogfood on the music app) — DONE 2026-09-25
Recon (quick) → intake Quick → 3 personas → 1 scenario each → sequential run → simple triage → report.
Builds on the spike: persona driver as an MCP server with a one-call-per-step `act` tool, persona agent
definition with only those tools, visible picker shim.
Question to answer: **do simulated personas produce findings that are actually useful?**
**Answer: yes, with a caveat.** 11 UX findings with evidence and code pointers; spot checks confirmed
them in code or by an independent re-run, and one (output clipping) came from harness audio signals.
Triage separated 3 harness artefacts on its own. Two of them would have been false findings (a
native `<select>` popup and a stand-in hidden under the app's modal dialog). Both are fixed. Cost
$5.27 per run: ≈ $0.28 per persona session, and the rest is planner-side overhead.
- [x] `driver/`: Session + stdio MCP server (`act`, `end_session`, `harness_*`), 40 tests
- [x] `agents/persona.md` restricted to the two persona tools; `agents/recon.md`, `agents/triage.md`
- [x] Visible stand-ins in the top layer: Save As / Open (OPFS) and native `<select>` lists
- [x] Harness signal log (`signals.jsonl`): audio (per step + session totals), picker/select/download/dialog events, page/console/HTTP errors, crashes, a browser that quits (`browser-closed`; the session ends with `over: BROWSER_CLOSED`)
- [x] `Input.dispatchMouseEvent: Invalid parameters` reproduced (non-finite coordinates only) and prevented

### M2 — DONE 2026-09-25
Guided intake · **creative-tool domain pack** (first curated pack) · parallel runs · safety rules · auth handling.
From the M1 dogfood: stand-ins for more native surfaces (date/color/file choosers, permission prompts) ·
a `visual_change` measure that works on animated apps · unattended mode (intake from recon + labelled
assumptions) · cheaper planner-side overhead (Sonnet for quick recon/orchestration).
Dogfooded unattended on the guide app (a Thai guide with an AI chat) and the music app: 3 parallel personas,
$2.3–3.3 and ~10 min per run (M1: $5.27, 22.8 min).
- [x] Modes Quick / Guided / Expert / **unattended** (`claude -p`, arguments, recommended answers recorded as assumptions); state menu (D20)
- [x] `knowledge/intake.md` (six rounds), `knowledge/packs/creative-tool.md` (curated), pack choice with ad-hoc fallback
- [x] Parallel runs in batches of `max_parallel` (default 3; 1 when server state is shared) — no crosstalk (test + runs)
- [x] **Enforced safety** in the driver: `external_navigation: stop`, `stop_before` (with `max` allowances for spending integrations: unattended default 0), `block`, redirects and service workers covered
- [x] Stand-ins: `<input type=file>` (sample files), date/time/month/week, color, permission prompts (mic/camera/MIDI/notifications/geolocation), beforeunload note — F-12 (MIDI prompt on load) came from this
- [x] `visual_change`: `changed` / `none` / `animating_only` with an animation mask, `changed_box`, `changed_while_idle`; `driver/png-diff.mjs` for triage
- [x] Auth start states: `storage_state` + `harness_save_state` (cookies, localStorage, IndexedDB), setup sessions, headed manual login for OAuth/OTP — driver and Codex orchestrator tested against the maker app's real password login and returning state on 2026-09-27; the Claude orchestrator remains untested
- [x] Finding labels (D15 minimal): `feedback.md` per run, "Label findings" in the state menu, precision per run
- [x] Guided intake and authenticated returning personas dogfooded through Codex on the maker app, 2026-09-27.
- [ ] Expert intake and auth through the Claude Code orchestrator remain unverified (Claude CLI weekly limit blocked the maker-app run).

### Local Codex adapter — 2026-09-27

The shared browser driver and knowledge now have a Codex entry point. A short-lived,
two-tool MCP bridge serves one persona session, while `codex exec` runs in a macOS
sandbox that denies app/plugin source reads, direct localhost app access, and
subprocess execution. The parent process owns state, signals, logs, and shutdown.
The first release accepts only local app URLs. Details and acceptance evidence:
`docs/superpowers/specs/2026-09-27-codex-ux-assessment-design.md` (the maker-app dogfood notes
are not published).

- [x] Cross-platform Codex runner (D24–D26): feature gate, canary self-check (PASS on macOS, codex-cli 0.155.0-alpha.9.2, 2026-09-29; the first full run FAILed mcp-tools because the model skipped `act`, and a retry PASSed; mitigated in codex-self-check.mjs and codex-runner.mjs by act-first prompt wording and one automatic retry when the only miss is zero `act` calls), Windows/Linux behind a self-check record; CI (D29) written and fixed after one partial run; CI then ran green once on Windows and Ubuntu (2026-09-29, run 36585441762) after a Windows timeout in safety.test.mjs; macOS was not in the matrix then, so "unit tests on three OSes" was not met at that point (macOS was restored in phase 5). Branch oss-phase1.
- [x] Installer + portability (D27, D28): scripts/install.mjs (Claude marketplace install, Codex symlink/junction, exit 0/1/2), driver/probe.mjs, the $PLUGIN real-path rule, the win32 outside-profile warning; install.test.mjs green on macOS locally (240/240 driver tests), CI ran green once on Windows and Ubuntu (2026-09-29, run 36585441762) after a Windows timeout in safety.test.mjs (the matrix was Windows + Ubuntu then, while the repo was private; macOS was restored in phase 5), so "green on three OSes" was not met at that point. Open question 4 (Codex discovering a junctioned skill) still open: Node's junction resolution is covered by the CI step, Codex itself needs a live Windows run; the fail-closed real-path rule is in place. Branch oss-phase1.
- [x] Model map + token accounting (D30, D31): driver/models.mjs, driver/usage.mjs (hook, report, estimate), knowledge/cost.md measured 2026-09-29 (hook vs claude -p: input and cached input within 0.0 %; output FAILS the 5 % check, the transcripts carry 57 % of billed output, recorded as a known undercount; the hook now finds the project above a Bash `cd`), codex-canary.yml (not yet run: needs the OPENAI_API_KEY secret); O-1 not adopted at 30.6 %.
- [x] Docs (component 9): README (support matrix, "Not verified yet", install per harness × OS, the Windows/Linux Codex self-check, models, measured tokens), CONTRIBUTING.md, SECURITY.md, issue forms (bug, Codex self-check report), `node driver/probe.mjs deps` with the skill's dependency check, and `driver/test/docs.test.mjs` (links, anchors, commands and flags, no private names or local paths, issue forms, the README model and token tables against `models.mjs` and `knowledge/cost.md`). CI ran green once on Windows and Ubuntu (2026-09-29, run 36585441762) after a Windows timeout in the safety tests; the spec's "CI-verified" matrix wording waits for a track record and an end-to-end run on those OSes.
- [x] Release prep (D32, D33): LICENSE, version 0.3.0 and the repository owner in every manifest, the anonymized tree with a scan in the test suite, macOS back in CI, docs/releasing.md. Publishing is the maintainer's checklist; not run yet.

### M3
- [x] Verify-only (D15): `agents/verifier.md`, `driver/ledger.mjs` (cross-run identity + status), `driver/verify.mjs`, "Verify fixes" in both skills; triage writes `check` and reuses ledger ids. Dogfooded on the music app 2026-09-28 via Claude Code (`claude -p`, Sonnet): 13 findings, 12 still there, F-12 not seen, $4.37.
- [x] Intended behaviors (D15): a charter section, a triage rule (*working as intended* unless it costs the goal) and an offer in the label step. Backfilled for the music app and the maker app from their labels on 2026-09-28; not yet exercised by a triage run.
- [x] Harness-controlled clock (D22): `clock: controlled` for long in-app timers and human-speed deadlines ([SPIKE.md](SPIKE.md#harness-clock)) — `driver/clock.mjs`; `clock` on `harness_start`, Codex and verifier sessions; charter, recon and triage rules. Implemented on branch `m3-harness-clock`; not yet exercised by a real run.
- [ ] Top-finding re-verification right after triage (D14): reuse the verifier.
- [ ] Rerun comparison of persona runs (fixed / still present / new across full reruns).
- [ ] Claude in Chrome adapter · Thai tuning · fix-tasks export · real-user kit · retention pruning.

### Deferred
Forms/signup domain pack — postponed until there is an app with forms to dogfood it on (unvalidated otherwise).

---

## 10. Dogfood target: a loop-based music web app

- Loop-based music creation web app; single user; saves projects locally (draw.io-like); no signup.
- Runs locally.
- **No README / user-facing usage docs**, but it does have `CLAUDE.md` and `docs/` (incl. `design.md`), so
  recon has a developer-intent source (D7); intake round 1 still confirms it. Still the most on-target
  test: can people understand the app without a manual?
- Saves three ways: IndexedDB autosave, Save/Open via File System Access pickers (needs the OPFS shim,
  D5), and **Google Drive** (OAuth → stop-before).
- Test goal: **can users understand the app and create something conveniently?**
- Constraints to design around:
  - **Personas cannot hear.** Define success with checkable outcomes (e.g. ≥N tracks/loops placed,
    playback started, project saved and reopened intact). Personas judge only **visual feedback of
    sound** (playhead, active cells, meters) — itself a valuable UX lens.
  - Grid-heavy UI. The piano roll is **DOM buttons, not canvas**, but its accessible names are poor
    (258 cells, 33 distinct names — pitch only, no step), so the a11y tree cannot target cells and a
    screen-reader persona cannot tell steps apart. Sighted personas use screenshots, coordinate clicks
    and stepped drags (verified reliable, SPIKE Q7).
  - Routes: one page whose tabs are selected by a query parameter.
  - Relationship dimension = **creative tool** → include the "empty canvas" problem, undo, flow
    interruption, first-sound time-to-value.

---

## 11. Open questions / known unknowns
- Quality of auto-generated domain packs (no benchmark to measure it — D16).
- Frustration counting still relies on personas reporting events honestly; triage must audit logs
  for personas that persisted longer than their budget should allow.
- Cost estimates are rough ranges until real runs are recorded (one spike session measured so far).
- Persona claims vs. harness truth: triage must cross-check claims ("it played", "Save did nothing")
  against harness signals before a finding counts as `ux`.
- ~~One unexplained driver error in the spike: `Input.dispatchMouseEvent: Invalid parameters`.~~
  Resolved in M1: only non-finite coordinates produce it; the driver rejects them before any CDP
  call, and real action failures are logged as `action-error` signals, never as `no_response`
  (SPIKE "M1 follow-ups").
- Native browser/OS surfaces a screenshot cannot see (M1 found `<select>` popups and pickers hidden
  under the app's modal dialog) turn into false "nothing happened" findings. Each new app may bring
  new ones; triage's `env_error` cross-check is the safety net, and stand-ins are added per surface.
- Precision of UX findings is still unmeasured: no run has been labelled yet (label sheets exist
  for the music app and the guide app; D15/D16).
- Run-to-run stability: two triage passes over the same guide-app sessions agreed on all 7
  findings (one severity differed); persona-level variance between runs is not measured yet.
- Claude Code refuses report files written by subagents, so triage returns the report as its reply
  and the orchestrator saves it — a large reply passes through the main context once.
- Whether 10–15 intake questions is too many for devs who "just want to try" (Quick mode is the hedge).
