// The viewer tools and harness_design_start through the real MCP server process. No page is loaded, so there is no fixture server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import { registerViewerTools } from '../viewer-tools.mjs';
import { click, node, snapshotFolder, tmpDir } from './design-fixtures.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp.mjs');
let client;
before(async () => {
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'inherit' }));
});
after(async () => { await client.close(); });

const call = (name, args) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const LOOK = { purpose: 'a page', confidence: 'guess', main_action: { what: 'the button', point: [20, 20] } };
const READ = { pressable: [], not_understood: [], purpose_changed: { changed: false, purpose: null } };
const logOf = (dir) => fs.readFileSync(path.join(dir, 'design-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// a is 90 x 400 (a fold of 160), with a button to b; b is 90 x 100.
const design = (t) => snapshotFolder(t, { frames: [
  { id: 'a', width: 90, height: 400, nodes: [node('a:1', 'INSTANCE', 'Button', 'a', [10, 10, 70, 30], { links: [click('b')] })] },
  { id: 'b', width: 90, height: 100 },
  { id: 'c', width: 90, height: 100, image: false },
] });

test('view and answer are listed with plain descriptions that name no frame, node, layer or Figma', async () => {
  const { tools } = await client.listTools();
  const view = tools.find((t) => t.name === 'view');
  const answer = tools.find((t) => t.name === 'answer');
  assert.deepEqual(view.inputSchema.required, ['session']);
  assert.deepEqual(Object.keys(view.inputSchema.properties).sort(), ['scroll', 'session']);
  assert.deepEqual(view.inputSchema.properties.scroll.enum, ['down', 'up']);
  assert.deepEqual(answer.inputSchema.required, ['session']);
  assert.deepEqual(Object.keys(answer.inputSchema.properties).sort(), ['after_reading', 'first_look', 'session']);
  assert.equal(answer.inputSchema.properties.after_reading.properties.pressable.maxItems, 5);
  assert.ok(answer.inputSchema.properties.after_reading.properties.first_click);
  for (const tool of [view, answer]) {
    assert.doesNotMatch(JSON.stringify(tool), /\b(?:frames?|nodes?|layers?|figma|tests?|harness)\b/i, tool.name);
  }
  const start = tools.find((t) => t.name === 'harness_design_start');
  assert.match(start.description, /^HARNESS ONLY\. /);
  assert.deepEqual(start.inputSchema.required.sort(), ['design', 'dir', 'frame', 'session']);
  assert.deepEqual(Object.keys(start.inputSchema.properties).sort(), ['design', 'dir', 'first_click', 'follow_links', 'frame', 'session', 'views_per_frame']);
});

test('a viewer session over MCP: start, view returns a PNG, scroll, answer, signals, stop', async (t) => {
  const folder = design(t);
  const dir = path.join(tmpDir(t), 'viewer');
  const started = await call('harness_design_start', { session: 'v1', dir, design: folder, frame: 'a', views_per_frame: 3 });
  assert.equal(started.isError, undefined, textOf(started));
  assert.deepEqual(JSON.parse(textOf(started)), {
    session: 'v1', dir, design: folder, frame: 'a', device: 'touch', frame_size: { width: 90, height: 400 }, fold_height: 160,
    follow_links: false, first_click: false, views_per_frame: 3,
  });

  const first = await call('view', { session: 'v1' });
  assert.equal(first.isError, undefined);
  assert.equal(textOf(first), 'Screen 1. You see the top part; there is more below.');
  const image = first.content.find((c) => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = PNG.sync.read(Buffer.from(image.data, 'base64'));
  assert.deepEqual([png.width, png.height], [90, 160]);

  const early = await call('view', { session: 'v1', scroll: 'down' });
  assert.equal(early.isError, true);
  assert.equal(textOf(early), 'ANSWER_FIRST: answer first_look before you scroll.');
  assert.equal(early.content.some((c) => c.type === 'image'), false);

  assert.equal(textOf(await call('answer', { session: 'v1', first_look: LOOK })), 'First look recorded. Read the whole screen now (call view to scroll if there is more), then call answer with after_reading.');
  const again = await call('answer', { session: 'v1', first_look: LOOK });
  assert.deepEqual([again.isError, textOf(again)], [true, 'ALREADY_ANSWERED: you already gave first_look for this screen.']);
  assert.match(textOf(await call('view', { session: 'v1', scroll: 'down' })), /^Screen 1\. You see a middle part/);
  assert.match(textOf(await call('view', { session: 'v1', scroll: 'down' })), /^Screen 1\. You see the bottom part/);
  const capped = await call('view', { session: 'v1' });
  assert.deepEqual([capped.isError, textOf(capped)], [true, 'VIEW_CAP_REACHED: you cannot look at this screen again (3 looks used). Answer with what you have seen.']);

  const outside = await call('answer', { session: 'v1', after_reading: { ...READ, pressable: [{ point: [500, 5], expect: 'x', confidence: 'sure' }] } });
  assert.deepEqual([outside.isError, textOf(outside)],
    [true, 'INVALID_ANSWER: pressable[0].point [500, 5] is outside the picture you were last shown (90 by 160). Nothing was recorded. Point inside the picture.']);
  const wrong = await call('answer', { session: 'v1', first_look: 'nope' });
  assert.equal(wrong.isError, true, 'a part of the wrong shape is a tool error, not a crash');

  const signals = JSON.parse(textOf(await call('harness_signals', { session: 'v1' })));
  assert.deepEqual(signals, {
    session: 'v1', kind: 'design', frame: 'a', state: 'first_look_done', device: 'touch', frames_shown: 1, history: [], views: 3, views_on_frame: 3,
    views_per_frame: 3, over: null, follow_links: false, first_click: false,
  });

  assert.equal(textOf(await call('answer', { session: 'v1', after_reading: READ })), 'Answers recorded. The session is over.');
  const ended = await call('view', { session: 'v1' });
  assert.deepEqual([ended.isError, textOf(ended)], [true, 'SESSION_ENDED: this session is over. Nothing more can be recorded.']);

  const stopped = await call('harness_stop', { session: 'v1' });
  assert.equal(stopped.isError, undefined);
  assert.equal(JSON.parse(textOf(stopped)).over, 'answered');
  const after = await call('view', { session: 'v1' });
  assert.match(textOf(after), /^UNKNOWN_SESSION/);

  assert.deepEqual(logOf(dir).map((l) => l.type), ['start', 'view', 'answer', 'view', 'view', 'answer', 'end']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'screenshots')).sort(), ['v01.png', 'v02.png', 'v03.png']);
  assert.equal(fs.existsSync(path.join(dir, 'log.jsonl')), false);
});

test('harness_stop on an unfinished viewer says it was stopped, the same word the log ends with', async (t) => {
  const dir = path.join(tmpDir(t), 'viewer');
  await call('harness_design_start', { session: 'unfinished', dir, design: design(t), frame: 'a' });
  await call('view', { session: 'unfinished' });
  const stopped = JSON.parse(textOf(await call('harness_stop', { session: 'unfinished' })));
  assert.deepEqual([stopped.over, stopped.frames_shown, stopped.views], ['stopped', 1, 1]);
  const last = logOf(dir).at(-1);
  assert.deepEqual([last.type, last.reason], ['end', 'stopped']);
});

test('follow_links moves the viewer from frame to frame by its own first click', async (t) => {
  const folder = design(t);
  const dir = path.join(tmpDir(t), 'viewer');
  assert.equal((await call('harness_design_start', { session: 'flow', dir, design: folder, frame: 'a', follow_links: true, first_click: true })).isError, undefined);
  await call('view', { session: 'flow' });
  await call('answer', { session: 'flow', first_look: LOOK });
  const moved = await call('answer', { session: 'flow', after_reading: { ...READ, first_click: { result: 'click', point: [20, 20], expect: 'the next page' } } });
  assert.equal(textOf(moved), 'A new screen is showing. Call view.');
  assert.equal(textOf(await call('view', { session: 'flow' })), 'Screen 2. You see the whole screen.');
  await call('answer', { session: 'flow', first_look: LOOK });
  const over = await call('answer', { session: 'flow', after_reading: { ...READ, first_click: { result: 'click', point: [20, 20], expect: 'x' } } });
  assert.equal(textOf(over), 'Nothing happened here in this design.');
  const stopped = JSON.parse(textOf(await call('harness_stop', { session: 'flow' })));
  assert.deepEqual([stopped.over, stopped.frames_shown, stopped.history], ['no_link', 2, ['a']]);
  assert.deepEqual(logOf(dir).filter((l) => l.type === 'navigate').map((l) => [l.frame, l.to]), [['a', 'b']]);
});

test('harness_design_start refuses a frame with no image, an unknown frame and a link flow without a first click', async (t) => {
  const folder = design(t);
  const dir = path.join(tmpDir(t), 'viewer');
  const start = (extra) => call('harness_design_start', { session: 'bad', dir, design: folder, frame: 'a', ...extra });
  const noImage = await start({ frame: 'c' });
  assert.deepEqual([noImage.isError, textOf(noImage)], [true, 'frame "c" has no image']);
  assert.equal(textOf(await start({ frame: 'zz' })), 'frame "zz" is not in the design');
  assert.match(textOf(await start({ follow_links: true })), /^follow_links needs first_click/);
  assert.match(textOf(await call('harness_design_start', { session: 'bad', dir, design: tmpDir(t), frame: 'a' })), /^cannot read design\.json/);
  assert.match(textOf(await call('view', { session: 'bad' })), /^UNKNOWN_SESSION/, 'a failed start leaves no session');
});

test('act and end_session on a viewer session answer UNKNOWN_SESSION, as for an id that does not exist', async (t) => {
  const dir = path.join(tmpDir(t), 'viewer');
  await call('harness_design_start', { session: 'static', dir, design: design(t), frame: 'a' });
  const act = { session: 'static', observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action: { type: 'look' } };
  const missing = await call('act', { ...act, session: 'nobody' });
  const onStatic = await call('act', act);
  assert.equal(onStatic.isError, true);
  assert.equal(textOf(onStatic), 'UNKNOWN_SESSION: no open browser session "static".');
  assert.equal(textOf(onStatic).replace('static', 'nobody'), textOf(missing));
  const end = await call('end_session', {
    session: 'static', outcome: 'gave_up', final_observation: 'o', exit_interview: { what_it_is_for: 'a', would_come_back: 'no', reason: 'r', most_confusing: 'm' },
  });
  assert.equal(textOf(end), 'UNKNOWN_SESSION: no open browser session "static".');
  assert.equal((await call('harness_eval', { session: 'static', js: '1' })).isError, true);
  assert.equal((await call('harness_save_state', { session: 'static', path: path.join(tmpDir(t), 's.json') })).isError, true);
  assert.equal(textOf(await call('view', { session: 'nobody' })), 'UNKNOWN_SESSION: no open session "nobody".');
  assert.equal(textOf(await call('answer', { session: 'nobody', first_look: LOOK })), 'UNKNOWN_SESSION: no open session "nobody".');
  assert.equal(JSON.parse(textOf(await call('harness_signals', { session: 'static' }))).kind, 'design', 'the viewer session is still open');
  await call('harness_stop', { session: 'static' });
});

test('an id lives in one registry: SESSION_EXISTS from harness_design_start twice and from harness_start after it', async (t) => {
  const folder = design(t);
  const dir = path.join(tmpDir(t), 'viewer');
  await call('harness_design_start', { session: 'once', dir, design: folder, frame: 'a' });
  const twice = await call('harness_design_start', { session: 'once', dir, design: folder, frame: 'a' });
  assert.deepEqual([twice.isError, textOf(twice)], [true, 'SESSION_EXISTS: "once" is already open; stop it first.']);
  const browser = await call('harness_start', { session: 'once', dir: path.join(tmpDir(t), 'p'), url: 'http://127.0.0.1:9/' });
  assert.deepEqual([browser.isError, textOf(browser)], [true, 'SESSION_EXISTS: "once" is already open; stop it first.']);
  await call('harness_stop', { session: 'once' });
  assert.match(textOf(await call('harness_signals', { session: 'once' })), /^UNKNOWN_SESSION/);
  assert.equal((await call('harness_design_start', { session: 'once', dir: path.join(tmpDir(t), 'again'), design: folder, frame: 'a' })).isError, undefined, 'a stopped id can be used again');
  await call('harness_stop', { session: 'once' });
});

test('view and answer on a browser session id answer UNKNOWN_SESSION, and harness_design_start refuses that id', async (t) => {
  const dir = path.join(tmpDir(t), 'persona');
  const opened = await call('harness_start', { session: 'browser', dir, url: 'about:blank' });
  assert.equal(opened.isError, undefined, textOf(opened));
  try {
    assert.equal(textOf(await call('view', { session: 'browser' })), 'UNKNOWN_SESSION: no open session "browser".');
    assert.equal(textOf(await call('answer', { session: 'browser', first_look: LOOK })), 'UNKNOWN_SESSION: no open session "browser".');
    const clash = await call('harness_design_start', { session: 'browser', dir: path.join(tmpDir(t), 'v'), design: design(t), frame: 'a' });
    assert.deepEqual([clash.isError, textOf(clash)], [true, 'SESSION_EXISTS: "browser" is already open; stop it first.']);
    assert.equal(JSON.parse(textOf(await call('harness_signals', { session: 'browser' }))).session, 'browser', 'harness_signals still reaches a browser session');
  } finally {
    await call('harness_stop', { session: 'browser' });
  }
});

test('an error the viewer tools did not expect shows a fixed sentence, not its message or the path in it', async () => {
  const handlers = {};
  registerViewerTools({ registerTool: (name, _config, handler) => { handlers[name] = handler; } }, (id) => {
    if (id === 'nobody') throw new Error(`UNKNOWN_SESSION: no open session "${id}".`);
    const fail = () => { throw new Error("EACCES: permission denied, open '/srv/app/run-one/v1/v01.png'"); };
    return { view: fail, answer: fail };
  });
  for (const [name, args] of [['view', { session: 'v1' }], ['answer', { session: 'v1', first_look: LOOK }]]) {
    const result = await handlers[name](args);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'FAILED: this call did not work. Try it once more.' }], isError: true }, name);
  }
  assert.deepEqual(await handlers.view({ session: 'nobody' }), { content: [{ type: 'text', text: 'UNKNOWN_SESSION: no open session "nobody".' }], isError: true });
});
