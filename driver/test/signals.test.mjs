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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-sig-'));
const step = (action) => ({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action });
const click = (x, y) => step({ type: 'click', x, y });
const readSignals = (dir) => fs.readFileSync(path.join(dir, 'signals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const status = (s) => s.evalHarness("document.getElementById('status').textContent");
// The stand-in lives in a closed shadow root; find it by its host and read geometry from the host.
const pickerOpen = (s) => s.evalHarness("!!document.querySelector('[data-ux-harness=picker]')");
// The fixture sets its status from an async handler that finishes after the step has returned
// (eventually.mjs): a write or a read in the origin-private file system, or the catch of a cancelled
// picker. Every status the app writes is read with statusAfter, which waits for it to leave `from`;
// the Open stand-in lists the folder before it appears, so it is waited for too.
const statusAfter = (s, from) => eventually(() => status(s), (v) => v !== from);
const openPicker = (s) => eventually(() => s.evalHarness('window.__uxPickerGeometry?.() ?? null'), (g) => g?.title === 'Open');

test('audio tap: sound after a click shows up in the audio signal', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'aud', dir, url: fx.url('audio.html') });
  try {
    await s.act(click(160, 120));
    await s.act(step({ type: 'wait', seconds: 1 }));
    const sig = await s.signals();
    assert.ok(sig.audio.maxPeak > 0.01, `maxPeak ${sig.audio.maxPeak}`);
    assert.ok(sig.audio.nonSilentMs > 0);
    assert.deepEqual(sig.audio.states, ['running']);
    assert.ok(readSignals(dir).some((e) => e.type === 'audio' && e.step === 2 && e.maxPeak > 0.01));
    await s.act(step({ type: 'reload' })); // new document: in-page stats reset
    const after = await s.signals();
    assert.equal(after.audio.maxPeak, 0, 'current document has no sound');
    assert.ok(after.audio_session.maxPeak > 0.01, 'session totals survive the reload');
    assert.equal(after.audio_session.documents, 2);
    assert.ok(after.audio_session.nonSilentMs >= sig.audio.nonSilentMs);
  } finally { await s.stop(); }
});

test('autoplay is gesture-gated: audio started on load stays suspended, even across harness reads and steps', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'aud2', dir, url: fx.url('autoplay.html') });
  try {
    await s.evalHarness('1 + 1'); // harness eval must not grant user activation
    await s.act(step({ type: 'look' })); // the per-step audio read must not either
    await s.act(step({ type: 'wait', seconds: 1 }));
    const sig = await s.signals();
    assert.deepEqual(sig.audio.states, ['suspended']);
    assert.equal(sig.audio.maxPeak, 0);
    await s.act(click(10, 10)); // a real click is a user gesture; the page did not resume() though
    assert.deepEqual((await s.signals()).audio.states, ['suspended']);
  } finally { await s.stop(); }
});

test('autoplay free mode lets audio start on load', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'aud3', dir, url: fx.url('autoplay.html'), autoplay: 'free' });
  try {
    await s.act(step({ type: 'wait', seconds: 1 }));
    assert.deepEqual((await s.signals()).audio.states, ['running']);
  } finally { await s.stop(); }
});

test('page errors, console errors, native dialogs and downloads are logged as signals', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'err', dir, url: fx.url('errors.html') });
  try {
    await s.act(click(160, 120));
    const alert = await s.act(click(160, 220));
    assert.equal(alert.ok, true, 'a native alert does not hang the action');
    assert.match(alert.text, /pop-up \(alert\) said: "Hello from alert"/);
    assert.equal(await s.evalHarness('document.title'), 'after alert');
    const dl = await s.act(click(160, 320));
    assert.match(dl.text, /downloaded a file named "hello.txt"/);
    // The copy into downloads/ and its signal come after the step has returned (eventually.mjs).
    const types = await eventually(() => readSignals(dir).map((e) => e.type), (v) => v.includes('download'));
    for (const t of ['setup', 'pageerror', 'console-error', 'dialog', 'download']) assert.ok(types.includes(t), `missing ${t}: ${types}`);
    assert.equal(fs.readFileSync(path.join(dir, 'downloads', 'hello.txt'), 'utf8'), 'hello');
    const pe = readSignals(dir).find((e) => e.type === 'pageerror');
    assert.equal(pe.step, 1);
    assert.match(pe.msg, /boom thrown/);
  } finally { await s.stop(); }
});

test('stop writes a final signal and deletes the profile', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'stop', dir, url: fx.url('basic.html') });
  await s.stop();
  await s.stop(); // idempotent
  assert.equal(fs.existsSync(s.profileDir), false);
  assert.equal(readSignals(dir).at(-1).type, 'stop');
  const r = await s.act(click(10, 10));
  assert.match(r.text, /^SESSION_STOPPED/);
});

