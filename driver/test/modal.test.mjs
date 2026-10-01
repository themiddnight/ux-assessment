// Apps often show a modal <dialog> (top layer) while a picker is open, or put a <select> inside one.
// The top layer paints above any z-index and makes the rest of the page inert, so the stand-ins must
// be modal dialogs themselves, opened last (M1 dogfood, a music app: a "Saving..." overlay hid the Save As).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session.mjs';
import { startFixtureServer } from './fixture-server.mjs';
import { eventually } from './eventually.mjs';

let fx;
before(async () => { fx = await startFixtureServer(); });
after(async () => { await fx.close(); });

const step = (action) => ({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action });
const click = (x, y) => step({ type: 'click', x, y });
const withSession = async (fn, viewport = 'desktop') => {
  const s = await Session.start({ id: 'modal', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-modal-')), url: fx.url('modal.html'), viewport });
  try { await fn(s); } finally { await s.stop(); }
};
const status = (s) => s.evalHarness("document.getElementById('status').textContent");
// Which element is painted at a point, seen through the closed shadow root's host.
const hitIsHarness = (s, x, y) => s.evalHarness(`!!document.elementFromPoint(${x}, ${y})?.closest('[data-ux-harness]')`);

for (const viewport of ['desktop', 'mobile-small']) {
  test(`Save As stand-in is on top of the app's modal overlay and usable (${viewport})`, () => withSession(async (s) => {
    await s.act(click(160, 120));
    const g = await s.evalHarness('window.__uxPickerGeometry()');
    assert.equal(g.title, 'Save As');
    assert.equal(await hitIsHarness(s, g.ok.x, g.ok.y), true, 'Save button is the topmost element');
    await s.act(click(g.ok.x, g.ok.y));
    // The write goes through the origin-private file system after the step has returned (eventually.mjs).
    assert.equal(await eventually(() => status(s), (v) => v !== 'idle'), 'saved');
  }, viewport));
}

test('select stand-in works for a select inside a modal dialog', () => withSession(async (s) => {
  await s.act(click(320, 120));
  const pos = await s.evalHarness("(() => { const r = document.getElementById('s').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  await s.act(click(pos.x, pos.y));
  const g = await s.evalHarness('window.__uxSelectGeometry()');
  const bravo = g.rows.find((r) => r.label === 'Bravo');
  assert.equal(await hitIsHarness(s, bravo.x, bravo.y), true, 'the list is the topmost element');
  await s.act(click(bravo.x, bravo.y));
  assert.equal(await status(s), 'chose b');
  assert.equal(await s.evalHarness("document.getElementById('m').open"), true, "the app's own dialog stays open");
}));
