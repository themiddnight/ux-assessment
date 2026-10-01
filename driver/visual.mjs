// Pixel diffs for `visual_change` (SPEC §6). Works on raw RGBA buffers: no per-pixel objects.
// A page that changes on its own (a playhead, a spinner, a meter) must not make every action look
// like a response, so pixels that changed between steps form an "animation mask" that is ignored.
import { PNG } from 'pngjs';

export const CHANNEL_THRESHOLD = 24; // a pixel changed when any RGB channel differs by more than this
export const MIN_CHANGED_PIXELS = 16; // unmasked changed pixels needed for "changed"
export const MASK_DILATE_PX = 3;

/** PNG buffer -> {width, height, data: RGBA Uint8Array}. */
export function decode(png) {
  const { width, height, data } = PNG.sync.read(png);
  return { width, height, data };
}

/** Changed-pixel mask (1 = changed) of two same-size images; a size change marks every pixel. */
export function diff(a, b) {
  const n = b.width * b.height;
  const out = new Uint8Array(n);
  if (a.width !== b.width || a.height !== b.height) return out.fill(1);
  const x = a.data;
  const y = b.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (Math.abs(x[p] - y[p]) > CHANNEL_THRESHOLD || Math.abs(x[p + 1] - y[p + 1]) > CHANNEL_THRESHOLD
      || Math.abs(x[p + 2] - y[p + 2]) > CHANNEL_THRESHOLD) out[i] = 1;
  }
  return out;
}

/**
 * The animation mask, dilated by r px (square neighbourhood); null when empty. It is the union of
 * - `now`: pixels changing right before the action (two pre shots a moment apart), and
 * - pixels that changed in at least `minRecurring` of the `recent` between-step intervals.
 * A one-off change (a slow response landing between steps, a route change) shows up in a single
 * interval and is not masked; a playhead, spinner or ticking clock recurs and is.
 */
export function animationMask({ now = [], recent = [], minRecurring = 2 }, width, height, r = MASK_DILATE_PX) {
  const n = width * height;
  const fits = (m) => m && m.length === n;
  const u = new Uint8Array(n);
  let any = false;
  for (const m of now.filter(fits)) for (let i = 0; i < n; i++) if (m[i]) { u[i] = 1; any = true; }
  const hist = recent.filter(fits);
  if (hist.length >= minRecurring) {
    for (let i = 0; i < n; i++) {
      if (u[i]) continue;
      let c = 0;
      for (const m of hist) c += m[i];
      if (c >= minRecurring) { u[i] = 1; any = true; }
    }
  }
  if (!any) return null;
  // Separable dilation: rows, then columns, each with a sliding window count.
  const h = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(r, width); x++) count += u[row + x];
    for (let x = 0; x < width; x++) {
      if (x + r < width) count += u[row + x + r];
      if (x - r - 1 >= 0) count -= u[row + x - r - 1];
      h[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(n);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, height); y++) count += h[y * width + x];
    for (let y = 0; y < height; y++) {
      if (y + r < height) count += h[(y + r) * width + x];
      if (y - r - 1 >= 0) count -= h[(y - r - 1) * width + x];
      out[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Classify diff(pre, post) against the animation mask.
 * none: nothing changed · changed: >= 16 unmasked pixels changed · animating_only: otherwise.
 * changed_box: bounding box (CSS px) of the unmasked changed pixels when "changed", else null (a few
 * stray pixels at an animation's edge are not a location worth reporting).
 */
export function classify(d, mask, width) {
  let total = 0;
  let unmasked = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < d.length; i++) {
    if (!d[i]) continue;
    total++;
    if (mask && mask[i]) continue;
    unmasked++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (total === 0) return { visual_change: 'none', changed_box: null };
  if (unmasked < MIN_CHANGED_PIXELS) return { visual_change: 'animating_only', changed_box: null };
  return { visual_change: 'changed', changed_box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}
