// The planner commands of design mode: `frames` and `crop` on a snapshot and `judge` on a run, with no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { decode } from '../perception/image.mjs';
import { main, isPlaceholder, PLACEHOLDER_LABELS, LOREM_PHRASES } from '../design.mjs';
import { StaticSession } from '../static-session.mjs';
import { back, click, node, other, snapshotFolder, tmpDir, HAS_ALL } from './design-fixtures.mjs';

const run = (argv) => {
  const out = [];
  const err = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, json: () => JSON.parse(out.join('\n')) };
};

const GREY = [170, 170, 170];
const BLUE = [26, 60, 180];
const LIGHT = [235, 235, 235];
const BLACK = [0, 0, 0];

// Two phone frames. In a: a faint heading, a blue button holding a white label, a tiny pale link and faint fine print.
// In b: placeholder text and a black button.
const FRAMES = [
  {
    id: 'a', name: 'Shop', page: 'Mobile', width: 200, height: 300,
    paint: [
      { x: 10, y: 14, w: 180, h: 4, colour: GREY }, // ink of a:1
      { x: 10, y: 250, w: 180, h: 48, colour: BLUE },
      { x: 70, y: 266, w: 60, h: 4, colour: [255, 255, 255] }, // ink of a:3
      { x: 10, y: 100, w: 30, h: 12, colour: LIGHT },
      { x: 10, y: 154, w: 100, h: 4, colour: GREY }, // ink of a:5
    ],
    nodes: [
      node('a:1', 'TEXT', 'Heading', 'a', [10, 10, 180, 20], { text: 'Welcome to the shop', font_size: 16 }),
      node('a:2', 'INSTANCE', 'Button / Primary', 'a', [10, 250, 180, 48], { links: [click('b')] }),
      node('a:3', 'TEXT', 'Label', 'a:2', [70, 262, 60, 16], { text: 'Pay now', font_size: 14 }),
      node('a:4', 'INSTANCE', 'Link', 'a', [10, 100, 30, 12]),
      node('a:5', 'TEXT', 'Fine print', 'a', [10, 150, 100, 12], { text: 'Returns accepted within thirty days', font_size: 10 }),
    ],
  },
  {
    id: 'b', name: 'Done', page: 'Mobile', width: 200, height: 300,
    paint: [{ x: 10, y: 14, w: 180, h: 4, colour: BLACK }, { x: 10, y: 250, w: 180, h: 48, colour: BLACK }],
    nodes: [
      node('b:1', 'TEXT', 'Body', 'b', [10, 10, 180, 20], { text: 'Lorem ipsum dolor sit', font_size: 16 }),
      node('b:2', 'INSTANCE', 'Button', 'b', [10, 250, 180, 48], { links: [back()] }),
    ],
  },
];

const point = (p, element, control) => ({ point: p, element, control });
const entry = (frame, part, answer) => ({ t: 1, type: 'answer', frame, part, answer });
const LOOK = (p, element, control) => ({ purpose: 'a page', confidence: 'guess', main_action: { what: 'the button', ...point(p, element, control) } });
const READ = (extra = {}) => ({ pressable: [], not_understood: [], purpose_changed: { changed: false, purpose: null }, ...extra });