test('save picker shim: visible stand-in, Save writes through the app code path', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'save', dir, url: fx.url('save.html') });
  try {
    const shown = await s.act(click(160, 120)); // app's Save button
    assert.equal(shown.ok, true);
    assert.equal(await pickerOpen(s), true, 'stand-in dialog is in the page');
    assert.equal(await status(s), 'idle', 'app is still waiting on the picker');
    // Stand-in: 440px window centred in 1280x800; buttons bottom-right. Press Enter = Save.
    await s.act(step({ type: 'press_key', key: 'Enter' }));
    assert.equal(await pickerOpen(s), false);
    assert.equal(await statusAfter(s, 'idle'), 'saved song.json');
    const sig = await s.signals();
    assert.deepEqual(sig.opfs, { 'song.json': 11 });
    await s.stop();
    assert.deepEqual(readSignals(dir).at(-1).opfs, { 'song.json': 11 }, 'stop signal lists saved files');
    const kinds = sig.events.filter((e) => e.type.startsWith('picker-')).map((e) => e.type);
    assert.deepEqual(kinds, ['picker-save-shown', 'picker-save']);
  } finally { await s.stop(); }
});

test('save stand-in: visible in the screenshot, clickable by coordinates; Cancel aborts', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'save2', dir, url: fx.url('save.html') });
  try {
    const before = await s.act(step({ type: 'look' }));
    const shown = await s.act(click(160, 120));
    assert.equal(shown.ok, true);
    assert.ok(!shown.png.equals(before.png), 'the stand-in changes what the persona sees');
    const geo = await s.evalHarness('window.__uxPickerGeometry()');
    assert.equal(geo.title, 'Save As');
    await s.act(click(geo.cancel.x, geo.cancel.y));
    assert.equal(await pickerOpen(s), false);
    assert.equal(await statusAfter(s, 'idle'), 'save failed: AbortError');
    const kinds = (await s.signals()).events.filter((e) => e.type.startsWith('picker-')).map((e) => e.type);
    assert.deepEqual(kinds, ['picker-save-shown', 'picker-save-cancel']);
  } finally { await s.stop(); }
});

test('save stand-in: typing replaces the base name and keeps the extension; Escape cancels open', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'open', dir, url: fx.url('save.html') });
  try {
    await s.act(click(160, 120));
    await s.act(step({ type: 'type', text: 'my beat' }));
    const geo = await s.evalHarness('window.__uxPickerGeometry()');
    await s.act(click(geo.ok.x, geo.ok.y));
    assert.equal(await statusAfter(s, 'idle'), 'saved my beat.json');
    await s.act(click(320, 120)); // app's Open button
    assert.equal((await openPicker(s))?.title, 'Open');
    await s.act(step({ type: 'press_key', key: 'Enter' })); // nothing selected: Open is disabled
    assert.equal(await pickerOpen(s), true);
    await s.act(step({ type: 'press_key', key: 'Escape' }));
    assert.equal(await statusAfter(s, 'saved my beat.json'), 'open failed: AbortError');
  } finally { await s.stop(); }
});

test('only one picker at a time, like Chromium', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'twice', dir, url: fx.url('save.html') });
  try {
    await s.act(click(160, 120));
    const err = await s.evalHarness("showOpenFilePicker().then(() => 'opened', (e) => e.name)");
    assert.equal(err, 'NotAllowedError');
  } finally { await s.stop(); }
});

test('app keyboard shortcuts do not fire while typing in the stand-in', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'keys', dir, url: fx.url('save.html') });
  try {
    await s.evalHarness("window.__keys = 0; document.addEventListener('keydown', () => window.__keys++)");
    await s.act(click(160, 120));
    await s.act(step({ type: 'type', text: 'x y' }));
    assert.equal(await s.evalHarness('window.__keys'), 0);
  } finally { await s.stop(); }
});

test('open stand-in: clicking a listed file and Open returns that file', async () => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'open2', dir, url: fx.url('save.html') });
  try {
    await s.act(click(160, 120));
    await s.act(step({ type: 'press_key', key: 'Enter' }));
    assert.equal(await statusAfter(s, 'idle'), 'saved song.json'); // the file exists before Open lists the folder
    await s.act(click(320, 120));
    const geo = await openPicker(s);
    assert.ok(geo?.rows?.length === 1, JSON.stringify(geo));
    const [r] = geo.rows;
    await s.act(click(r.x, r.y));
    await s.act(click(geo.ok.x, geo.ok.y));
    assert.equal(await statusAfter(s, 'saved song.json'), 'opened song.json: hello world');
    const kinds = (await s.signals()).events.filter((e) => e.type.startsWith('picker-')).map((e) => e.type);
    assert.deepEqual(kinds, ['picker-save-shown', 'picker-save', 'picker-open-shown', 'picker-open']);
  } finally { await s.stop(); }
});
