# Harness-controlled clock — design (2026-09-28)

Evidence: [SPIKE.md](../../../SPIKE.md#harness-clock) (Playwright 1.63, the timer app).

## Problem

1. **Long in-app timers do not fit a session.**
   - The timer app's countdown runs for 13 minutes, and its first reminder comes at +90 s.
   - `wait` is capped at 10 s, so a persona burns about 9 of its 30 steps to reach the first reminder.
2. **Personas are slower than people.**
   - A persona takes 10–30 s of real time per step.
   - With a real clock, a deadline (OTP expiry, a quiz timer, a hold on a booking) runs out at LLM
     speed, not human speed. That produces false findings.

## Decision

Add a charter harness option, `clock: real | controlled`.
- **`real` is the default** and keeps today's behavior.
- **`controlled`** means the harness owns page time. The persona is never told that time is
  simulated.

This is one rule for every app with timers. There are no per-app-type rules. Recon decides per
*timer* whether `controlled` is safe (see Recon below).

### The model under `controlled`

Page time means `Date`, `performance.now`, `setTimeout`, `setInterval` and `requestAnimationFrame`,
faked with `context.clock` over every page and popup of the session.

1. **Setup.**
   - Before the entry URL loads, the harness calls `context.clock.install()` and then pauses the
     clock at the install time.
   - The entry-URL load and the setup settle run under the pacer (point 2).
2. **Pacer.** While the harness does work inside a step, page time advances alongside real time:
   - it repeats `runFor(100)` and a real 100 ms sleep until the work finishes;
   - "work" covers the pre shots, the action, the settle and the post screenshot;
   - this keeps network → `setTimeout` chains alive. The spike showed that a single `runFor` on a
     paused clock left the page on "loading" for good.
   - Between `act` calls, while the persona is thinking, the clock stays paused.
3. **Human time.** At the start of each counted step, before the idle shot, page time advances by the
   time a person would spend reading and deciding:
   - 2 s for every step;
   - plus 0.2 s per character for `type`;
   - the free first look adds none.
   - This time advances in network-aware chunks (point 5).
   - Changes it causes count as "changed while idle", which is the existing between-step history.
4. **`wait {seconds}`.**
   - Under `controlled` the cap is **600 s**; under `real` it stays 10 s. The persona-tool
     description states the cap of the session's mode.
   - Page time advances with `runFor(1000)` chunks.
   - After each chunk the harness computes a **change signature**:
     - `document.body.innerText` with every run of digits (any script) replaced by `#` and whitespace collapsed;
     - `location.href`;
     - the number of `navigator.vibrate` calls;
     - the number of `Notification`s shown.
   - The wait **stops early** at the first chunk whose signature differs from the one taken at the
     start of the wait. A real user looks up when something changes.
   - Pixels are not compared, because CSS animations run in real time.
5. **Network-aware chunks.**
   - Before each chunk of human time or `wait`, the harness waits in real time until the session has
     no request in flight, for at most 5 s.
   - Page time never runs far ahead of a response. Otherwise an app's own fetch timeout would fire
     against a request that had no time to complete.
6. **Wall cap.**
   - One `wait` spends at most 60 s of real time. Pages with a `requestAnimationFrame` loop are slow:
     60 s of page time took 17.6 s of real time.
   - When the cap is reached, the wait ends early and reports how much page time actually passed.
7. **Never use `fastForward` or `pauseAt` to skip time.** Both fire each due timer only once, which
   breaks countdowns that decrement per tick.

### What the persona sees

- **A wait ends early:** `You waited 31 s. Something on the screen changed.`
- **A wait ends at the wall cap:** `You waited 45 s.`
- **A full wait:** nothing extra.
- **Vibration:** in both modes, when the device has touch and the page called `navigator.vibrate`
  during the step, the status says `The phone vibrated.` A real phone user feels it; otherwise the
  persona misses a signal the app designed. Each call is logged as a `vibrate` signal.
- **What is never said:** the persona never learns that time is simulated, and never learns the
  human-time amounts.

### Signals and logs

- The `setup` signal gets a `clock` field.
- Every step's log gets `page_time_ms`, the page time elapsed since setup.
- A `wait` log also gets:
  - `waited_ms` (page time);
  - `wait_stop`: one of `changed`, `full` or `wall_cap`.
- Triage reads `page_time_ms` to judge timing claims.

## Recon, charter and triage

- **Recon** lists each timer the app relies on, and where its clock runs:
  - the page's main thread;
  - a Web Worker or Service Worker;
  - `AudioContext` or media playback;
  - the server (a countdown from an API `expires_at`, or an SSE/WebSocket tick).

  It proposes `clock: controlled` only when:
  - the timers that matter run on the main thread;
  - and the goal needs long waits, or the app has deadlines.

  Audio-driven apps such as the music app stay `real`: their audio keeps real time while the playhead would
  stop.
- **Charter:**
  - `clock` is added to the harness config block.
  - The environment-shims table gets a row: `timers → clock: controlled`, and personas see nothing
    different.
  - Under `controlled`, "Not tested this run" always lists:
    - the screen locking or sleeping;
    - the app going to the background;
    - wake lock;
    - timers that span days.
- **Triage:** a finding caused by drift between page time and a clock the harness cannot fake is
  `env_error`, never `ux`. Examples of such clocks: a Worker, `AudioContext`, CSS animation or the
  server.
- **Verify:** the verifier sessions take `clock` from the charter, like `fs` and `permissions`.

## Plumbing

- `Session` gets the constructor option `clock = 'real'`; any other value throws.
- The MCP `start` tool gets a `clock` enum.
- Both skills pass `clock` from the charter to every persona session and every verifier session.
- The Codex runner already passes session options through.

## Out of scope

- Time travel between sessions, such as a returning user "3 days later".
- Faking Worker, audio or media clocks.
- Modelling a screen lock or background tab.

## Tests (driver)

All tests use fixture pages on the local fixture server.

1. `controlled`: a page with a per-tick `setInterval` countdown (the same shape as the timer app's).
   `wait 90` shows 90 s elapsed, not 1 tick.
2. `controlled`: a banner appears at +31 s. `wait 120` stops with `wait_stop: changed`, and the
   status says it ended early.
3. `controlled`: fetch → `setTimeout(0)` → text. After a click, the post screenshot shows the final
   text, not "loading".
4. `controlled`: with no action for 3 s of real time, page time does not move (the clock is paused
   while the persona thinks).
5. `controlled`: a counted step advances page time by at least 2 s. A `type` of 10 characters adds a
   further 2 s.
6. `real`: `wait` above 10 s is still invalid. `controlled`: `wait 601` is invalid.
7. A touch device plus `navigator.vibrate` produces the status line and a signal. A desktop session
   produces the signal only.
8. A slow response of 1.5 s during a `wait 10` completes before its `setTimeout`-based client
   timeout fires (the network-aware chunks).
9. Wall cap: a `requestAnimationFrame`-heavy page with `wait 600` ends with `wall_cap` and reports
   less than 600 s. For test speed, the cap is overridable through a constructor option.
