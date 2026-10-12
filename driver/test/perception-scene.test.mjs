// The scene of a design frame: how nodes become elements, and what a point lands on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneOf, hitTest, DEFAULT_PATTERNS } from '../perception/scene.mjs';

const HAS = { nodes: true, text: true, font_size: true, links: true };
const node = (id, type, name, parent, [x, y, w, h], extra = {}) => ({
  id, type, name, parent, box: { x, y, w, h }, text: null, font_size: null, image_fill: false, links: [], ...extra,
});
const click = (to) => ({ trigger: 'click', action: 'navigate', to });

// A card holding a primary button that holds a label, plus an avatar, a photo and a text field.
const frame = {
  id: '1:1', name: 'Checkout', width: 390, height: 800, image_scale: 1,
  nodes: [
    node('1:2', 'FRAME', 'Card', '1:1', [10, 10, 370, 500]),
    node('1:3', 'INSTANCE', 'Button / Primary', '1:2', [30, 400, 330, 52], { links: [click('2:1')] }),
    node('1:4', 'TEXT', 'Label', '1:3', [150, 414, 90, 24], { text: 'Pay now', font_size: 16 }),
    node('1:5', 'INSTANCE', 'Avatar', '1:2', [30, 30, 48, 48]),
    node('1:6', 'RECTANGLE', 'Photo', '1:2', [30, 100, 330, 200], { image_fill: true }),
    node('1:7', 'INSTANCE', 'Input / Email', '1:2', [30, 320, 330, 48]),
  ],
};
const scene = sceneOf(frame, { has: HAS });
const kinds = Object.fromEntries(scene.elements.map((e) => [e.id, e.kind]));

test('a node with a click link is a control, and so is a component whose name matches a pattern', () => {
  assert.equal(kinds['1:3'], 'control');
  assert.equal(kinds['1:7'], 'control');
});

test('text, image and everything else get their own kinds', () => {
  assert.equal(kinds['1:4'], 'text');
  assert.equal(kinds['1:6'], 'image');
  assert.equal(kinds['1:5'], 'container');
  assert.equal(kinds['1:2'], 'container');
});

test('the scene carries the frame, its size, the image scale and the elements in the shape of the spec', () => {
  assert.equal(scene.frame, '1:1');
  assert.deepEqual([scene.width, scene.height, scene.imageScale, scene.image, scene.links], [390, 800, 1, null, []]);
  assert.deepEqual(scene.has, HAS);
  assert.deepEqual(scene.elements[2], {
    id: '1:4', parent: '1:3', kind: 'text', box: { x: 150, y: 414, w: 90, h: 24 }, text: 'Pay now', fontSize: 16, links: [],
  });
});

const kindOfName = (type, name, patterns) => {
  const s = sceneOf({ id: 'f', width: 10, height: 10, nodes: [node('n', type, name, 'f', [0, 0, 5, 5])] }, { has: HAS, patterns });
  return s.elements[0].kind;
};

test('names match case-insensitively on word boundaries', () => {
  assert.equal(kindOfName('INSTANCE', 'BUTTON', undefined), 'control');
  assert.equal(kindOfName('COMPONENT', 'primaryButton', undefined), 'control');
  assert.equal(kindOfName('COMPONENT_SET', 'menu-item', undefined), 'control');
  assert.equal(kindOfName('INSTANCE', 'Menu_Item / Selected', undefined), 'control');
  assert.equal(kindOfName('INSTANCE', 'Buttonish', undefined), 'container');
  assert.equal(kindOfName('INSTANCE', 'Tabular data', undefined), 'container');
});

test('a name only makes a control of a component, an instance or a component set', () => {
  assert.equal(kindOfName('FRAME', 'Button', undefined), 'container');
  assert.equal(kindOfName('RECTANGLE', 'Button', undefined), 'container');
});

test('the patterns can be replaced', () => {
  assert.equal(kindOfName('INSTANCE', 'Button', ['cta']), 'container');
  assert.equal(kindOfName('INSTANCE', 'Hero CTA', ['cta']), 'control');
});

