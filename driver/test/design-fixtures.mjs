// Helpers for the design-mode tests: snapshot folders made of synthetic frames with known colours and boxes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

export const HAS_ALL = Object.freeze({ nodes: true, text: true, font_size: true, links: true });
export const WHITE = Object.freeze([255, 255, 255]);

/** A temp folder removed when the test ends. */
export function tmpDir(t, prefix = 'uxa-design-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** PNG bytes of a background with boxes painted on it. Boxes are in frame pixels and the image is `scale` times larger. */
export function framePng({ width, height, scale = 1, background = WHITE, paint = [] }) {
  const png = new PNG({ width: width * scale, height: height * scale });
  for (let i = 0; i < png.width * png.height; i++) png.data.set([...background, 255], i * 4);
  for (const { x, y, w, h, colour } of paint) {
    for (let j = y * scale; j < (y + h) * scale; j++) for (let i = x * scale; i < (x + w) * scale; i++) png.data.set([...colour, 255], (j * png.width + i) * 4);
  }
  return PNG.sync.write(png);
}

/** A snapshot node with the defaults of the snapshot shape. */
export const node = (id, type, name, parent, [x, y, w, h], extra = {}) => ({
  id, type, name, parent, box: { x, y, w, h }, text: null, font_size: null, image_fill: false, links: [], ...extra,
});
export const click = (to) => ({ trigger: 'click', action: 'navigate', to });
export const back = () => ({ trigger: 'click', action: 'back', to: null });
export const other = (action) => ({ trigger: 'click', action, to: null });

/**
 * Writes design.json and frames/N.png into a fresh temp folder and returns the folder. A frame is
 * {id, name, width, height, scale, background, paint, nodes, links, page, image: false}; `image: false` leaves the frame without an image.
 */
export function snapshotFolder(t, { frames, has = HAS_ALL, source = 'rest', flowStarts = [], arrows = [], skipped = [] }) {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'frames'));
  const written = frames.map((f, i) => {
    const entry = {
      id: f.id, name: f.name ?? f.id, page: f.page ?? null, width: f.width, height: f.height,
      image_scale: f.scale ?? 1, links: f.links ?? [], nodes: f.nodes ?? [],
    };
    if (f.image === false) return entry;
    fs.writeFileSync(path.join(dir, 'frames', `${i + 1}.png`), framePng(f));
    return { ...entry, image: `frames/${i + 1}.png` };
  });
  fs.writeFileSync(path.join(dir, 'design.json'), JSON.stringify({
    source, file_key: 'TestKey', version: '1', fetched_at: '2026-10-12T09:00:00Z', has, frames: written, flow_starts: flowStarts, arrows, skipped,
  }, null, 2));
  return dir;
}
