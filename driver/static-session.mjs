// One viewer's static session in design mode: a snapshot frame served as pictures, answers taken in a fixed order,
// and prototype links followed by the harness. No browser. Writes <dir>/design-log.jsonl and <dir>/screenshots/vNN.png.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { crop, encode, readImageInside, scaleDown } from './perception/image.mjs';
import { hitTest, sceneOf } from './perception/scene.mjs';

/** The longest side of a picture served to a viewer, in pixels. A larger fold is scaled down first. */
export const MAX_IMAGE_PX = 1568;
/** The most pixels (width times height) of a picture served to a viewer. The authors' reading of the model's image limit, not checked against the model. */
export const MAX_IMAGE_PIXELS = 1_150_000;
/** A frame at most this wide is a touch device. */
export const TOUCH_MAX_WIDTH = 480;
export const FRAMES_PER_FLOW = 8;
export const DEFAULT_VIEWS_PER_FRAME = 12;
// The fold height as a multiple of the frame width: a phone screen is 16:9 portrait, a desktop window about 8:5 landscape.
const FOLD_RATIO = Object.freeze({ touch: 16 / 9, desktop: 5 / 8 });
// Each scroll moves one fold less this share of it, so the last lines of one view are the first lines of the next.
const SCROLL_OVERLAP = 1 / 8;

/** The image scaled down until neither its longest side nor its pixel count is over the limit. */
function fitImage(image) {
  let factor = Math.min(1, MAX_IMAGE_PX / Math.max(image.width, image.height), Math.sqrt(MAX_IMAGE_PIXELS / (image.width * image.height)));
  let served = factor < 1 ? scaleDown(image, factor) : image;
  // rounding the two sides can leave the area a few hundred pixels over
  while (served.width * served.height > MAX_IMAGE_PIXELS) served = scaleDown(image, (factor *= 0.995));
  return served;
}

/** What the viewer is told when the harness follows its first click and the click leads nowhere it can go. */
export const SENTENCES = Object.freeze({
  moved: 'A new screen is showing. Call view.',
  no_link: 'Nothing happened here in this design.',
  unsupported: 'This opens something this test cannot show.',
});

// Kept here so the static session does not load the browser driver for one constant.
const CONFIDENCE = ['sure', 'guess', 'cannot_tell'];
const point = z.array(z.number()).length(2).describe('[x, y] in pixels of the latest picture you were shown, counted from its top-left corner.');
const confidence = z.enum(CONFIDENCE).describe('sure: you can tell at a glance. guess: you think so but are not certain. cannot_tell: you do not know.');

/** The two parts of an answer, one schema each. The tool lists them as optional fields of `answer`. */
export const ANSWER_SCHEMAS = Object.freeze({
  first_look: z.object({
    purpose: z.string().describe('What this screen is for, in one sentence.'),
    confidence,
    main_action: z.object({
      what: z.string().describe('The one thing you would do here, in your own words.'),
      point,
    }),
  }).describe('Give this right after your first look, before you scroll.'),
  after_reading: z.object({
    pressable: z.array(z.object({
      point,
      expect: z.string().describe('What you think happens when you press it. Say so if you cannot tell.'),
      confidence,
    })).max(5).describe('Up to 5 things that can be pressed.'),
    not_understood: z.array(z.string()).describe('Words or icons you did not understand, copied exactly. Empty if none.'),
    purpose_changed: z.object({
      changed: z.boolean(),
      purpose: z.string().nullable().describe('Your new sentence when it changed, otherwise null.'),
    }).describe('Whether reading the screen changed what you think it is for.'),
    first_click: z.object({
      result: z.enum(['click', 'cannot_find']),
      point: point.optional().describe('Needed when result is click.'),
      expect: z.string().optional().describe('What you think happens.'),
    }).optional().describe('Only when your instructions ask where you would click first for your goal.'),
  }).describe('Give this after you have read the whole screen.'),
});

// --- the frame visit as a state machine -----------------------------------------------------------------------
// One visit starts when a screen is first shown. An entry is the next state, or a refusal code (capitals). A refusal
// leaves the state as it is. `scroll` is a `view` call that asks to scroll.

