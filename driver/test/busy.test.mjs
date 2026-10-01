// A page whose main thread is busy (a long loop, a hung app) must not hang the persona's step:
// every harness call in a step is bounded, and the step still returns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session.mjs';
import { startFixtureServer } from './fixture-server.mjs';

let fx;
before(async () => { fx = await startFixtureServer(); });
after(async () => { await fx.close(); });

const step = (action) => ({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action });

test('a busy main thread does not hang act', async () => {
  const s = await Session.start({ id: 'busy', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-busy-')), url: fx.url('busy.html') });
  try {
    await s.act(step({ type: 'click', x: 150, y: 210 })); // focus the field: a caret to hide
    let t = Date.now();
    const r = await s.act(step({ type: 'click', x: 160, y: 120 }));
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t < 10000, `busy step took ${Date.now() - t} ms`);
    t = Date.now();
    const r2 = await s.act(step({ type: 'wait', seconds: 1 }));
    assert.equal(r2.ok, true);
    assert.match(r.text + r2.text, /could not be captured/);
    assert.ok(Date.now() - t < 10000, `next step took ${Date.now() - t} ms`);
  } finally { await s.stop(); }
});
