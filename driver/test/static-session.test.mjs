// The static session of design mode, called directly: folds, the order of the answers, every refusal, link following and the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_IMAGE_PIXELS, StaticSession, SENTENCES, VISIT_STATES, VISIT_TRANSITIONS } from '../static-session.mjs';
import { decode } from '../perception/image.mjs';
import { back, click, node, other, snapshotFolder, tmpDir } from './design-fixtures.mjs';

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 160, 0];

const open = (t, design, options = {}) => {
  const dir = path.join(tmpDir(t), 'viewer');
  return { dir, session: StaticSession.start({ id: 'v', dir, design, frame: options.frame ?? 'a', ...options }) };
};
const logOf = (dir) => fs.readFileSync(path.join(dir, 'design-log.jsonl'), 'utf8').trim().split('\n').map((line) => {
  const { t, ...rest } = JSON.parse(line);
  assert.equal(typeof t, 'number');
  return rest;
});
const pixelOf = (png, x, y) => {
  const img = decode(png);
  return [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
};
const lookAt = (point) => ({ first_look: { purpose: 'a page', confidence: 'guess', main_action: { what: 'the button', point } } });
const readAll = (first_click, extra = {}) => ({
  after_reading: { pressable: [], not_understood: [], purpose_changed: { changed: false, purpose: null }, ...(first_click ? { first_click } : {}), ...extra },
});
const clickAt = (point) => ({ result: 'click', point, expect: 'something happens' });
/** One whole visit: view, first look, read, first click. */
async function visit(session, point) {
  assert.equal((await session.view()).ok, true);
  assert.equal((await session.answer(lookAt([1, 1]))).ok, true);
  return session.answer(readAll(clickAt(point)));
}

// A phone-sized frame, 90 wide: a fold of 160 px, scrolled 140 px at a time, 240 px of travel.
const tall = (t) => snapshotFolder(t, {
  frames: [{
    id: 'a', width: 90, height: 400,
    paint: [{ x: 0, y: 170, w: 90, h: 20, colour: RED }, { x: 0, y: 380, w: 90, h: 20, colour: BLUE }],
    nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [10, 20, 70, 30])],
  }],
});

test('the states and what each call does in them are a table', () => {
  assert.deepEqual([...VISIT_STATES], ['unseen', 'seen', 'first_look_done', 'done']);
  assert.deepEqual(VISIT_TRANSITIONS.unseen, { view: 'seen', scroll: 'ANSWER_FIRST', first_look: 'LOOK_FIRST', after_reading: 'LOOK_FIRST' });
  assert.deepEqual(VISIT_TRANSITIONS.seen, { view: 'seen', scroll: 'ANSWER_FIRST', first_look: 'first_look_done', after_reading: 'ANSWER_FIRST' });
  assert.deepEqual(VISIT_TRANSITIONS.first_look_done, { view: 'first_look_done', scroll: 'first_look_done', first_look: 'ALREADY_ANSWERED', after_reading: 'done' });
  assert.ok(Object.isFrozen(VISIT_TRANSITIONS) && Object.isFrozen(VISIT_TRANSITIONS.seen));
});

test('a phone frame is a touch device with a 16 to 9 fold, and a frame wider than 480 px is a desktop with a 5 to 8 fold', (t) => {
  const design = snapshotFolder(t, { frames: [
    { id: 'a', width: 390, height: 1420 }, { id: 'b', width: 480, height: 2000 }, { id: 'c', width: 481, height: 2000 }, { id: 'd', width: 90, height: 100 },
  ] });
  const info = (frame) => { const { session } = open(t, design, { frame }); return [session.device, session.foldHeight]; };
  assert.deepEqual(info('a'), ['touch', 693]);
  assert.deepEqual(info('b'), ['touch', 853]);
  assert.deepEqual(info('c'), ['desktop', 301]);
  assert.deepEqual(info('d'), ['touch', 100], 'the fold is never taller than the frame');
});