test('a click link makes a control of any node, a hover link does not', () => {
  assert.equal(kindOfName('FRAME', 'Row', undefined), 'container');
  const withLink = (trigger) => sceneOf({ id: 'f', width: 10, height: 10, nodes: [
    node('n', 'FRAME', 'Row', 'f', [0, 0, 5, 5], { links: [{ trigger, action: 'navigate', to: 'x' }] })] }, { has: HAS }).elements[0].kind;
  assert.equal(withLink('click'), 'control');
  assert.equal(withLink('hover'), 'container');
});

test('a text node with a click link is a control', () => {
  const s = sceneOf({ id: 'f', width: 10, height: 10, nodes: [
    node('n', 'TEXT', 'Forgot?', 'f', [0, 0, 5, 5], { text: 'Forgot?', links: [click('x')] })] }, { has: HAS });
  assert.equal(s.elements[0].kind, 'control');
});

test('the default patterns are a frozen list', () => {
  assert.ok(Object.isFrozen(DEFAULT_PATTERNS));
  assert.deepEqual([...DEFAULT_PATTERNS], [
    'button', 'btn', 'input', 'field', 'checkbox', 'radio', 'toggle', 'switch', 'tab', 'link', 'chip', 'select', 'dropdown', 'menu item']);
});

test('a scene cannot be built without knowing what the source gave', () => {
  assert.throws(() => sceneOf(frame, {}), TypeError);
});

test('a point on text inside a button inside a card lands on the text, the button and the button link', () => {
  const hit = hitTest(scene, { x: 160, y: 420 });
  assert.equal(hit.element.id, '1:4');
  assert.equal(hit.control.id, '1:3');
  assert.deepEqual(hit.link, click('2:1'));
});

test('a point on the button outside its label lands on the button itself', () => {
  const hit = hitTest(scene, { x: 40, y: 410 });
  assert.equal(hit.element.id, '1:3');
  assert.equal(hit.control.id, '1:3');
  assert.deepEqual(hit.link, click('2:1'));
});

test('a point on the card outside any control has no control and no link', () => {
  const hit = hitTest(scene, { x: 200, y: 480 });
  assert.equal(hit.element.id, '1:2');
  assert.equal(hit.control, null);
  assert.equal(hit.link, null);
});

test('a point on a control without a link has a control and no link', () => {
  const hit = hitTest(scene, { x: 100, y: 340 });
  assert.equal(hit.element.id, '1:7');
  assert.equal(hit.control.id, '1:7');
  assert.equal(hit.link, null);
});

test('a point on the image inside the card lands on the image', () => {
  assert.equal(hitTest(scene, { x: 100, y: 150 }).element.id, '1:6');
});

test('a point outside every element finds nothing', () => {
  assert.deepEqual(hitTest(scene, { x: 2, y: 2 }), { element: null, control: null, link: null });
});

test('the right and bottom edges of a box are outside it', () => {
  assert.equal(hitTest(scene, { x: 380, y: 100 }).element, null);
  assert.equal(hitTest(scene, { x: 379, y: 100 }).element.id, '1:2');
  assert.equal(hitTest(scene, { x: 100, y: 510 }).element, null);
});

test('the link comes from the nearest ancestor with a click link, skipping hover links', () => {
  const s = sceneOf({ id: 'f', width: 100, height: 100, nodes: [
    node('a', 'FRAME', 'Row', 'f', [0, 0, 100, 100], { links: [click('far')] }),
    node('b', 'FRAME', 'Inner', 'a', [10, 10, 50, 50], { links: [{ trigger: 'hover', action: 'overlay', to: null }] }),
    node('c', 'FRAME', 'Deep', 'b', [20, 20, 10, 10]),
  ] }, { has: HAS });
  const hit = hitTest(s, { x: 25, y: 25 });
  assert.equal(hit.element.id, 'c');
  assert.equal(hit.control.id, 'a');
  assert.deepEqual(hit.link, click('far'));
});

