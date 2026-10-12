// The PNG helpers of the perception layer, checked on small synthetic images with known colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decode, encode, crop, scaleDown, dominantColour, ringColour, readImageInside, contrastRatio, outlineBox } from '../perception/image.mjs';

const solid = (width, height, [r, g, b, a = 255]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, a], i * 4);
  return { width, height, data };
};
const paint = (img, { x, y, w, h }, [r, g, b, a = 255]) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) img.data.set([r, g, b, a], (j * img.width + i) * 4);
  return img;
};
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('encode then decode gives the same image back', () => {
  const img = paint(solid(3, 2, [10, 20, 30]), { x: 2, y: 1, w: 1, h: 1 }, [255, 0, 0, 128]);
  const back = decode(encode(img));
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.data], [...img.data]);
});

test('crop returns the pixels inside the box', () => {
  const img = paint(solid(6, 4, [255, 255, 255]), { x: 2, y: 1, w: 2, h: 2 }, [0, 0, 255]);
  const part = crop(img, { x: 2, y: 1, w: 2, h: 2 });
  assert.equal(part.width, 2);
  assert.equal(part.height, 2);
  assert.deepEqual([...part.data], Array.from({ length: 4 }, () => [0, 0, 255, 255]).flat());
});

test('crop clamps a box that overhangs the image and returns nothing for a box outside it', () => {
  const img = paint(solid(6, 4, [255, 255, 255]), { x: 5, y: 3, w: 1, h: 1 }, [9, 9, 9]);
  const corner = crop(img, { x: 4, y: 2, w: 10, h: 10 });
  assert.equal(corner.width, 2);
  assert.equal(corner.height, 2);
  assert.deepEqual(pixel(corner, 1, 1), [9, 9, 9, 255]);
  const none = crop(img, { x: 20, y: 20, w: 5, h: 5 });
  assert.deepEqual([none.width, none.height, none.data.length], [0, 0, 0]);
});

test('scaleDown to a half keeps four flat quadrants as four pixels', () => {
  const img = solid(4, 4, [255, 255, 255]);
  paint(img, { x: 0, y: 0, w: 2, h: 2 }, [255, 0, 0]);
  paint(img, { x: 2, y: 0, w: 2, h: 2 }, [0, 255, 0]);
  paint(img, { x: 0, y: 2, w: 2, h: 2 }, [0, 0, 255]);
  const small = scaleDown(img, 0.5);
  assert.deepEqual([small.width, small.height], [2, 2]);
  assert.deepEqual([pixel(small, 0, 0), pixel(small, 1, 0), pixel(small, 0, 1), pixel(small, 1, 1)],
    [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]]);
});

test('scaleDown averages the pixels under each new pixel', () => {
  const img = paint(solid(2, 1, [0, 0, 0]), { x: 1, y: 0, w: 1, h: 1 }, [255, 255, 255]);
  assert.deepEqual(pixel(scaleDown(img, 0.5), 0, 0), [128, 128, 128, 255]);
});

test('scaleDown by 1 returns the same pixels and a factor outside (0, 1] is refused', () => {
  const img = paint(solid(3, 3, [1, 2, 3]), { x: 1, y: 1, w: 1, h: 1 }, [4, 5, 6]);
  assert.deepEqual([...scaleDown(img, 1).data], [...img.data]);
  assert.throws(() => scaleDown(img, 0), RangeError);
  assert.throws(() => scaleDown(img, 1.5), RangeError);
});

test('dominantColour is the most frequent colour and exclude skips the background', () => {
  const img = paint(solid(10, 10, [255, 255, 255]), { x: 3, y: 3, w: 3, h: 3 }, [0, 0, 0]);
  const all = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(dominantColour(img, all), { r: 255, g: 255, b: 255 });
  assert.deepEqual(dominantColour(img, all, { exclude: { r: 255, g: 255, b: 255 } }), { r: 0, g: 0, b: 0 });
  assert.deepEqual(dominantColour(img, { x: 3, y: 3, w: 3, h: 3 }), { r: 0, g: 0, b: 0 });
});

test('dominantColour treats near shades as one colour and returns their mean', () => {
  const half = paint(solid(10, 2, [255, 255, 255]), { x: 0, y: 1, w: 10, h: 1 }, [250, 250, 250]);
  assert.deepEqual(dominantColour(half, { x: 0, y: 0, w: 10, h: 2 }), { r: 253, g: 253, b: 253 });
});

test('dominantColour is null when the box is outside the image or every pixel is excluded', () => {
  const img = solid(4, 4, [10, 10, 10]);
  assert.equal(dominantColour(img, { x: 10, y: 10, w: 2, h: 2 }), null);
  assert.equal(dominantColour(img, { x: 0, y: 0, w: 4, h: 4 }, { exclude: { r: 10, g: 10, b: 10 } }), null);
});

test('dominantColour reads a transparent pixel as white', () => {
  assert.deepEqual(dominantColour(solid(2, 2, [0, 0, 0, 0]), { x: 0, y: 0, w: 2, h: 2 }), { r: 255, g: 255, b: 255 });
});

test('ringColour is the colour just outside the box and ignores the box itself', () => {
  const img = paint(solid(30, 30, [200, 200, 200]), { x: 10, y: 10, w: 10, h: 10 }, [255, 0, 0]);
  assert.deepEqual(ringColour(img, { x: 10, y: 10, w: 10, h: 10 }, 3), { r: 200, g: 200, b: 200 });
});