test('the first view is the top fold; scrolling moves a fold less an overlap and stops at the ends', async (t) => {
  const { session } = open(t, tall(t));
  const first = await session.view();
  assert.equal(first.text, 'Screen 1. You see the top part; there is more below.');
  assert.deepEqual([pixelOf(first.png, 45, 100), pixelOf(first.png, 45, 155)], [[255, 255, 255], [255, 255, 255]]);
  assert.equal(decode(first.png).height, 160);
  assert.equal((await session.answer(lookAt([10, 10]))).ok, true);

  const second = await session.view({ scroll: 'down' });
  assert.equal(second.text, 'Screen 1. You see a middle part; there is more above and below.');
  assert.deepEqual([pixelOf(second.png, 45, 20), pixelOf(second.png, 45, 40)], [[255, 255, 255], RED], 'the red band at 170 to 190 now sits at 30 to 50');

  const third = await session.view({ scroll: 'down' });
  assert.equal(third.text, 'Screen 1. You see the bottom part; there is more above.');
  assert.deepEqual([pixelOf(third.png, 45, 100), pixelOf(third.png, 45, 150)], [[255, 255, 255], BLUE], 'the last fold ends at the frame bottom');

  const stuck = await session.view({ scroll: 'down' });
  assert.equal(stuck.text, 'Screen 1. You see the bottom part; there is more above. You cannot scroll further down.');

  assert.equal((await session.view({ scroll: 'up' })).text, 'Screen 1. You see a middle part; there is more above and below.');
  await session.view({ scroll: 'up' });
  assert.equal((await session.view({ scroll: 'up' })).text, 'Screen 1. You see the top part; there is more below. You cannot scroll further up.');
});

test('a frame that fits one fold has nothing to scroll', async (t) => {
  const { session } = open(t, snapshotFolder(t, { frames: [{ id: 'a', width: 90, height: 100 }] }));
  assert.equal((await session.view()).text, 'Screen 1. You see the whole screen.');
});

test('a view without scroll shows the same part again', async (t) => {
  const { session } = open(t, tall(t));
  await session.view();
  await session.answer(lookAt([10, 10]));
  await session.view({ scroll: 'down' });
  assert.equal((await session.view()).text, 'Screen 1. You see a middle part; there is more above and below.');
});

test('a frame wider than 1568 px is scaled down and a point in the served image maps back to frame pixels', async (t) => {
  const design = snapshotFolder(t, { frames: [{
    id: 'a', width: 2000, height: 500, paint: [{ x: 900, y: 200, w: 200, h: 100, colour: GREEN }],
    nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [900, 200, 200, 100])],
  }] });
  const { dir, session } = open(t, design);
  const shown = await session.view();
  const served = decode(shown.png);
  assert.deepEqual([served.width, served.height], [1568, 392]);
  assert.deepEqual(pixelOf(shown.png, 100, 100), [255, 255, 255]);
  assert.deepEqual([pixelOf(shown.png, 784, 196), pixelOf(shown.png, 784, 150)], [GREEN, [255, 255, 255]], 'the green box at frame 200 to 300 is at 157 to 235');
  assert.equal((await session.answer(lookAt([784, 196]))).ok, true);
  const answer = logOf(dir).find((l) => l.type === 'answer');
  assert.deepEqual(answer.answer.main_action, { what: 'the button', point: [1000, 250], element: 'a:1', control: 'a:1' });
});

test('a fold of 1440 by 900 is above the pixel limit, is served smaller, and its right edge maps back to the right edge of the frame', async (t) => {
  const design = snapshotFolder(t, { frames: [{
    id: 'a', width: 1440, height: 900, paint: [{ x: 1400, y: 0, w: 40, h: 900, colour: GREEN }],
    nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [1400, 0, 40, 900])],
  }] });
  const { dir, session } = open(t, design);
  const shown = await session.view();
  const served = decode(shown.png);
  assert.deepEqual([served.width, served.height], [1356, 848]);
  assert.ok(served.width * served.height <= MAX_IMAGE_PIXELS, 'at most the pixel limit');
  assert.deepEqual([pixelOf(shown.png, 1355, 400), pixelOf(shown.png, 1300, 400)], [GREEN, [255, 255, 255]]);
  assert.equal((await session.answer(lookAt([1355, 400]))).ok, true);
  const answer = logOf(dir).find((l) => l.type === 'answer');
  assert.deepEqual(answer.answer.main_action, { what: 'the button', point: [1438.94, 424.53], element: 'a:1', control: 'a:1' });
});

