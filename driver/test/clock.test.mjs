import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageClock, humanMs, CLOCK_MODES, WAIT_CAP_S, NET_IDLE_MS } from '../clock.mjs';

// A fake Playwright Clock: records runFor calls and the most calls that ever overlapped.
function fakeClock({ delayMs = 0, fail = false, hang = false } = {}) {
  const c = { calls: [], active: 0, maxActive: 0 };
  c.runFor = async (ms) => {
    c.calls.push(ms);
    c.active++;
    c.maxActive = Math.max(c.maxActive, c.active);
    try {
      if (hang) await new Promise(() => {});
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error('boom from a timer');
    } finally { c.active--; }
  };
  return c;
}
const tick = () => new Promise((r) => setImmediate(r));
function make(clock, opts = {}) {
  const errors = [];
  const idle = [];
  const pc = new PageClock({
    clock, networkIdle: async (ms) => { idle.push(ms); }, signature: async () => 'same',
    onError: (kind, e) => errors.push([kind, e.message]), sleep: tick, ...opts,
  });
  return { pc, errors, idle };
}

test('modes and wait caps', () => {
  assert.deepEqual(CLOCK_MODES, ['real', 'controlled']);
  assert.deepEqual(WAIT_CAP_S, { real: 10, controlled: 600 });
});

test('human time: 2 s per counted step plus 0.2 s per typed character', () => {
  assert.equal(humanMs({ type: 'click', x: 1, y: 1 }), 2000);
  assert.equal(humanMs({ type: 'wait', seconds: 5 }), 2000);
  assert.equal(humanMs({ type: 'type', text: '0123456789' }), 4000);
});

test('advance moves page time in network-aware 1 s chunks', async () => {
  const clock = fakeClock();
  const { pc, idle } = make(clock);
  await pc.advance(2500);
  assert.deepEqual(clock.calls, [1000, 1000, 500]);
  assert.deepEqual(idle, [NET_IDLE_MS, NET_IDLE_MS, NET_IDLE_MS]);
  assert.equal(pc.elapsedMs, 2500);
});

test('a full wait runs every 1 s chunk and reports full', async () => {
  const clock = fakeClock();
  const { pc, idle } = make(clock);
  assert.deepEqual(await pc.wait(3.5), { waitedMs: 3500, stop: 'full' });
  assert.deepEqual(clock.calls, [1000, 1000, 1000, 500]);
  assert.equal(idle.length, 4, 'network check before every chunk');
  assert.equal(pc.elapsedMs, 3500);
});

test('a wait stops at the first chunk whose signature differs from the start', async () => {
  const clock = fakeClock();
  let n = 0;
  const { pc } = make(clock, { signature: async () => (n++ < 3 ? 'a' : 'b') }); // start, +1 s, +2 s: a; +3 s: b
  assert.deepEqual(await pc.wait(120), { waitedMs: 3000, stop: 'changed' });
  assert.equal(clock.calls.length, 3);
});

test('an unreadable signature is never a change', async () => {
  const { pc } = make(fakeClock(), { signature: async () => null });
  assert.deepEqual(await pc.wait(3), { waitedMs: 3000, stop: 'full' });
});

test('the wall cap ends a wait and reports the page time that passed', async () => {
  let t = 0;
  const clock = fakeClock();
  const run = clock.runFor;
  clock.runFor = async (ms) => { t += 1000; return run(ms); }; // each chunk costs 1 s of real time
  const { pc, idle } = make(clock, { wallCapMs: 3500, now: () => t });
  assert.deepEqual(await pc.wait(600), { waitedMs: 4000, stop: 'wall_cap' });
  assert.equal(idle[0], 3500, 'the network wait never outlasts the wall cap');
});

test('the pacer and a wait never run runFor at the same time; stopPacer stops it', async () => {
  const clock = fakeClock({ delayMs: 5 });
  const { pc } = make(clock);
  pc.startPacer();
  pc.startPacer(); // idempotent: still one loop
  await pc.wait(3);
  await pc.stopPacer();
  await pc.stopPacer(); // idempotent
  assert.equal(clock.maxActive, 1);
  assert.ok(clock.calls.includes(100), 'the pacer ran');
  const n = clock.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(clock.calls.length, n, 'no runFor after stopPacer');
});

test('a timer that throws is reported and page time still moves', async () => {
  const { pc, errors } = make(fakeClock({ fail: true }));
  await pc.advance(2000);
  assert.deepEqual(errors, [['timer-error', 'boom from a timer'], ['timer-error', 'boom from a timer']]);
  assert.equal(pc.elapsedMs, 2000);
  assert.deepEqual(await pc.wait(1), { waitedMs: 1000, stop: 'full' });
});

test('a page that never yields: runFor is bounded, reported once, and nothing queues behind it', async () => {
  const clock = fakeClock({ hang: true });
  const { pc, errors } = make(clock, { runTimeoutMs: 50 });
  const t = Date.now();
  assert.deepEqual(await pc.wait(600), { waitedMs: 0, stop: 'wall_cap' });
  await pc.advance(2000);
  pc.startPacer();
  await new Promise((r) => setTimeout(r, 20));
  await pc.stopPacer();
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  assert.equal(clock.calls.length, 1, 'no runFor queued behind the stuck one');
  assert.deepEqual(errors.map(([k]) => k), ['stuck']);
});