test('of two elements at the same depth the later one is hit', () => {
  const s = sceneOf({ id: 'f', width: 100, height: 100, nodes: [
    node('a', 'FRAME', 'Under', 'f', [0, 0, 60, 60]),
    node('b', 'FRAME', 'Over', 'f', [30, 30, 60, 60]),
  ] }, { has: HAS });
  assert.equal(hitTest(s, { x: 40, y: 40 }).element.id, 'b');
});

test('an element with no size is never hit', () => {
  const s = sceneOf({ id: 'f', width: 100, height: 100, nodes: [node('a', 'FRAME', 'Dot', 'f', [10, 10, 0, 0])] }, { has: HAS });
  assert.equal(hitTest(s, { x: 10, y: 10 }).element, null);
});

// A splash screen: the frame itself moves on at a click anywhere.
const splash = sceneOf({ id: 's', width: 100, height: 100, links: [{ trigger: 'hover', action: 'overlay', to: null }, click('next'), click('later')], nodes: [
  node('a', 'FRAME', 'Logo', 's', [10, 10, 30, 30]),
  node('b', 'INSTANCE', 'Button', 's', [50, 50, 40, 40], { links: [click('own')] }),
] }, { has: HAS });

test('the scene carries the links of the frame itself', () => {
  assert.deepEqual(splash.links, [{ trigger: 'hover', action: 'overlay', to: null }, click('next'), click('later')]);
});

test('with no click link at or above the point the first click link of the frame answers', () => {
  assert.deepEqual(hitTest(splash, { x: 20, y: 20 }).link, click('next'));
  const empty = hitTest(splash, { x: 5, y: 95 });
  assert.equal(empty.element, null);
  assert.deepEqual(empty.link, click('next'));
});

test('a click link of an element wins over the link of the frame', () => {
  assert.deepEqual(hitTest(splash, { x: 60, y: 60 }).link, click('own'));
});

test('a frame whose links hold no click link gives no fallback', () => {
  const hoverOnly = sceneOf({ id: 'h', width: 10, height: 10, links: [{ trigger: 'hover', action: 'overlay', to: null }], nodes: [] }, { has: HAS });
  assert.equal(hitTest(hoverOnly, { x: 1, y: 1 }).link, null);
});

// An interaction with several actions (set a variable, then navigate) reaches the snapshot as several links, the other one first.
const setVariable = { trigger: 'click', action: 'other', to: null };
const goBack = { trigger: 'click', action: 'back', to: null };
const multi = sceneOf({ id: 'm', width: 100, height: 100, links: [setVariable, click('frame-next')], nodes: [
  node('both', 'INSTANCE', 'Button', 'm', [0, 0, 40, 40], { links: [setVariable, click('next')] }),
  node('only-other', 'INSTANCE', 'Button', 'm', [50, 0, 40, 40], { links: [setVariable, { trigger: 'click', action: 'url', to: null }] }),
  node('with-back', 'INSTANCE', 'Button', 'm', [0, 50, 40, 40], { links: [{ trigger: 'click', action: 'url', to: null }, goBack] }),
  node('hover-first', 'INSTANCE', 'Button', 'm', [50, 50, 40, 40], { links: [{ trigger: 'hover', action: 'navigate', to: 'hovered' }, setVariable, click('after-hover')] }),
] }, { has: HAS });

test('of the click links of the nearest element that has any, navigate or back wins over an action the test cannot show', () => {
  assert.deepEqual(hitTest(multi, { x: 10, y: 10 }).link, click('next'));
  assert.deepEqual(hitTest(multi, { x: 10, y: 60 }).link, goBack);
  assert.deepEqual(hitTest(multi, { x: 60, y: 60 }).link, click('after-hover'), 'a hover link is not a click link');
});

test('with no navigate or back link among the click links the first click link answers', () => {
  assert.deepEqual(hitTest(multi, { x: 60, y: 10 }).link, setVariable);
});

test('the frame-level fallback prefers navigate or back in the same way', () => {
  assert.deepEqual(hitTest(multi, { x: 95, y: 95 }).link, click('frame-next'));
});