test('a fold that rounds to a few hundred pixels over the limit is scaled once more', async (t) => {
  const { session } = open(t, snapshotFolder(t, { frames: [{ id: 'a', width: 1357, height: 848 }] }));
  const served = decode((await session.view()).png);
  assert.deepEqual([served.width, served.height], [1350, 843], 'scaling by the exact factor would round to 1357 by 848, which is 1150736 pixels');
});

test('a frame twice as wide as the limit is halved', async (t) => {
  const design = snapshotFolder(t, { frames: [{ id: 'a', width: 3136, height: 1000 }] });
  const { dir, session } = open(t, design);
  const served = decode((await session.view()).png);
  assert.deepEqual([served.width, served.height], [1568, 500]);
  await session.answer(lookAt([1000, 250]));
  assert.deepEqual(logOf(dir).at(-1).answer.main_action.point, [2000, 500]);
});

test('an image scale above 1 maps points back to frame pixels', async (t) => {
  const design = snapshotFolder(t, { frames: [{
    id: 'a', width: 90, height: 100, scale: 2, nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [10, 20, 40, 30])],
  }] });
  const { dir, session } = open(t, design);
  const served = decode((await session.view()).png);
  assert.deepEqual([served.width, served.height], [180, 200]);
  await session.answer(lookAt([60, 90]));
  assert.deepEqual(logOf(dir).at(-1).answer.main_action, { what: 'the button', point: [30, 45], element: 'a:1', control: 'a:1' });
});

test('a point on the scrolled part maps to the frame below the first fold', async (t) => {
  const { dir, session } = open(t, tall(t));
  await session.view();
  await session.answer(lookAt([10, 10]));
  await session.view({ scroll: 'down' });
  await session.answer(readAll(null, { pressable: [{ point: [45, 40], expect: 'nothing', confidence: 'cannot_tell' }] }));
  assert.deepEqual(logOf(dir).find((l) => l.part === 'after_reading').answer.pressable, [{ point: [45, 180], element: null, control: null, expect: 'nothing', confidence: 'cannot_tell' }]);
});

// --- refusals ----------------------------------------------------------------------------------------------------

const refused = (result, code) => {
  assert.equal(result.ok, false);
  assert.equal(result.refused, code);
  assert.match(result.text, new RegExp(`^${code}: `));
  assert.ok(!result.text.includes('\n'));
};

test('LOOK_FIRST: an answer before the first view of the frame', async (t) => {
  const { session } = open(t, tall(t));
  refused(await session.answer(lookAt([1, 1])), 'LOOK_FIRST');
  refused(await session.answer(readAll()), 'LOOK_FIRST');
  assert.equal((await session.answer(lookAt([1, 1]))).ok, false);
  assert.equal((await session.view()).ok, true, 'nothing was changed by the refusals');
});

test('ANSWER_FIRST: scrolling or after_reading before first_look is recorded', async (t) => {
  const { session } = open(t, tall(t));
  refused(await session.view({ scroll: 'down' }), 'ANSWER_FIRST');
  await session.view();
  refused(await session.view({ scroll: 'down' }), 'ANSWER_FIRST');
  refused(await session.answer(readAll()), 'ANSWER_FIRST');
  assert.equal((await session.view()).text, 'Screen 1. You see the top part; there is more below.', 'a view without scroll is allowed');
  assert.equal((await session.answer(lookAt([1, 1]))).ok, true);
  assert.equal((await session.view({ scroll: 'down' })).ok, true);
});

