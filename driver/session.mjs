// One persona browser session: its own Chromium (persistent on-disk profile), an init script for
// harness instrumentation, a mechanical step cap and patience cap, and two logs:
//   <dir>/log.jsonl      persona step log (what the persona claims) — SPEC §6
//   <dir>/signals.jsonl  harness signals (what actually happened) — never shown to the persona
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, diff, animationMask, classify } from './visual.mjs';
import { PageClock, CLOCK_MODES, WAIT_CAP_S, WALL_CAP_MS, NET_IDLE_MS, humanMs } from './clock.mjs';
import { stderrLine, warnOutsideProfile } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  'mobile-small': { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true },
};
export const ACTION_TYPES = ['look', 'click', 'double_click', 'drag', 'type', 'press_key', 'scroll', 'wait', 'reload', 'back'];
export const EVENTS = ['none', 'no_response', 'error_shown', 'went_back', 'not_found', 'asked_twice', 'jargon'];
export const OUTCOMES = ['goal_achieved', 'gave_up', 'step_cap', 'patience_exhausted', 'stop_before'];

const SETTLE_MS = 400;
const EVAL_TIMEOUT_MS = 5000;
const CARET_TIMEOUT_MS = 1500; // hiding the caret is cosmetic: never wait long for a busy page
const SHOT_TIMEOUT_MS = 5000;
const HOVER_MS = 150; // pointer on the target before the pre shot, so hover styles are not a response
const PRE_GAP_MS = 150; // two pre shots this far apart show what is animating right now
const INSTALL_LEAD_MS = 1000; // the page clock pauses this far after install, while only about:blank is open
const STREAMS = new Set(['eventsource', 'media']); // requests that stay open by design: never waited for
const TARGET_CLOSED = /Target page, context or browser has been closed/i; // Playwright's own "the target is gone" error
const BROWSER_GONE = 'the browser quit unexpectedly'; // the browser process went away under the session
const RESPONSE_SETTLE_MS = 50; // after a response, the page handles it before page time moves on
// On Windows, Chrome can still hold files of its profile (Default/chrome_debug.log) for a moment
// after the context closes: removing it then fails with EBUSY (seen on Windows CI). rmSync retries
// EBUSY/EPERM/ENOTEMPTY with a linear backoff, about 5.5 s in all.
const removeProfile = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 300) => String(s).slice(0, n);
function appendPrivate(file, text) {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
  } finally { fs.closeSync(fd); }
}
// http(s) host name of a URL, or null for anything else (about:, data:, blob:, chrome-error:).
const hostOf = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.hostname : null; } catch { return null; } };
// Safety pattern: "/…/flags" is a RegExp; anything else is a case-insensitive substring of the URL.
function matcher(pattern) {
  const re = /^\/(.+)\/([dgimsuvy]*)$/.exec(pattern);
  if (re) { const rx = new RegExp(re[1], re[2].replace(/[gy]/g, '')); return (u) => rx.test(u); }
  const needle = String(pattern).toLowerCase();
  return (u) => u.toLowerCase().includes(needle);
}
// Playwright permission names per prompt kind (a MIDI grant includes sysex).
const PERMISSIONS = { microphone: ['microphone'], camera: ['camera'], midi: ['midi', 'midi-sysex'], notifications: ['notifications'], geolocation: ['geolocation'] };
const GEOLOCATION = { latitude: 13.7563, longitude: 100.5018 };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mid: 'audio/midi', midi: 'audio/midi',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', txt: 'text/plain', csv: 'text/csv', html: 'text/html',
  json: 'application/json', pdf: 'application/pdf', xml: 'application/xml', zip: 'application/zip' };
/** Does a file name match an <input accept> list (".ext", "type/*", "type/sub")? */
function accepts(name, accept) {
  const tokens = String(accept ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const ext = path.extname(name).toLowerCase();
  const mime = MIME[ext.slice(1)] ?? '';
  return tokens.some((t) => (t.startsWith('.') ? ext === t : t.endsWith('/*') ? mime.startsWith(t.slice(0, -1)) : mime === t));
}
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref()),
]);

export class Session {
  /** Launch the browser, open `url` and return the session. Setup is never counted as a step. */
  static async start(opts) {
    const s = new Session(opts);
    try {
      await s.#launch();
    } catch (e) {
      // A failed start (bad storage_state, entry URL unreachable) must not leave Chromium or its profile behind.
      s.stopped = true;
      await s.context?.close().catch(() => {});
      removeProfile(s.profileDir);
      throw e;
    }
    return s;
  }

