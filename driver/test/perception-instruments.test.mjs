// The instruments, measured on synthetic frames whose colours and boxes are known, against ratios worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneOf } from '../perception/scene.mjs';
import {
  measure, contrast, targetSize, textLoad, iconOnly, prominence, wordCount, WORD_BUDGETS, THRESHOLDS,
} from '../perception/instruments.mjs';

const HAS = { nodes: true, text: true, font_size: true, links: true };
const WHITE = [255, 255, 255];
const solid = (width, height, [r, g, b]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, 255], i * 4);
  return { width, height, data };
};
// Paints a box given in frame pixels; the image is `scale` times larger than the frame.
const paint = (img, { x, y, w, h }, [r, g, b], scale = 1) => {
  for (let j = y * scale; j < (y + h) * scale; j++) for (let i = x * scale; i < (x + w) * scale; i++) img.data.set([r, g, b, 255], (j * img.width + i) * 4);
};
const node = (id, type, name, [x, y, w, h], extra = {}) => ({
  id, type, name, parent: 'f', box: { x, y, w, h }, text: null, font_size: null, image_fill: false, links: [], ...extra,
});
const sceneFrom = (nodes, { image = null, has = HAS, scale = 1, width = 200, height = 100 } = {}) =>
  sceneOf({ id: 'f', width, height, image_scale: scale, nodes }, { image, has });
const entry = (result, id) => result.elements.find((e) => e.id === id);

// Text in a 70 x 20 box: a stripe of ink with a lighter edge row, as anti-aliasing leaves it.
const textScene = (ink, { fontSize = 16, scale = 1, has = HAS } = {}) => {
  const image = solid(200 * scale, 100 * scale, WHITE);
  paint(image, { x: 10, y: 15, w: 60, h: 1 }, [190, 190, 190], scale);
  paint(image, { x: 10, y: 16, w: 60, h: 6 }, ink, scale);
  paint(image, { x: 10, y: 22, w: 60, h: 1 }, [190, 190, 190], scale);
  return sceneFrom([node('t', 'TEXT', 'Label', [5, 10, 70, 20], { text: 'Hello', font_size: fontSize })], { image, scale, has });
};
const buttonScene = (fill, [w, h] = [100, 40], { scale = 1 } = {}) => {
  const image = solid(200 * scale, 100 * scale, WHITE);
  paint(image, { x: 20, y: 20, w, h }, fill, scale);
  const label = node('label', 'TEXT', 'Label', [21, 21, 1, 1], { text: 'Pay' });
  return sceneFrom([node('b', 'INSTANCE', 'Button', [20, 20, w, h]), label], { image, scale });
};

test('text contrast is the ink against the background, within 0.1 of the computed ratio', () => {
  const scene = textScene([0x76, 0x76, 0x76]);
  assert.ok(Math.abs(contrast(scene, scene.elements[0]) - 4.54) <= 0.1);
  assert.deepEqual(entry(measure(scene), 't').below, []);
});

test('control contrast is the fill against the colour around it, within 0.1 of the computed ratio', () => {
  const scene = buttonScene([0, 0x66, 0xcc]);
  assert.ok(Math.abs(contrast(scene, scene.elements[0]) - 5.57) <= 0.1);
});

test('a frame whose image is twice the frame size gives the same ratios', () => {
  const text = textScene([0x76, 0x76, 0x76], { scale: 2 });
  assert.ok(Math.abs(contrast(text, text.elements[0]) - 4.54) <= 0.1);
  const button = buttonScene([0, 0x66, 0xcc], [100, 40], { scale: 2 });
  assert.ok(Math.abs(contrast(button, button.elements[0]) - 5.57) <= 0.1);
});

test('black on white is 21', () => {
  const scene = textScene([0, 0, 0]);
  assert.equal(contrast(scene, scene.elements[0]), 21);
});

