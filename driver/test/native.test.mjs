// Native surfaces that automation cannot see or drive (SPEC D5): file inputs, date/time/color
// pickers and permission prompts get visible in-page stand-ins; beforeunload is answered and told.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { Session } from '../session.mjs';
import { startFixtureServer } from './fixture-server.mjs';

let fx;
before(async () => { fx = await startFixtureServer(); });
after(async () => { await fx.close(); });

const step = (action) => ({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action });
const click = (x, y) => step({ type: 'click', x, y });
const at = (p) => click(p.x, p.y);
const withSession = async (opts, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-nat-'));
  const s = await Session.start({ id: 'nat', dir, url: fx.url('native.html'), ...opts });
  try { await fn(s); } finally { await s.stop(); }
};
const text = (s, id) => s.evalHarness(`document.getElementById(${JSON.stringify(id)}).textContent`);
// getUserMedia and geolocation resolve in the browser after the stand-in's answer: that is the app's
// own async work, which a step does not wait for (fake-device mic start measured 0.2 s idle, up to
// 0.9 s under load, against a 0.4 s settle). Wait for the page instead of assuming it is done.
const textWhen = async (s, id, expected, ms = 5000) => {
  const end = Date.now() + ms;
  let got = await text(s, id);
  while (got !== expected && Date.now() < end) { await new Promise((r) => setTimeout(r, 25)); got = await text(s, id); }
  return got;
};
const value = (s, id) => s.evalHarness(`document.getElementById(${JSON.stringify(id)}).value`);
const events = async (s, prefix) => (await s.signals()).events.filter((e) => e.type.startsWith(prefix))
  .map(({ t, step: _, ...e }) => e);
