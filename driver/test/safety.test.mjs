// Enforced safety (SPEC D12): the harness, not the persona's good will, stops a run before a
// payment, an e-mail or leaving the app. Requests are aborted before they reach any server.
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
const STOP = (label) => `STOP: this would take you to "${label}". The test ends here — do not try again. Call end_session with outcome stop_before and describe what you expected to happen next.`;
// Fake external hosts resolve to the fixture server, so nothing touches the real network.
const RESOLVE = ['--host-resolver-rules=MAP fake-external.test 127.0.0.1, MAP fake-cdn.test 127.0.0.1'];
const withSession = async (opts, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-safe-'));
  const s = await Session.start({ id: 'safe', dir, url: fx.url('safety.html'), chromiumArgs: RESOLVE, ...opts });
  try { await fn(s); } finally { await s.stop(); }
};
const kinds = async (s, type) => (await s.signals()).events.filter((e) => e.type === type);

test('default: a link off the app is aborted with the STOP note; the persona stays', () => withSession({}, async (s) => {
  const r = await s.act(click(120, 110));
  const label = 'leaving the app (example.invalid)';
  assert.ok(r.text.includes(STOP(label)), r.text);
  assert.match(r.text, /Address bar: .*safety\.html/);
  const sig = await s.signals();
  assert.equal(sig.stop_before, label);
  assert.deepEqual((await kinds(s, 'stop-before')).map((e) => [e.label, e.method, e.url]), [[label, 'GET', 'http://example.invalid/']]);
  assert.equal((await kinds(s, 'request-failed')).length, 0, 'the abort is not reported as a failure');
  const again = await s.act(step({ type: 'look' }));
  assert.equal(again.ok, true, 'act never refuses after stop-before');
  assert.ok(!again.text.includes('STOP:'), 'the note is sent once');
}));

test('stop_before max: the first N matching requests pass, the next one stops', () => withSession(
  { safety: { stop_before: [{ pattern: '/api/pay', label: 'payment', max: 1 }] } }, async (s) => {
    const before = fx.requests.filter((q) => q.path.startsWith('/api/pay')).length;
    const first = await s.act(click(180, 178));
    assert.ok(!first.text.includes('STOP:'), first.text);
    assert.equal(fx.requests.filter((q) => q.path.startsWith('/api/pay')).length, before + 1, 'the first call reached the server');
    assert.equal((await kinds(s, 'limited')).length, 1);
    const second = await s.act(click(180, 178));
    assert.ok(second.text.includes(STOP('payment')), second.text);
    assert.equal(fx.requests.filter((q) => q.path.startsWith('/api/pay')).length, before + 1, 'the second call never left');
    assert.equal((await s.signals()).stop_before, 'payment');
  }));

test('stop_before max on a navigation: the allowed navigation is counted once and does not stop', () => withSession(
  { url: fx.url(`safety.html?ext=${encodeURIComponent('/basic.html?max')}`), safety: { stop_before: [{ pattern: '/basic.html', label: 'basic', max: 1 }] } }, async (s) => {
    const r = await s.act(click(120, 290));
    assert.ok(!r.text.includes('STOP:'), r.text);
    assert.match(r.text, /Address bar: .*basic\.html\?max/);
    assert.equal((await kinds(s, 'limited')).length, 1);
    assert.equal((await s.signals()).stop_before, null);
  }));

test('stop_before max on a redirect hop: the hop is counted once and does not stop', () => withSession(
  { url: fx.url(`safety.html?ext=${encodeURIComponent(`/redirect?to=${encodeURIComponent('/basic.html?hop')}`)}`), safety: { stop_before: [{ pattern: '/basic.html', label: 'basic', max: 1 }] } }, async (s) => {
    const r = await s.act(click(120, 290));
    assert.ok(!r.text.includes('STOP:'), r.text);
    assert.match(r.text, /Address bar: .*basic\.html\?hop/);
    assert.equal((await kinds(s, 'limited')).length, 1);
    assert.equal((await s.signals()).stop_before, null);
  }));