/** The states of one visit. */
export const VISIT_STATES = Object.freeze(['unseen', 'seen', 'first_look_done', 'done']);
export const VISIT_TRANSITIONS = Object.freeze({
  unseen: Object.freeze({ view: 'seen', scroll: 'ANSWER_FIRST', first_look: 'LOOK_FIRST', after_reading: 'LOOK_FIRST' }),
  seen: Object.freeze({ view: 'seen', scroll: 'ANSWER_FIRST', first_look: 'first_look_done', after_reading: 'ANSWER_FIRST' }),
  first_look_done: Object.freeze({ view: 'first_look_done', scroll: 'first_look_done', first_look: 'ALREADY_ANSWERED', after_reading: 'done' }),
  // a finished visit is always the last one of its session, so every call finds the session over first
  done: Object.freeze({ view: 'SESSION_ENDED', scroll: 'SESSION_ENDED', first_look: 'SESSION_ENDED', after_reading: 'SESSION_ENDED' }),
});

const MESSAGES = Object.freeze({
  LOOK_FIRST: 'call view and look at the screen before you answer.',
  SESSION_ENDED: 'this session is over. Nothing more can be recorded.',
  ANSWER_FIRST: (event) => `answer first_look before ${event === 'scroll' ? 'you scroll' : 'after_reading'}.`,
  ALREADY_ANSWERED: (event) => `you already gave ${event} for this screen.`,
});

const round2 = (v) => Math.round(v * 100) / 100;
const isRefusal = (entry) => entry === entry.toUpperCase();
const refusal = (code, message) => ({ ok: false, refused: code, text: `${code}: ${message}` });

function appendPrivate(file, text) {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
  } finally { fs.closeSync(fd); }
}
export function writePrivate(file, data) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data);
  } finally { fs.closeSync(fd); }
}

function readSnapshot(design) {
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(path.join(design, 'design.json'), 'utf8')); } catch {
    throw new Error(`cannot read design.json in ${design}`);
  }
  if (snapshot == null || !Array.isArray(snapshot.frames)) throw new Error(`design.json in ${design} has no frames`);
  return snapshot;
}

export class StaticSession {
  #snapshot;
  #flow; // {current, history, shown, over}: the level above one frame visit
  #visit; // the frame on screen: {frame, scene, touch, foldHeight, maxOffset, step, state, views, offset, served}
  #views = 0;
  #stopped = false;
  #queue = Promise.resolve();

  /** Opens a session on one frame of a snapshot folder. Throws when the frame is unknown or has no image. */
  static start(options) { return new StaticSession(options); }