function writeViewer(runDir, name, lines, settings) {
  const dir = path.join(runDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'design-log.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  if (settings) fs.writeFileSync(path.join(dir, 'viewer.json'), JSON.stringify(settings));
}


const KEY = {
  tier: 'keyed',
  frames: { a: { name: 'Shop', intent: 'Choose to pay', intent_source: 'user' }, b: { name: 'Done', intent: 'Shows that the order went through', intent_source: 'frame_name' } },
  goals: [{ id: 'G1', text: 'Pay for what is in your basket', start_frame: 'a', steps: [{ frame: 'a', target: 'a:2' }] }],
};

function fixtureRun(t) {
  const design = snapshotFolder(t, { frames: FRAMES, flowStarts: ['a'] });
  const dir = tmpDir(t);
  const key = path.join(dir, 'key.yaml');
  fs.writeFileSync(key, YAML.stringify(KEY));
  const runDir = path.join(dir, 'run');
  writeViewer(runDir, 'v1', [
    { t: 1, type: 'start', frame: 'a' },
    { t: 1, type: 'view', image: 'screenshots/v01.png' },
    entry('a', 'first_look', LOOK([100, 255], 'a:2', 'a:2')),
    { t: 1, type: 'view', image: 'screenshots/v02.png' },
    entry('a', 'after_reading', READ({
      pressable: [
        { ...point([20, 105], 'a:4', 'a:4'), expect: 'no idea', confidence: 'cannot_tell' },
        { ...point([20, 20], 'a:1', null), expect: 'nothing', confidence: 'sure' },
      ],
      first_click: { result: 'click', ...point([100, 270], 'a:3', 'a:2'), expect: 'the next page' },
    })),
    { t: 1, type: 'navigate', frame: 'a', to: 'b', via: 'navigate', link: click('b') },
    { t: 1, type: 'view', image: 'screenshots/v03.png' },
    entry('b', 'first_look', LOOK([100, 270], 'b:2', 'b:2')),
    entry('b', 'after_reading', READ({ not_understood: ['PromptPay'], first_click: { result: 'cannot_find' } })),
    { t: 1, type: 'end', frame: 'b', reason: 'cannot_find', frames_shown: 2, views: 2 },
  ]);
  writeViewer(runDir, 'v2', [
    { t: 1, type: 'start', frame: 'a' },
    { t: 1, type: 'view', image: 'screenshots/v01.png' },
    entry('a', 'first_look', LOOK([20, 105], 'a:4', 'a:4')),
    entry('a', 'after_reading', READ({ first_click: { result: 'click', ...point([20, 105], 'a:4', 'a:4'), expect: 'x' } })),
    { t: 1, type: 'end', frame: 'a', reason: 'answered', frames_shown: 1, views: 1 },
  ], { vision: 'low', reading_style: 'skim' });
  writeViewer(runDir, 'v3', [
    { t: 1, type: 'start', frame: 'b' },
    entry('b', 'first_look', LOOK([20, 20], 'b:1', null)),
    entry('b', 'after_reading', READ({ first_click: { result: 'click', ...point([100, 270], 'b:2', 'b:2'), expect: 'back' } })),
    { t: 1, type: 'end', frame: 'b', reason: 'answered', frames_shown: 1, views: 1 },
  ]);
  writeViewer(runDir, 'v4', [{ t: 1, type: 'start', frame: 'b' }, entry('b', 'first_look', LOOK([20, 20], 'b:1', null))]);
  fs.mkdirSync(path.join(runDir, 'notes'));
  return { design, key, runDir };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const linesOf = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// --- frames ------------------------------------------------------------------------------------------------------

test('frames: the level, the frames with their words, controls and links, the flows, the arrows and what was skipped', (t) => {
  const design = snapshotFolder(t, {
    frames: FRAMES, flowStarts: ['a'], arrows: [{ between: ['a', 'b'], direction: 'unknown' }], skipped: [{ id: 'z', reason: 'no image' }],
  });
  const result = run(['frames', design]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.err, []);
  assert.deepEqual(result.json(), {
    level: 'flows',
    order_hint: true,
    has: HAS_ALL,
    frames: [
      { id: 'a', name: 'Shop', page: 'Mobile', width: 200, height: 300, touch: true, words: 11, placeholder_share: 0, controls: 2, links: 1 },
      { id: 'b', name: 'Done', page: 'Mobile', width: 200, height: 300, touch: true, words: 4, placeholder_share: 1, controls: 1, links: 1 },
    ],
    flows: [{ start: 'a', frames: ['a', 'b'] }],
    arrows: [{ between: ['a', 'b'], direction: 'unknown' }],
    skipped: [{ id: 'z', reason: 'no image' }],
  });
});

test('frames: the level follows what the source gave, and the order hint only comes with arrows', (t) => {
  const frames = [{ id: 'a', width: 600, height: 400, nodes: [node('a:1', 'TEXT', 'T', 'a', [0, 0, 10, 10], { text: 'Hi' })] }];
  const levelOf = (has, extra = {}) => run(['frames', snapshotFolder(t, { frames, has, ...extra })]).json();
  const noNodes = levelOf({ nodes: false, text: false, font_size: false, links: false });
  assert.deepEqual([noNodes.level, 'order_hint' in noNodes], ['images', false]);
  assert.equal(noNodes.frames[0].words, null);
  assert.equal(noNodes.frames[0].placeholder_share, null);
  assert.equal(noNodes.frames[0].touch, false);
  assert.equal(levelOf({ nodes: true, text: false, font_size: false, links: false }).level, 'frames');
  assert.equal(levelOf({ nodes: true, text: true, font_size: true, links: false }).level, 'static');
  assert.equal(levelOf({ nodes: true, text: true, font_size: true, links: true }).level, 'static', 'links but no flow to start');
  assert.equal(levelOf(HAS_ALL, { flowStarts: ['a'] }).level, 'flows');
  assert.equal(levelOf({ nodes: true, text: true, font_size: true, links: false }, { arrows: [{ between: ['a', 'a'], direction: 'unknown' }] }).order_hint, true);
});

test('frames: a flow lists the frames reached by click links that navigate, in order of discovery', (t) => {
  const box = [0, 0, 10, 10];
  const design = snapshotFolder(t, { flowStarts: ['a', 'x'], frames: [
    { id: 'a', width: 100, height: 100, nodes: [
      node('a:1', 'INSTANCE', 'Button', 'a', box, { links: [click('c'), { trigger: 'hover', action: 'navigate', to: 'z' }] }),
      node('a:2', 'INSTANCE', 'Button', 'a', box, { links: [click('b'), other('overlay')] }),
    ] },
    { id: 'b', width: 100, height: 100, links: [click('d')], nodes: [node('b:1', 'INSTANCE', 'Button', 'b', box, { links: [back(), click('a')] })] },
    { id: 'c', width: 100, height: 100, nodes: [] },
    { id: 'd', width: 100, height: 100 },
    { id: 'z', width: 100, height: 100 },
    { id: 'x', width: 100, height: 100 },
  ] });
  const result = run(['frames', design]).json();
  assert.deepEqual(result.flows, [{ start: 'a', frames: ['a', 'c', 'b', 'd'] }, { start: 'x', frames: ['x'] }]);
  assert.deepEqual(result.frames.map((f) => [f.id, f.controls, f.links]), [['a', 2, 3], ['b', 1, 3], ['c', 0, 0], ['d', 0, 0], ['z', 0, 0], ['x', 0, 0]]);
});

test('frames: placeholder words are lorem ipsum and default labels, as a share of all words', (t) => {
  const design = snapshotFolder(t, { frames: [{
    id: 'a', width: 100, height: 100, nodes: [
      node('a:1', 'TEXT', 'T', 'a', [0, 0, 10, 10], { text: 'Label' }),
      node('a:2', 'TEXT', 'T', 'a', [0, 10, 10, 10], { text: 'Lorem ipsum dolor sit amet' }),
      node('a:3', 'TEXT', 'T', 'a', [0, 20, 10, 10], { text: 'Pay for your basket' }),
      node('a:4', 'TEXT', 'T', 'a', [0, 30, 10, 10], { text: 'Button 2' }),
      node('a:5', 'TEXT', 'T', 'a', [0, 40, 10, 10], { text: '   ' }),
    ],
  }] });
  const frame = run(['frames', design]).json().frames[0];
  assert.deepEqual([frame.words, frame.placeholder_share], [12, 0.67], '8 of 12 words');
});

test('isPlaceholder: default labels, with a number after them, and lorem ipsum anywhere in the text', () => {
  for (const text of ['Label', ' BUTTON ', 'Heading 1', 'Text', 'Title', 'Placeholder', 'Lorem ipsum dolor', 'Intro: lorem IPSUM', 'Dolor sit amet']) {
    assert.equal(isPlaceholder(text), true, text);
  }
  for (const text of ['Labels', 'Pay now', 'Button text', 'Title of the book', '', 'Ipsum']) assert.equal(isPlaceholder(text), false, text);
  assert.ok(Object.isFrozen(PLACEHOLDER_LABELS) && Object.isFrozen(LOREM_PHRASES));
  assert.deepEqual([...PLACEHOLDER_LABELS], ['label', 'button', 'heading', 'text', 'title', 'placeholder']);
});

test('frames: a missing snapshot, a wrong argument count and an unknown command fail', (t) => {
  const missing = run(['frames', path.join(tmpDir(t), 'nope')]);
  assert.equal(missing.code, 1);
  assert.match(missing.err[0], /^cannot read design\.json in /);
  const notSnapshot = tmpDir(t);
  fs.writeFileSync(path.join(notSnapshot, 'design.json'), '{"frames": 3}');
  assert.match(run(['frames', notSnapshot]).err[0], /is not a design snapshot$/);
  for (const argv of [['frames'], ['frames', 'a', 'b'], ['judge', 'run'], ['judge', 'run', '--design'], ['frames', '--x', 'a'], ['nope'], []]) {
    const result = run(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.err.at(-1), /^usage: node design\.mjs frames/);
  }
});

// --- judge -------------------------------------------------------------------------------------------------------

const A_LOOK = { purpose: 'a page', confidence: 'guess', main_action: { what: 'the button', point: [100, 255], element: 'a:2', control: 'a:2' } };
const READING = { not_understood: [], purpose_changed: { changed: false, purpose: null } };

test('judge: a fixture run gives the literal design-results.json', (t) => {
  const { design, key, runDir } = fixtureRun(t);
  const result = run(['judge', runDir, '--design', design, '--key', key]);
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.deepEqual(result.err, []);
  assert.deepEqual(result.json(), {
    results: path.join(runDir, 'design-results.json'), perception: path.join(runDir, 'perception.jsonl'), viewers: 4, frames: 2, elements: 15,
  });
  const bLook = (point, element, control) => ({ purpose: 'a page', confidence: 'guess', main_action: { what: 'the button', point, element, control } });
  assert.deepEqual(readJson(path.join(runDir, 'design-results.json')), {
    level: 'flows',
    tier: 'keyed',
    has: HAS_ALL,
    viewers: [
      { viewer: 'v1', frames: [
        {
          frame: 'a', screenshots: ['v1/screenshots/v01.png', 'v1/screenshots/v02.png'], complete: true, first_look: A_LOOK, after_reading: READING,
          pressable_hits: [
            { point: [20, 105], element: 'a:4', control: 'a:4', expect: 'no idea', confidence: 'cannot_tell' },
            { point: [20, 20], element: 'a:1', control: null, expect: 'nothing', confidence: 'sure' },
          ],
          first_click: { result: 'click', point: [100, 270], hit: { element: 'a:3', control: 'a:2' }, target: 'a:2', verdict: 'hit' },
          moved_to: 'b', ended: null,
        },
        {
          frame: 'b', screenshots: ['v1/screenshots/v03.png'], complete: true, first_look: bLook([100, 270], 'b:2', 'b:2'),
          after_reading: { not_understood: ['PromptPay'], purpose_changed: { changed: false, purpose: null } }, pressable_hits: [],
          first_click: { result: 'cannot_find', point: null, hit: null, target: null, verdict: 'cannot_find' },
          moved_to: null, ended: 'cannot_find',
        },
      ] },
      { viewer: 'v2', frames: [{
        frame: 'a', screenshots: ['v2/screenshots/v01.png'], complete: true, first_look: bLook([20, 105], 'a:4', 'a:4'), after_reading: READING, pressable_hits: [],
        first_click: { result: 'click', point: [20, 105], hit: { element: 'a:4', control: 'a:4' }, target: 'a:2', verdict: 'miss' },
        moved_to: null, ended: 'answered',
      }] },
      { viewer: 'v3', frames: [{
        frame: 'b', screenshots: [], complete: true, first_look: bLook([20, 20], 'b:1', null), after_reading: READING, pressable_hits: [],
        first_click: { result: 'click', point: [100, 270], hit: { element: 'b:2', control: 'b:2' }, target: null, verdict: 'no_target' },
        moved_to: null, ended: 'answered',
      }] },
      { viewer: 'v4', frames: [{
        frame: 'b', screenshots: [], complete: false, first_look: bLook([20, 20], 'b:1', null), after_reading: null, pressable_hits: [],
        first_click: null, moved_to: null, ended: null,
      }] },
    ],
    frames: [
      {
        frame: 'a', intent: 'Choose to pay', intent_source: 'user',
        viewers_pointed: [
          { element: 'a:1', viewers: ['v1'] }, { element: 'a:2', viewers: ['v1'] }, { element: 'a:3', viewers: ['v1'] }, { element: 'a:4', viewers: ['v1', 'v2'] },
        ],
        instrument_findings: [
          { element: 'a:1', instrument: 'contrast', value: 2.32, threshold: 4.5, viewers: ['v1'], keyed: false, vision: 'normal', reading_style: 'read-all' },
          { element: 'a:4', instrument: 'contrast', value: 1.19, threshold: 3, viewers: ['v1'], keyed: false, vision: 'normal', reading_style: 'read-all' },
          { element: 'a:4', instrument: 'target_size', value: 12, threshold: 44, viewers: ['v1'], keyed: false, vision: 'normal', reading_style: 'read-all' },
          { element: 'a:4', instrument: 'icon_only', value: true, threshold: null, viewers: ['v1'], keyed: false, vision: 'normal', reading_style: 'read-all' },
          { element: 'a:4', instrument: 'contrast', value: 1.19, threshold: 7, viewers: ['v2'], keyed: false, vision: 'low', reading_style: 'skim' },
          { element: 'a:4', instrument: 'target_size', value: 12, threshold: 44, viewers: ['v2'], keyed: false, vision: 'low', reading_style: 'skim' },
          { element: 'a:4', instrument: 'icon_only', value: true, threshold: null, viewers: ['v2'], keyed: false, vision: 'low', reading_style: 'skim' },
        ],
      },
      {
        frame: 'b', intent: 'Shows that the order went through', intent_source: 'frame_name',
        viewers_pointed: [{ element: 'b:1', viewers: ['v3', 'v4'] }, { element: 'b:2', viewers: ['v1', 'v3'] }],
        instrument_findings: [
          { element: 'b:2', instrument: 'icon_only', value: true, threshold: null, viewers: ['v1', 'v3'], keyed: false, vision: 'normal', reading_style: 'read-all' },
        ],
      },
    ],
    not_simulated: [{ kind: 'placeholder_frame', frame: 'b', share: 1 }],
  });
});

test('judge: perception.jsonl has one line per element and per frame, and an element is used only when a viewer pointed at it or it is keyed', (t) => {
  const { design, key, runDir } = fixtureRun(t);
  run(['judge', runDir, '--design', design, '--key', key]);
  const lines = linesOf(path.join(runDir, 'perception.jsonl'));
  assert.deepEqual(lines.map((l) => `${l.frame} ${l.vision} ${l.element}`), [
    'a normal a:1', 'a normal a:2', 'a normal a:3', 'a normal a:4', 'a normal a:5', 'a normal null',
    'a low a:1', 'a low a:2', 'a low a:3', 'a low a:4', 'a low a:5', 'a low null',
    'b normal b:1', 'b normal b:2', 'b normal null',
  ]);
  assert.deepEqual(lines.map((l) => l.used), [true, true, true, true, false, true, false, true, false, true, false, true, true, true, true]);
  assert.deepEqual(lines.filter((l) => l.keyed).map((l) => `${l.vision} ${l.element}`), ['normal a:2', 'low a:2'], 'a keyed target is used even when nobody pointed at it');
  assert.deepEqual(lines[1], {
    frame: 'a', touch: true, vision: 'normal', reading_style: 'read-all', element: 'a:2', kind: 'control', contrast: 8.94, target_size: 48, icon_only: false,
    words: null, prominence_rank: 1, thresholds: { contrast: 3, target_size: 44 }, below: [], used: true, used_by: ['v1'], keyed: true,
  });
  assert.deepEqual(lines[4], {
    frame: 'a', touch: true, vision: 'normal', reading_style: 'read-all', element: 'a:5', kind: 'text', contrast: 2.32, target_size: null, icon_only: null,
    words: 5, prominence_rank: null, thresholds: { contrast: 4.5, target_size: null }, below: ['contrast'], used: false, used_by: [], keyed: false,
  });
  assert.deepEqual(lines[7], {
    frame: 'a', touch: true, vision: 'low', reading_style: 'skim', element: 'a:2', kind: 'control', contrast: 8.94, target_size: 48, icon_only: false,
    words: null, prominence_rank: 1, thresholds: { contrast: 7, target_size: 44 }, below: [], used: true, used_by: [], keyed: true,
  });
  assert.deepEqual(lines[11], {
    frame: 'a', touch: true, vision: 'low', reading_style: 'skim', element: null, kind: 'frame', words: 11, reading_seconds: 3.3, word_budget: 100,
    below: [], used: true, used_by: ['v2'], keyed: false,
  });
  const results = readJson(path.join(runDir, 'design-results.json'));
  const raised = results.frames.flatMap((f) => f.instrument_findings.map((x) => `${f.frame}/${x.element}`));
  assert.ok(!raised.includes('a/a:5'), 'faint fine print below its threshold but pointed at by nobody is not raised');
});

test('judge: viewer.json sets the vision and reading style of a viewer, and a frame over its word budget is raised for the viewers who reached it', (t) => {
  const design = snapshotFolder(t, { frames: [{
    id: 'a', width: 200, height: 300, nodes: [node('a:1', 'TEXT', 'Body', 'a', [0, 0, 100, 20], { text: Array.from({ length: 120 }, () => 'word').join(' '), font_size: 16 })],
  }] });
  const runDir = path.join(tmpDir(t), 'run');
  writeViewer(runDir, 'skimmer', [{ t: 1, type: 'start', frame: 'a' }], { reading_style: 'skim' });
  writeViewer(runDir, 'reader', [{ t: 1, type: 'start', frame: 'a' }]);
  assert.equal(run(['judge', runDir, '--design', design]).code, 0);
  const results = readJson(path.join(runDir, 'design-results.json'));
  assert.equal(results.tier, 'blind');
  assert.deepEqual(results.frames[0].instrument_findings, [
    { element: null, instrument: 'text_load', value: 120, threshold: 100, viewers: ['skimmer'], keyed: false, vision: 'normal', reading_style: 'skim' },
  ]);
  assert.deepEqual(linesOf(path.join(runDir, 'perception.jsonl')).filter((l) => l.kind === 'frame').map((l) => [l.reading_style, l.word_budget, l.used_by, l.below]), [
    ['read-all', 250, ['reader'], []], ['skim', 100, ['skimmer'], ['text_load']],
  ]);
});

test('judge: a click on a label in the keyed button hits, a click on a different control misses, a keyed child is in the control that was pressed', (t) => {
  const design = snapshotFolder(t, { frames: [{
    id: 'a', width: 200, height: 300, nodes: [
      node('a:1', 'FRAME', 'Card', 'a', [0, 0, 200, 150], { links: [click('b')] }),
      node('a:2', 'INSTANCE', 'Button', 'a:1', [10, 10, 100, 40]),
      node('a:3', 'TEXT', 'Label', 'a:2', [20, 20, 50, 16], { text: 'Pay' }),
      node('a:4', 'INSTANCE', 'Button', 'a:1', [10, 80, 100, 40]),
    ],
  }, { id: 'b', width: 200, height: 300 }] });
  const clickAt = (element, control) => ({ result: 'click', point: [1, 1], element, control, expect: 'x' });
  const verdicts = (targets, element, control) => {
    const dir = tmpDir(t);
    const key = path.join(dir, 'key.yaml');
    fs.writeFileSync(key, YAML.stringify({ tier: 'keyed', goals: [{ id: 'G', steps: targets.map((target) => ({ frame: 'a', target })) }] }));
    const runDir = path.join(dir, 'run');
    writeViewer(runDir, 'v', [{ t: 1, type: 'start', frame: 'a' }, entry('a', 'first_look', LOOK([1, 1], null, null)), entry('a', 'after_reading', READ({ first_click: clickAt(element, control) }))]);
    assert.equal(run(['judge', runDir, '--design', design, '--key', key]).code, 0);
    const { first_click: c } = readJson(path.join(runDir, 'design-results.json')).viewers[0].frames[0];
    return [c.verdict, c.target];
  };
  assert.deepEqual(verdicts(['a:2'], 'a:3', 'a:2'), ['hit', 'a:2'], 'the target is the control above the label that was hit');
  assert.deepEqual(verdicts(['a:3'], 'a:2', 'a:2'), ['hit', 'a:3'], 'the target is the label inside the control that was pressed');
  assert.deepEqual(verdicts(['a:3'], 'a:3', 'a:2'), ['hit', 'a:3']);
  assert.deepEqual(verdicts(['a:4'], 'a:2', 'a:2'), ['miss', 'a:4']);
  assert.deepEqual(verdicts(['a:2'], 'a:1', null), ['miss', 'a:2'], 'a click on the card around the button');
  assert.deepEqual(verdicts(['a:2'], null, null), ['miss', 'a:2'], 'a click on nothing');
  assert.deepEqual(verdicts(['a:4', 'a:2'], 'a:3', 'a:2'), ['hit', 'a:2'], 'with two keyed targets on a frame, the one that was hit');
  assert.deepEqual(verdicts(['a:1'], 'a:3', 'a:2'), ['hit', 'a:1'], 'a container above the click is hit too');
});

test('judge: a PNG-only snapshot has no nodes, so no click can be judged', (t) => {
  const design = snapshotFolder(t, { has: { nodes: false, text: false, font_size: false, links: false }, frames: [{ id: 'a', width: 200, height: 300 }] });
  const dir = tmpDir(t);
  const key = path.join(dir, 'key.yaml');
  fs.writeFileSync(key, YAML.stringify({ tier: 'keyed', goals: [{ id: 'G', steps: [{ frame: 'a', target: 'a:2' }] }] }));
  const runDir = path.join(dir, 'run');
  writeViewer(runDir, 'v', [
    { t: 1, type: 'start', frame: 'a' }, entry('a', 'first_look', LOOK([1, 1], null, null)),
    entry('a', 'after_reading', READ({ first_click: { result: 'click', point: [1, 1], element: null, control: null, expect: 'x' } })),
  ]);
  const result = run(['judge', runDir, '--design', design, '--key', key]);
  assert.deepEqual(result.err, []);
  const doc = readJson(path.join(runDir, 'design-results.json'));
  assert.deepEqual([doc.level, doc.viewers[0].frames[0].first_click.verdict, doc.not_simulated], [
    'images', 'no_target', [{ kind: 'instruments', reason: 'the source gave no nodes' }],
  ]);
  assert.deepEqual(linesOf(path.join(runDir, 'perception.jsonl')).map((l) => [l.kind, l.words, l.used]), [['frame', null, true]]);
});

test('judge: what the run could not simulate is listed', (t) => {
  const design = snapshotFolder(t, {
    has: { nodes: true, text: false, font_size: false, links: false }, skipped: [{ id: 'z', reason: 'no image' }],
    frames: [{ id: 'a', width: 200, height: 300, nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [0, 0, 50, 50])] }],
  });
  const runDir = path.join(tmpDir(t), 'run');
  writeViewer(runDir, 'v', [{ t: 1, type: 'start', frame: 'a' }, { t: 1, type: 'end', frame: 'a', reason: 'unsupported', frames_shown: 1, views: 1, action: 'overlay' }]);
  assert.equal(run(['judge', runDir, '--design', design]).code, 0);
  assert.deepEqual(readJson(path.join(runDir, 'design-results.json')).not_simulated, [
    { kind: 'skipped_frame', frame: 'z', reason: 'no image' },
    { kind: 'text', reason: 'the source gave no text: text_load, icon_only and the placeholder check were not run' },
    { kind: 'links', reason: 'the source gave no prototype links: no link was followed' },
    { kind: 'link_action', action: 'overlay', frame: 'a', viewer: 'v' },
  ]);
  const withText = snapshotFolder(t, { has: { nodes: true, text: true, font_size: false, links: true }, frames: [{ id: 'a', width: 200, height: 300 }] });
  assert.equal(run(['judge', runDir, '--design', withText]).code, 0);
  assert.deepEqual(readJson(path.join(runDir, 'design-results.json')).not_simulated, [
    { kind: 'font_size', reason: 'the source gave no font size: all text is measured against 4.5' },
    { kind: 'link_action', action: 'overlay', frame: 'a', viewer: 'v' },
  ]);
});

