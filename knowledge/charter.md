# Charter — pack choice, template, harness config

Planner-only. Written after intake; the user approves it before personas are generated.

## Choosing a pack (SPEC D10)

1. Read the app-profile's *Dimensions*.
2. Each curated pack in `$PLUGIN/knowledge/packs/` starts with a "Dimensions (match rule)" section.
   Use the pack whose rule matches. Today: `creative-tool.md`.
3. No match → write an **ad-hoc pack** to `.ux-assessment/packs/<name>.md` with the same sections
   (dimensions, lenses, you might be missing, persona archetypes, scenario templates, success
   criteria, native surfaces), derived from recon. Its first line is
   `> auto-generated, unreviewed` and the charter names it as such. The user can promote it to
   permanent by removing that line.
4. Record the pack in the charter (`## Pack`).

## Template (`.ux-assessment/charter.md`)

```markdown
# Charter — <app name> (<date>)

## What this app is (confirmed with the developer)
<one paragraph: what it does, for whom, what the first 5 minutes should achieve>

## Why test now
<pre-launch / after a feature change / people complain or drop off>

## Pack
<creative-tool (curated) | <name> (auto-generated, unreviewed)>

## Success criteria (checkable, not "feels good")
- <e.g. a newcomer places at least 4 notes and starts playback within 20 actions>
- <e.g. a project is saved and reopened intact>

## Lenses
<from the pack + app dimensions + intake (round 2 and 5)>

## Intended behaviors
<behaviors that look like friction but are on purpose; triage only, never shown to personas.
Empty is fine. One line each, in user terms:>
- <what the app does> — why: <the design reason> — source: <developer · label F-07 (run <name>)>

## Safety rules
| tier | actions |
|---|---|
| allowed | <everything local: creating, editing, saving to local storage/files> |
| stop-before | <payments, connecting outside accounts (OAuth), sending email/SMS, publishing> |
| forbidden | <deleting real data, anything on a production-looking URL without confirmation> |

## Environment shims (harness replacements; artefacts are `env_error`, never `ux`)
| what | shim | what personas see |
|---|---|---|
| OS file pickers (File System Access API) | `fs: shim` — OPFS-backed handles | an in-page "Save As" / "Open" window marked "Simulated system dialog (test harness)" |
| audio | none — personas cannot hear | only visual feedback; harness logs audio levels |
| timers (`Date`, `setTimeout`, `setInterval`, `requestAnimationFrame`) | `clock: controlled` — the harness owns page time: paused while the persona thinks, moving with real time while the harness acts, 2 s of reading time per step, `wait` up to 600 s that ends when the screen changes | nothing different |

## Harness config
<the yaml block from "Charter → harness config" below, filled in>

## Intake record
| question | answer | source |
|---|---|---|
| 1.1 understanding | … | user · not sure → default · from recon · assumption (unattended) |

## Assumptions
<every answer whose source is not `user`, one line each; unattended runs open the report with this list>

## Not tested this run
<stop-before actions, OAuth/2FA personas skipped, audio quality, anything behind steps not allowed>
<under `clock: controlled`, always: the screen locking or sleeping, the app going to the background, wake lock, timers that span days>

## What this can and cannot find (told to the developer during intake)
CAN: usability friction, unclear purpose/copy, broken or confusing flows, poor error handling,
missing states (empty/loading/error), mobile/slow-network issues, first-session value clarity.
CANNOT: whether the problem is worth solving, willingness to pay, long-term retention, aesthetic
taste, anything requiring hearing, anything behind steps that were not allowed.
```

## Charter → harness config

Every persona session gets the same block (plus its own `storage_state` when returning):

```yaml
safety:
  external_navigation: stop        # default; leaving the app = stop-before "leaving the app (<host>)"
  allow_hosts: []                  # the app's own other hosts a user may navigate to (exact host)
  stop_before: [{pattern: "…", label: "…"}]
  block: []
fs: shim                           # shim | none | native
files: /abs/project/.ux-assessment/files   # only when the app imports files
permissions: prompt                # prompt | grant | deny
clock: real                        # real | controlled — controlled only when recon found the timers that matter on the main thread
```

### Safety tier → `safety`

- **allowed** → nothing. The entry host, `localhost` and `127.0.0.1` pass; subresources from other
  hosts (CDNs, fonts, SDK scripts) always pass. Add to `allow_hosts` only the app's own other hosts a
  user navigates to in the main frame (e.g. `auth.example.com` for a password login page). Host
  matching is exact: `app.example.com` does not cover `example.com`.
- **stop-before** → one `stop_before` entry per integration from recon. The request is aborted and
  the persona gets a STOP note, then ends with `stop_before`.
  - `pattern`: a case-insensitive substring of the full URL, or `/regex/flags`. It matches **every**
    request, scripts included, so aim at the action, not the SDK: `api.stripe.com/v1/payment_intents`,
    not `stripe.com` (that also kills `js.stripe.com`); `accounts.google.com/o/oauth2`, not
    `accounts.google.com` (that also kills the `gsi/client` script).
  - `label`: **persona-visible**, user language: "paying", "connecting your Google account",
    "sending an email". Never a route or code name.
  - Examples:
    | integration | pattern | label |
    |---|---|---|
    | own payment API | `/api/checkout` | paying |
    | Stripe charges | `/api\.stripe\.com\/v1\/(charges\|payment_intents)/` | paying |
    | Google OAuth (Drive save) | `accounts.google.com/o/oauth2` | connecting your Google account |
    | own email/SMS send | `/api/invite` | sending an invitation |
  - **Spends the developer's money or quota** (an AI/LLM API on their keys, paid geocoding, SMS
    credits): the persona may use it only as often as the charter allows. Put the allowance in
    `max` — the driver lets the first `max` matching requests through and stops the next:
    `{pattern: "/api/ask-ai", label: "asking the AI assistant", max: 1}`. Default `max` is 0.
    **Never** write the allowance, or the feature itself, into a briefing ("you may ask the AI
    once" is a hint *and* an unenforced rule); the persona finds the feature or not, and the STOP
    note tells it when the allowance is used up.
  - Third-party redirects (checkout pages, OAuth consent) are already caught by
    `external_navigation: stop`; list them anyway when you know them, for a clearer label.
- **forbidden** → user-visible actions go into `stop_before` too (the persona must stop). Background
  calls with real side effects the persona never chooses (real webhooks, production analytics
  writes) go into `block`: silently aborted, logged as `blocked`. A blocked call can break the app;
  triage treats what follows as `env_error`.
- A production-looking URL is never made safe by config: it needs the developer's confirmation
  (attended) or is refused (unattended).

### Environment shim → option

| app uses (recon) | option | note |
|---|---|---|
| File System Access pickers | `fs: shim` | `none` makes the app fall back to downloads; `native` only for debugging |
| `<input type=file>` imports | `files: <abs>/.ux-assessment/files` | create small sample files of the accepted types, named as a user would name them ("drum loop.wav", "holiday.jpg"), never "fixture" or "test" |
| mic / camera / MIDI / notifications / geolocation | `permissions: prompt` | `grant` when the permission is not under test; `deny` to test the refusal path |
| date / time / color inputs, `<select>`, `beforeunload` | none | stand-ins are always on |
| returning users | `storage_state: <abs>/.ux-assessment/state/<account>.json` | from the setup session |
| audio | none | personas cannot hear; audio signals are harness-only |
| long in-app timers or deadlines (recon "Timers") | `clock: controlled` | only when the timers that matter run on the page's main thread and the goal needs long waits or the app has deadlines; Worker, `AudioContext`/media or server clocks keep `real` (they would drift from page time) |
