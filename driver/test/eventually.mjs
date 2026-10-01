// act() returns after a fixed settle (SETTLE_MS in session.mjs) plus a screenshot; it does not wait
// for the app's own async work. What a fixture does after a click through the origin-private file
// system (create the file, write it, list the folder) usually takes a few milliseconds, but nothing
// bounds it: on a slow disk it outlasts the settle and a read taken right after the step still sees
// the state from before. Poll for the state instead of assuming it has arrived.

/** Read until `done(value)` holds; returns the last value read, so the caller's assert names it. */
export async function eventually(read, done, { timeoutMs = 15000, everyMs = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= end) return value;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