test('a pale control is below the non-text threshold of 3', () => {
  const result = measure(buttonScene([230, 230, 230]));
  assert.ok(Math.abs(entry(result, 'b').contrast - 1.25) <= 0.1);
  assert.equal(entry(result, 'b').thresholds.contrast, 3);
  assert.deepEqual(entry(result, 'b').below, ['contrast']);
});

test('text at 3.19:1 passes as large text and fails as normal text', () => {
  const large = entry(measure(textScene([0x90, 0x90, 0x90], { fontSize: 28 })), 't');
  assert.deepEqual([large.thresholds.contrast, large.below], [3, []]);
  const normal = entry(measure(textScene([0x90, 0x90, 0x90], { fontSize: 14 })), 't');
  assert.deepEqual([normal.thresholds.contrast, normal.below], [4.5, ['contrast']]);
});

test('the large-text rule is not applied when the source gave no font size', () => {
  const scene = textScene([0x90, 0x90, 0x90], { fontSize: 28, has: { ...HAS, font_size: false } });
  const e = entry(measure(scene), 't');
  assert.deepEqual([e.thresholds.contrast, e.below], [4.5, ['contrast']]);
});

test('a low-vision viewer needs 7:1', () => {
  const scene = textScene([0x76, 0x76, 0x76]);
  const e = entry(measure(scene, { vision: 'low' }), 't');
  assert.deepEqual([e.thresholds.contrast, e.below], [7, ['contrast']]);
  const control = entry(measure(buttonScene([0, 0x66, 0xcc]), { vision: 'low' }), 'b');
  assert.deepEqual([control.thresholds.contrast, control.below], [7, ['contrast']]);
});

test('target size is the short side, below 24 px, and below 44 px on a touch device', () => {
  const small = buttonScene([0, 0, 0], [100, 23]);
  assert.equal(targetSize(small.elements[0]), 23);
  assert.deepEqual(entry(measure(small), 'b').below, ['target_size']);
  const edge = measure(buttonScene([0, 0, 0], [24, 80]));
  assert.deepEqual([entry(edge, 'b').target_size, entry(edge, 'b').below], [24, []]);
  const touch = measure(buttonScene([0, 0, 0], [100, 40]), { touch: true });
  assert.deepEqual([entry(touch, 'b').thresholds.target_size, entry(touch, 'b').below], [44, ['target_size']]);
  assert.deepEqual(entry(measure(buttonScene([0, 0, 0], [100, 44]), { touch: true }), 'b').below, []);
});

test('only a control has a target size, a prominence rank and an icon_only value', () => {
  const t = entry(measure(textScene([0, 0, 0])), 't');
  assert.deepEqual([t.target_size, t.icon_only, t.prominence_rank, t.thresholds.target_size], [null, null, null, null]);
});

test('English and Thai text are counted by words', () => {
  assert.equal(wordCount('Pay now and save ten percent today'), 7);
  // Thai has no spaces, and where ICU splits it differs between Node versions: a range, not one number.
  const thai = wordCount('ฉันอยากสั่งอาหารตอนนี้');
  assert.ok(thai >= 4 && thai <= 8, `${thai} words`);
  assert.equal(wordCount('ฉันอยากสั่งอาหารตอนนี้ Pay 2 items'), thai + 3);
  assert.equal(wordCount(''), 0);
});

test('text load counts the words of each text block and of the frame', () => {
  const scene = sceneFrom([
    node('a', 'TEXT', 'Title', [0, 0, 100, 20], { text: 'Pay now and save' }),
    node('b', 'TEXT', 'Note', [0, 30, 100, 20], { text: 'I want to order food now' }),
    node('c', 'TEXT', 'Empty', [0, 60, 100, 20], { text: '  ' }),
  ]);
  assert.deepEqual(textLoad(scene), { blocks: [{ id: 'a', words: 4 }, { id: 'b', words: 6 }], words: 10, reading_seconds: 3 });
});