test('judge: a folder without a design-log.jsonl is not a viewer, and a rerun writes the same files', (t) => {
  const { design, key, runDir } = fixtureRun(t);
  fs.writeFileSync(path.join(runDir, 'notes', 'log.jsonl'), '{}\n');
  assert.equal(run(['judge', runDir, '--design', design, '--key', key]).code, 0);
  const first = fs.readFileSync(path.join(runDir, 'design-results.json'), 'utf8');
  assert.deepEqual(readJson(path.join(runDir, 'design-results.json')).viewers.map((v) => v.viewer), ['v1', 'v2', 'v3', 'v4']);
  assert.equal(run(['judge', runDir, '--design', design, '--key', key]).code, 0);
  assert.equal(fs.readFileSync(path.join(runDir, 'design-results.json'), 'utf8'), first);
});

test('judge: no viewer folder, a bad key, a bad viewer.json and a missing design fail with one line', (t) => {
  const { design, key, runDir } = fixtureRun(t);
  const empty = run(['judge', tmpDir(t), '--design', design]);
  assert.equal(empty.code, 1);
  assert.match(empty.err[0], /^no viewer folder with a design-log\.jsonl in /);

  const badKey = path.join(tmpDir(t), 'key.yaml');
  fs.writeFileSync(badKey, 'tier: maybe\n');
  assert.match(run(['judge', runDir, '--design', design, '--key', badKey]).err[0], /key\.yaml needs tier: keyed \| goal \| blind$/);
  assert.match(run(['judge', runDir, '--design', design, '--key', path.join(runDir, 'nope.yaml')]).err[0], /^cannot read key file /);

  fs.writeFileSync(path.join(runDir, 'v3', 'viewer.json'), '{"vision": "blurry"}');
  assert.equal(run(['judge', runDir, '--design', design, '--key', key]).err[0], 'v3/viewer.json: vision must be normal or low');
  fs.writeFileSync(path.join(runDir, 'v3', 'viewer.json'), '{"reading_style": "speed"}');
  assert.equal(run(['judge', runDir, '--design', design, '--key', key]).err[0], 'v3/viewer.json: reading_style must be read-all, skim, icons-only');
  fs.writeFileSync(path.join(runDir, 'v3', 'viewer.json'), 'not json');
  assert.equal(run(['judge', runDir, '--design', design, '--key', key]).err[0], 'cannot read v3/viewer.json');

  assert.match(run(['judge', runDir, '--design', path.join(tmpDir(t), 'nope')]).err[0], /^cannot read design\.json in /);
});