test('ringColour ignores pixels farther than the ring width and is null when the box fills the image', () => {
  const img = paint(solid(40, 40, [0, 0, 0]), { x: 8, y: 8, w: 24, h: 24 }, [255, 255, 255]);
  paint(img, { x: 14, y: 14, w: 12, h: 12 }, [255, 0, 0]);
  assert.deepEqual(ringColour(img, { x: 14, y: 14, w: 12, h: 12 }, 2), { r: 255, g: 255, b: 255 });
  assert.equal(ringColour(img, { x: 0, y: 0, w: 40, h: 40 }, 3), null);
});

test('readImageInside reads a PNG under the folder and refuses a path that leaves it, an absolute path and a file that is not a PNG', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'snapshot');
  fs.mkdirSync(path.join(snapshot, 'frames'), { recursive: true });
  const png = encode(solid(2, 1, [1, 2, 3]));
  fs.writeFileSync(path.join(snapshot, 'frames', '1.png'), png);
  fs.writeFileSync(path.join(root, 'outside.png'), png);
  fs.writeFileSync(path.join(snapshot, 'frames', 'text.png'), 'not a png');
  assert.deepEqual(readImageInside(snapshot, 'frames/1.png')?.width, 2);
  assert.equal(readImageInside(snapshot, 'frames/../frames/1.png')?.width, 2, 'a path that stays inside is fine');
  assert.equal(readImageInside(snapshot, '../outside.png'), null);
  assert.equal(readImageInside(snapshot, 'frames/../../outside.png'), null);
  assert.equal(readImageInside(snapshot, path.join(root, 'outside.png')), null);
  assert.equal(readImageInside(snapshot, 'frames/text.png'), null);
  assert.equal(readImageInside(snapshot, 'frames/missing.png'), null);
  assert.equal(readImageInside(snapshot, undefined), null);
});

test('contrastRatio is 21 for black on white, 1 for equal colours, and does not depend on the order', () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  assert.equal(contrastRatio(black, white), 21);
  assert.equal(contrastRatio(white, black), 21);
  assert.equal(contrastRatio(white, white), 1);
});

const RED = [255, 0, 0, 255];
const CYAN = [0, 255, 255, 255];

test('outlineBox draws a 3 pixel red band just outside a box on a light background and leaves everything else alone', () => {
  const img = solid(30, 30, [250, 250, 250]);
  paint(img, { x: 10, y: 10, w: 8, h: 6 }, [20, 90, 200]);
  const before = [...img.data];
  const out = outlineBox(img, { x: 10, y: 10, w: 8, h: 6 });
  assert.deepEqual([...img.data], before, 'the input is not changed');
  assert.deepEqual([out.width, out.height], [30, 30]);
  assert.deepEqual([pixel(out, 7, 10), pixel(out, 9, 10), pixel(out, 18, 12), pixel(out, 20, 12), pixel(out, 12, 7), pixel(out, 12, 9), pixel(out, 12, 16), pixel(out, 12, 18)],
    Array(8).fill(RED));
  assert.deepEqual([pixel(out, 6, 10), pixel(out, 21, 12), pixel(out, 12, 6), pixel(out, 12, 19)], Array(4).fill([250, 250, 250, 255]), 'the band is 3 pixels wide');
  assert.deepEqual([pixel(out, 10, 10), pixel(out, 17, 15), pixel(out, 13, 12)], Array(3).fill([20, 90, 200, 255]), 'the box itself is untouched');
  assert.deepEqual(pixel(out, 8, 8), RED, 'the corners are part of the band');
});

test('outlineBox picks cyan on a dark background, by the colour under the band', () => {
  const dark = outlineBox(solid(30, 30, [10, 10, 30]), { x: 10, y: 10, w: 8, h: 6 });
  assert.deepEqual([pixel(dark, 8, 12), pixel(dark, 12, 8)], [CYAN, CYAN]);
  const light = paint(solid(30, 30, [10, 10, 30]), { x: 5, y: 5, w: 20, h: 20 }, [250, 250, 250]);
  paint(light, { x: 10, y: 10, w: 8, h: 6 }, [10, 10, 30]);
  const red = outlineBox(light, { x: 10, y: 10, w: 8, h: 6 });
  assert.deepEqual(pixel(red, 8, 12), RED, 'the band lies on the light panel, not on the dark page around it');
});

test('outlineBox draws the band inside the box on a side where the box touches the image edge', () => {
  const img = solid(20, 20, [250, 250, 250]);
  const out = outlineBox(img, { x: 0, y: 5, w: 10, h: 10 });
  assert.deepEqual([pixel(out, 0, 10), pixel(out, 2, 10), pixel(out, 10, 10), pixel(out, 12, 10)], [RED, RED, RED, RED]);
  assert.deepEqual([pixel(out, 3, 10), pixel(out, 13, 10)], [[250, 250, 250, 255], [250, 250, 250, 255]], 'inside the box and past the band');
  assert.deepEqual([pixel(out, 5, 2), pixel(out, 5, 4), pixel(out, 5, 15), pixel(out, 5, 17)], [RED, RED, RED, RED], 'the sides with room get it outside');
});

test('outlineBox rounds a fractional box outward, and gives the image back unchanged for a box outside it', () => {
  const out = outlineBox(solid(30, 30, [250, 250, 250]), { x: 10.4, y: 10.4, w: 7.2, h: 5.2 });
  assert.deepEqual([pixel(out, 9, 12), pixel(out, 7, 12)], [RED, RED], 'from floor(10.4) = 10: the band starts at 9');
  assert.deepEqual(pixel(out, 6, 12), [250, 250, 250, 255]);
  const img = solid(10, 10, [1, 2, 3]);
  assert.deepEqual([...outlineBox(img, { x: 50, y: 50, w: 5, h: 5 }).data], [...img.data]);
});