// The stand-in is really painted: the screenshot shows several colours inside its box.
function assertPainted(png, box) {
  const { width, data } = PNG.sync.read(png);
  const colours = new Set();
  for (let y = box.y + 2; y < box.y + box.h - 2; y += 3) {
    for (let x = box.x + 2; x < box.x + box.w - 2; x += 3) { const i = (y * width + x) * 4; colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`); }
  }
  assert.ok(colours.size > 3, `stand-in box ${JSON.stringify(box)} is blank in the screenshot`);
}
const filesDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-files-'));
  fs.writeFileSync(path.join(d, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(d, 'photo.png'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(d, 'data.csv'), 'a,b');
  return d;
};

test('file input: visible Open stand-in lists matching files; choosing sets them on the input', async () => {
  const files = filesDir();
  await withSession({ files }, async (s) => {
    const r = await s.act(click(150, 115));
    const g = await s.evalHarness('window.__uxPickerGeometry()');
    assert.equal(g.title, 'Open');
    assert.deepEqual(g.rows.map((x) => x.label), ['notes.txt', 'photo.png'], 'accept filters out data.csv');
    assertPainted(r.png, g.box);
    await s.act(at(g.rows[0]));
    await s.act(at(g.rows[1]));
    await s.act(at(g.ok));
    assert.equal(await s.evalHarness('window.__uxPickerGeometry()'), null);
    assert.equal(await text(s, 'out-file'), 'notes.txt:5,photo.png:2048');
    assert.deepEqual(await events(s, 'picker-file'), [
      { type: 'picker-file-shown', accept: '.txt,image/png', multiple: true },
      { type: 'picker-file', names: ['notes.txt', 'photo.png'] },
    ]);
    assert.ok(!(await events(s, 'filechooser')).length);
  });
});

test('file input: single choice replaces the selection; Cancel sets nothing', async () => {
  await withSession({ files: filesDir() }, async (s) => {
    await s.act(click(150, 515));
    let g = await s.evalHarness('window.__uxPickerGeometry()');
    assert.equal(g.rows.length, 3);
    await s.act(at(g.rows[0]));
    await s.act(at(g.rows[1]));
    await s.act(at(g.ok));
    assert.equal(await s.evalHarness("[...document.getElementById('single').files].map((f) => f.name).join()"), 'notes.txt');
    await s.act(click(150, 115));
    g = await s.evalHarness('window.__uxPickerGeometry()');
    await s.act(at(g.cancel));
    assert.equal(await text(s, 'out-file'), 'no file');
    assert.deepEqual((await events(s, 'picker-file')).map((e) => e.type).slice(-2), ['picker-file-shown', 'picker-file-cancel']);
  });
});

test('file input without a files dir: "No files available" and only Cancel; Escape closes it', () => withSession({}, async (s) => {
  const r = await s.act(click(150, 115));
  const g = await s.evalHarness('window.__uxPickerGeometry()');
  assert.equal(g.rows.length, 0);
  assert.equal(g.ok, null);
  assert.match(g.text, /No files available/);
  assertPainted(r.png, g.box);
  await s.act(step({ type: 'press_key', key: 'Escape' }));
  assert.equal(await s.evalHarness('window.__uxPickerGeometry()'), null);
  assert.equal(await text(s, 'out-file'), 'no file');
}));

test('showing a stand-in from harness code grants no user activation', () => withSession({ files: filesDir() }, async (s) => {
  // Screenshots must not grant activation either (Playwright's page.screenshot does).
  await s.act(step({ type: 'look' }));
  assert.equal(await s.evalHarness('navigator.userActivation.hasBeenActive'), false, 'no activation after the free look');
  await s.evalHarness("window.__uxShowFilePicker([{name: 'a.txt', size: 1}], '', false)");
  assert.equal((await s.evalHarness('window.__uxPickerGeometry()')).rows.length, 1);
  assert.equal(await s.evalHarness('navigator.userActivation.hasBeenActive'), false);
  await assert.rejects(s.evalHarness("document.getElementById('date').showPicker()"), /NotAllowedError|user gesture/);
  assert.equal(await s.evalHarness('window.__uxInputPickerGeometry()'), null);
}));

test('date input: visible month grid; a day sets the value through a React-style controlled input', () => withSession({}, async (s) => {
  const r = await s.act(click(150, 175));
  const g = await s.evalHarness('window.__uxInputPickerGeometry()');
  assert.equal(g.type, 'date');
  assert.equal(g.format, 'YYYY-MM-DD');
  assert.ok(g.days.length >= 28 && g.prev && g.next);
  assert.ok(g.box.y >= 190, 'opens below the input');
  assertPainted(r.png, g.box);
  await s.act(at(g.next));
  const g2 = await s.evalHarness('window.__uxInputPickerGeometry()');
  assert.notEqual(g2.month, g.month);
  const day = g2.days.find((d) => d.day === 15);
  await s.act(at(day));
  assert.equal(await s.evalHarness('window.__uxInputPickerGeometry()'), null);
  const v = await value(s, 'date');
  assert.match(v, /^\d{4}-\d{2}-15$/);
  assert.equal(await text(s, 'out-date'), `state ${v}`);
  await s.evalHarness('window.rerender()');
  assert.equal(await value(s, 'date'), v, 'value survives a re-render');
  const ev = await events(s, 'picker-date');
  // `type` is the signal's own field, so the input's type is logged as input_type.
  assert.deepEqual(ev.map((e) => [e.type, e.input_type]), [['picker-date-shown', 'date'], ['picker-date', 'date']]);
  assert.equal(ev[1].value, v);
}));

test('time input: typing into the stand-in field and Enter; Escape cancels', () => withSession({}, async (s) => {
  await s.act(click(150, 235));
  const g = await s.evalHarness('window.__uxInputPickerGeometry()');
  assert.equal(g.format, 'HH:MM');
  await s.act(step({ type: 'type', text: '13:45' }));
  await s.act(step({ type: 'press_key', key: 'Enter' }));
  assert.equal(await value(s, 'time'), '13:45');
  assert.equal(await text(s, 'out-time'), 'state 13:45');
  await s.act(click(150, 235));
  await s.act(step({ type: 'type', text: '09:00' }));
  await s.act(step({ type: 'press_key', key: 'Escape' }));
  assert.equal(await value(s, 'time'), '13:45');
  assert.equal((await events(s, 'picker-date')).at(-1).type, 'picker-date-cancel');
}));

test('date input: keyboard typing still works when focus arrives by Tab', () => withSession({}, async (s) => {
  await s.act(step({ type: 'press_key', key: 'Tab' }));
  await s.act(step({ type: 'press_key', key: 'Tab' }));
  assert.equal(await s.evalHarness('document.activeElement.id'), 'date');
  // Day and month are both 01, so this holds for day-first and month-first locales.
  await s.act(step({ type: 'type', text: '01012026' }));
  assert.equal(await value(s, 'date'), '2026-01-01');
  assert.equal(await s.evalHarness('window.__uxInputPickerGeometry()'), null);
}));

test('color input: 16 swatches and a hex field', () => withSession({}, async (s) => {
  const r = await s.act(click(150, 295));
  const g = await s.evalHarness('window.__uxInputPickerGeometry()');
  assert.equal(g.type, 'color');
  assert.equal(g.swatches.length, 16);
  assertPainted(r.png, g.box);
  await s.act(at(g.swatches[3]));
  const swatch = await value(s, 'color');
  assert.notEqual(swatch, '#000000');
  assert.equal(await text(s, 'out-color'), `state ${swatch}`);
  await s.act(click(150, 295));
  await s.act(step({ type: 'type', text: '#336699' }));
  await s.act(step({ type: 'press_key', key: 'Enter' }));
  assert.equal(await value(s, 'color'), '#336699');
  const ev = await events(s, 'picker-color');
  assert.deepEqual(ev.map((e) => e.type), ['picker-color-shown', 'picker-color', 'picker-color-shown', 'picker-color']);
  assert.equal(ev[3].value, '#336699');
}));

test('permission prompt: Allow reaches the page, is remembered; Block rejects', () => withSession({}, async (s) => {
  const r = await s.act(click(150, 355));
  let g = await s.evalHarness('window.__uxPermissionGeometry()');
  assert.match(g.text, /http:\/\/127\.0\.0\.1:\d+ wants to use your microphone/);
  assert.match(g.text, /Simulated system dialog \(test harness\)/);
  assertPainted(r.png, g.box);
  await s.act(at(g.allow));
  assert.equal(await textWhen(s, 'out-perm', 'mic ok 1 1'), 'mic ok 1 1');
  await s.act(click(150, 355));
  assert.equal(await s.evalHarness('window.__uxPermissionGeometry()'), null, 'no second prompt');
  assert.equal(await textWhen(s, 'out-perm', 'mic ok 2 1'), 'mic ok 2 1');
  await s.act(click(150, 405));
  g = await s.evalHarness('window.__uxPermissionGeometry()');
  assert.match(g.text, /wants to show notifications/);
  await s.act(at(g.block));
  assert.equal(await text(s, 'out-perm'), 'notify denied');
  await s.act(click(150, 455));
  g = await s.evalHarness('window.__uxPermissionGeometry()');
  await s.act(at(g.allow));
  assert.equal(await textWhen(s, 'out-perm', 'geo 13.7563,100.5018'), 'geo 13.7563,100.5018');
  await s.act(step({ type: 'reload' }));
  await s.act(click(150, 405));
  assert.equal(await s.evalHarness('window.__uxPermissionGeometry()'), null, 'remembered across documents');
  assert.equal(await text(s, 'out-perm'), 'notify denied');
  const ev = await events(s, 'permission');
  assert.deepEqual(ev.map((e) => [e.type, e.kind, e.decision]), [
    ['permission-shown', 'microphone', undefined], ['permission', 'microphone', 'allow'],
    ['permission-shown', 'notifications', undefined], ['permission', 'notifications', 'block'],
    ['permission-shown', 'geolocation', undefined], ['permission', 'geolocation', 'allow'],
  ]);
}));

test('permissions deny and grant modes never prompt', async () => {
  await withSession({ permissions: 'deny' }, async (s) => {
    await s.act(click(150, 355));
    assert.equal(await s.evalHarness('window.__uxPermissionGeometry()'), null);
    assert.equal(await text(s, 'out-perm'), 'mic NotAllowedError');
    assert.deepEqual((await events(s, 'permission')).map((e) => [e.type, e.kind, e.decision]), [['permission', 'microphone', 'block']]);
  });
  await withSession({ permissions: 'grant' }, async (s) => {
    await s.act(click(150, 405));
    assert.equal(await text(s, 'out-perm'), 'notify granted');
    await s.act(click(150, 355));
    assert.equal(await textWhen(s, 'out-perm', 'mic ok 1 1'), 'mic ok 1 1');
    assert.equal(await s.evalHarness('window.__uxPermissionGeometry()'), null);
  });
});

test('beforeunload is answered "Leave" and the persona is told', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-nat-'));
  const s = await Session.start({ id: 'unl', dir, url: fx.url('unload.html') });
  try {
    await s.act(click(150, 130));
    await s.act(step({ type: 'type', text: 'draft' }));
    const r = await s.act(click(115, 208));
    assert.ok(r.text.includes('A browser dialog asked "Leave site? Changes you made may not be saved." — it was answered "Leave".'), r.text);
    assert.match(r.text, /Address bar: .*basic\.html/);
  } finally { await s.stop(); }
});