test('judge: a log line that is not JSON and a key target that is not in the frame are warned about, never skipped silently', (t) => {
  const { design, key, runDir } = fixtureRun(t);
  fs.appendFileSync(path.join(runDir, 'v4', 'design-log.jsonl'), '{"t": 1, "type": "ans\n');
  fs.writeFileSync(key, YAML.stringify({ ...KEY, goals: [{ id: 'G1', steps: [{ frame: 'a', target: 'a:2' }, { frame: 'b', target: 'b:99' }] }] }));
  const result = run(['judge', runDir, '--design', design, '--key', key]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.err, [
    'warning: v4/design-log.jsonl line 3 is not JSON and was skipped',
    'warning: key target b:99 is not an element of frame b',
  ]);
  const v3 = readJson(path.join(runDir, 'design-results.json')).viewers[2].frames[0];
  assert.deepEqual([v3.first_click.verdict, v3.first_click.target], ['miss', 'b:99']);
});

test('judge: a frame that the key names but nobody reached still gets its values, with its keyed target used', (t) => {
  const design = snapshotFolder(t, { frames: FRAMES });
  const dir = tmpDir(t);
  const key = path.join(dir, 'key.yaml');
  fs.writeFileSync(key, YAML.stringify({ tier: 'keyed', goals: [{ id: 'G', steps: [{ frame: 'b', target: 'b:2' }] }] }));
  const runDir = path.join(dir, 'run');
  writeViewer(runDir, 'v', [{ t: 1, type: 'start', frame: 'a' }]);
  assert.equal(run(['judge', runDir, '--design', design, '--key', key]).code, 0);
  const lines = linesOf(path.join(runDir, 'perception.jsonl'));
  assert.deepEqual(lines.filter((l) => l.frame === 'b').map((l) => [l.element, l.used, l.keyed]), [['b:1', false, false], ['b:2', true, true], [null, false, false]]);
  const frames = readJson(path.join(runDir, 'design-results.json')).frames;
  assert.deepEqual(frames.map((f) => f.frame), ['a', 'b']);
  assert.deepEqual(frames[1].instrument_findings.map((f) => [f.element, f.instrument, f.viewers, f.keyed]), [['b:2', 'icon_only', [], true]]);
});

