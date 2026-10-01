// Native <select> popups are drawn by the OS, outside the page: screenshots never show them and
// coordinate clicks cannot reach them (found in the M1 dogfood run on a music app). The driver replaces the
// popup with an in-page stand-in list the persona can see and click.
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
const click = (x, y) => step({ type: 'click', x, y });
const withSession = async (fn) => {
  const s = await Session.start({ id: 'sel', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-sel-')), url: fx.url('select.html') });
  try { await fn(s); } finally { await s.stop(); }
};
const geo = (s) => s.evalHarness('window.__uxSelectGeometry()');
const out = (s) => s.evalHarness("document.getElementById('out').textContent");

test('clicking a select shows a visible in-page list; clicking an option selects it and fires change', () => withSession(async (s) => {
  const before = await s.act(step({ type: 'look' }));
  const opened = await s.act(click(180, 110));
  assert.ok(!opened.png.equals(before.png));
  const g = await geo(s);
  assert.deepEqual(g.rows.map((r) => r.label), ['Alpha', 'Later', 'Bravo', 'Charlie', 'Delta']);
  const delta = g.rows.find((r) => r.label === 'Delta');
  assert.ok(delta.y > 110, 'list opens below the select');
  await s.act(click(delta.x, delta.y));
  assert.equal(await geo(s), null, 'list closes after choosing');
  assert.equal(await out(s), 'changed to d');
  const kinds = (await s.signals()).events.filter((e) => e.type.startsWith('picker-select')).map((e) => [e.type, e.name]);
  assert.deepEqual(kinds, [['picker-select-shown', 'Alpha'], ['picker-select-chosen', 'Delta']]);
}));

test('group labels and disabled options cannot be chosen', () => withSession(async (s) => {
  await s.act(click(180, 110));
  const g = await geo(s);
  for (const label of ['Later', 'Charlie']) {
    const r = g.rows.find((x) => x.label === label);
    await s.act(click(r.x, r.y));
    assert.notEqual(await geo(s), null, `${label} keeps the list open`);
  }
  assert.equal(await out(s), 'none');
}));

test('Escape and clicking outside close the list without changing the value', () => withSession(async (s) => {
  await s.act(click(180, 110));
  await s.act(step({ type: 'press_key', key: 'Escape' }));
  assert.equal(await geo(s), null);
  await s.act(click(180, 110));
  await s.act(click(900, 600));
  assert.equal(await geo(s), null);
  assert.equal(await out(s), 'none');
  assert.equal(await s.evalHarness("document.getElementById('s').value"), 'a');
}));

test('near the bottom of the screen the list opens upwards and stays on screen', () => withSession(async (s) => {
  await s.act(click(180, 770));
  const g = await geo(s);
  assert.ok(g.rows.every((r) => r.y > 0 && r.y < 760), JSON.stringify(g.rows));
  await s.act(click(g.rows[0].x, g.rows[0].y));
  assert.equal(await s.evalHarness("document.getElementById('bottom').value"), 'Top');
}));

test('clicking the open select again closes the list', () => withSession(async (s) => {
  await s.act(click(180, 110));
  await s.act(click(180, 110));
  assert.equal(await geo(s), null);
}));