test('stop_before pattern: the payment request never reaches the server', () => withSession(
  { safety: { stop_before: [{ pattern: '/api/pay', label: 'payment' }] } }, async (s) => {
    const pays = () => fx.requests.filter((q) => q.path.startsWith('/api/pay')).length;
    const before = pays();
    const r = await s.act(click(180, 178));
    assert.ok(r.text.includes(STOP('payment')), r.text);
    assert.equal(pays(), before, 'the request never reached the server');
    assert.equal((await s.signals()).stop_before, 'payment');
    const [e] = await kinds(s, 'stop-before');
    assert.equal(e.method, 'POST');
  }));

test('regex patterns and block: blocked requests log a signal and send no note', () => withSession(
  { safety: { block: ['/\\/api\\/TRACK/i'] } }, async (s) => {
    const r = await s.act(click(180, 238));
    assert.ok(!r.text.includes('STOP:'), r.text);
    assert.equal(await s.evalHarness("document.getElementById('out').textContent"), 'failed');
    assert.equal(fx.requests.some((q) => q.path.startsWith('/api/track')), false);
    assert.deepEqual((await kinds(s, 'blocked')).map((e) => new URL(e.url).pathname), ['/api/track']);
    assert.equal((await s.signals()).stop_before, null);
  }));

test('other-host subresources load; external_navigation stop vs allow', async () => {
  const ext = `http://fake-external.test:${fx.port}/basic.html`;
  const cdn = `http://fake-cdn.test:${fx.port}/cdn.js`;
  const q = `safety.html?ext=${encodeURIComponent(ext)}&cdn=${encodeURIComponent(cdn)}`;
  await withSession({ url: fx.url(q) }, async (s) => {
    assert.equal(await s.evalHarness('window.cdnLoaded === true'), true, 'a script from another host still loads');
    const r = await s.act(click(120, 290));
    assert.ok(r.text.includes(STOP('leaving the app (fake-external.test)')), r.text);
  });
  await withSession({ url: fx.url(q), safety: { external_navigation: 'allow' } }, async (s) => {
    const r = await s.act(click(120, 290));
    assert.ok(!r.text.includes('STOP:'), r.text);
    assert.match(r.text, /Address bar: http:\/\/fake-external\.test:\d+\/basic\.html/);
  });
  await withSession({ url: fx.url(q), safety: { allow_hosts: ['fake-external.test'] } }, async (s) => {
    const r = await s.act(click(120, 290));
    assert.match(r.text, /Address bar: http:\/\/fake-external\.test/);
  });
});

test('a popup leaving the app is stopped and closed', () => withSession({}, async (s) => {
  const r = await s.act(click(180, 358));
  assert.ok(r.text.includes(STOP('leaving the app (example.invalid)')), r.text);
  assert.match(r.text, /Address bar: .*safety\.html/);
  assert.equal(s.context.pages().length, 1);
}));

test('backstop: a popup navigation the route never saw still stops the run and the popup closes (fail closed)', () => withSession({}, async (s) => {
  await s.context.unrouteAll(); // what CI saw once: the popup's first navigation bypassed the route
  const r = await s.act(click(180, 358));
  assert.ok(r.text.includes(STOP('leaving the app (example.invalid)')), r.text);
  assert.equal((await s.signals()).stop_before, 'leaving the app (example.invalid)');
  assert.equal((await kinds(s, 'route-bypassed')).length, 1);
  assert.equal(s.context.pages().length, 1, 'the popup is closed');
}));

test('window.open(url): the popup starts blank and the harness loads the URL through the route; the opener stays', async () => {
  await withSession({ url: fx.url(`safety.html?popup=${encodeURIComponent('/basic.html?pop')}`) }, async (s) => {
    const r = await s.act(click(180, 358));
    assert.match(r.text, /Address bar: .*basic\.html\?pop/, r.text);
    assert.equal(await s.evalHarness('window.opener !== null'), true);
    assert.equal(await s.evalHarness('window.__uxPopupUrl'), undefined, 'the handed-over URL is gone');
    assert.equal(fx.requests.filter((q) => q.path === '/basic.html?pop').length, 1);
  });
});