  constructor({ id, dir, url, viewport = 'desktop', cap = 30, patienceBudget = null, fsMode = 'shim',
    autoplay = 'gesture', headed = false, profileDir, safety = {}, chromiumArgs = [], files = null, permissions = 'prompt', storageState = null,
    clock = 'real', goal = null, waitWallCapMs = WALL_CAP_MS, platform = process.platform, homedir = os.homedir(), warn = stderrLine }) {
    if (!id || !dir || !url) throw new Error('Session needs id, dir and url');
    warnOutsideProfile({ root: dir, platform, homedir, warn }); // D28: file modes are no-ops on Windows
    this.id = id;
    this.dir = path.resolve(dir);
    this.url = url;
    this.device = typeof viewport === 'string' ? VIEWPORTS[viewport] : { viewport };
    if (!this.device?.viewport) throw new Error(`unknown viewport ${JSON.stringify(viewport)}`);
    this.cap = cap;
    this.patienceBudget = patienceBudget;
    this.fsMode = fsMode;
    this.autoplay = autoplay;
    this.headed = headed;
    this.files = files ? path.resolve(files) : null; // files offered by the <input type=file> stand-in
    if (!['prompt', 'grant', 'deny'].includes(permissions)) throw new Error('permissions must be prompt, grant or deny');
    this.permissions = permissions;
    this.storageState = storageState ? path.resolve(storageState) : null; // returning-user start state
    if (!CLOCK_MODES.includes(clock)) throw new Error('clock must be real or controlled');
    this.clockMode = clock; // D22: 'controlled' = the harness owns page time
    this.waitCap = WAIT_CAP_S[clock]; // seconds; the act tool description states it
    this.waitWallCapMs = waitWallCapMs; // real-time cap of one controlled wait (tests lower it)
    this.pageClock = null; // PageClock under clock: controlled, from setup on
    this.requests = new Map(); // request -> start (real ms) while in flight; controlled clock only
    this.vibrated = false; // Chrome accepted a vibrate since the last status: told once, on touch devices
    this.permDecisions = new Map(); // kind -> 'allow' | 'block', remembered for the session like Chrome
    this.fileChooser = null; // {chooser, offered: Set<name>} while the file stand-in is open
    this.inflight = new Set(); // harness work started by page events (file stand-in, setFiles) that a step waits for
    this.chromiumArgs = chromiumArgs; // extra Chromium flags (tests map fake hosts with --host-resolver-rules)
    this.safety = {
      external_navigation: safety?.external_navigation ?? 'stop',
      allow_hosts: safety?.allow_hosts ?? [],
      stop_before: (safety?.stop_before ?? []).map(({ pattern, label, max = 0 }) => ({ label, test: matcher(pattern), max, used: 0 })),
      block: (safety?.block ?? []).map(matcher),
    };
    if (!['stop', 'allow'].includes(this.safety.external_navigation)) throw new Error('safety.external_navigation must be stop or allow');
    this.allowedHosts = new Set([hostOf(url), 'localhost', '127.0.0.1', '[::1]', ...this.safety.allow_hosts].filter(Boolean));
    this.stopBeforeReached = null; // label of the last stop-before, for triage
    this.notedStops = new Set(); // labels already told to the persona this step
    this.aborted = new WeakSet(); // requests the harness aborted: not app failures
    this.routed = new WeakSet(); // requests the safety route has judged: the backstop leaves them alone
    this.judgedNav = new Set(); // main-frame navigation URLs already judged (route, redirect check or backstop)
    this.abortedUrls = new Set(); // requests whose redirect the harness refused: not app failures
    // Profiles live outside the run folder: they are large and never committed.
    this.profileDir = profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `uxa-profile-${id.replace(/[^\w-]/g, '_')}-`));
    this.steps = 0;
    this.frustration = 0;
    this.over = null; // 'STEP_CAP_REACHED' | 'PATIENCE_EXHAUSTED' | 'BROWSER_CLOSED'
    this.browserGone = false; // the browser process went away (it crashed or was killed): nothing can be reopened
    this.browserRefusalLogged = false; // the first BROWSER_CLOSED refusal is in log.jsonl
    this.ended = false; // exit interview recorded
    this.goalChecked = false; // the one-time goal re-check before goal_achieved has been asked
    this.goal = goal?.trim() || null; // the persona's own goal ("What you want"), quoted back by GOAL_CHECK
    this.stopped = false;
    this.events = [];
    this.shots = 0;
    this.freeLookUsed = false;
    this.lastImg = null; // decoded post-screenshot of the previous step (or the initial one)
    this.animMasks = []; // diff(last, pre) of the last 3 steps: what changed with nobody acting
    this.pendingNotes = []; // persona-visible things a screenshot cannot show (native dialogs, new tabs)
    this.closedTabs = []; // URLs of tabs that closed, not yet reported (see #reportClosedTabs)
    this.queue = Promise.resolve();
  }

  get viewport() { return this.device.viewport; }

  async #launch() {
    const screenshotsDir = path.join(this.dir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    fs.chmodSync(screenshotsDir, 0o700);
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: !this.headed,
      // 'gesture' = Chrome's real desktop default. Not `user-gesture-required`: under that flag an
      // AudioContext starts running without any gesture (verified M1), which hides autoplay problems.
      args: [this.autoplay === 'free' ? '--autoplay-policy=no-user-gesture-required' : '--autoplay-policy=document-user-activation-required',
        // Fake camera/microphone: an allowed getUserMedia gets a real (synthetic) stream.
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...this.chromiumArgs],
      ...this.device,
      deviceScaleFactor: 1, // screenshot pixels == CSS pixels == click coordinates
      acceptDownloads: true,
      // Requests a service worker makes itself never pass context.route, so a worker could send a
      // stop_before request unseen. With patterns to enforce, workers are blocked; otherwise a
      // controlling worker is reported (setup warning service-worker-bypasses-safety).
      ...(this.safety.stop_before.length || this.safety.block.length ? { serviceWorkers: 'block' } : {}),
    });
    // A page that crashes leaves its browser running; when the browser itself goes, the context closes.
    // Never rejects: a log line that cannot be written must not become an unhandled rejection.
    this.contextClosed = new Promise((resolve) => this.context.once('close', resolve)).then(() => this.#browserClosed()).catch(() => {});
    await this.context.addInitScript(`globalThis.__uxFsMode__ = ${JSON.stringify(this.fsMode)}; globalThis.__uxPermissionsMode__ = ${JSON.stringify(this.permissions)};`);
    await this.context.addInitScript({ path: path.join(HERE, 'inject.js') });
    if (this.permissions === 'grant') {
      await this.context.grantPermissions(Object.values(PERMISSIONS).flat());
      await this.context.setGeolocation(GEOLOCATION);
    }
    // Safety (SPEC D12): every request of every page, popup and worker passes this route first.
    await this.context.route('**/*', (route) => this.#route(route));
    // Backstop: a popup's first navigation can reach the network without the route aborting it (seen once
    // on Linux CI). A stop-before navigation that got a response or failed on its own still stops the run
    // and closes the popup. `request` fires before the route runs, so the backstop listens after it.
    this.context.on('response', (res) => this.#bypassed(res.request()));
    this.context.on('requestfailed', (req) => this.#bypassed(req));
    this.context.on('page', (p) => {
      if (p === this.page || this.creatingPage) return;
      if (this.closeNextPopup) {
        this.closeNextPopup = false;
        this.#track(p.close().catch(() => {}));
        return;
      }
      this.#watch(p, true);
      this.#track(this.#loadPopupUrl(p));
      this.#signal('new-page', { url: p.url() });
      this.pendingNotes.push('A new browser tab opened and is now in front.');
      this.page = p;
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.#watch(this.page);
    await Promise.allSettled([...this.inflight]); // the harness binding is attached before the entry URL loads
    if (this.storageState) await this.#restoreState();
    this.clockOrigin = Date.now(); // page_time_ms under clock: real counts from here
    if (this.clockMode === 'controlled') await this.#installClock();
    // The entry-URL load and the setup settle run under the pacer (no-op under clock: real).
    this.pageClock?.startPacer();
    try {
      await this.page.goto(this.url, { waitUntil: 'load' });
      await this.page.waitForTimeout(800); // real time: Playwright's own timer, not the page's
      this.lastImg = await this.#rawShot();
    } finally { await this.pageClock?.stopPacer(); }
    this.#signal('setup', { url: this.url, viewport: this.viewport, cap: this.cap, patience_budget: this.patienceBudget, fs: this.fsMode,
      safety: { external_navigation: this.safety.external_navigation, allowed_hosts: [...this.allowedHosts], stop_before: this.safety.stop_before.map((x) => x.label), block: this.safety.block.length },
      files: this.files, permissions: this.permissions, clock: this.clockMode });
  }

  // D22: Date, performance.now, setTimeout, setInterval and requestAnimationFrame of every page and
  // popup are faked and paused; only PageClock moves them, with runFor.
  async #installClock() {
    // Requests in flight, for network-aware chunks: page time never runs far ahead of a response.
    this.context.on('request', (r) => { if (!STREAMS.has(r.resourceType())) this.requests.set(r, Date.now()); });
    this.context.on('requestfinished', (r) => this.requests.delete(r));
    this.context.on('requestfailed', (r) => this.requests.delete(r));
    const t0 = Date.now();
    await this.context.clock.install({ time: t0 });
    // Pausing at a moment the page clock has already passed throws "Cannot fast-forward to the
    // past" (spike): the clock flows from install until the pause. Pause 1 s ahead of *now* (after
    // install resolves), not ahead of t0, so a slow install cannot outrun the lead. Only about:blank
    // is open at this point, so no app timer sees the lead. pauseAt is never used again.
    await this.context.clock.pauseAt(Date.now() + INSTALL_LEAD_MS);
    this.pageClock = new PageClock({
      clock: this.context.clock, wallCapMs: this.waitWallCapMs,
      networkIdle: (ms) => this.#networkIdle(ms),
      signature: () => this.#clockSignature(),
      onError: (kind, e) => this.#clockError(kind, e),
    });
  }

  /** Real-time wait (at most maxMs) until no request younger than NET_IDLE_MS is in flight. */
  async #networkIdle(maxMs) {
    const end = Date.now() + maxMs;
    let waited = false;
    for (;;) {
      const now = Date.now();
      // A request older than NET_IDLE_MS (a hanging call, a long poll) no longer holds page time back.
      for (const [r, t] of this.requests) if (now - t >= NET_IDLE_MS) this.requests.delete(r);
      if (!this.requests.size) break;
      if (now >= end) return;
      waited = true;
      await sleep(25);
    }
    if (waited) await sleep(RESPONSE_SETTLE_MS);
  }

  /** What a user would notice during a wait (inject.js section 7); null when it cannot be read. */
  #clockSignature() {
    if (this.pageBusy || !this.page || this.page.isClosed()) return Promise.resolve(null);
    return this.#evalNoGesture('window.__uxClockSignature?.() ?? null').catch((e) => {
      if (/timed out/.test(e.message)) this.pageBusy = true;
      return null;
    });
  }

  #clockError(kind, e) {
    if (this.stopped) return;
    if (kind === 'stuck') {
      this.pageBusy = true; // the rest of the step skips page evals, as for any busy page
      this.#signal('clock-stuck', { msg: clip(e.message) });
    } else {
      // Only Playwright's own "the target is gone" error means "the harness is closing"; an app
      // timer's own "closed" message (AudioContext, BroadcastChannel, ...) is a real error to report.
      const harnessClosing = this.page?.isClosed() || TARGET_CLOSED.test(e.message);
      if (!harnessClosing) {
        const msg = e.message.replace(/^clock\.runFor:\s*/, ''); // Playwright's own runFor prefix, not the app's
        this.#signal('pageerror', { msg: clip(msg.split('\n')[0]), via: 'timer' });
      }
    }
  }

  /** Page time since setup: harness-advanced under controlled, real elapsed time under real. */
  #pageTime() {
    return this.pageClock ? this.pageClock.elapsedMs : Date.now() - (this.clockOrigin ?? Date.now());
  }

  /** Returning-user start state: cookies, localStorage and IndexedDB, before the entry URL. Not a step. */
  async #restoreState() {
    const state = JSON.parse(fs.readFileSync(this.storageState, 'utf8'));
    // setStorageState works on a persistent context and restores IndexedDB too. It loads each
    // origin in a helper page of its own; that page is not the persona's new tab.
    this.creatingPage = true;
    try {
      await this.context.setStorageState(state);
    } catch (e) {
      const withIdb = state.origins?.some((o) => o.indexedDB?.length);
      if (!withIdb) throw e;
      // Keep the account usable: restore cookies and localStorage, and say what is missing.
      await this.context.setStorageState({ ...state, origins: state.origins.map(({ indexedDB: _, ...o }) => o) });
      this.#signal('setup', { warning: 'indexeddb-not-restored', msg: clip(e.message.split('\n')[0]) });
    } finally { this.creatingPage = false; }
    this.#signal('setup', { storage_state: this.storageState, cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0 });
  }

  /** Harness-only: save cookies, localStorage and IndexedDB for later sessions (a logged-in account). */
  saveState(file) {
    return this.#serial(async () => {
      const target = path.resolve(file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      // Playwright writes to an existing file without changing its permissions. Make the
      // credential-bearing state private before any cookies or tokens are written.
      const fd = fs.openSync(target, 'w', 0o600);
      try { fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
      const st = await this.context.storageState({ path: target, indexedDB: true });
      return { path: target, cookies: st.cookies.length, origins: st.origins.length };
    });
  }

  /** Safety verdict for a URL: {stop: label} | {block: true} | null (allowed). */
  #verdict(url, mainFrameNavigation) {
    const stop = this.safety.stop_before.find((x) => x.test(url));
    if (stop) {
      // `max` matching requests pass (e.g. one question to a paid AI API per persona); the next stops.
      if (stop.used < stop.max) {
        stop.used++;
        this.#signal('limited', { url: clip(url, 200), label: stop.label, used: stop.used, max: stop.max });
        return null;
      }
      return { stop: stop.label };
    }
    if (this.safety.block.some((test) => test(url))) return { block: true };
    // Only a main-frame document navigation is "leaving the app"; CDN scripts, fonts and
    // third-party iframes always load.
    if (mainFrameNavigation && this.safety.external_navigation === 'stop') {
      const host = hostOf(url);
      if (host && !this.allowedHosts.has(host)) return { stop: `leaving the app (${host})` };
    }
    return null;
  }

  async #route(route) {
    const req = route.request();
    this.routed.add(req);
    try {
      const nav = req.isNavigationRequest() && this.#mainFrame(req);
      if (nav) this.judgedNav.add(req.url());
      const verdict = this.#verdict(req.url(), nav);
      // Fail closed: once denied, an error in the abort never falls back to letting the request go.
      if (verdict) return await this.#deny(route, req, verdict, req.url()).catch(() => {});
    } catch { /* a closed page or a handled route: let the request go on as usual */ }
    return route.fallback().catch(() => {});
  }

  async #deny(route, req, verdict, url) {
    if (verdict.stop) return this.#stopBefore(route, req, verdict.stop, url);
    this.aborted.add(req);
    this.#signal('blocked', { url: clip(url, 200) });
    return route.abort('blockedbyclient');
  }

  #mainFrame(req) {
    try { return req.frame().parentFrame() === null; } catch {
      // A popup's first navigation is issued before its frame exists; service-worker requests
      // have no frame and are never navigations.
      return req.isNavigationRequest();
    }
  }

  async #stopBefore(route, req, label, url = req.url()) {
    this.aborted.add(req);
    const navigation = req.isNavigationRequest() && this.#mainFrame(req);
    // A main-frame navigation aborted as "blocked" would show Chrome's error page; "aborted"
    // cancels it and the persona stays where they were. Other requests fail as blocked.
    this.#reachStop(label, url, req.method()); // before the abort, so a failing abort still stops the run
    await route.abort(navigation ? 'aborted' : 'blockedbyclient').catch(() => {});
    // A popup opened only to leave the app: close it, so the persona is back on the app's tab.
    if (navigation) {
      let pages;
      try { pages = [req.frame().page()]; } catch { pages = this.context.pages(); }
      await this.#closeBlankPopups(pages);
    }
  }

  #bypassed(req) {
    try {
      // Only a navigation nothing judged: the route saw neither it nor, for a redirect hop, the CDP
      // redirect check. Judging it again would count a `max` pattern twice and stop an allowed page.
      if (this.routed.has(req) || req.redirectedFrom() || !req.isNavigationRequest() || !this.#mainFrame(req)) return;
      let page = null;
      try { page = req.frame().page(); } catch { /* a popup's first navigation: its page event comes later */ }
      this.#unjudgedNavigation(req.url(), req.method(), page);
    } catch { /* a request of a page that is already gone */ }
  }

  // Backstop (C): a popup's first navigation can start before the harness controls the tab, and then
  // neither the route nor the request events see it (Windows CI: 3 of 24 runs). Its first commit is
  // judged instead: a DNS or connection failure commits chrome-error, whose unreachableUrl is the URL.
  #popupCommitted(page, frame) {
    if (frame.parentId) return false;
    const url = frame.unreachableUrl || frame.url;
    if (/^(about:blank)?$/.test(url)) return false;
    this.#unjudgedNavigation(url, 'GET', page);
    return true;
  }

  // A navigation that nothing judged yet stops the run if it should have; a popup it opened is closed.
  #unjudgedNavigation(url, method, page) {
    if (this.judgedNav.has(url)) return;
    this.judgedNav.add(url);
    const verdict = this.#verdict(url, true);
    if (!verdict?.stop) return;
    this.#signal('route-bypassed', { url: clip(url, 200) });
    this.#reachStop(verdict.stop, url, method);
    if (page) this.#track(page.opener().then((opener) => opener && page.close()).catch(() => {}));
    else this.closeNextPopup = true;
  }

  // Prevention (A): window.open(url) opens about:blank and leaves the URL on the popup (inject.js
  // section 9). Loading it here, once the page event says the harness controls the tab, puts the
  // popup's first real navigation through the safety route.
  async #loadPopupUrl(page) {
    const url = await page.evaluate(() => { const u = window.__uxPopupUrl ?? null; delete window.__uxPopupUrl; return u; }).catch(() => null);
    if (!url) return;
    const opener = await page.opener().catch(() => null);
    await page.goto(url, { waitUntil: 'commit', ...(opener ? { referer: opener.url() } : {}) }).catch(() => {});
  }

  async #closeBlankPopups(pages) {
    for (const page of pages) {
      if (/^(about:blank|chrome-error:\/\/chromewebdata\/)?$/.test(page.url()) && await page.opener().catch(() => null)) await page.close().catch(() => {});
    }
  }

  #reachStop(label, url, method, via = null) {
    this.#signal('stop-before', { url: clip(url, 200), label, method, ...(via ? { via: clip(via, 200) } : {}) });
    this.stopBeforeReached = label;
    if (!this.notedStops.has(label)) {
      this.notedStops.add(label);
      this.pendingNotes.push(`STOP: this would take you to "${label}". The test ends here — do not try again. Call end_session with outcome stop_before and describe what you expected to happen next.`);
    }
  }

  // Playwright never routes the hops of a server redirect, so a same-site link that redirects to a
  // payment page or another site would pass context.route unseen. CDP pauses each document response
  // (and fetch/XHR responses when there are patterns) before the browser follows a redirect; its
  // Location is judged like a request of its own. The browser still makes every request itself, so
  // the address bar, cookies and Chrome's local-network rules stay real.
  async #judgeRedirect(cdp, e, mainFrameId, page) {
    const location = e.responseStatusCode >= 300 && e.responseStatusCode < 400
      && e.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
    const nav = e.resourceType === 'Document' && e.frameId === mainFrameId;
    let next = null;
    let verdict = null;
    if (location) {
      try { next = new URL(location, e.request.url).href; } catch { next = null; }
      if (next && nav) this.judgedNav.add(next);
      if (next) verdict = this.#verdict(next, nav);
    }
    if (!verdict) return cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    this.abortedUrls.add(e.request.url);
    await cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: nav ? 'Aborted' : 'BlockedByClient' }).catch(() => {});
    if (verdict.stop) this.#reachStop(verdict.stop, next, e.request.method, e.request.url);
    else this.#signal('blocked', { url: clip(next, 200), via: clip(e.request.url, 200) });
    if (nav) await this.#closeBlankPopups([page]);
  }

  #watch(page, popup = false) {
    if (page.__uxWatched) return;
    page.__uxWatched = true;
    // A popup the safety route closes at once may go before the binding is attached: not an error.
    this.#track(this.#attachBinding(page, popup).catch((e) => { if (!page.isClosed()) throw e; }));
    page.on('close', () => {
      if (page !== this.page || this.stopped || this.creatingPage) return;
      const url = page.url();
      this.page = this.context.pages().filter((p) => !p.isClosed()).at(-1) ?? null;
      this.closedTabs.push(url);
    });
    page.on('load', () => {
      if (page === this.page) this.crashed = false;
      if (!this.swWarned) this.#track(this.#checkServiceWorker(page));
    });
    page.on('crash', () => {
      if (page === this.page) this.crashed = true;
      this.#signal('crash', { url: page.url() });
      this.pendingNotes.push('The page crashed: the browser shows its "Aw, Snap! Something went wrong" error page.');
    });
    page.on('pageerror', (e) => this.#signal('pageerror', { msg: clip(e.message ?? e) }));
    page.on('console', (m) => {
      // The browser's own report of a request the harness aborted is not an app error.
      if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) this.#signal('console-error', { msg: clip(m.text()) });
    });
    page.on('response', (r) => { if (r.status() >= 400) this.#signal('http-error', { status: r.status(), url: clip(r.url(), 200) }); });
    page.on('requestfailed', (r) => {
      if (this.aborted.has(r) || this.abortedUrls.has(r.url())) return;
      const err = r.failure()?.errorText ?? '';
      if (!/ERR_ABORTED/.test(err)) this.#signal('request-failed', { url: clip(r.url(), 200), err });
    });
    page.on('filechooser', (chooser) => this.#track(this.#showFileChooser(page, chooser)));
    page.on('dialog', async (d) => {
      // Native dialogs never appear in screenshots, but a real user sees them: tell the persona.
      this.#signal('dialog', { kind: d.type(), msg: clip(d.message()) });
      this.pendingNotes.push(d.type() === 'beforeunload'
        ? 'A browser dialog asked "Leave site? Changes you made may not be saved." — it was answered "Leave".'
        : `A browser pop-up (${d.type()}) said: "${clip(d.message(), 200)}". It was answered "OK".`);
      await d.accept().catch(() => {});
    });
    page.on('download', async (dl) => {
      const name = dl.suggestedFilename();
      // Said before the copy: saving can outlast the step's settle (seen on Windows CI), and the persona
      // must hear of the download in the step that caused it, not in a later one.
      this.pendingNotes.push(`The browser downloaded a file named "${name}".`);
      fs.mkdirSync(path.join(this.dir, 'downloads'), { recursive: true });
      await dl.saveAs(path.join(this.dir, 'downloads', path.basename(name))).catch(() => {});
      this.#signal('download', { name });
    });
  }

  /** Harness work a step must wait for before its screenshot. */
  #track(promise) {
    const p = Promise.resolve(promise).catch((e) => this.#signal('harness-error', { msg: clip(e.message.split('\n')[0]) }));
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }

  // Stand-ins report through a raw CDP binding. Playwright's exposeBinding answers every call with
  // a user-gesture evaluate, which grants the page user activation (verified M2). Runtime.addBinding
  // also covers documents created later (reloads, navigations) and exists before init scripts run.
  async #attachBinding(page, popup) {
    const cdp = await this.context.newCDPSession(page);
    const origins = new Map(); // executionContextId -> origin of the document that asked
    cdp.on('Runtime.executionContextCreated', ({ context }) => origins.set(context.id, context.origin));
    cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => origins.delete(executionContextId));
    cdp.on('Runtime.bindingCalled', async ({ name, payload, executionContextId }) => {
      if (name !== '__uxPickerEvent') return;
      let msg;
      try { msg = JSON.parse(payload); } catch { return; }
      const origin = origins.get(executionContextId);
      const value = await this.#pickerEvent(origin && origin !== 'null' ? origin : undefined, msg.kind, msg.data)
        .catch((e) => { this.#signal('harness-error', { msg: clip(e.message.split('\n')[0]) }); return null; });
      if (msg.id == null) return;
      await cdp.send('Runtime.evaluate', {
        expression: `window.__uxAnswer(${JSON.stringify(msg.id)}, ${JSON.stringify(value ?? null)})`, contextId: executionContextId, userGesture: false,
      }).catch(() => {}); // the document may be gone
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: '__uxPickerEvent' });
    const { frameTree } = await cdp.send('Page.getFrameTree');
    cdp.on('Fetch.requestPaused', (e) => { this.#judgeRedirect(cdp, e, frameTree.frame.id, page).catch(() => {}); });
    const types = ['Document', ...(this.safety.stop_before.length || this.safety.block.length ? ['XHR', 'Fetch'] : [])];
    await cdp.send('Fetch.enable', { patterns: types.map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Response' })) });
    if (popup) {
      let judged = false;
      cdp.on('Page.frameNavigated', ({ frame }) => { if (!judged) judged = this.#popupCommitted(page, frame); });
      await cdp.send('Page.enable');
      // The first commit may have come before this session attached.
      const { frameTree: now } = await cdp.send('Page.getFrameTree');
      if (!judged) judged = this.#popupCommitted(page, now.frame);
    }
  }

  /** Every stand-in reports through the __uxPickerEvent binding; some reports get an answer. */
  async #pickerEvent(origin, kind, data) {
    const fields = data && typeof data === 'object' && !Array.isArray(data) ? data : { name: data };
    switch (kind) {
      case 'permission-check': return this.#permissionCheck(origin, fields.kinds ?? []);
      case 'permission': return this.#permissionDecide(origin, fields);
      case 'permission-shown': this.#signal('permission-shown', { kind: fields.kind }); return null;
      case 'vibrate': {
        const pattern = Array.isArray(fields.pattern) ? fields.pattern.slice(0, 20).map(Number) : [];
        const allowed = fields.allowed === true;
        this.#signal('vibrate', { pattern, allowed });
        if (allowed && pattern.some((ms, i) => i % 2 === 0 && ms > 0)) this.vibrated = true; // vibrate(0) only cancels
        return null;
      }
      case 'file': return this.#track(this.#setFiles(fields.names));
      case 'file-cancel': this.fileChooser = null; break;
    }
    this.#signal(`picker-${kind}`, fields);
    return null;
  }

  async #showFileChooser(page, chooser) {
    const info = await this.#evalNoGesture('window.__uxFileInputInfo?.() ?? null', page).catch(() => null);
    const accept = info?.accept ?? '';
    const list = this.files && fs.existsSync(this.files)
      ? fs.readdirSync(this.files, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.startsWith('.') && accepts(d.name, accept))
        .map((d) => ({ name: d.name, size: fs.statSync(path.join(this.files, d.name)).size }))
        .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    this.fileChooser = { chooser, offered: new Set(list.map((f) => f.name)) };
    await this.#evalNoGesture(`window.__uxShowFilePicker(${JSON.stringify(list)}, ${JSON.stringify(accept)}, ${chooser.isMultiple()})`, page);
  }

  async #setFiles(names) {
    const open = this.fileChooser;
    this.fileChooser = null;
    // Only files the stand-in offered: a page cannot use the binding to read other files.
    const chosen = (Array.isArray(names) ? names : []).filter((n) => open?.offered.has(n));
    this.#signal('picker-file', { names: chosen });
    if (open && chosen.length) await open.chooser.setFiles(chosen.map((n) => path.join(this.files, n)));
  }

  async #grant(kind, origin) {
    await this.context.grantPermissions(PERMISSIONS[kind] ?? [], origin ? { origin } : {});
    if (kind === 'geolocation') await this.context.setGeolocation(GEOLOCATION);
  }

  /** Remembered decisions for these kinds; a remembered "allow" is granted to the asking origin. */
  async #permissionCheck(origin, kinds) {
    const out = {};
    for (const kind of kinds) {
      if (!PERMISSIONS[kind]) continue;
      let d = this.permDecisions.get(kind);
      if (!d && this.permissions === 'deny') {
        d = 'block';
        this.permDecisions.set(kind, d);
        this.#signal('permission', { kind, decision: d });
      }
      if (d === 'allow') await this.#grant(kind, origin);
      if (d) out[kind] = d;
    }
    return out;
  }

  async #permissionDecide(origin, { kinds = [], decision, dismissed = false }) {
    for (const kind of kinds) {
      if (!PERMISSIONS[kind]) continue;
      const d = decision === 'allow' ? 'allow' : 'block';
      if (!dismissed) this.permDecisions.set(kind, d); // Escape dismisses: Chrome asks again next time
      this.#signal('permission', { kind, decision: d, ...(dismissed ? { dismissed: true } : {}) });
      if (d === 'allow') await this.#grant(kind, origin);
    }
    return true;
  }

  async #checkServiceWorker(page) {
    const controlled = await this.#evalNoGesture('!!navigator.serviceWorker?.controller', page).catch(() => false);
    if (!controlled || this.swWarned) return;
    this.swWarned = true;
    this.#signal('setup', { warning: 'service-worker-bypasses-safety', url: clip(page.url(), 200) });
  }

  #signal(type, data) {
    const e = { t: Date.now(), step: this.steps, type, ...data };
    this.events.push(e);
    appendPrivate(path.join(this.dir, 'signals.jsonl'), JSON.stringify(e) + '\n');
  }

  #log(entry) {
    appendPrivate(path.join(this.dir, 'log.jsonl'), JSON.stringify({ t: Date.now(), ...entry }) + '\n');
  }

  /** Validate an action; returns an error string or null. */
  #invalid(a) {
    if (!a || !ACTION_TYPES.includes(a.type)) return `unknown action type ${JSON.stringify(a?.type)}; use one of ${ACTION_TYPES.join(', ')}`;
    const { width, height } = this.viewport;
    const point = (p, label) => {
      if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return `${label} needs integer x and y`;
      if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return `${label} (${p.x}, ${p.y}) is outside the ${width}x${height} screen`;
      return null;
    };
    switch (a.type) {
      case 'click': case 'double_click': return point(a, a.type);
      case 'drag': return point(a.from, 'drag from') ?? point(a.to, 'drag to');
      case 'type': return typeof a.text === 'string' && a.text.length > 0 ? null : 'type needs non-empty text';
      case 'press_key': return typeof a.key === 'string' && a.key.length > 0 ? null : 'press_key needs a key, e.g. "Enter"';
      case 'scroll':
        if (!Number.isInteger(a.dy) || a.dy === 0) return 'scroll needs a non-zero integer dy (positive = down)';
        return a.x === undefined && a.y === undefined ? null : point(a, 'scroll position');
      case 'wait': return a.seconds === undefined || (a.seconds > 0 && a.seconds <= this.waitCap) ? null : `wait seconds must be between 0 and ${this.waitCap}`;
      default: return null;
    }
  }

  /**
   * The browser process went away under the session (it crashed, or was killed): seen once on Linux CI,
   * where a renderer that dies while a screenshot is pending takes Chromium down with it. No tab can be
   * opened again, so the session is over; the persona is told, and every later act is refused.
   */
  #browserClosed() {
    if (this.stopped || this.browserGone) return;
    this.browserGone = true;
    this.closedTabs.length = 0; // its pages closed because the browser quit, not because the app closed a tab
    this.over ??= 'BROWSER_CLOSED';
    this.#signal('browser-closed', {});
    this.pendingNotes.push('The browser quit unexpectedly: its window is gone and it cannot be opened again. Call end_session now.');
  }

  /** A new tab. Fails with BROWSER_GONE when there is no browser left to open it in. */
  async #newPage() {
    if (this.browserGone) throw new Error(BROWSER_GONE);
    try {
      return await this.context.newPage();
    } catch (e) {
      // The context's own close event can land just after this rejection: wait for it, briefly.
      if (TARGET_CLOSED.test(e.message)) await Promise.race([this.contextClosed, sleep(250)]);
      throw this.browserGone ? new Error(BROWSER_GONE) : e;
    }
  }

  async #ensurePage() {
    if (!this.page || this.page.isClosed()) {
      // Every tab closed: like reopening the browser, the persona gets a blank tab.
      this.creatingPage = true;
      try { this.page = await this.#newPage(); } finally { this.creatingPage = false; }
      this.#watch(this.page);
    }
    return this.page;
  }

  async #perform(a) {
    const p = await this.#ensurePage();
    const touch = !!this.device.hasTouch;
    switch (a.type) {
      case 'look': return;
      case 'click': return touch ? p.touchscreen.tap(a.x, a.y) : p.mouse.click(a.x, a.y);
      case 'double_click':
        if (touch) { await p.touchscreen.tap(a.x, a.y); await p.waitForTimeout(60); return p.touchscreen.tap(a.x, a.y); }
        return p.mouse.dblclick(a.x, a.y);
      case 'drag': return touch ? this.#touchDrag(a.from, a.to) : this.#mouseDrag(a.from, a.to);
      case 'type': return p.keyboard.type(a.text, { delay: 20 });
      case 'press_key': return p.keyboard.press(a.key);
      case 'scroll':
        if (a.x !== undefined) await p.mouse.move(a.x, a.y);
        return p.mouse.wheel(0, a.dy);
      case 'wait': return this.pageClock ? this.#clockWait(a.seconds ?? 2) : p.waitForTimeout((a.seconds ?? 2) * 1000);
      case 'reload': return this.crashed ? this.#reopenCrashed() : p.reload({ waitUntil: 'load' });
      case 'back': return p.goBack({ waitUntil: 'load' });
    }
  }

  /** `wait` under clock: controlled. The pacer rests while the wait moves page time itself. */
  async #clockWait(seconds) {
    await this.pageClock.stopPacer();
    try { this.lastWait = await this.pageClock.wait(seconds); } finally { this.pageClock.startPacer(); }
  }

  /** Playwright cannot reload a crashed page; a user pressing Reload on "Aw, Snap" gets the page back. */
  async #reopenCrashed() {
    const url = this.page.url();
    this.creatingPage = true;
    try {
      await this.page.close().catch(() => {});
      this.page = await this.#newPage();
    } finally { this.creatingPage = false; }
    this.crashed = false;
    this.#watch(this.page);
    await this.page.goto(url, { waitUntil: 'load' });
  }

  async #mouseDrag(from, to) {
    const m = this.page.mouse;
    await m.move(from.x, from.y);
    await m.down();
    // Stepped moves: apps that paint or resize on pointermove need intermediate points (SPIKE Q7).
    for (let i = 1; i <= 10; i++) await m.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await m.up();
  }

  async #touchDrag(from, to) {
    const cdp = await this.context.newCDPSession(this.page);
    const at = (x, y) => [{ x: Math.round(x), y: Math.round(y) }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from.x, from.y) });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  async #settle() {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    // A file stand-in being shown or files being set must land before the screenshot.
    if (this.inflight.size) await withTimeout(Promise.allSettled([...this.inflight]), EVAL_TIMEOUT_MS * 2, 'harness work').catch(() => {});
    // With the browser gone there is no page to settle: the step ends with what the persona is told.
    const p = await this.#ensurePage().catch((e) => { if (this.browserGone) return null; throw e; });
    await p?.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  }

  /** Returns {file, png, img}, or null when the page cannot be captured (e.g. it crashed). */
  async #screenshot() {
    if (this.crashed || !this.page || this.browserGone) return null;
    const file = path.join(this.dir, 'screenshots', `s${String(this.shots + 1).padStart(2, '0')}.png`);
    const png = await this.#capture().catch((e) => {
      this.#signal('screenshot-error', { msg: clip(e.message.split('\n')[0]) });
      return null;
    });
    if (!png) return null;
    fs.writeFileSync(file, png);
    this.shots++;
    return { file, png, img: decode(png) };
  }

  // Screenshots go through CDP too: Playwright's page.screenshot grants user activation (verified
  // M2), so even the free first look would unlock audio the persona never unlocked. The text caret
  // is hidden while capturing, as Playwright does, so its blink is not a visual change.
  // A busy main thread (a long loop, a hung app) never answers Runtime.evaluate: every call here is
  // bounded, and once the page has been found busy in a step the rest of the step skips page evals.
  async #capture() {
    const cdp = await this.context.newCDPSession(this.page);
    const caret = (on) => withTimeout(cdp.send('Runtime.evaluate', { expression: `window.__uxHideCaret?.(${on})`, userGesture: false }),
      CARET_TIMEOUT_MS, 'hide caret').then(() => true, () => { this.pageBusy = true; return false; });
    let hidden = false;
    try {
      // A renderer too busy to paint once in this step will not paint for the next shot either.
      if (this.shotTimedOut) throw new Error('screenshot skipped: the page did not paint earlier in this step');
      hidden = !this.pageBusy && await caret(true); // busy: capture with the caret showing
      const { data } = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png' }), SHOT_TIMEOUT_MS, 'screenshot')
        .catch((e) => { this.shotTimedOut = /timed out/.test(e.message); throw e; });
      return Buffer.from(data, 'base64');
    } finally {
      if (hidden) await caret(false);
      cdp.detach().catch(() => {}); // not awaited: detaching waits for a busy renderer
    }
  }

  /** In-memory screenshot (the pre-action shot of D1), decoded; null when it cannot be taken. */
  async #rawShot() {
    if (this.crashed || !this.page || this.page.isClosed()) return null;
    const png = await this.#capture().catch((e) => {
      this.#signal('screenshot-error', { phase: 'pre', msg: clip(e.message.split('\n')[0]) });
      return null;
    });
    return png && decode(png);
  }

  /** Mouse pointer onto the action's target (a real user's pointer gets there before the press). */
  async #pointAt(a) {
    const p = this.page;
    if (this.crashed || !p || p.isClosed()) return;
    const at = this.#pointerTarget(a);
    if (!at) return;
    await withTimeout(p.mouse.move(at.x, at.y), 2000, 'pointer move').catch(() => {});
    await sleep(HOVER_MS);
  }

  /** Where a mouse action will point, or null (touch devices and keyless actions have no hover). */
  #pointerTarget(a) {
    if (this.device.hasTouch) return null;
    return a.type === 'click' || a.type === 'double_click' ? a : a.type === 'drag' ? a.from : a.type === 'scroll' && a.x !== undefined ? a : null;
  }

  /** Remember what changed while nobody acted (last -> now); keeps the last 3 steps. */
  #noteAnimation(last, now, d = null) {
    if (!last || !now) return;
    this.animMasks.push(d ?? diff(last, now));
    if (this.animMasks.length > 3) this.animMasks.shift();
  }

  /** visual_change + changed_box of one step; pre is null when it could not be captured. */
  #visual(pre, post, animatingNow) {
    if (!pre || !post) return { visual_change: null, changed_box: null };
    const mask = animationMask({ now: [animatingNow], recent: this.animMasks }, post.width, post.height);
    return classify(diff(pre, post), mask, post.width);
  }

  // Every harness read goes through CDP with userGesture:false. Playwright's page.evaluate grants
  // user activation, which would unlock audio autoplay that the persona never unlocked.
  async #evalNoGesture(js, page = this.page) {
    // A crashed renderer never answers Runtime.evaluate; without this guard stop() would hang too.
    if (this.crashed && page === this.page) throw new Error('page crashed');
    const cdp = await this.context.newCDPSession(page);
    try {
      const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true, userGesture: false }),
        EVAL_TIMEOUT_MS, 'harness eval');
      if (r.exceptionDetails) throw new Error(`harness eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    } finally { cdp.detach().catch(() => {}); } // not awaited: detaching waits for a busy renderer
  }

  async #audio() {
    if (this.pageBusy) return null;
    const a = await this.#evalNoGesture('window.__uxAudio?.() ?? null').catch(() => null);
    if (a) this.#trackAudio(a);
    return a;
  }

  // In-page audio stats reset with every new document (reload, navigation). Keep session totals so
  // the summary triage reads does not claim "no sound" after a persona reloads.
  #trackAudio(a) {
    const t = this.audioTotals ??= { maxPeak: 0, nonSilentMs: 0, documents: 1, firstSoundAt: null, lastDocMs: 0 };
    if (a.nonSilentMs < t.lastDocMs) { t.nonSilentMs += t.lastDocMs; t.documents++; }
    t.lastDocMs = a.nonSilentMs;
    t.maxPeak = Math.max(t.maxPeak, a.maxPeak);
    t.firstSoundAt ??= a.firstSoundAt;
  }

  #audioSession() {
    const t = this.audioTotals;
    return t && { maxPeak: t.maxPeak, nonSilentMs: t.nonSilentMs + t.lastDocMs, documents: t.documents, firstSoundAt: t.firstSoundAt };
  }

  /** Run `fn` after any earlier call on this session has finished (one action at a time). */
  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * One persona step: log fields + one action → the next observation.
   * Returns {ok, text, png?, screenshotPath?, refused?}.
   */
  act(input) { return this.#serial(() => this.#act(input)); }

  async #act({ observation = '', reaction = '', event = 'none', frustration_delta = 0, action } = {}) {
    if (this.stopped) return { ok: false, text: 'SESSION_STOPPED: this browser session is closed.' };
    const fields = { observation, reaction, action, event, frustration_delta };
    if (this.ended) return { ok: false, refused: true, text: 'SESSION_ENDED: you already finished this session. Stop now.' };
    if (this.over) {
      // The cap and patience refusals log themselves when they first happen; the browser quits on its own.
      const first = this.over === 'BROWSER_CLOSED' && !this.browserRefusalLogged;
      if (first) this.browserRefusalLogged = true;
      return this.#refuse(this.over, fields, first);
    }

    const bad = this.#invalid(action) ?? (EVENTS.includes(event) ? null : `unknown event ${JSON.stringify(event)}; use one of ${EVENTS.join(', ')}`)
      ?? (Number.isInteger(frustration_delta) && frustration_delta >= 0 ? null : 'frustration_delta must be a non-negative integer');
    if (bad) {
      this.#log({ invalid: bad, ...fields });
      return { ok: false, text: `INVALID_ACTION: ${bad}. Nothing happened and no step was used. Try again.` };
    }

    this.frustration += frustration_delta;
    const free = action.type === 'look' && this.steps === 0 && !this.freeLookUsed;
    if (!free && this.steps >= this.cap) return this.#refuse('STEP_CAP_REACHED', fields, true);
    if (this.patienceBudget != null && this.frustration >= this.patienceBudget) return this.#refuse('PATIENCE_EXHAUSTED', fields, true);

    if (free) this.freeLookUsed = true;
    else this.steps++;
    this.notedStops.clear();
    this.pageBusy = false; // set when a page eval times out during this step
    this.shotTimedOut = false;
    this.lastWait = null;
    // D22: under clock: controlled, page time first moves by what a person spends reading and
    // deciding (never for the free look); what that changes counts as "changed while idle" below.
    if (!free) await this.pageClock?.advance(humanMs(action));
    // While the harness works on this step, page time moves alongside real time (the pacer).
    this.pageClock?.startPacer();
    // D1: the pre shot shows the screen right before the action, with the pointer already on the
    // target. Two pre shots a moment apart show what animates right now; what changed since the last
    // step's shot happened with nobody acting and joins the history of between-step intervals.
    let pre = free ? this.lastImg : null;
    let animatingNow = null;
    let idle = null; // what changed on its own between the last shot and this action
    let actionError = null;
    let shot = null;
    try {
      if (!free) {
        // The idle shot comes before the pointer moves, so hover styles are not counted as idle change.
        const idleShot = this.lastImg && this.#pointerTarget(action) ? await this.#rawShot() : null;
        await this.#pointAt(action);
        const pre1 = await this.#rawShot();
        const idleNow = idleShot ?? pre1;
        const idleDiff = this.lastImg && idleNow ? diff(this.lastImg, idleNow) : null;
        const earlier = this.animMasks.slice();
        this.#noteAnimation(this.lastImg, idleNow, idleDiff);
        if (pre1) {
          await sleep(PRE_GAP_MS);
          pre = await this.#rawShot();
          if (pre) animatingNow = diff(pre1, pre);
        }
        if (idleDiff) {
          const mask = animationMask({ now: [animatingNow], recent: earlier }, idleNow.width, idleNow.height);
          const c = classify(idleDiff, mask, idleNow.width);
          idle = { changed_while_idle: c.visual_change, idle_box: c.changed_box };
        }
      }
      try {
        await this.#perform(action);
      } catch (e) {
        if (/Unknown key/.test(e.message)) {
          this.steps--;
          this.#log({ invalid: clip(e.message), ...fields });
          return { ok: false, text: `INVALID_ACTION: ${clip(e.message.split('\n')[0], 120)}. No step was used.` };
        }
        // An action cut short by the browser quitting is not the app's failure: browser-closed says it.
        if (TARGET_CLOSED.test(e.message)) await Promise.race([this.contextClosed, sleep(250)]);
        if (!this.browserGone) {
          actionError = clip(e.message.split('\n')[0]);
          this.#signal('action-error', { action: action.type, msg: actionError });
        }
      }
      await this.#settle();
      shot = await this.#screenshot();
    } finally { await this.pageClock?.stopPacer(); } // between steps the clock stays paused
    // The free look does nothing: every change it sees is animation.
    if (free && pre && shot) { animatingNow = diff(pre, shot.img); this.#noteAnimation(pre, shot.img); }
    const visual = this.#visual(pre, shot?.img ?? null, animatingNow);
    if (shot) this.lastImg = shot.img;
    const audio = await this.#audio();
    if (audio) this.#signal('audio', audio);
    this.#log({
      step: free ? null : this.steps, ...fields, frustration: this.frustration,
      screenshot: shot ? path.relative(this.dir, shot.file).split(path.sep).join('/') : null, url: this.page?.url() ?? null, ...visual,
      changed_while_idle: idle?.changed_while_idle ?? null, idle_box: idle?.idle_box ?? null,
      page_time_ms: this.#pageTime(),
      ...(this.lastWait ? { waited_ms: this.lastWait.waitedMs, wait_stop: this.lastWait.stop } : {}),
      ...(actionError ? { action_error: actionError } : {}),
    });
    return { ok: true, text: this.#statusText(actionError, !shot), png: shot?.png ?? null, screenshotPath: shot?.file ?? null };
  }

  #refuse(reason, fields, first) {
    this.over = reason;
    if (first) this.#log({ refused: reason, ...fields, frustration: this.frustration });
    const why = reason === 'STEP_CAP_REACHED'
      ? `STEP_CAP_REACHED (${this.cap}). The session is over: you have used all your actions.`
      : reason === 'BROWSER_CLOSED'
        ? 'BROWSER_CLOSED. The session is over: the browser quit unexpectedly and cannot be opened again.'
        : `PATIENCE_EXHAUSTED (${this.frustration}/${this.patienceBudget}). You have run out of patience and give up.`;
    return { ok: false, refused: true, text: `${why} Nothing was done. Call end_session now with your exit interview.` };
  }

  // A closed tab is reported with the next step's result (or at stop), not when it closes. When the
  // browser itself quits, each page closes before the context does, and no fixed wait tells that from
  // the app closing its tab: on a slow machine the context's close came later than any such wait.
  #reportClosedTabs() {
    for (const url of this.closedTabs.splice(0)) {
      this.#signal('page-closed', { url });
      this.pendingNotes.push('The tab closed.');
    }
  }

  #statusText(actionError, noScreen = false) {
    this.#reportClosedTabs();
    const lines = [];
    const counted = this.steps === 0 ? 'Free first look' : `Step ${this.steps} of ${this.cap}`;
    const patience = this.patienceBudget != null ? ` · frustration ${this.frustration}/${this.patienceBudget}` : '';
    lines.push(`${counted}${patience}`);
    lines.push(`Address bar: ${this.page?.url() ?? 'about:blank'}`);
    for (const n of this.pendingNotes.splice(0)) lines.push(n);
    const w = this.lastWait; // never says that time is simulated, and a full wait says nothing
    // wall_cap with under 1 s waited is a frozen page (clock-stuck already logged it), not a real
    // cap hit: say nothing rather than "You waited 0 s."
    if (w && !(w.stop === 'wall_cap' && w.waitedMs < 1000)) {
      const secs = Math.max(1, Math.round(w.waitedMs / 1000));
      if (w.stop === 'changed') lines.push(`You waited ${secs} s. Something on the screen changed.`);
      else if (w.stop === 'wall_cap') lines.push(`You waited ${secs} s.`);
    }
    // A real phone user feels it; a vibration between steps is felt at the next status.
    if (this.vibrated && this.device.hasTouch) lines.push('The phone vibrated.');
    this.vibrated = false;
    if (actionError) lines.push('The browser could not complete that action.');
    if (noScreen) lines.push('(The screen could not be captured this time.)');
    const left = this.cap - this.steps;
    if (left === 0) lines.push('That was your last action. Call end_session now.');
    else if (left <= 3) lines.push(`Only ${left} action(s) left.`);
    return lines.join('\n');
  }

  /**
   * Record the exit interview. Allowed once, also after the cap or patience ran out.
   * The first goal_achieved only asks the persona to re-read its goal (personas declared success on
   * a partial goal, the timer app 2026-09-28); the next end() call records whatever outcome it gives.
   */
  end({ outcome, final_observation = '', exit_interview }) {
    if (this.ended) throw new Error('session already ended');
    if (outcome === 'goal_achieved' && !this.goalChecked) {
      this.goalChecked = true;
      this.#signal('goal-check', { final_observation });
      const goal = this.goal ? `: "${this.goal}"` : ' in your briefing';
      return `GOAL_CHECK: before you finish, read your goal again, part by part${goal}. `
        + 'Is every part of it done, and does the screen show it now? If yes, call end_session again with outcome goal_achieved. '
        + 'If not, keep going with act, or end with another outcome.';
    }
    this.ended = true;
    this.outcome = outcome;
    this.#log({ end: { outcome, final_observation, exit_interview, steps: this.steps, frustration: this.frustration, over: this.over, final_screenshot: this.shots ? `screenshots/s${String(this.shots).padStart(2, '0')}.png` : null } });
    return 'Exit interview recorded. The session is over; reply with a short summary of your journey.';
  }

  /** Harness-only: evaluate a JS expression in the page (start-state setup, probes). Never counted. */
  evalHarness(js) { return this.#serial(() => this.#evalNoGesture(js)); }

  /** Harness-only: summary of what actually happened. */
  signals() {
    return this.#serial(async () => ({
      session: this.id, steps: this.steps, cap: this.cap, frustration: this.frustration,
      patience_budget: this.patienceBudget, over: this.over, ended: this.ended, outcome: this.outcome ?? null,
      stop_before: this.stopBeforeReached, clock: this.clockMode, page_time_ms: this.#pageTime(),
      audio: this.stopped ? null : await this.#audio(), // current document only
      audio_session: this.#audioSession(), // whole session, across reloads
      opfs: this.stopped ? null : await this.#evalNoGesture('window.__uxOpfsFiles?.() ?? null').catch(() => null),
      events: this.events.filter((e) => e.type !== 'audio'),
    }));
  }

  /** Close the browser and delete the profile. Idempotent. */
  stop() {
    return this.#serial(async () => {
      if (this.stopped) return;
      this.#reportClosedTabs();
      const audio = await this.#audio();
      const opfs = await this.#evalNoGesture('window.__uxOpfsFiles?.() ?? null').catch(() => null);
      this.#signal('stop', { steps: this.steps, frustration: this.frustration, over: this.over, ended: this.ended, outcome: this.outcome ?? null, stop_before: this.stopBeforeReached, page_time_ms: this.#pageTime(), audio, audio_session: this.#audioSession(), opfs });
      this.stopped = true;
      await this.context.close().catch(() => {});
      removeProfile(this.profileDir);
    });
  }
}