test('ALREADY_ANSWERED: first_look for the same frame twice', async (t) => {
  const { dir, session } = open(t, tall(t));
  await session.view();
  assert.equal((await session.answer(lookAt([1, 1]))).ok, true);
  const again = await session.answer(lookAt([2, 2]));
  refused(again, 'ALREADY_ANSWERED');
  assert.equal(again.text, 'ALREADY_ANSWERED: you already gave first_look for this screen.');
  assert.equal(logOf(dir).filter((l) => l.type === 'answer').length, 1);
});

test('VIEW_CAP_REACHED: after views_per_frame views, and answers still work', async (t) => {
  const { session } = open(t, tall(t), { viewsPerFrame: 2 });
  assert.equal((await session.view()).ok, true);
  assert.equal((await session.view()).ok, true);
  const capped = await session.view();
  refused(capped, 'VIEW_CAP_REACHED');
  assert.equal(capped.text, 'VIEW_CAP_REACHED: you cannot look at this screen again (2 looks used). Answer with what you have seen.');
  assert.equal((await session.answer(lookAt([1, 1]))).ok, true);
  refused(await session.view({ scroll: 'down' }), 'VIEW_CAP_REACHED');
  assert.equal((await session.answer(readAll())).ok, true);
});

test('the views per frame default to 12', async (t) => {
  const { session } = open(t, tall(t));
  for (let i = 0; i < 12; i++) assert.equal((await session.view()).ok, true, `view ${i + 1}`);
  refused(await session.view(), 'VIEW_CAP_REACHED');
});

test('SESSION_ENDED: every call after the session is over', async (t) => {
  const { session } = open(t, tall(t));
  await session.view();
  await session.answer(lookAt([1, 1]));
  assert.equal((await session.answer(readAll())).text, 'Answers recorded. The session is over.');
  for (const result of [await session.view(), await session.view({ scroll: 'down' }), await session.answer(lookAt([1, 1])), await session.answer(readAll()), await session.answer({})]) {
    refused(result, 'SESSION_ENDED');
  }
});

test('INVALID_ANSWER: a point outside the image last returned, with nothing recorded', async (t) => {
  const { dir, session } = open(t, tall(t));
  await session.view();
  for (const point of [[90, 10], [10, 160], [-1, 5], [200, 500]]) {
    const result = await session.answer(lookAt(point));
    refused(result, 'INVALID_ANSWER');
    assert.match(result.text, /is outside the picture you were last shown \(90 by 160\)\. Nothing was recorded/);
  }
  assert.deepEqual(logOf(dir).map((l) => l.type), ['start', 'view']);
  assert.equal((await session.answer(lookAt([89, 159]))).ok, true, 'the last pixel is inside');
  await session.view({ scroll: 'down' });
  const read = await session.answer(readAll(null, { pressable: [{ point: [5, 5], expect: 'x', confidence: 'sure' }, { point: [5, 170], expect: 'y', confidence: 'sure' }] }));
  assert.equal(read.text, 'INVALID_ANSWER: pressable[1].point [5, 170] is outside the picture you were last shown (90 by 160). Nothing was recorded. Point inside the picture.');
  assert.equal(logOf(dir).filter((l) => l.type === 'answer').length, 1);
  assert.equal((await session.answer(readAll())).ok, true, 'the same part can be sent again after a refusal');
});

test('INVALID_ANSWER: both parts, no part, a field of the wrong kind and more than 5 pressable things', async (t) => {
  const { session } = open(t, tall(t));
  await session.view();
  refused(await session.answer({ ...lookAt([1, 1]), ...readAll() }), 'INVALID_ANSWER');
  refused(await session.answer({}), 'INVALID_ANSWER');
  const wrong = await session.answer({ first_look: { purpose: 'p', confidence: 'maybe', main_action: { what: 'w', point: [1, 1] } } });
  refused(wrong, 'INVALID_ANSWER');
  assert.match(wrong.text, /^INVALID_ANSWER: first_look\.confidence: /);
  assert.equal((await session.answer(lookAt([1, 1]))).ok, true, 'the state did not move');
  const six = Array.from({ length: 6 }, () => ({ point: [1, 1], expect: 'e', confidence: 'sure' }));
  const many = await session.answer(readAll(null, { pressable: six }));
  refused(many, 'INVALID_ANSWER');
  assert.match(many.text, /^INVALID_ANSWER: after_reading\.pressable: /);
});