  constructor({ id, dir, design, frame, followLinks = false, firstClick = false, viewsPerFrame = DEFAULT_VIEWS_PER_FRAME }) {
    if (followLinks && !firstClick) throw new Error('follow_links needs first_click: the click that is followed is the first click');
    if (!Number.isInteger(viewsPerFrame) || viewsPerFrame < 1) throw new Error('views_per_frame must be a whole number of at least 1');
    this.id = id;
    this.dir = dir;
    this.design = design;
    this.followLinks = followLinks;
    this.firstClick = firstClick;
    this.viewsPerFrame = viewsPerFrame;
    this.#snapshot = readSnapshot(design);
    this.#flow = { current: frame, history: [], shown: 1, over: null };
    this.#visit = this.#visitOf(frame);
    const screenshots = path.join(dir, 'screenshots');
    fs.mkdirSync(screenshots, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(screenshots, 0o700);
    this.#log('start', {
      session: id, design, source: this.#snapshot.source ?? null, file_key: this.#snapshot.file_key ?? null, version: this.#snapshot.version ?? null,
      settings: { follow_links: followLinks, first_click: firstClick, views_per_frame: viewsPerFrame },
    });
  }

  /** The device of the frame on screen: `touch` at most 480 px wide, otherwise `desktop`. */
  get device() { return this.#visit.touch ? 'touch' : 'desktop'; }
  get foldHeight() { return this.#visit.foldHeight; }
  get frameSize() { return { width: this.#visit.frame.width, height: this.#visit.frame.height }; }

  /** A new visit on a frame. Throws when the frame is not in the snapshot or has no image. */
  #visitOf(id) {
    const frame = this.#snapshot.frames.find((f) => f.id === id);
    if (!frame) throw new Error(`frame "${id}" is not in the design`);
    const image = readImageInside(this.design, frame.image);
    if (!image) throw new Error(`frame "${id}" has no image`);
    const touch = frame.width <= TOUCH_MAX_WIDTH;
    const foldHeight = Math.min(frame.height, Math.round(frame.width * (touch ? FOLD_RATIO.touch : FOLD_RATIO.desktop)));
    return {
      frame, touch, foldHeight, maxOffset: frame.height - foldHeight, step: foldHeight - Math.round(foldHeight * SCROLL_OVERLAP),
      scene: sceneOf(frame, { image, has: this.#snapshot.has ?? {} }), state: 'unseen', views: 0, offset: 0, served: null,
    };
  }

  #log(type, fields) {
    appendPrivate(path.join(this.dir, 'design-log.jsonl'), `${JSON.stringify({ t: Date.now(), type, frame: this.#flow.current, ...fields })}\n`);
  }

  /** Runs `fn` after any earlier call on this session has finished (one call at a time). */
  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** The refusal for an event the visit does not allow, or null. */
  #gate(event) {
    if (this.#flow.over) return refusal('SESSION_ENDED', MESSAGES.SESSION_ENDED);
    const next = VISIT_TRANSITIONS[this.#visit.state][event];
    if (!isRefusal(next)) return null;
    const message = MESSAGES[next];
    return refusal(next, typeof message === 'function' ? message(event) : message);
  }

  /** Shows the screen, or the part above or below the last one shown. Returns {ok, text, png?}. */
  view({ scroll } = {}) { return this.#serial(() => this.#view(scroll)); }

  #view(scroll) {
    const v = this.#visit;
    const refused = this.#gate(scroll ? 'scroll' : 'view');
    if (refused) return refused;
    if (v.views >= this.viewsPerFrame) {
      return refusal('VIEW_CAP_REACHED', `you cannot look at this screen again (${this.viewsPerFrame} looks used). Answer with what you have seen.`);
    }
    const before = v.offset;
    if (scroll === 'down') v.offset = Math.min(v.maxOffset, v.offset + v.step);
    if (scroll === 'up') v.offset = Math.max(0, v.offset - v.step);
    const stuck = scroll && v.offset === before;

    const scale = v.scene.imageScale;
    const shown = crop(v.scene.image, { x: 0, y: Math.round(v.offset * scale), w: v.frame.width * scale, h: v.foldHeight * scale });
    const served = fitImage(shown);
    v.served = { width: served.width, height: served.height, cropWidth: shown.width, cropHeight: shown.height, offset: v.offset };
    v.state = VISIT_TRANSITIONS[v.state][scroll ? 'scroll' : 'view'];
    v.views++;
    this.#views++;

    const png = Buffer.from(encode(served));
    const file = `screenshots/v${String(this.#views).padStart(2, '0')}.png`;
    writePrivate(path.join(this.dir, file), png);
    this.#log('view', {
      scroll: scroll ?? null, fold: { y: v.offset, h: v.foldHeight }, image: file, served: { width: served.width, height: served.height },
      views_on_frame: v.views,
    });

    const where = v.maxOffset === 0 ? 'the whole screen'
      : v.offset === 0 ? 'the top part; there is more below'
        : v.offset === v.maxOffset ? 'the bottom part; there is more above' : 'a middle part; there is more above and below';
    const limit = stuck ? ` You cannot scroll further ${scroll}.` : '';
    return { ok: true, text: `Screen ${this.#flow.shown}. You see ${where}.${limit}`, png };
  }

  /** Records `{first_look}` or `{after_reading}`. Returns {ok, text}. */
  answer(input) { return this.#serial(() => this.#answer(input ?? {})); }

  #answer(input) {
    if (this.#flow.over) return refusal('SESSION_ENDED', MESSAGES.SESSION_ENDED);
    const parts = Object.keys(ANSWER_SCHEMAS).filter((name) => input[name] !== undefined);
    if (parts.length !== 1) return refusal('INVALID_ANSWER', 'send exactly one of first_look and after_reading in a call. Nothing was recorded.');
    const part = parts[0];
    const refused = this.#gate(part);
    if (refused) return refused;

    const parsed = ANSWER_SCHEMAS[part].safeParse(input[part]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refusal('INVALID_ANSWER', `${[part, ...issue.path].join('.')}: ${issue.message}. Nothing was recorded.`);
    }
    const value = parsed.data;
    if (part === 'after_reading') {
      const click = value.first_click;
      if (this.firstClick && !click) return refusal('INVALID_ANSWER', 'after_reading.first_click is needed: say where you would click first. Nothing was recorded.');
      if (!this.firstClick && click) return refusal('INVALID_ANSWER', 'after_reading.first_click is not asked for. Nothing was recorded.');
      if (click?.result === 'click' && !click.point) return refusal('INVALID_ANSWER', 'after_reading.first_click.point is needed when result is click. Nothing was recorded.');
    }
    const record = this.#located(part, value);
    if (typeof record === 'string') return refusal('INVALID_ANSWER', record);

    this.#visit.state = VISIT_TRANSITIONS[this.#visit.state][part];
    this.#log('answer', { part, answer: record.answer });
    if (part === 'first_look') {
      return { ok: true, text: 'First look recorded. Read the whole screen now (call view to scroll if there is more), then call answer with after_reading.' };
    }
    return this.#afterReading(record.click);
  }

  /**
   * The answer with every point in frame pixels and the ids of the element and control under it, or a sentence
   * when a point is outside the picture last shown.
   */
  #located(part, value) {
    const v = this.#visit;
    const s = v.served;
    const scale = v.scene.imageScale;
    let bad = null;
    const at = (pixel, label) => {
      const [px, py] = pixel;
      if (px < 0 || px >= s.width || py < 0 || py >= s.height) {
        bad ??= `${label} [${px}, ${py}] is outside the picture you were last shown (${s.width} by ${s.height}). Nothing was recorded. Point inside the picture.`;
        return null;
      }
      const frame = [round2((px * s.cropWidth / s.width) / scale), round2(s.offset + (py * s.cropHeight / s.height) / scale)];
      const hit = hitTest(v.scene, { x: frame[0], y: frame[1] });
      return { point: frame, element: hit.element?.id ?? null, control: hit.control?.id ?? null, link: hit.link };
    };
    const withoutLink = ({ link, ...rest }) => rest;
    let answer;
    let click = null;
    if (part === 'first_look') {
      const main = at(value.main_action.point, 'main_action.point');
      answer = { purpose: value.purpose, confidence: value.confidence, main_action: main && { what: value.main_action.what, ...withoutLink(main) } };
    } else {
      const pressable = value.pressable.map((p, i) => {
        const found = at(p.point, `pressable[${i}].point`);
        return found && { ...withoutLink(found), expect: p.expect, confidence: p.confidence };
      });
      answer = { pressable, not_understood: value.not_understood, purpose_changed: value.purpose_changed };
      const c = value.first_click;
      if (c) {
        if (c.result === 'click') {
          click = at(c.point, 'first_click.point');
          answer.first_click = click && { result: 'click', ...withoutLink(click), expect: c.expect ?? null };
        } else answer.first_click = { result: 'cannot_find' };
      }
    }
    return bad ?? { answer, click };
  }

  /** What happens after `after_reading`: the session ends, or the first click moves the viewer. */
  #afterReading(click) {
    if (!this.followLinks) return this.#end('answered', 'Answers recorded. The session is over.');
    if (!click) return this.#end('cannot_find', 'Answers recorded. The session is over.');
    const { link } = click;
    const { history } = this.#flow;
    // a back link on the first screen has nowhere to go, like a link that is not there
    if (!link || (link.action === 'back' && !history.length)) return this.#end('no_link', SENTENCES.no_link);
    if (link.action !== 'navigate' && link.action !== 'back') return this.#end('unsupported', SENTENCES.unsupported, { action: link.action });
    if (this.#flow.shown >= FRAMES_PER_FLOW) return this.#end('frame_cap', 'Answers recorded. The session is over.');
    const back = link.action === 'back';
    const target = back ? history.at(-1) : link.to;
    let next;
    try { next = this.#visitOf(target); } catch { return this.#end('unsupported', SENTENCES.unsupported, { action: link.action }); }
    this.#log('navigate', { to: target, via: link.action, link });
    if (back) history.pop(); else history.push(this.#flow.current);
    this.#flow.current = target;
    this.#flow.shown++;
    this.#visit = next;
    return { ok: true, text: SENTENCES.moved };
  }

  #end(reason, text, extra = {}) {
    this.#flow.over = reason;
    this.#log('end', { reason, frames_shown: this.#flow.shown, views: this.#views, ...extra });
    return { ok: true, text };
  }

  /** Harness-only: where the session stands. */
  signals() {
    return this.#serial(async () => ({
      session: this.id, kind: 'design', frame: this.#flow.current, state: this.#visit.state, device: this.device,
      frames_shown: this.#flow.shown, history: [...this.#flow.history], views: this.#views, views_on_frame: this.#visit.views,
      views_per_frame: this.viewsPerFrame, over: this.#flow.over, follow_links: this.followLinks, first_click: this.firstClick,
    }));
  }

  /** Ends the session if it is still open. Idempotent. */
  stop() {
    return this.#serial(async () => {
      if (this.#stopped) return;
      this.#stopped = true;
      if (!this.#flow.over) this.#end('stopped', '');
    });
  }
}
