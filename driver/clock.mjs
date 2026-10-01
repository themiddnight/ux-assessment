// Harness-owned page time (SPEC D22; docs/superpowers/specs/2026-09-28-harness-clock-design.md).
// Under `clock: controlled` the page clock (Playwright context.clock) is paused and only this
// module moves it, always with runFor: runFor fires every due tick, while fastForward and pauseAt
// fire each timer once and break countdowns that subtract 1 per tick (SPIKE.md, "Harness clock").
// Two runFor calls never overlap.
export const CLOCK_MODES = ['real', 'controlled'];
export const WAIT_CAP_S = { real: 10, controlled: 600 }; // the persona-tool description states it
export const PACE_MS = 100; // pacer: runFor(100) + a real 100 ms sleep while the harness works
export const CHUNK_MS = 1000; // human time and wait move in 1 s chunks
export const STEP_HUMAN_MS = 2000; // a person reads and decides before every counted step
export const CHAR_HUMAN_MS = 200; // ...and types 0.2 s per character
export const NET_IDLE_MS = 5000; // before a chunk, wait at most this long for requests in flight
export const NET_GRACE_MS = 20; // after a chunk: a request a timer just started reaches the tracker
export const WALL_CAP_MS = 60000; // one wait spends at most this much real time
export const RUN_TIMEOUT_MS = 5000; // a page whose main thread never yields cannot advance

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page time a person spends reading and deciding before this action. Never told to the persona. */
export function humanMs(action) {
  return STEP_HUMAN_MS + (action?.type === 'type' ? String(action.text ?? '').length * CHAR_HUMAN_MS : 0);
}

export class PageClock {
  elapsedMs = 0; // page time advanced since the clock was paused at install
  #lock = Promise.resolve(); // the runFor in progress (settled handlers only: never rejects)
  #stuck = false; // a runFor has not returned: the page's main thread never yields
  #pacing = null; // {stop, done} while the pacer runs

  constructor({ clock, networkIdle, signature, onError = () => {}, wallCapMs = WALL_CAP_MS, runTimeoutMs = RUN_TIMEOUT_MS,
    sleep = realSleep, now = Date.now }) {
    this.clock = clock;
    this.networkIdle = networkIdle;
    this.signature = signature;
    this.onError = onError;
    this.wallCapMs = wallCapMs;
    this.runTimeoutMs = runTimeoutMs;
    this.sleep = sleep;
    this.now = now;
  }

  /** One runFor(ms) after any earlier one. False when page time could not move (a frozen page). */
  async #run(ms) {
    if (this.#stuck) return false; // queueing more behind a frozen page would only pile up
    this.#lock = this.#lock.then(() => this.clock.runFor(ms)).then(
      () => { this.elapsedMs += ms; },
      // Playwright rethrows a page timer's exception after the time has moved.
      (e) => { this.elapsedMs += ms; this.onError('timer-error', e); },
    );
    const settled = this.#lock;
    let timer;
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise((r) => { timer = setTimeout(() => r(true), this.runTimeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!timedOut) return true;
    this.#stuck = true;
    this.onError('stuck', new Error(`the page clock did not advance within ${this.runTimeoutMs} ms`));
    settled.then(() => { this.#stuck = false; });
    return false;
  }

  /** While the harness works inside a step, page time moves alongside real time. Idempotent. */
  startPacer() {
    if (this.#pacing) return;
    const pacing = { stop: false };
    pacing.done = (async () => {
      while (!pacing.stop) {
        await this.#run(PACE_MS);
        if (!pacing.stop) await this.sleep(PACE_MS);
      }
    })();
    this.#pacing = pacing;
  }

  /** Stop the pacer and wait for its last runFor. Idempotent. */
  async stopPacer() {
    const pacing = this.#pacing;
    if (!pacing) return;
    this.#pacing = null;
    pacing.stop = true;
    await pacing.done;
  }

  /** Human time: `ms` of page time in network-aware 1 s chunks. */
  async advance(ms) {
    for (let left = ms; left > 0; left -= CHUNK_MS) {
      await this.networkIdle(NET_IDLE_MS);
      if (!(await this.#run(Math.min(CHUNK_MS, left)))) return;
      await this.sleep(NET_GRACE_MS);
    }
  }

  /** `wait {seconds}`: 1 s chunks until the signature changes, the time is up or the wall cap is hit. */
  async wait(seconds) {
    const target = Math.round(seconds * 1000);
    const start = this.now();
    const before = await this.signature();
    let waitedMs = 0;
    while (waitedMs < target) {
      const spent = this.now() - start;
      if (spent >= this.wallCapMs) return { waitedMs, stop: 'wall_cap' };
      await this.networkIdle(Math.min(NET_IDLE_MS, this.wallCapMs - spent));
      const ms = Math.min(CHUNK_MS, target - waitedMs);
      if (!(await this.#run(ms))) return { waitedMs, stop: 'wall_cap' };
      waitedMs += ms;
      // A request a timer just started needs real time to reach the tracker (mirrors advance()).
      await this.sleep(NET_GRACE_MS);
      const after = await this.signature();
      if (before != null && after != null && after !== before) return { waitedMs, stop: 'changed' };
    }
    return { waitedMs, stop: 'full' };
  }
}
