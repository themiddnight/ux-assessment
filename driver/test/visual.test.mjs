// visual_change must survive animation: a page that changes on its own (a playhead, a spinner) must
// not make every click look like a response (M1 follow-up). The driver masks areas that changed
// between steps and only reports "changed" for pixels outside that mask.
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
const readLog = (dir) => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastStep = (dir) => readLog(dir).filter((e) => e.step != null).at(-1);
const withSession = async (file, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-vis-'));
  const s = await Session.start({ id: 'vis', dir, url: fx.url(file) });
  try { await fn(s, dir); } finally { await s.stop(); }
};

test('animated page: a click on a dead area is never "changed"', () => withSession('animated.html', async (s, dir) => {
  await s.act(step({ type: 'look' }));
  for (let i = 0; i < 3; i++) {
    await s.act(click(900, 600));
    const e = lastStep(dir);
    assert.ok(['none', 'animating_only'].includes(e.visual_change), `step ${i + 1}: ${e.visual_change}`);
    assert.equal(e.changed_box, null);
  }
}));

test('animated page: a click that reveals text is "changed" and the box covers the text', () => withSession('animated.html', async (s, dir) => {
  await s.act(step({ type: 'look' }));
  await s.act(click(900, 600));
  await s.act(click(160, 120));
  const e = lastStep(dir);
  assert.equal(e.visual_change, 'changed');
  const text = await s.evalHarness("(() => { const r = document.getElementById('msg').getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()");
  const b = e.changed_box;
  assert.ok(b, 'changed_box is set');
  // Glyphs sit inside the text's line box, so the box covers the ink, not every blank pixel of it.
  assert.ok(b.x <= text.x + 4 && b.y <= text.y + text.h / 2 && b.x + b.w >= text.x + text.w - 4 && b.y + b.h >= text.y + text.h / 2,
    `box ${JSON.stringify(b)} covers text ${JSON.stringify(text)}`);
}));

test('animated page: a response under the animation is "animating_only", never "none"', () => withSession('animated.html', async (s, dir) => {
  await s.act(step({ type: 'look' }));
  await s.act(click(900, 600));
  await s.act(click(640, 140));
  assert.equal(await s.evalHarness("document.getElementById('cell').textContent"), 'ON');
  assert.equal(lastStep(dir).visual_change, 'animating_only');
}));

test('static page: a no-op click is "none"; a real change is "changed"', () => withSession('basic.html', async (s, dir) => {
  await s.act(click(900, 600));
  assert.equal(lastStep(dir).visual_change, 'none');
  assert.equal(lastStep(dir).changed_box, null);
  await s.act(click(160, 120));
  assert.equal(lastStep(dir).visual_change, 'changed');
}));

test('a dead button with a hover style is not "changed": the pointer is on it before the pre shot', () => withSession('visual2.html', async (s, dir) => {
  await s.act(step({ type: 'look' }));
  await s.act(click(170, 120));
  assert.notEqual(lastStep(dir).visual_change, 'changed');
}));

test('a slow response that lands between steps does not mask the next real response', () => withSession('visual2.html', async (s, dir) => {
  await s.act(step({ type: 'look' }));
  await s.act(click(170, 220)); // the view changes 800 ms later, after this step's screenshot
  await new Promise((r) => setTimeout(r, 1000)); // the persona thinks
  assert.equal(await s.evalHarness('document.body.style.background'), 'rgb(204, 221, 238)');
  await s.act(click(170, 320));
  assert.equal(lastStep(dir).visual_change, 'changed');
  const b = lastStep(dir).changed_box;
  assert.ok(b.y <= 430 && b.y + b.h >= 440, JSON.stringify(b));
}));

test('a change that lands while the persona thinks is logged as changed_while_idle, not as the next action\'s effect', () => withSession('visual2.html', async (s, dir) => {
  await s.act(step({ type: 'look' }));
  await s.act(click(170, 220)); // the view changes 800 ms later, after this step's screenshot
  assert.notEqual(lastStep(dir).changed_while_idle, 'changed', 'hovering the button is not idle change');
  await new Promise((r) => setTimeout(r, 1000)); // the persona thinks
  await s.act(step({ type: 'wait', seconds: 1 }));
  const e = lastStep(dir);
  assert.equal(e.visual_change, 'none');
  assert.equal(e.changed_while_idle, 'changed');
  assert.ok(e.idle_box && e.idle_box.w > 600, JSON.stringify(e.idle_box));
}));