test('first_click is required when the session asks for it and refused when it does not', async (t) => {
  const asked = open(t, tall(t), { firstClick: true });
  await asked.session.view();
  await asked.session.answer(lookAt([1, 1]));
  assert.equal((await asked.session.answer(readAll())).text, 'INVALID_ANSWER: after_reading.first_click is needed: say where you would click first. Nothing was recorded.');
  assert.match((await asked.session.answer(readAll({ result: 'click', expect: 'x' }))).text, /^INVALID_ANSWER: after_reading\.first_click\.point is needed when result is click/);
  assert.equal((await asked.session.answer(readAll({ result: 'cannot_find' }))).ok, true);

  const plain = open(t, tall(t));
  await plain.session.view();
  await plain.session.answer(lookAt([1, 1]));
  assert.equal((await plain.session.answer(readAll(clickAt([1, 1])))).text, 'INVALID_ANSWER: after_reading.first_click is not asked for. Nothing was recorded.');
});

test('a session cannot start without an image, on an unknown frame, or following links without a first click', (t) => {
  const design = snapshotFolder(t, { frames: [{ id: 'a', width: 90, height: 100 }, { id: 'b', width: 90, height: 100, image: false }] });
  const start = (options) => StaticSession.start({ id: 'v', dir: path.join(tmpDir(t), 'v'), design, frame: 'a', ...options });
  assert.throws(() => start({ frame: 'b' }), /^Error: frame "b" has no image$/);
  assert.throws(() => start({ frame: 'zz' }), /^Error: frame "zz" is not in the design$/);
  assert.throws(() => start({ followLinks: true }), /follow_links needs first_click/);
  assert.throws(() => start({ viewsPerFrame: 0 }), /views_per_frame/);
  assert.throws(() => StaticSession.start({ id: 'v', dir: tmpDir(t), design: tmpDir(t), frame: 'a' }), /cannot read design\.json/);
  const dir = path.join(tmpDir(t), 'never');
  assert.throws(() => StaticSession.start({ id: 'v', dir, design, frame: 'b' }));
  assert.equal(fs.existsSync(dir), false, 'a failed start leaves no folder');
});

// --- links -------------------------------------------------------------------------------------------------------

// a: a button to b and a hover-only box. b: back, a button to c, an overlay and a frame with no links. c: the whole frame is a link to a.
const flow = (t) => snapshotFolder(t, { frames: [
  { id: 'a', width: 90, height: 100, nodes: [
    node('a:1', 'INSTANCE', 'Button', 'a', [10, 10, 70, 30], { links: [click('b')] }),
    node('a:2', 'FRAME', 'Hover only', 'a', [10, 50, 70, 30], { links: [{ trigger: 'hover', action: 'overlay', to: null }] }),
  ] },
  { id: 'b', width: 90, height: 100, nodes: [
    node('b:1', 'TEXT', 'Back', 'b', [0, 0, 30, 20], { text: 'Back', links: [back()] }),
    node('b:2', 'INSTANCE', 'Button', 'b', [10, 30, 70, 30], { links: [click('c')] }),
    node('b:3', 'INSTANCE', 'Menu', 'b', [10, 70, 70, 20], { links: [other('overlay')] }),
  ] },
  { id: 'c', width: 90, height: 100, links: [click('a')], nodes: [node('c:1', 'FRAME', 'Card', 'c', [10, 10, 30, 30])] },
] });