test('judge: reads what a real StaticSession wrote', async (t) => {
  const design = snapshotFolder(t, { flowStarts: ['a'], frames: FRAMES });
  const dir = tmpDir(t);
  const runDir = path.join(dir, 'run');
  const key = path.join(dir, 'key.yaml');
  fs.writeFileSync(key, YAML.stringify(KEY));
  const session = StaticSession.start({ id: 'p1-a', dir: path.join(runDir, 'p1-a'), design, frame: 'a', followLinks: true, firstClick: true });
  await session.view();
  await session.answer({ first_look: { purpose: 'a shop', confidence: 'sure', main_action: { what: 'pay', point: [100, 270] } } });
  await session.answer({ after_reading: {
    pressable: [{ point: [20, 105], expect: 'unknown', confidence: 'cannot_tell' }], not_understood: [], purpose_changed: { changed: false, purpose: null },
    first_click: { result: 'click', point: [100, 270], expect: 'the next page' },
  } });
  await session.view();
  await session.answer({ first_look: { purpose: 'done', confidence: 'sure', main_action: { what: 'go back', point: [100, 270] } } });
  await session.answer({ after_reading: { pressable: [], not_understood: ['PromptPay'], purpose_changed: { changed: false, purpose: null }, first_click: { result: 'click', point: [100, 270], expect: 'back' } } });
  await session.stop();
  assert.equal(run(['judge', runDir, '--design', design, '--key', key]).code, 0);
  const [viewer] = readJson(path.join(runDir, 'design-results.json')).viewers;
  assert.equal(viewer.viewer, 'p1-a');
  assert.deepEqual(viewer.frames.map((f) => [f.frame, f.complete, f.first_click?.verdict ?? null, f.first_click?.hit ?? null, f.moved_to, f.ended]), [
    ['a', true, 'hit', { element: 'a:3', control: 'a:2' }, 'b', null],
    ['b', true, 'no_target', { element: 'b:2', control: 'b:2' }, 'a', null],
    ['a', false, null, null, null, 'stopped'],
  ]);
  assert.deepEqual(viewer.frames[0].pressable_hits, [{ point: [20, 105], element: 'a:4', control: 'a:4', expect: 'unknown', confidence: 'cannot_tell' }]);
});