test('a frame over its word budget is below text_load, and the budget follows the reading style', () => {
  const scene = sceneFrom([node('a', 'TEXT', 'Body', [0, 0, 100, 20], { text: 'word '.repeat(120) })]);
  const read = measure(scene, { readingStyle: 'read-all' }).frame;
  assert.deepEqual(read, { words: 120, reading_seconds: 36, word_budget: 250, below: [] });
  assert.deepEqual(measure(scene, { readingStyle: 'skim' }).frame, { words: 120, reading_seconds: 36, word_budget: 100, below: ['text_load'] });
  assert.deepEqual(measure(scene, { readingStyle: 'icons-only' }).frame.below, ['text_load']);
  assert.equal(entry(measure(scene), 'a').words, 120);
});

test('the word budgets are a frozen table and an unknown reading style is refused', () => {
  assert.ok(Object.isFrozen(WORD_BUDGETS));
  assert.deepEqual({ ...WORD_BUDGETS }, { 'read-all': 250, skim: 100, 'icons-only': 30 });
  assert.ok(Object.isFrozen(THRESHOLDS));
  assert.throws(() => measure(sceneFrom([]), { readingStyle: 'glance' }), RangeError);
});

test('a control with no text inside its box is icon-only, and one with a label is not', () => {
  const scene = sceneFrom([
    node('icon', 'INSTANCE', 'Button / Close', [10, 10, 40, 40]),
    node('plain', 'INSTANCE', 'Button / Pay', [10, 60, 100, 40]),
    node('label', 'TEXT', 'Label', [30, 68, 50, 24], { text: 'Pay' }),
    node('outside', 'TEXT', 'Caption', [150, 10, 40, 20], { text: 'Close' }),
  ]);
  assert.equal(iconOnly(scene, scene.elements[0]), true);
  assert.equal(iconOnly(scene, scene.elements[1]), false);
  const result = measure(scene);
  assert.deepEqual(entry(result, 'icon').below, ['icon_only']);
  assert.deepEqual(entry(result, 'plain').below, []);
});

test('a link made of text is not icon-only and is measured as text', () => {
  const image = solid(200, 100, WHITE);
  paint(image, { x: 10, y: 16, w: 60, h: 6 }, [0, 0, 0]);
  const scene = sceneFrom([node('l', 'TEXT', 'Forgot?', [5, 10, 70, 20], {
    text: 'Forgot?', font_size: 14, links: [{ trigger: 'click', action: 'navigate', to: 'x' }] })], { image });
  const e = entry(measure(scene), 'l');
  assert.deepEqual([e.kind, e.icon_only, e.contrast, e.thresholds.contrast], ['control', false, 21, 4.5]);
});

test('without text from the source, text_load and icon_only are null and nothing is flagged for them', () => {
  const has = { nodes: true, text: false, font_size: false, links: true };
  const scene = sceneFrom([node('icon', 'INSTANCE', 'Button', [10, 10, 40, 40]), node('t', 'TEXT', 'Label', [60, 10, 40, 20])], { has });
  assert.equal(textLoad(scene), null);
  assert.equal(iconOnly(scene, scene.elements[0]), null);
  const result = measure(scene);
  assert.deepEqual(result.frame, { words: null, reading_seconds: null, word_budget: 250, below: [] });
  assert.deepEqual([entry(result, 'icon').icon_only, entry(result, 'icon').words, entry(result, 't').words], [null, null, null]);
  assert.ok(!entry(result, 'icon').below.includes('icon_only'));
});

test('a value that cannot be read is null and never flagged', () => {
  const noImage = sceneFrom([node('b', 'INSTANCE', 'Button', [20, 20, 100, 40]), node('t', 'TEXT', 'Label', [0, 0, 50, 20], { text: 'Hi' })]);
  const result = measure(noImage);
  assert.deepEqual([entry(result, 'b').contrast, entry(result, 'b').prominence_rank, entry(result, 'b').below], [null, null, ['icon_only']]);
  assert.equal(entry(result, 't').contrast, null);

  const image = solid(200, 100, WHITE);
  const odd = sceneFrom([
    node('zero', 'INSTANCE', 'Button', [20, 20, 0, 0]),
    node('away', 'INSTANCE', 'Button', [500, 500, 40, 40]),
    node('flat', 'TEXT', 'Label', [60, 20, 40, 20], { text: 'Hi' }),
  ], { image });
  const r = measure(odd);
  assert.deepEqual([entry(r, 'zero').contrast, entry(r, 'zero').target_size, entry(r, 'zero').below], [null, null, []]);
  assert.deepEqual([entry(r, 'away').contrast, entry(r, 'away').below], [null, ['icon_only']]);
  assert.equal(entry(r, 'flat').contrast, null);
});