test('a flow: navigate, then back, then navigate again, and the log tells it', async (t) => {
  const design = flow(t);
  const { dir, session } = open(t, design, { followLinks: true, firstClick: true });
  assert.equal((await visit(session, [20, 20])).text, SENTENCES.moved);
  assert.equal((await session.signals()).frame, 'b');
  assert.equal((await visit(session, [5, 5])).text, SENTENCES.moved);
  const signals = await session.signals();
  assert.deepEqual([signals.frame, signals.history, signals.frames_shown, signals.state, signals.over], ['a', [], 3, 'unseen', null]);
  assert.equal((await session.answer(lookAt([1, 1]))).refused, 'LOOK_FIRST', 'a new screen starts unseen');
  assert.equal((await visit(session, [20, 20])).text, SENTENCES.moved);
  assert.equal((await session.view()).text, 'Screen 4. You see the whole screen.');
  await session.answer(lookAt([1, 1]));
  assert.equal((await session.answer(readAll(clickAt([20, 40])))).text, SENTENCES.moved, 'a click on b:2 moves on to c');
  assert.equal((await visit(session, [80, 90])).text, SENTENCES.moved, 'c has a link on the frame itself');
  const end = await session.signals();
  assert.deepEqual([end.frame, end.history, end.frames_shown], ['a', ['a', 'b', 'c'], 6]);
  const lines = logOf(dir);
  assert.deepEqual(lines.filter((l) => l.type === 'navigate'), [
    { type: 'navigate', frame: 'a', to: 'b', via: 'navigate', link: click('b') },
    { type: 'navigate', frame: 'b', to: 'a', via: 'back', link: back() },
    { type: 'navigate', frame: 'a', to: 'b', via: 'navigate', link: click('b') },
    { type: 'navigate', frame: 'b', to: 'c', via: 'navigate', link: click('c') },
    { type: 'navigate', frame: 'c', to: 'a', via: 'navigate', link: click('a') },
  ]);
});

test('a click on a control whose interaction sets a variable and then navigates follows the navigation', async (t) => {
  const design = snapshotFolder(t, { frames: [
    { id: 'a', width: 90, height: 100, nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [10, 10, 40, 30], { links: [other('other'), click('b')] })] },
    { id: 'b', width: 90, height: 100 },
  ] });
  const { dir, session } = open(t, design, { followLinks: true, firstClick: true });
  assert.equal((await visit(session, [20, 20])).text, SENTENCES.moved);
  assert.equal((await session.signals()).frame, 'b');
  assert.deepEqual(logOf(dir).filter((l) => l.type === 'navigate'), [{ type: 'navigate', frame: 'a', to: 'b', via: 'navigate', link: click('b') }]);
});

test('a click on an element without a click link ends the flow with the sentence for no link', async (t) => {
  for (const point of [[20, 60], [85, 95]]) {
    const { dir, session } = open(t, flow(t), { followLinks: true, firstClick: true });
    assert.equal((await visit(session, point)).text, 'Nothing happened here in this design.');
    refused(await session.view(), 'SESSION_ENDED');
    assert.deepEqual(logOf(dir).at(-1), { type: 'end', frame: 'a', reason: 'no_link', frames_shown: 1, views: 1 });
  }
});

test('any other action ends the flow with the sentence for something the test cannot show', async (t) => {
  const { dir, session } = open(t, flow(t), { followLinks: true, firstClick: true, frame: 'b' });
  assert.equal((await visit(session, [20, 80])).text, 'This opens something this test cannot show.');
  assert.deepEqual(logOf(dir).at(-1), { type: 'end', frame: 'b', reason: 'unsupported', frames_shown: 1, views: 1, action: 'overlay' });
});

test('a back link on the first screen of the flow leads nowhere', async (t) => {
  const { dir, session } = open(t, flow(t), { followLinks: true, firstClick: true, frame: 'b' });
  assert.equal((await visit(session, [10, 10])).text, SENTENCES.no_link);
  assert.equal(logOf(dir).at(-1).reason, 'no_link');
});