// --- crop --------------------------------------------------------------------------------------------------------

const RED = [255, 0, 0, 255];
const CYAN = [0, 255, 255, 255];
const pixelOf = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const cropFolder = (t) => snapshotFolder(t, { frames: [
  {
    id: 'a', name: 'Shop', width: 200, height: 300, scale: 2, paint: [{ x: 60, y: 100, w: 40, h: 20, colour: BLUE }],
    nodes: [node('a:1', 'INSTANCE', 'Button / Primary', 'a', [60, 100, 40, 20]), node('a:2', 'TEXT', 'Logo', 'a', [0, 0, 30, 30], { text: 'Shop' })],
  },
  { id: 'dark', width: 100, height: 100, background: [10, 10, 30], nodes: [node('dark:1', 'INSTANCE', 'Button', 'dark', [40, 40, 20, 10])] },
  { id: 'bare', width: 100, height: 100, image: false, nodes: [node('bare:1', 'INSTANCE', 'Button', 'bare', [10, 10, 20, 10])] },
] });

test('crop: the part of the frame image around the node, a margin of 48 frame pixels, an outline on the node, in image pixels', (t) => {
  const design = cropFolder(t);
  const out = path.join(tmpDir(t), 'run', 'key', '1.png');
  const result = run(['crop', design, '--frame', 'a', '--node', 'a:1', '--out', out]);
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.deepEqual(result.err, []);
  assert.deepEqual(result.json(), { out, frame: 'a', node: 'a:1', box: { x: 60, y: 100, w: 40, h: 20 } });
  const img = decode(fs.readFileSync(out));
  assert.deepEqual([img.width, img.height], [272, 232], '(40 + 2 x 48) x 2 by (20 + 2 x 48) x 2');
  assert.deepEqual([pixelOf(img, 96, 96), pixelOf(img, 175, 135), pixelOf(img, 130, 110)], Array(3).fill([...BLUE, 255]), 'the node, from (60 - 12) x 2');
  assert.deepEqual([pixelOf(img, 93, 110), pixelOf(img, 95, 110), pixelOf(img, 130, 93), pixelOf(img, 178, 110), pixelOf(img, 130, 138)], Array(5).fill(RED));
  assert.deepEqual([pixelOf(img, 92, 110), pixelOf(img, 0, 0), pixelOf(img, 271, 231)], Array(3).fill([255, 255, 255, 255]));
});