test('a control with no fill of its own (a ghost button) has no contrast to measure, is never below, and is not ranked', () => {
  const image = solid(300, 100, WHITE);
  paint(image, { x: 10, y: 10, w: 100, h: 40 }, [0, 0, 0]);
  paint(image, { x: 130, y: 10, w: 60, h: 1 }, [0, 0x66, 0xcc]);
  paint(image, { x: 130, y: 49, w: 60, h: 1 }, [0, 0x66, 0xcc]);
  const scene = sceneFrom([
    node('solid', 'INSTANCE', 'Button', [10, 10, 100, 40]),
    node('ghost', 'INSTANCE', 'Button', [130, 10, 60, 40]),
    node('same', 'INSTANCE', 'Button', [220, 10, 60, 40]),
    node('pale', 'INSTANCE', 'Button', [10, 60, 60, 30]),
  ], { image, width: 300 });
  paint(image, { x: 220, y: 10, w: 60, h: 40 }, [250, 250, 250]);
  paint(image, { x: 10, y: 60, w: 60, h: 30 }, [235, 235, 235]);
  const result = measure(scene);
  assert.deepEqual([entry(result, 'ghost').contrast, entry(result, 'ghost').prominence_rank], [null, null]);
  assert.ok(!entry(result, 'ghost').below.includes('contrast'));
  assert.deepEqual([entry(result, 'same').contrast, entry(result, 'same').prominence_rank], [null, null], 'a fill within 8 levels of its surroundings counts as no fill');
  assert.equal(entry(result, 'pale').contrast, 1.19, 'a deliberately pale fill is still measured');
  assert.ok(entry(result, 'pale').below.includes('contrast'));
  assert.deepEqual([entry(result, 'solid').contrast, entry(result, 'solid').prominence_rank], [21, 1]);
});

test('prominence ranks controls by area times contrast with their surroundings', () => {
  const image = solid(300, 100, WHITE);
  const boxes = { big: [10, 10, 100, 40], small: [130, 10, 50, 20], pale: [200, 10, 100, 40] };
  paint(image, { x: 10, y: 10, w: 100, h: 40 }, [0, 0, 0]);
  paint(image, { x: 130, y: 10, w: 50, h: 20 }, [0, 0, 0]);
  paint(image, { x: 200, y: 10, w: 100, h: 40 }, [230, 230, 230]);
  const scene = sceneFrom(Object.entries(boxes).map(([id, box]) => node(id, 'INSTANCE', 'Button', box)), { image, width: 300 });
  assert.deepEqual([...prominence(scene)], [['big', 1], ['small', 2], ['pale', 3]]);
  assert.deepEqual(measure(scene).elements.map((e) => e.prominence_rank), [1, 2, 3]);
});

test('controls that look alike share a rank', () => {
  const image = solid(300, 100, WHITE);
  paint(image, { x: 10, y: 10, w: 50, h: 40 }, [0, 0, 0]);
  paint(image, { x: 100, y: 10, w: 50, h: 40 }, [0, 0, 0]);
  paint(image, { x: 200, y: 10, w: 20, h: 20 }, [0, 0, 0]);
  const scene = sceneFrom([
    node('a', 'INSTANCE', 'Button', [10, 10, 50, 40]), node('b', 'INSTANCE', 'Button', [100, 10, 50, 40]),
    node('c', 'INSTANCE', 'Button', [200, 10, 20, 20]),
  ], { image, width: 300 });
  assert.deepEqual([...prominence(scene)], [['a', 1], ['b', 1], ['c', 3]]);
});