test('cannot_find as the first click ends the flow, and without follow_links the session ends after after_reading', async (t) => {
  const found = open(t, flow(t), { followLinks: true, firstClick: true });
  await found.session.view();
  await found.session.answer(lookAt([1, 1]));
  assert.equal((await found.session.answer(readAll({ result: 'cannot_find' }))).text, 'Answers recorded. The session is over.');
  assert.deepEqual(logOf(found.dir).at(-1), { type: 'end', frame: 'a', reason: 'cannot_find', frames_shown: 1, views: 1 });

  const single = open(t, flow(t), { firstClick: true });
  await single.session.view();
  await single.session.answer(lookAt([1, 1]));
  assert.equal((await single.session.answer(readAll(clickAt([20, 20])))).text, 'Answers recorded. The session is over.');
  assert.deepEqual(logOf(single.dir).at(-1), { type: 'end', frame: 'a', reason: 'answered', frames_shown: 1, views: 1 });
  assert.equal((await single.session.signals()).frame, 'a', 'the link was hit-tested but not followed');
});

test('a link to a frame that cannot be shown is a link to something the test cannot show', async (t) => {
  const design = snapshotFolder(t, { frames: [
    { id: 'a', width: 90, height: 100, nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [10, 10, 70, 30], { links: [click('b')] })] },
    { id: 'b', width: 90, height: 100, image: false },
  ] });
  const { dir, session } = open(t, design, { followLinks: true, firstClick: true });
  assert.equal((await visit(session, [20, 20])).text, SENTENCES.unsupported);
  assert.deepEqual(logOf(dir).at(-1), { type: 'end', frame: 'a', reason: 'unsupported', frames_shown: 1, views: 1, action: 'navigate' });
});

test('a flow ends after 8 frames', async (t) => {
  const design = snapshotFolder(t, { frames: [
    { id: 'a', width: 90, height: 100, nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [10, 10, 70, 30], { links: [click('b')] })] },
    { id: 'b', width: 90, height: 100, nodes: [node('b:1', 'INSTANCE', 'Button', 'b', [10, 10, 70, 30], { links: [click('a')] })] },
  ] });
  const { dir, session } = open(t, design, { followLinks: true, firstClick: true });
  for (let i = 1; i <= 7; i++) assert.equal((await visit(session, [20, 20])).text, SENTENCES.moved, `frame ${i}`);
  assert.equal((await visit(session, [20, 20])).text, 'Answers recorded. The session is over.');
  assert.deepEqual(logOf(dir).at(-1), { type: 'end', frame: 'b', reason: 'frame_cap', frames_shown: 8, views: 8 });
  assert.equal(logOf(dir).filter((l) => l.type === 'navigate').length, 7);
  refused(await session.view(), 'SESSION_ENDED');
});

test('the views per frame start again on every frame', async (t) => {
  const { session } = open(t, flow(t), { followLinks: true, firstClick: true, viewsPerFrame: 1 });
  assert.equal((await visit(session, [20, 20])).text, SENTENCES.moved);
  assert.equal((await session.view()).ok, true);
});

// --- the log and the files ---------------------------------------------------------------------------------------