test('crop: the margin stops at the frame edge, and an outline on the edge is drawn inside', (t) => {
  const out = path.join(tmpDir(t), 'logo.png');
  assert.equal(run(['crop', cropFolder(t), '--frame', 'a', '--node', 'a:2', '--out', out]).code, 0);
  const img = decode(fs.readFileSync(out));
  assert.deepEqual([img.width, img.height], [156, 156], '(30 + 48) x 2 on both sides');
  assert.deepEqual([pixelOf(img, 0, 20), pixelOf(img, 20, 0), pixelOf(img, 61, 20), pixelOf(img, 20, 61)], Array(4).fill(RED));
  assert.deepEqual(pixelOf(img, 30, 30), [255, 255, 255, 255]);
});

test('crop: the outline colour is the one that contrasts more with the colour under it', (t) => {
  const out = path.join(tmpDir(t), 'dark.png');
  assert.equal(run(['crop', cropFolder(t), '--frame', 'dark', '--node', 'dark:1', '--out', out]).code, 0);
  assert.deepEqual(pixelOf(decode(fs.readFileSync(out)), 38, 45), CYAN, 'the margin stops at the frame edge, so the node is 40 px in');
});

test('crop: the file is private and its folders are made, an existing file is replaced', { skip: process.platform === 'win32' && 'no mode bits on Windows' }, (t) => {
  const out = path.join(tmpDir(t), 'a', 'b', 'c.png');
  const args = ['crop', cropFolder(t), '--frame', 'a', '--node', 'a:1', '--out', out];
  assert.equal(run(args).code, 0);
  fs.chmodSync(out, 0o644);
  assert.equal(run(args).code, 0);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(out)).mode & 0o777, 0o700);
});