test('backstop: a noopener popup the route never saw still stops the run and the popup closes', () => withSession(
  { url: fx.url('safety.html?features=noopener') }, async (s) => {
    await s.context.unrouteAll();
    const r = await s.act(click(180, 358));
    assert.ok(r.text.includes(STOP('leaving the app (example.invalid)')), r.text);
    assert.equal((await kinds(s, 'route-bypassed')).length, 1);
    assert.equal(s.context.pages().length, 1, 'the popup is closed');
  }));

test('service workers: blocked when safety has patterns, otherwise a setup warning', async () => {
  await withSession({ url: fx.url('sw.html'), safety: { block: ['/nothing-here'] } }, async (s) => {
    await s.act(step({ type: 'reload' }));
    assert.equal(await s.evalHarness('navigator.serviceWorker.controller'), null);
    assert.ok(!(await s.signals()).events.some((e) => e.warning === 'service-worker-bypasses-safety'));
  });
  await withSession({ url: fx.url('sw.html') }, async (s) => {
    // Only an active worker controls the reload: a slow machine may still be installing it (Windows CI).
    assert.equal(await s.evalHarness('navigator.serviceWorker.ready.then(() => true)'), true);
    await s.act(step({ type: 'reload' }));
    assert.equal(await s.evalHarness('!!navigator.serviceWorker.controller'), true);
    const warnings = (await s.signals()).events.filter((e) => e.warning === 'service-worker-bypasses-safety');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, 'setup');
  });
});

test('server redirects are judged hop by hop', async () => {
  const via = (to) => fx.url(`safety.html?ext=${encodeURIComponent(`/redirect?to=${encodeURIComponent(to)}`)}`);
  const ext = `http://fake-external.test:${fx.port}/basic.html?leaked`;
  await withSession({ url: via(ext) }, async (s) => {
    const seen = fx.requests.length;
    const r = await s.act(click(120, 290));
    assert.ok(r.text.includes(STOP('leaving the app (fake-external.test)')), r.text);
    assert.match(r.text, /Address bar: .*safety\.html/);
    assert.equal(fx.requests.slice(seen).some((q) => q.host.startsWith('fake-external.test')), false, 'the external page never loads');
    assert.ok(fx.requests.slice(seen).some((q) => q.path.startsWith('/redirect')), 'the redirect itself was requested');
  });
  await withSession({ url: via('/api/pay?order=1'), safety: { stop_before: [{ pattern: '/api/pay', label: 'payment' }] } }, async (s) => {
    const paySeen = fx.requests.length;
    const r = await s.act(click(120, 290));
    assert.ok(r.text.includes(STOP('payment')), r.text);
    assert.equal(fx.requests.slice(paySeen).some((q) => q.path.startsWith('/api/pay')), false);
    // A fetch whose redirect leads to the pattern is stopped too.
    assert.equal(await s.evalHarness("fetch('/redirect?to=%2Fapi%2Fpay%3Fvia%3Dfetch').then(() => 'loaded', () => 'failed')"), 'failed');
    assert.equal(fx.requests.slice(paySeen).some((q) => q.path.startsWith('/api/pay')), false);
    assert.equal((await kinds(s, 'stop-before')).at(-1).via.includes('/redirect'), true);
    assert.equal((await kinds(s, 'request-failed')).length, 0);
  });
  await withSession({ url: via('/basic.html?landed') }, async (s) => {
    const r = await s.act(click(120, 290));
    assert.ok(!r.text.includes('STOP'), r.text);
    assert.match(r.text, /Address bar: http:\/\/127\.0\.0\.1:\d+\/basic\.html\?landed/, 'the address bar shows where the redirect went');
    assert.match(await s.evalHarness('document.cookie'), /hop=1/, 'the redirect\'s cookie is kept');
    assert.equal(await s.evalHarness("document.getElementById('count').textContent"), '0');
    const back = await s.act(step({ type: 'back' }));
    assert.match(back.text, /Address bar: .*safety\.html/, 'back returns to the page before the redirect');
  });
});

test('an entry URL that redirects lands where the redirect goes', async () => {
  await withSession({ url: fx.url(`redirect?to=${encodeURIComponent('/basic.html?entry')}`) }, async (s) => {
    const r = await s.act(step({ type: 'look' }));
    assert.match(r.text, /Address bar: .*basic\.html\?entry/);
  });
});