test('the log has one line per event, with the answer in frame pixels and the ids under each point', async (t) => {
  const design = snapshotFolder(t, { frames: [{
    id: 'a', width: 90, height: 100, nodes: [
      node('a:1', 'FRAME', 'Card', 'a', [0, 0, 90, 60]),
      node('a:2', 'INSTANCE', 'Button', 'a:1', [10, 10, 70, 30], { links: [click('b')] }),
      node('a:3', 'TEXT', 'Label', 'a:2', [20, 15, 30, 10], { text: 'Pay' }),
    ],
  }, { id: 'b', width: 90, height: 100 }] });
  const { dir, session } = open(t, design, { followLinks: true, firstClick: true, viewsPerFrame: 5 });
  await session.view();
  await session.answer({ first_look: { purpose: 'pay', confidence: 'sure', main_action: { what: 'the pay button', point: [25, 18] } } });
  await session.answer({ after_reading: {
    pressable: [{ point: [60, 35], expect: 'it pays', confidence: 'guess' }, { point: [50, 80], expect: 'no idea', confidence: 'cannot_tell' }],
    not_understood: ['PromptPay'],
    purpose_changed: { changed: true, purpose: 'pay and check out' },
    first_click: { result: 'click', point: [60, 35], expect: 'a form' },
  } });
  assert.deepEqual(logOf(dir), [
    {
      type: 'start', frame: 'a', session: 'v', design: path.join(design), source: 'rest', file_key: 'TestKey', version: '1',
      settings: { follow_links: true, first_click: true, views_per_frame: 5 },
    },
    { type: 'view', frame: 'a', scroll: null, fold: { y: 0, h: 100 }, image: 'screenshots/v01.png', served: { width: 90, height: 100 }, views_on_frame: 1 },
    {
      type: 'answer', frame: 'a', part: 'first_look',
      answer: { purpose: 'pay', confidence: 'sure', main_action: { what: 'the pay button', point: [25, 18], element: 'a:3', control: 'a:2' } },
    },
    {
      type: 'answer', frame: 'a', part: 'after_reading',
      answer: {
        pressable: [
          { point: [60, 35], element: 'a:2', control: 'a:2', expect: 'it pays', confidence: 'guess' },
          { point: [50, 80], element: null, control: null, expect: 'no idea', confidence: 'cannot_tell' },
        ],
        not_understood: ['PromptPay'],
        purpose_changed: { changed: true, purpose: 'pay and check out' },
        first_click: { result: 'click', point: [60, 35], element: 'a:2', control: 'a:2', expect: 'a form' },
      },
    },
    { type: 'navigate', frame: 'a', to: 'b', via: 'navigate', link: click('b') },
  ]);
  await session.stop();
  assert.deepEqual(logOf(dir).at(-1), { type: 'end', frame: 'b', reason: 'stopped', frames_shown: 2, views: 1 });
});

test('stop is idempotent, ends an open session once and leaves a finished one alone', async (t) => {
  const open1 = open(t, tall(t));
  await open1.session.stop();
  await open1.session.stop();
  assert.deepEqual(logOf(open1.dir).map((l) => l.type), ['start', 'end']);
  refused(await open1.session.view(), 'SESSION_ENDED');

  const done = open(t, tall(t));
  await done.session.view();
  await done.session.answer(lookAt([1, 1]));
  await done.session.answer(readAll());
  await done.session.stop();
  assert.deepEqual(logOf(done.dir).map((l) => l.type), ['start', 'view', 'answer', 'answer', 'end']);
  assert.equal(logOf(done.dir).at(-1).reason, 'answered');
});

test('each image served is saved as screenshots/vNN.png, the same bytes the viewer got', async (t) => {
  const { dir, session } = open(t, tall(t));
  const shots = [await session.view()];
  await session.answer(lookAt([1, 1]));
  shots.push(await session.view({ scroll: 'down' }), await session.view({ scroll: 'down' }));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'screenshots')).sort(), ['v01.png', 'v02.png', 'v03.png']);
  shots.forEach((shot, i) => assert.ok(fs.readFileSync(path.join(dir, 'screenshots', `v0${i + 1}.png`)).equals(shot.png)));
  assert.deepEqual(logOf(dir).filter((l) => l.type === 'view').map((l) => [l.image, l.scroll, l.fold]), [
    ['screenshots/v01.png', null, { y: 0, h: 160 }], ['screenshots/v02.png', 'down', { y: 140, h: 160 }], ['screenshots/v03.png', 'down', { y: 240, h: 160 }],
  ]);
  assert.ok(!fs.existsSync(path.join(dir, 'log.jsonl')), 'the file of an app session is not written');
});

test('the log and the screenshots are private', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, session } = open(t, tall(t));
  await session.view();
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, 'screenshots')), 0o700);
  assert.equal(mode(path.join(dir, 'design-log.jsonl')), 0o600);
  assert.equal(mode(path.join(dir, 'screenshots', 'v01.png')), 0o600);
});

test('calls on one session run one at a time', async (t) => {
  const { dir, session } = open(t, tall(t));
  const results = await Promise.all([session.view(), session.answer(lookAt([1, 1])), session.view({ scroll: 'down' }), session.answer(readAll())]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(logOf(dir).map((l) => l.type), ['start', 'view', 'answer', 'view', 'answer', 'end']);
});