test('crop: an unknown frame, an unknown node, a frame with no image, a snapshot with no nodes and a missing --out fail with one line and exit 1', (t) => {
  const design = cropFolder(t);
  const out = path.join(tmpDir(t), 'x.png');
  const noNodes = snapshotFolder(t, { has: { nodes: false, text: false, font_size: false, links: false }, frames: [{ id: 'png-1', width: 50, height: 50 }] });
  const unreadable = cropFolder(t);
  fs.rmSync(path.join(unreadable, 'frames', '1.png'));
  const cases = [
    [['crop', design, '--frame', 'zz', '--node', 'a:1', '--out', out], 'no frame zz in the snapshot'],
    [['crop', design, '--frame', 'a', '--node', 'a:9', '--out', out], 'frame a has no node a:9'],
    [['crop', design, '--frame', 'a', '--node', 'a', '--out', out], 'frame a has no node a'],
    [['crop', design, '--frame', 'a', '--node', 'dark:1', '--out', out], 'frame a has no node dark:1'],
    [['crop', design, '--frame', 'bare', '--node', 'bare:1', '--out', out], 'frame bare has no image'],
    [['crop', unreadable, '--frame', 'a', '--node', 'a:1', '--out', out], 'cannot read the image of frame a'],
    [['crop', noNodes, '--frame', 'png-1', '--node', 'png-1:1', '--out', out], 'the snapshot has no nodes, so there is nothing to crop'],
    [['crop', design, '--frame', 'a', '--node', 'a:1'], 'crop needs --out, the file to write'],
    [['crop', path.join(design, 'nope'), '--frame', 'a', '--node', 'a:1', '--out', out], `cannot read design.json in ${path.join(design, 'nope')}`],
  ];
  for (const [argv, message] of cases) {
    const result = run(argv);
    assert.equal(result.code, 1, message);
    assert.deepEqual(result.err, [message]);
    assert.deepEqual(result.out, []);
  }
  assert.equal(fs.existsSync(out), false, 'a refusal writes nothing');
});

test('crop: a node wholly outside its frame image is refused; a wrong command line exits 2 with the usage text', (t) => {
  const design = snapshotFolder(t, { frames: [{ id: 'a', width: 100, height: 100, nodes: [node('a:1', 'INSTANCE', 'Off', 'a', [300, 300, 10, 10])] }] });
  const out = path.join(tmpDir(t), 'x.png');
  const off = run(['crop', design, '--frame', 'a', '--node', 'a:1', '--out', out]);
  assert.equal(off.code, 1);
  assert.deepEqual(off.err, ['node a:1 lies outside the image of frame a']);
  for (const argv of [['crop'], ['crop', design], ['crop', design, '--node', 'a:1', '--out', out], ['crop', design, '--frame', 'a', '--out', out],
    ['crop', design, '--frame', 'a', '--node'], ['crop', design, 'extra', '--frame', 'a', '--node', 'a:1', '--out', out], ['crop', design, '--frame', 'a', '--node', 'a:1', '--wat', 'x']]) {
    const result = run(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.err.at(-1), /^usage: node design\.mjs frames/, argv.join(' '));
  }
});
