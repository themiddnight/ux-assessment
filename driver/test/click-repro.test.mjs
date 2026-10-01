// SPEC §11: the spike saw `Input.dispatchMouseEvent: Invalid parameters` on a click. Reproduced in M1
// only with non-finite coordinates (NaN / Infinity — e.g. `+"640,"` or a missing y); popups, native
// dialogs, navigation on mousedown, crashes and concurrent clicks do not produce it. These tests pin
// that persona input can no longer reach CDP with such values, and that page-level surprises during
// a click never break the session.
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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-click-'));
const step = (action) => ({ observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action });
const click = (x, y) => step({ type: 'click', x, y });
const logLines = (dir) => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const signalTypes = (dir) => fs.readFileSync(path.join(dir, 'signals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
const withSession = async (fn, opts = {}) => {
  const dir = tmpDir();
  const s = await Session.start({ id: 'click', dir, url: fx.url('clicky.html'), ...opts });
  try { await fn(s, dir); } finally { await s.stop(); }
};

test('non-finite or non-numeric coordinates are rejected before reaching the browser', () => withSession(async (s, dir) => {
  for (const [x, y] of [[NaN, 38], [Infinity, 38], ['640,', 38], [640, undefined], [null, null]]) {
    const r = await s.act(click(x, y));
    assert.equal(r.ok, false);
    assert.match(r.text, /^INVALID_ACTION/);
  }
  assert.equal(s.steps, 0);
  assert.ok(!signalTypes(dir).includes('action-error'));
}));

test('navigation on mousedown: click completes and lands on the new page', () => withSession(async (s) => {
  const r = await s.act(click(180, 38));
  assert.equal(r.ok, true);
  assert.match(r.text, /from=down/);
}));

test('confirm() on mousedown: persona is told what the pop-up said', () => withSession(async (s) => {
  const r = await s.act(click(180, 388));
  assert.equal(r.ok, true);
  assert.match(r.text, /pop-up \(confirm\) said: "Sure\?"/);
  assert.equal(await s.evalHarness('document.title'), 'confirm: true');
}));

test('a click that opens a new tab moves the session to that tab', () => withSession(async (s, dir) => {
  const r = await s.act(click(180, 438));
  assert.equal(r.ok, true);
  assert.match(r.text, /new browser tab opened/);
  assert.match(r.text, /popup=1/);
  assert.ok(signalTypes(dir).includes('new-page'));
  const back = await s.act(click(160, 120)); // acts on the new tab
  assert.equal(back.ok, true);
}));

test('a tab that closes itself returns the session to the previous tab', () => withSession(async (s, dir) => {
  const opened = await s.act(click(180, 488));
  assert.match(opened.text, /closer\.html/);
  const r = await s.act(click(180, 120)); // "Close this tab" in the popup
  assert.equal(r.ok, true);
  assert.match(r.text, /tab closed/i);
  assert.match(r.text, /clicky\.html/);
  assert.ok(signalTypes(dir).includes('page-closed'));
  assert.equal((await s.act(step({ type: 'look' }))).ok, true);
}));

test('a crashed page is reported to the persona and logged, not thrown', () => withSession(async (s, dir) => {
  const cdp = await s.context.newCDPSession(s.page);
  // Wait for the crash itself, not for a fixed time: on Linux CI the renderer once took longer than
  // a second to die, the look began on a page that only hung, and its screenshot was still pending
  // when the renderer went, which takes Chromium down with it (the tests below cover that case).
  const crashed = new Promise((r) => s.page.once('crash', r));
  cdp.send('Page.crash').catch(() => {}); // never resolves: the target is gone
  await crashed;
  const r = await s.act(step({ type: 'look' }));
  assert.equal(r.ok, true);
  assert.match(r.text, /crashed/i);
  assert.ok(signalTypes(dir).includes('crash'));
  const reload = await s.act(step({ type: 'reload' }));
  assert.equal(reload.ok, true);
  assert.ok(reload.png, 'after reload the page renders again');
}));

// The browser itself can go, not only a page (Chromium dies when a renderer is killed while a
// screenshot is pending). Browser.close is what the driver sees then: the context closes under it.
const quitBrowser = async (s) => {
  const cdp = await s.context.newCDPSession(s.page);
  cdp.send('Browser.close').catch(() => {}); // the answer may never come: the browser is gone
};

test('a browser that quits between steps ends the session: reported and logged, not thrown', () => withSession(async (s, dir) => {
  const closed = new Promise((r) => s.context.once('close', r));
  await quitBrowser(s);
  await closed;
  const r = await s.act(step({ type: 'look' }));
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.text, /^BROWSER_CLOSED\. .*Call end_session now/);
  assert.doesNotMatch(r.text, /tab closed/i);
  assert.ok(signalTypes(dir).includes('browser-closed'));
  // The page's own close comes first when the browser quits: that is not the app closing a tab.
  assert.ok(!signalTypes(dir).includes('page-closed'));
  assert.ok(!signalTypes(dir).includes('action-error'));
  assert.equal(s.steps, 0, 'a refused act uses no step');
  assert.equal(logLines(dir).at(-1).refused, 'BROWSER_CLOSED', 'the first refusal is logged');
  await s.act(step({ type: 'look' }));
  assert.equal(logLines(dir).filter((l) => l.refused).length, 1, 'and only the first');
  assert.match(s.end({ outcome: 'gave_up', exit_interview: 'x' }), /Exit interview recorded/);
}));

test('a browser that quits during a step is reported in that step, and the next act is refused', () => withSession(async (s, dir) => {
  await s.act(step({ type: 'look' }));
  const timer = setTimeout(() => quitBrowser(s).catch(() => {}), 500); // while the wait below is running
  try {
    const r = await s.act(step({ type: 'wait', seconds: 2 }));
    assert.equal(r.ok, true);
    assert.match(r.text, /browser quit unexpectedly/);
    // Neither the tab nor the action is what failed: the persona is told about the browser only.
    assert.doesNotMatch(r.text, /tab closed|could not complete that action/i);
    assert.equal(r.png, null);
  } finally { clearTimeout(timer); }
  assert.ok(signalTypes(dir).includes('browser-closed'));
  assert.ok(!signalTypes(dir).includes('page-closed'));
  assert.ok(!signalTypes(dir).includes('action-error'));
  assert.equal(logLines(dir).at(-1).step, 1, 'the step the browser quit in is logged');
  assert.equal(logLines(dir).at(-1).action_error, undefined);
  const next = await s.act(step({ type: 'look' }));
  assert.equal(next.refused, true);
  assert.match(next.text, /^BROWSER_CLOSED/);
  assert.equal(logLines(dir).at(-1).refused, 'BROWSER_CLOSED');
  assert.equal(s.steps, 1);
}));

test('a click that blocks the main thread still returns', () => withSession(async (s) => {
  const r = await s.act(click(180, 338));
  assert.equal(r.ok, true);
}));
