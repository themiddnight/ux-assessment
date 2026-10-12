// The five instruments of design mode (contrast, target size, text load, icon-only, prominence) as pure
// functions from a scene to numbers. A value that cannot be measured is null, and a null is never a finding.
import { COLOUR_BUCKET, contrastRatio, dominantColour, ringColour } from './image.mjs';

export const THRESHOLDS = Object.freeze({
  contrast: Object.freeze({ normal: 4.5, large: 3, non_text: 3, low_vision: 7 }),
  target_size: Object.freeze({ default: 24, touch: 44 }),
  large_text_px: 24,
});

/** Most words one frame may hold before `text_load` is below its budget, per reading style. */
export const WORD_BUDGETS = Object.freeze({ 'read-all': 250, skim: 100, 'icons-only': 30 });
export const READING_WORDS_PER_MINUTE = 200;
/** Width of the ring read around a control to find its surroundings, in frame pixels. */
export const RING_PX = 4;
// Tolerance for the second pass that finds text ink when it is nearly the background colour.
const FAINT_INK_TOLERANCE = 4;

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const filled = (box) => box.w > 0 && box.h > 0;

/** The element's box in image pixels, or null when there is no image, the box is empty or it lies outside the image. */
function pixelBox(scene, box) {
  const { image, imageScale: s } = scene;
  if (!image || !filled(box)) return null;
  const b = { x: box.x * s, y: box.y * s, w: box.w * s, h: box.h * s };
  if (b.x >= image.width || b.y >= image.height || b.x + b.w <= 0 || b.y + b.h <= 0) return null;
  return b;
}

const hasInk = (e) => e.text != null && e.text.trim() !== '';
// A control that carries its own text (a text link) is measured as text. When the source gave no text, it cannot be told apart.
const measuredAsText = (e) => e.kind === 'text' || (e.kind === 'control' && e.text != null);

function textContrast(scene, element) {
  const box = pixelBox(scene, element.box);
  const background = box && dominantColour(scene.image, box);
  if (!background) return null;
  const ink = dominantColour(scene.image, box, { exclude: background })
    ?? dominantColour(scene.image, box, { exclude: background, tolerance: FAINT_INK_TOLERANCE });
  return ink && contrastRatio(background, ink);
}

// One colour bucket apart is the noise of anti-aliasing. EXCLUDE_TOLERANCE would also hide a deliberately pale fill.
const sameColour = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) <= COLOUR_BUCKET;

// The fill of a control against the colour just outside it. A control whose fill is its surroundings (a ghost button, a
// text link, an outlined input) has no fill to measure, and 1.0 would flag it as invisible.
function surroundContrast(scene, element) {
  const box = pixelBox(scene, element.box);
  if (!box) return null;
  const fill = dominantColour(scene.image, box);
  const around = ringColour(scene.image, box, Math.ceil(RING_PX * scene.imageScale));
  return fill && around && !sameColour(fill, around) ? contrastRatio(fill, around) : null;
}

/** The contrast ratio of a text element (ink against background) or of a control (fill against its surroundings), to 2 decimals; null for other elements and when it cannot be read. */
export function contrast(scene, element) {
  let ratio = null;
  if (measuredAsText(element)) ratio = textContrast(scene, element);
  else if (element.kind === 'control') ratio = surroundContrast(scene, element);
  return ratio == null ? null : round(ratio, 2);
}

/** The short side of a control in frame pixels; null for other elements. */
export function targetSize(element) {
  return element.kind === 'control' && filled(element.box) ? round(Math.min(element.box.w, element.box.h), 2) : null;
}

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
/** The number of words in a string. Thai has no spaces, so the segmenter's dictionary finds the words. */
export function wordCount(text) {
  let n = 0;
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
  return n;
}

/** Words per text element and in the frame, and the estimated reading time; null when the source gave no text. */
export function textLoad(scene) {
  if (!scene.has.text) return null;
  const blocks = scene.elements.filter(hasInk).map((e) => ({ id: e.id, words: wordCount(e.text) }));
  const words = blocks.reduce((sum, b) => sum + b.words, 0);
  return { blocks, words, reading_seconds: round((words / READING_WORDS_PER_MINUTE) * 60, 1) };
}

/** True when a control holds no text; null for other elements and when the source gave no text. */
export function iconOnly(scene, element) {
  if (element.kind !== 'control' || !scene.has.text || !filled(element.box)) return null;
  if (hasInk(element)) return false;
  const { x, y, w, h } = element.box;
  return !scene.elements.some((e) => e !== element && hasInk(e)
    && e.box.x + e.box.w / 2 >= x && e.box.x + e.box.w / 2 <= x + w
    && e.box.y + e.box.h / 2 >= y && e.box.y + e.box.h / 2 <= y + h);
}

/** A Map from the id of every control to its rank (1 is the most prominent), by area times contrast with its surroundings. Controls that cannot be read are ranked null; equal scores share a rank. */
export function prominence(scene) {
  const scored = [];
  const ranks = new Map();
  for (const e of scene.elements) {
    if (e.kind !== 'control') continue;
    const ratio = filled(e.box) ? surroundContrast(scene, e) : null;
    if (ratio == null) ranks.set(e.id, null);
    else scored.push({ id: e.id, score: e.box.w * e.box.h * ratio });
  }
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => ranks.set(s.id, i > 0 && s.score === scored[i - 1].score ? ranks.get(scored[i - 1].id) : i + 1));
  return ranks;
}

function contrastThreshold(scene, element, vision) {
  if (vision === 'low') return THRESHOLDS.contrast.low_vision;
  if (!measuredAsText(element)) return THRESHOLDS.contrast.non_text;
  const large = scene.has.font_size && element.fontSize != null && element.fontSize >= THRESHOLDS.large_text_px;
  return large ? THRESHOLDS.contrast.large : THRESHOLDS.contrast.normal;
}

/**
 * Every instrument for every element of a scene, and the text load of the frame. `below` lists the
 * instruments whose value is under its threshold (for `icon_only`, a control that holds no text).
 */
export function measure(scene, { touch = false, vision = 'normal', readingStyle = 'read-all' } = {}) {
  if (!Object.hasOwn(WORD_BUDGETS, readingStyle)) throw new RangeError(`unknown reading style: ${readingStyle}`);
  const ranks = prominence(scene);
  const elements = scene.elements.map((e) => {
    const isControl = e.kind === 'control';
    const thresholds = {
      contrast: isControl || measuredAsText(e) ? contrastThreshold(scene, e, vision) : null,
      target_size: isControl ? (touch ? THRESHOLDS.target_size.touch : THRESHOLDS.target_size.default) : null,
    };
    const entry = {
      id: e.id,
      kind: e.kind,
      contrast: contrast(scene, e),
      target_size: targetSize(e),
      icon_only: iconOnly(scene, e),
      words: scene.has.text && hasInk(e) ? wordCount(e.text) : null,
      prominence_rank: ranks.get(e.id) ?? null,
      thresholds,
    };
    entry.below = [];
    if (entry.contrast != null && thresholds.contrast != null && entry.contrast < thresholds.contrast) entry.below.push('contrast');
    if (entry.target_size != null && entry.target_size < thresholds.target_size) entry.below.push('target_size');
    if (entry.icon_only === true) entry.below.push('icon_only');
    return entry;
  });
  const load = textLoad(scene);
  const wordBudget = WORD_BUDGETS[readingStyle];
  return {
    elements,
    frame: {
      words: load && load.words,
      reading_seconds: load && load.reading_seconds,
      word_budget: wordBudget,
      below: load && load.words > wordBudget ? ['text_load'] : [],
    },
  };
}
