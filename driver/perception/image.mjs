// PNG helpers for the perception layer: decode, encode, crop, scale down, colour sampling and outlining a box.
// Images are {width, height, data: RGBA bytes}. Boxes are {x, y, w, h} in image pixels.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/** Colours are grouped in buckets of this many levels per channel, so anti-aliasing does not split one colour. */
export const COLOUR_BUCKET = 8;
/** Pixels within this many levels (largest channel difference) of an excluded colour are skipped. */
export const EXCLUDE_TOLERANCE = 24;
/** The width of the band that outlines a box, in image pixels. */
export const OUTLINE_PX = 3;
/** The two colours an outline can take: the one that contrasts more with what lies under the band is used. */
const OUTLINE_COLOURS = Object.freeze([{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 255 }]);

/** PNG buffer to an image. */
export function decode(buffer) {
  const { width, height, data } = PNG.sync.read(buffer);
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** The image of the PNG file at `relative` under `dir`, or null when the path leaves `dir`, is absolute, or the file is missing or not a PNG. */
export function readImageInside(dir, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) return null;
  const file = path.resolve(dir, relative);
  const from = path.relative(path.resolve(dir), file);
  if (from === '..' || from.startsWith(`..${path.sep}`)) return null;
  try { return decode(fs.readFileSync(file)); } catch { return null; }
}

/** An image to a PNG buffer. */
export function encode({ width, height, data }) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.length);
  return PNG.sync.write(png);
}

/** The box clamped to the image as whole pixels, or null when nothing of it is inside. */
function clampBox(img, box) {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** The part of the image inside the box; a box outside the image gives an image of size 0 by 0. */
export function crop(img, box) {
  const b = clampBox(img, box);
  if (!b) return { width: 0, height: 0, data: new Uint8Array(0) };
  const width = b.x1 - b.x0;
  const height = b.y1 - b.y0;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((b.y0 + y) * img.width + b.x0) * 4;
    data.set(img.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** The image shrunk to `factor` of its size (0 < factor <= 1) by averaging the source pixels under each new pixel. */
export function scaleDown(img, factor) {
  if (!(factor > 0 && factor <= 1)) throw new RangeError(`scaleDown factor must be in (0, 1], got ${factor}`);
  const width = Math.max(1, Math.round(img.width * factor));
  const height = Math.max(1, Math.round(img.height * factor));
  const data = new Uint8Array(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const ya = Math.floor(y * sy);
    const yb = Math.max(ya + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const xa = Math.floor(x * sx);
      const xb = Math.max(xa + 1, Math.ceil((x + 1) * sx));
      const sum = [0, 0, 0, 0];
      for (let j = ya; j < Math.min(yb, img.height); j++) {
        for (let i = xa; i < Math.min(xb, img.width); i++) {
          const p = (j * img.width + i) * 4;
          for (let c = 0; c < 4; c++) sum[c] += img.data[p + c];
        }
      }
      const n = (Math.min(yb, img.height) - ya) * (Math.min(xb, img.width) - xa);
      const q = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) data[q + c] = Math.round(sum[c] / n);
    }
  }
  return { width, height, data };
}

// Transparent pixels are read as if laid on white, which is how a viewer sees a frame.
function rgbAt(data, p) {
  const a = data[p + 3] / 255;
  return [data[p] * a + 255 * (1 - a), data[p + 1] * a + 255 * (1 - a), data[p + 2] * a + 255 * (1 - a)];
}

function mostFrequent(img, outer, hole, exclude, tolerance) {
  const counts = new Map();
  const bucket = (v) => Math.floor(v / COLOUR_BUCKET);
  for (let y = outer.y0; y < outer.y1; y++) {
    for (let x = outer.x0; x < outer.x1; x++) {
      if (hole && x >= hole.x0 && x < hole.x1 && y >= hole.y0 && y < hole.y1) continue;
      const [r, g, b] = rgbAt(img.data, (y * img.width + x) * 4);
      if (exclude && Math.max(Math.abs(r - exclude.r), Math.abs(g - exclude.g), Math.abs(b - exclude.b)) <= tolerance) continue;
      const key = (bucket(r) << 16) | (bucket(g) << 8) | bucket(b);
      const e = counts.get(key);
      if (e) { e.n++; e.r += r; e.g += g; e.b += b; } else counts.set(key, { n: 1, r, g, b });
    }
  }
  let best = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best && { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

/**
 * The most frequent colour {r, g, b} inside the box, or null when no pixel is left. The winner is the
 * fullest bucket, and the colour returned is the mean of the pixels in it. `exclude` is a colour
 * whose near pixels are skipped; `tolerance` sets how near.
 */
export function dominantColour(img, box, { exclude = null, tolerance = EXCLUDE_TOLERANCE } = {}) {
  const outer = clampBox(img, box);
  return outer ? mostFrequent(img, outer, null, exclude, tolerance) : null;
}

/** The most frequent colour in a ring `px` pixels wide just outside the box, or null when the ring is empty. */
export function ringColour(img, box, px) {
  const hole = { x0: Math.floor(box.x), y0: Math.floor(box.y), x1: Math.ceil(box.x + box.w), y1: Math.ceil(box.y + box.h) };
  const outer = clampBox(img, { x: hole.x0 - px, y: hole.y0 - px, w: hole.x1 - hole.x0 + 2 * px, h: hole.y1 - hole.y0 + 2 * px });
  return outer ? mostFrequent(img, outer, hole, null, 0) : null;
}

function linear(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** The WCAG contrast ratio of two colours {r, g, b}, from 1 to 21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A copy of the image with a band of `px` pixels around the box, red or cyan by which contrasts more with the most frequent colour under
 * the band. The band lies just outside the box, and inside it on a side where the box touches the image edge, so it is always visible.
 * A box outside the image gives an unchanged copy.
 */
export function outlineBox(img, box, px = OUTLINE_PX) {
  const out = { width: img.width, height: img.height, data: Uint8Array.from(img.data) };
  const b = clampBox(img, box);
  if (!b) return out;
  const roomLeft = b.x0 - px >= 0;
  const roomTop = b.y0 - px >= 0;
  const roomRight = b.x1 + px <= img.width;
  const roomBottom = b.y1 + px <= img.height;
  const outer = { x0: roomLeft ? b.x0 - px : b.x0, y0: roomTop ? b.y0 - px : b.y0, x1: roomRight ? b.x1 + px : b.x1, y1: roomBottom ? b.y1 + px : b.y1 };
  const hole = { x0: roomLeft ? b.x0 : b.x0 + px, y0: roomTop ? b.y0 : b.y0 + px, x1: roomRight ? b.x1 : b.x1 - px, y1: roomBottom ? b.y1 : b.y1 - px };
  const under = mostFrequent(img, outer, hole, null, 0);
  if (!under) return out;
  const { r, g, b: blue } = OUTLINE_COLOURS.reduce((best, c) => (contrastRatio(c, under) > contrastRatio(best, under) ? c : best));
  for (let y = outer.y0; y < outer.y1; y++) {
    for (let x = outer.x0; x < outer.x1; x++) {
      if (x >= hole.x0 && x < hole.x1 && y >= hole.y0 && y < hole.y1) continue;
      out.data.set([r, g, blue, 255], (y * img.width + x) * 4);
    }
  }
  return out;
}
