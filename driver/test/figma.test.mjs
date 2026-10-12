// The fixtures in test/fixtures/figma are written from Figma's published REST and Plugin API documentation. They are not
// recordings: nobody on this project has run these sources against a real Figma file. A passing test says the code agrees
// with the fixture, not with Figma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { PNG } from 'pngjs';
import { main, pngSize, scanOutline } from '../figma.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'figma');
const READ_SCRIPT = path.join(HERE, '..', 'figma-read.js');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const NOW = new Date('2026-10-12T09:00:00Z');
const TOKEN = 'figd_test-token-0123456789';
const LINK = 'https://www.figma.com/design/AbCdEf/Shop';

function pngBytes(width, height, [r, g, b]) {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) image.data.set([r, g, b, 255], i * 4);
  return PNG.sync.write(image);
}
const IMAGES = {
  welcome: pngBytes(120, 240, [250, 250, 250]),
  checkout: pngBytes(120, 240, [240, 240, 255]),
  dialog: pngBytes(100, 100, [255, 240, 240]),
  square: pngBytes(100, 100, [200, 200, 200]),
};

const tmp = (t, prefix = 'uxa-figma-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const findNode = (node, id) => {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
};

/**
 * A local stand-in for api.figma.com and the image host. `override(request, count)` may answer instead: {status, body, headers}.
 * `rest` replaces the fixture document behind /nodes, `everyImage` makes every frame id of the request come back with an image, and
 * `versions` (read at each request) says the version of a file key; every key serves the same document.
 */
async function fakeFigma(t, { override, pages = JSON.parse(fixture('rest-pages.json')), rest: replaced, everyImage = false, versions = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = { path: url.pathname, query: Object.fromEntries(url.searchParams), token: req.headers['x-figma-token'] ?? null };
    requests.push(record);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'image/png' : 'application/json', ...headers });
      res.end(body);
    };
    const forced = override?.(record, requests.length);
    if (forced) return send(forced.status, forced.body ?? '{}', forced.headers);
    const base = `http://127.0.0.1:${server.address().port}`;
    const rest = replaced ?? JSON.parse(fixture('rest-nodes.json'));
    const key = url.pathname.match(/^\/v1\/(?:files|images)\/(\w+)/)?.[1];
    const version = versions[key] ?? rest.version;
    if (url.pathname === `/v1/files/${key}` && url.searchParams.get('depth') === '2') return send(200, JSON.stringify({ ...pages, version }));
    if (url.pathname === `/v1/files/${key}/nodes`) {
      const id = url.searchParams.get('ids');
      const document = findNode(rest.nodes['0:1'].document, id);
      return send(200, JSON.stringify({ ...rest, version, nodes: { [id]: document ? { ...rest.nodes['0:1'], document } : null } }));
    }
    if (url.pathname === `/v1/images/${key}`) {
      const wanted = url.searchParams.get('ids').split(',');
      const all = everyImage ? { images: Object.fromEntries(wanted.map((id) => [id, `${base}/img/square.png`])) } : JSON.parse(fixture('rest-images.json').replaceAll('{{BASE}}', base));
      return send(200, JSON.stringify({ err: null, images: Object.fromEntries(Object.entries(all.images).filter(([id]) => wanted.includes(id))) }));
    }
    const image = url.pathname.match(/^\/img\/(\w+)\.png$/);
    if (image && IMAGES[image[1]]) return send(200, IMAGES[image[1]]);
    return send(404, '{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { requests, base: `http://127.0.0.1:${server.address().port}` };
}

/** Runs the CLI in process. The token must appear in no line it prints. */
async function run(args, { env = {}, sleeps = [], at = NOW } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, {
    out: (line) => out.push(line), err: (line) => err.push(line), env, now: () => at,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.ok(![...out, ...err].join('\n').includes(TOKEN), 'the token is in the output');
  return { code, out, err, text: [...out, ...err].join('\n') };
}

const snapshotOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
const lastJson = (result) => JSON.parse(result.out.at(-1));

// --- parse-url ---------------------------------------------------------------------------------------------------

test('parse-url: every row of the routing table', async () => {
  const board = {
    kind: 'unsupported',
    reason: 'FigJam board links are not supported. Give a link to a Figma design, file or prototype (/design/, /file/ or /proto/), or a folder of PNG files.',
  };
  const design = (file_key, node_id = null) => ({ kind: 'design', file_key, node_id, start_node_id: null });
  const rows = [
    ['https://www.figma.com/design/AbC123/Shop?node-id=12-34&t=xyz', design('AbC123', '12:34')],
    ['https://figma.com/file/AbC123/Shop', design('AbC123')],
    ['http://www.figma.com/design/AbC123/Shop', design('AbC123')],
    ['https://www.figma.com/design/AbC123/Shop?node-id=12%3A34', design('AbC123', '12:34')],
    ['https://www.figma.com/design/AbC123/branch/Br4nch/Shop?node-id=7-8', design('Br4nch', '7:8')],
    ['review (https://www.figma.com/design/AbC123/Shop?node-id=1-2). thanks', design('AbC123', '1:2')],
    ['https://www.figma.com/design/AbC123/Shop-(Copy)?node-id=12-34', design('AbC123', '12:34')],
    ['https://www.figma.com/design/AbC123/Shop-[v2]?node-id=12-34&t=x', design('AbC123', '12:34')],
    ['see (https://www.figma.com/design/AbC123/Shop?node-id=1-2) for the flow', design('AbC123', '1:2')],
    ['see (https://www.figma.com/design/AbC123/Shop-(Copy)?node-id=1-2) for the flow', design('AbC123', '1:2')],
    ['[the design](https://www.figma.com/design/AbC123/Shop?node-id=1-2)', design('AbC123', '1:2')],
    ['Open https://www.figma.com/design/AbC123/Shop?node-id=1-2.', design('AbC123', '1:2')],
    ['https://www.figma.com/design/AbC123/Shop-(Copy)?node-id=1-2.', design('AbC123', '1:2')],
    ['https://www.figma.com/proto/AbC123/Shop?node-id=1-2&starting-point-node-id=3-4&scaling=min-zoom',
      { kind: 'proto', file_key: 'AbC123', node_id: '1:2', start_node_id: '3:4' }],
    ['https://www.figma.com/proto/AbC123/Shop', { kind: 'proto', file_key: 'AbC123', node_id: null, start_node_id: null }],
    ['https://www.figma.com/board/Xy9/Plan', board],
    ['https://www.figma.com/slides/Xy9/Talk', { kind: 'unsupported', reason: board.reason.replace('FigJam board', 'Figma Slides') }],
    ['https://www.figma.com/community/file/123456', { kind: 'unsupported', reason: board.reason.replace('FigJam board', 'Figma Community') }],
    ['https://www.figma.com/board/Xy9/Plan and https://www.figma.com/design/AbC123/Shop', design('AbC123')],
    ['test https://localhost:3000 and https://www.figma.com/design/AbC123/Shop', design('AbC123')],
    ['https://example.com/design/AbC123/Shop', { kind: 'none' }],
    ['https://notfigma.com/design/AbC123/Shop', { kind: 'none' }],
    ['https://figma.com.example.org/design/AbC123/Shop', { kind: 'none' }],
    ['https://www.figma.com/make/AbC123/Thing', { kind: 'none' }],
    ['https://www.figma.com/design/', { kind: 'none' }],
    ['design', { kind: 'none' }],
    ['app', { kind: 'none' }],
    ['', { kind: 'none' }],
  ];
  for (const [text, expected] of rows) {
    const result = await run(['parse-url', text]);
    assert.equal(result.code, 0, text);
    assert.deepEqual(lastJson(result), expected, text);
  }
});

// --- fetch: the REST source --------------------------------------------------------------------------------------

const NODE = (id, type, name, parent, box, extra = {}) => ({
  id, type, name, parent, box, text: null, font_size: null, image_fill: false, links: [], ...extra,
});

const EXPECTED_REST = {
  source: 'rest',
  file_key: 'AbCdEf',
  version: '2207',
  fetched_at: '2026-10-12T09:00:00Z',
  has: { nodes: true, text: true, font_size: true, links: true },
  frames: [
    {
      id: '1:10', name: 'Welcome', page: 'Mobile', width: 120, height: 240, image: 'frames/1.png', image_scale: 1, links: [],
      nodes: [
        NODE('1:11', 'TEXT', 'Title', '1:10', { x: 10, y: 10, w: 100, h: 20 }, { text: 'Welcome back', font_size: 20 }),
        NODE('1:12', 'INSTANCE', 'Button / Primary', '1:10', { x: 10, y: 200, w: 100, h: 40 }, {
          links: [{ trigger: 'click', action: 'navigate', to: '1:20' }, { trigger: 'hover', action: 'overlay', to: null }],
        }),
        NODE('1:13', 'TEXT', 'Label', '1:12', { x: 20, y: 210, w: 30, h: 16 }, { text: 'Pay', font_size: 14 }),
        NODE('1:14', 'RECTANGLE', 'Hero', '1:10', { x: 0, y: 0, w: 120, h: 80 }, { image_fill: true }),
        NODE('1:18', 'TEXT', 'Terms', '1:10', { x: 10, y: 100, w: 60, h: 14 }, {
          text: 'Terms', font_size: 12, links: [{ trigger: 'click', action: 'url', to: null }],
        }),
        NODE('1:19', 'FRAME', 'Elsewhere', '1:10', { x: 10, y: 120, w: 40, h: 20 }, { links: [{ trigger: 'click', action: 'other', to: null }] }),
      ],
    },
    {
      id: '1:20', name: 'Checkout', page: 'Mobile', width: 120, height: 240, image: 'frames/2.png', image_scale: 1, links: [],
      nodes: [
        NODE('1:21', 'TEXT', 'Back', '1:20', { x: 10, y: 10, w: 40, h: 16 }, {
          text: 'Back', font_size: 14, links: [{ trigger: 'click', action: 'back', to: null }],
        }),
        NODE('1:22', 'INSTANCE', 'Switch', '1:20', { x: 10, y: 60, w: 60, h: 30 }, {
          links: [
            { trigger: 'hover', action: 'swap', to: null },
            { trigger: 'drag', action: 'scroll', to: null },
            { trigger: 'timeout', action: 'other', to: null },
            { trigger: 'other', action: 'swap', to: null },
          ],
        }),
      ],
    },
    {
      id: '1:32', name: 'Dialog', page: 'Mobile', width: 100, height: 100, image: 'frames/3.png', image_scale: 1,
      links: [{ trigger: 'click', action: 'navigate', to: '1:20' }],
      nodes: [NODE('1:33', 'TEXT', 'Confirm', '1:32', { x: 20, y: 20, w: 30, h: 16 }, { text: 'OK', font_size: 16 })],
    },
  ],
  flow_starts: ['1:10'],
  arrows: [{ between: ['1:10', '1:20'], direction: 'unknown' }],
  skipped: [{ id: '1:31', reason: 'no image' }],
};

test('fetch: a REST page becomes the literal snapshot, source.yaml and frame images', async (t) => {
  const figma = await fakeFigma(t);
  const project = tmp(t);
  const url = `${LINK}?node-id=0-1`;
  const result = await run(['fetch', project, url], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(result.err, []);

  const dir = path.join(project, '.ux-assessment', 'design', 'cache', 'AbCdEf', '2207');
  assert.deepEqual(snapshotOf(dir), EXPECTED_REST);
  assert.deepEqual(lastJson(result), { snapshot: dir, source: 'rest', file_key: 'AbCdEf', version: '2207', frames: 3, nodes: 9, skipped: 1 });
  assert.equal(result.out.length, 1);
  assert.deepEqual(['1.png', '2.png', '3.png'].map((name) => pngSize(fs.readFileSync(path.join(dir, 'frames', name)))),
    [{ width: 120, height: 240 }, { width: 120, height: 240 }, { width: 100, height: 100 }]);
  assert.deepEqual(YAML.parse(fs.readFileSync(path.join(project, '.ux-assessment', 'design', 'source.yaml'), 'utf8')), {
    source: 'rest', link: url, page: null, file_key: 'AbCdEf', version: '2207',
    frames: [{ id: '1:10', name: 'Welcome' }, { id: '1:20', name: 'Checkout' }, { id: '1:32', name: 'Dialog' }],
  });

  assert.deepEqual(figma.requests.map((r) => [r.path, r.token]), [
    ['/v1/files/AbCdEf/nodes', TOKEN], ['/v1/images/AbCdEf', TOKEN],
    ['/img/welcome.png', null], ['/img/checkout.png', null], ['/img/dialog.png', null],
  ]);
  assert.equal(figma.requests[0].query.ids, '0:1');
  assert.deepEqual({ ...figma.requests[1].query, ids: figma.requests[1].query.ids.split(',') },
    { ids: ['1:10', '1:20', '1:31', '1:32'], format: 'png', scale: '1' });
});

test('fetch: a link to one frame gives one frame, with flow starts from the links; a section gives its frames', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const frame = tmp(t);
  assert.equal((await run(['fetch', frame, `${LINK}?node-id=1-20`], { env })).code, 0);
  const one = snapshotOf(path.join(frame, '.ux-assessment', 'design', 'cache', 'AbCdEf', '2207'));
  assert.deepEqual(one.frames.map((f) => [f.id, f.page, f.nodes.length]), [['1:20', null, 2]]);
  assert.deepEqual([one.flow_starts, one.arrows, one.skipped], [['1:20'], [], []]);

  const section = tmp(t);
  assert.equal((await run(['fetch', section, `${LINK}?node-id=1-30`], { env })).code, 0);
  const many = snapshotOf(path.join(section, '.ux-assessment', 'design', 'cache', 'AbCdEf', '2207'));
  assert.deepEqual(many.frames.map((f) => f.id), ['1:32']);
  assert.deepEqual(many.skipped, [{ id: '1:31', reason: 'no image' }]);
  assert.deepEqual(many.frames[0].links, [{ trigger: 'click', action: 'other', to: null }], 'a frame link to a frame outside the snapshot is other');
});

test('fetch: a link with no node lists the pages and exits 3; --page continues; one page needs no choice', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const listed = await run(['fetch', project, LINK], { env });
  assert.equal(listed.code, 3);
  assert.deepEqual(lastJson(listed), { file_key: 'AbCdEf', pages: [{ id: '0:1', name: 'Mobile', children: 3 }, { id: '0:2', name: 'Scratch', children: 0 }] });
  assert.deepEqual(figma.requests.map((r) => [r.path, r.query.depth]), [['/v1/files/AbCdEf', '2']]);

  const chosen = await run(['fetch', project, LINK, '--page', '0:1'], { env });
  assert.equal(chosen.code, 0, chosen.text);
  assert.equal(snapshotOf(lastJson(chosen).snapshot).frames[0].page, 'Mobile');
  assert.equal(YAML.parse(fs.readFileSync(path.join(project, '.ux-assessment', 'design', 'source.yaml'), 'utf8')).page, '0:1');

  const single = await fakeFigma(t, { pages: { version: '2207', document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Mobile', type: 'CANVAS', children: [] }] } } });
  const auto = await run(['fetch', tmp(t), LINK], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: single.base } });
  assert.equal(auto.code, 0, auto.text);
  assert.deepEqual(single.requests.slice(0, 2).map((r) => [r.path, r.query.ids ?? r.query.depth]), [['/v1/files/AbCdEf', '2'], ['/v1/files/AbCdEf/nodes', '0:1']]);
});

test('fetch: a prototype link finds the page of its starting frame and starts the flow there', async (t) => {
  const figma = await fakeFigma(t);
  const project = tmp(t);
  const result = await run(['fetch', project, 'https://www.figma.com/proto/AbCdEf/Shop?node-id=1-20&starting-point-node-id=1-10'],
    { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(figma.requests.slice(0, 2).map((r) => [r.path, r.query.ids ?? r.query.depth]), [['/v1/files/AbCdEf', '2'], ['/v1/files/AbCdEf/nodes', '0:1']]);
  const snapshot = snapshotOf(lastJson(result).snapshot);
  assert.deepEqual([snapshot.frames.length, snapshot.flow_starts], [3, ['1:10']]);
});

test('fetch: the token comes from secrets.local.yaml when the environment has none', async (t) => {
  const figma = await fakeFigma(t);
  const project = tmp(t);
  fs.mkdirSync(path.join(project, '.ux-assessment'), { recursive: true });
  fs.writeFileSync(path.join(project, '.ux-assessment', 'secrets.local.yaml'), `figma_token: ${TOKEN}\r\n`);
  const result = await run(['fetch', project, `${LINK}?node-id=1-20`], { env: { FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 0, result.text);
  assert.equal(figma.requests[0].token, TOKEN);
});

test('fetch: no token stops with how to make one, before any request', async (t) => {
  const figma = await fakeFigma(t);
  const result = await run(['fetch', tmp(t), LINK], { env: { FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 1);
  assert.match(result.text, /No Figma token was found\./);
  assert.match(result.text, /scope file_content:read/);
  assert.match(result.text, /FIGMA_TOKEN/);
  assert.match(result.text, /secrets\.local\.yaml/);
  assert.match(result.text, /import-png/);
  assert.deepEqual(figma.requests, []);
});

for (const status of [403, 404]) {
  test(`fetch: Figma answering ${status} stops with how to make a token`, async (t) => {
    const figma = await fakeFigma(t, { override: () => ({ status }) });
    const result = await run(['fetch', tmp(t), `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
    assert.equal(result.code, 1);
    assert.match(result.text, new RegExp(`Figma answered ${status} for /v1/files/AbCdEf/nodes`));
    assert.match(result.text, /scope file_content:read/);
    assert.match(result.text, /must be able to open the file/);
    assert.equal(figma.requests.length, 1);
  });
}

test('fetch: a 429 with a short Retry-After waits once and retries', async (t) => {
  const figma = await fakeFigma(t, { override: (r, count) => (count === 1 ? { status: 429, headers: { 'retry-after': '2' } } : null) });
  const sleeps = [];
  const result = await run(['fetch', tmp(t), `${LINK}?node-id=1-20`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base }, sleeps });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(figma.requests.map((r) => r.path).slice(0, 3), ['/v1/files/AbCdEf/nodes', '/v1/files/AbCdEf/nodes', '/v1/images/AbCdEf']);
});

test('fetch: a 429 with a Retry-After over 60 s, or a second 429, stops with how to export by hand', async (t) => {
  const long = await fakeFigma(t, { override: () => ({ status: 429, headers: { 'retry-after': '61' } }) });
  const sleeps = [];
  const stopped = await run(['fetch', tmp(t), `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: long.base }, sleeps });
  assert.equal(stopped.code, 1);
  assert.match(stopped.text, /Export the frames by hand/);
  assert.match(stopped.text, /import-png/);
  assert.deepEqual([sleeps, long.requests.length], [[], 1]);

  for (const headers of [undefined, { 'retry-after': 'soon' }]) {
    const missing = await fakeFigma(t, { override: () => ({ status: 429, headers }) });
    const noWait = [];
    const result = await run(['fetch', tmp(t), `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: missing.base }, sleeps: noWait });
    assert.equal(result.code, 1);
    assert.match(result.text, /Export the frames by hand/);
    assert.deepEqual([noWait, missing.requests.length], [[], 1], 'a missing or unreadable Retry-After counts as a long wait');
  }

  const twice = await fakeFigma(t, { override: () => ({ status: 429, headers: { 'retry-after': '3' } }) });
  const waits = [];
  const again = await run(['fetch', tmp(t), `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: twice.base }, sleeps: waits });
  assert.equal(again.code, 1);
  assert.match(again.text, /Export the frames by hand/);
  assert.deepEqual([waits, twice.requests.length], [[3000], 2]);
});

test('fetch: a second run with the same link makes no request; --refresh does', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const args = ['fetch', project, `${LINK}?node-id=0-1`];
  const first = await run(args, { env });
  const calls = figma.requests.length;
  assert.equal(calls, 5);

  const second = await run(args, { env });
  assert.equal(second.code, 0);
  assert.equal(figma.requests.length, calls);
  assert.deepEqual(lastJson(second), { ...lastJson(first), cached: true });

  const refreshed = await run([...args, '--refresh'], { env });
  assert.equal(refreshed.code, 0);
  assert.equal(figma.requests.length, calls * 2);

  const another = await run(['fetch', project, `${LINK}?node-id=1-20`], { env });
  assert.equal(another.code, 0);
  assert.ok(figma.requests.length > calls * 2, 'a different link is not served from the cache');
});

// --- fetch: choosing frames --------------------------------------------------------------------------------------

const folderOf = (project, name, key = 'AbCdEf') => path.join(project, '.ux-assessment', 'design', 'cache', key, name);

/** A page of `count` frames, each 100 x 200. Frame 9:3 has a button that goes to 9:4, frame 9:7 itself goes to 9:8 on a click and on a hover. */
function bigPage(count) {
  const frame = (i) => {
    const id = `9:${i}`;
    const extra = i === 3 ? { children: [{ id: '9:30', name: 'Next', type: 'INSTANCE', absoluteBoundingBox: { x: i * 200, y: 0, width: 50, height: 20 },
      interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '9:4', navigation: 'NAVIGATE' }] }] }] }
      : i === 7 ? { interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '9:8', navigation: 'NAVIGATE' }] },
        { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: '9:8', navigation: 'NAVIGATE' }] }] } : {};
    return { id, name: `Screen ${i}`, type: 'FRAME', absoluteBoundingBox: { x: i * 200, y: 0, width: 100, height: 200 }, children: [], ...extra };
  };
  const document = { id: '0:1', name: 'Mobile', type: 'CANVAS', flowStartingPoints: [{ nodeId: '9:3', name: 'Start' }], children: Array.from({ length: count }, (_, i) => frame(i + 1)) };
  return { name: 'Shop', version: '2207', nodes: { '0:1': { document } } };
}

test('fetch: a page of more than 24 frames and no --frames lists the frames and exits 4 before any image request', async (t) => {
  const figma = await fakeFigma(t, { rest: bigPage(25), everyImage: true });
  const project = tmp(t);
  const result = await run(['fetch', project, `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 4, result.text);
  assert.deepEqual(result.err, []);
  assert.equal(result.out.length, 1);
  const plain = (i) => ({ id: `9:${i}`, name: `Screen ${i}`, width: 100, height: 200, links: 0, flow_start: false });
  assert.deepEqual(lastJson(result), {
    file_key: 'AbCdEf', version: '2207', too_many_frames: 25, limit: 24,
    frames: Array.from({ length: 25 }, (_, i) => i + 1).map((i) => (i === 3 ? { ...plain(3), links: 1, flow_start: true } : i === 7 ? { ...plain(7), links: 1 } : plain(i))),
  });
  assert.deepEqual(figma.requests.map((r) => r.path), ['/v1/files/AbCdEf/nodes'], 'no image was asked for or downloaded');
  assert.equal(fs.existsSync(path.join(project, '.ux-assessment')), false, 'nothing is written');

  const exactly = await fakeFigma(t, { rest: bigPage(24), everyImage: true });
  assert.equal((await run(['fetch', tmp(t), `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: exactly.base } })).code, 0, '24 frames are not too many');
});

test('fetch: --frames on a big page keeps those frames, and asks for and downloads only their images', async (t) => {
  const figma = await fakeFigma(t, { rest: bigPage(25), everyImage: true });
  const project = tmp(t);
  const result = await run(['fetch', project, `${LINK}?node-id=0-1`, '--frames', '9-4,9:3'], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(figma.requests.map((r) => [r.path, r.query.ids]), [
    ['/v1/files/AbCdEf/nodes', '0:1'], ['/v1/images/AbCdEf', '9:3,9:4'], ['/img/square.png', undefined], ['/img/square.png', undefined]]);
  const snapshot = snapshotOf(lastJson(result).snapshot);
  assert.deepEqual(snapshot.frames.map((f) => f.id), ['9:3', '9:4'], 'in page order, not in the order given');
  assert.deepEqual([snapshot.flow_starts, snapshot.skipped], [['9:3'], []]);
  assert.deepEqual(snapshot.frames[0].nodes[0].links, [{ trigger: 'click', action: 'navigate', to: '9:4' }]);
});

test('fetch: --frames names the cache folder after the sorted list, and the folder of a fetch without it is left alone', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const link = `${LINK}?node-id=0-1`;
  const some = await run(['fetch', project, link, '--frames', '1:32,1-20'], { env });
  assert.equal(some.code, 0, some.text);
  assert.equal(lastJson(some).snapshot, folderOf(project, '2207-f2112e778'));
  assert.deepEqual(snapshotOf(lastJson(some).snapshot).frames.map((f) => f.id), ['1:20', '1:32']);
  const all = await run(['fetch', project, link], { env });
  assert.equal(lastJson(all).snapshot, folderOf(project, '2207'));
  assert.equal(snapshotOf(folderOf(project, '2207')).frames.length, 3);
  assert.equal(snapshotOf(folderOf(project, '2207-f2112e778')).frames.length, 2, 'the other selection is still there');
  assert.deepEqual(fs.readdirSync(path.join(project, '.ux-assessment', 'design', 'cache', 'AbCdEf')).sort(), ['2207', '2207-f2112e778']);
});

test('fetch: a navigate link whose target is not kept becomes other, and the flow starts and arrows of the kept frames only remain', async (t) => {
  const figma = await fakeFigma(t);
  const result = await run(['fetch', tmp(t), `${LINK}?node-id=0-1`, '--frames', '1:10,1:32'], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 0, result.text);
  const snapshot = snapshotOf(lastJson(result).snapshot);
  assert.deepEqual(snapshot.frames.map((f) => f.id), ['1:10', '1:32']);
  assert.deepEqual(snapshot.frames[0].nodes[1].links, [{ trigger: 'click', action: 'other', to: null }, { trigger: 'hover', action: 'overlay', to: null }], '1:20 is not kept');
  assert.deepEqual(snapshot.frames[1].links, [{ trigger: 'click', action: 'other', to: null }]);
  assert.deepEqual([snapshot.flow_starts, snapshot.arrows], [['1:10'], []], 'the arrow between 1:10 and 1:20 is gone with 1:20');
  assert.deepEqual(snapshot.skipped, [], 'a frame left out by --frames is not a skipped frame');
});

test('fetch: an id that is not a frame of the page fails with one line before any image request', async (t) => {
  const figma = await fakeFigma(t);
  const project = tmp(t);
  for (const [frames, line] of [['1:20,9:99', 'not a frame of the linked page or section: 9:99'], ['1:11', 'not a frame of the linked page or section: 1:11'],
    ['8:1,1:20,9:9', 'not a frame of the linked page or section: 8:1, 9:9']]) {
    const before = figma.requests.length;
    const result = await run(['fetch', project, `${LINK}?node-id=0-1`, '--frames', frames], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
    assert.equal(result.code, 1, frames);
    assert.deepEqual(result.err, [line], frames);
    assert.deepEqual(figma.requests.slice(before).map((r) => r.path), ['/v1/files/AbCdEf/nodes'], 'only the node call was made');
  }
  assert.equal(fs.existsSync(path.join(project, '.ux-assessment')), false);
});

test('fetch: the cache hit takes the frame list into account', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const link = `${LINK}?node-id=0-1`;
  const first = await run(['fetch', project, link, '--frames', '1:20,1:32'], { env });
  const calls = figma.requests.length;
  assert.equal(calls, 4, 'the nodes, one images call and two downloads');

  const same = await run(['fetch', project, link, '--frames', '1-32,1:20'], { env });
  assert.equal(figma.requests.length, calls, 'the same frames in another order and spelling are the same request');
  assert.deepEqual(lastJson(same), { ...lastJson(first), cached: true });

  const other = await run(['fetch', project, link, '--frames', '1:10'], { env });
  assert.equal(other.code, 0, other.text);
  assert.ok(figma.requests.length > calls, 'another list is another request');
  assert.equal(lastJson(other).cached, undefined);

  const none = await run(['fetch', project, link], { env });
  assert.equal(none.code, 0, none.text);
  assert.equal(lastJson(none).cached, undefined, 'no list is not the list of an earlier fetch');
  const afterNone = figma.requests.length;
  assert.equal(lastJson(await run(['fetch', project, link, '--frames', '1:20,1:32'], { env })).cached, true);
  assert.equal(figma.requests.length, afterNone, 'and the first list is still saved');
});

// --- fetch: the index of saved copies ----------------------------------------------------------------------------

const OTHER_LINK = 'https://www.figma.com/design/ZyXwVu/Other?node-id=0-1';
const designOf = (project) => path.join(project, '.ux-assessment', 'design');
const sourceOf = (project) => YAML.parse(fs.readFileSync(path.join(designOf(project), 'source.yaml'), 'utf8'));
const indexOf = (project) => JSON.parse(fs.readFileSync(path.join(designOf(project), 'cache', 'index.json'), 'utf8'));
const requestKey = (link, frames = null, page = null) => JSON.stringify(['rest', link, page, frames]);

test('fetch: fetching file A, then file B, then A again makes no request and source.yaml names A again', async (t) => {
  const figma = await fakeFigma(t, { versions: { ZyXwVu: '3001' } });
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const a = `${LINK}?node-id=0-1`;
  const first = await run(['fetch', project, a], { env });
  assert.equal(first.code, 0, first.text);
  const second = await run(['fetch', project, OTHER_LINK], { env });
  assert.equal(second.code, 0, second.text);
  assert.deepEqual([sourceOf(project).file_key, sourceOf(project).version], ['ZyXwVu', '3001']);
  const calls = figma.requests.length;
  assert.equal(calls, 10);

  const again = await run(['fetch', project, a], { env });
  assert.equal(again.code, 0, again.text);
  assert.equal(figma.requests.length, calls, 'no request was made');
  assert.deepEqual(lastJson(again), { ...lastJson(first), cached: true });
  assert.deepEqual(sourceOf(project), {
    source: 'rest', link: a, page: null, file_key: 'AbCdEf', version: '2207',
    frames: [{ id: '1:10', name: 'Welcome' }, { id: '1:20', name: 'Checkout' }, { id: '1:32', name: 'Dialog' }],
  });
  assert.deepEqual(indexOf(project), {
    [requestKey(a)]: { file_key: 'AbCdEf', version: '2207', folder: 'AbCdEf/2207', fetched_at: '2026-10-12T09:00:00Z' },
    [requestKey(OTHER_LINK)]: { file_key: 'ZyXwVu', version: '3001', folder: 'ZyXwVu/3001', fetched_at: '2026-10-12T09:00:00Z' },
  });
  assert.deepEqual(fs.readdirSync(path.join(designOf(project), 'cache')).sort(), ['AbCdEf', 'ZyXwVu', 'index.json'], 'no temporary file is left');
});

test('fetch: the index is private, keeps one entry per request, and records the frame list and the page', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  assert.equal((await run(['fetch', project, LINK, '--page', '0:1', '--frames', '1:32,1-20'], { env })).code, 0);
  assert.deepEqual(indexOf(project), {
    [requestKey(LINK, ['1:20', '1:32'], '0:1')]: { file_key: 'AbCdEf', version: '2207', folder: 'AbCdEf/2207-f2112e778', fetched_at: '2026-10-12T09:00:00Z' },
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(designOf(project), 'cache', 'index.json')).mode & 0o777, 0o600);
  const again = await run(['fetch', project, LINK, '--page', '0:1', '--frames', '1:20,1:32'], { env });
  assert.equal(lastJson(again).cached, true);
  assert.equal(Object.keys(indexOf(project)).length, 1);
});

test('fetch: an index that cannot be read or has the wrong shape warns once, counts as empty and is replaced', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const link = `${LINK}?node-id=0-1`;
  const bad = ['not json at all', '[]', 'null', '{"k": 1}', '{"k": {"file_key": "AbCdEf", "version": 2207, "folder": "AbCdEf/2207", "fetched_at": "x"}}', ''];
  for (const text of bad) {
    const project = tmp(t);
    fs.mkdirSync(path.join(designOf(project), 'cache'), { recursive: true });
    const file = path.join(designOf(project), 'cache', 'index.json');
    fs.writeFileSync(file, text);
    const before = figma.requests.length;
    const result = await run(['fetch', project, link], { env });
    assert.equal(result.code, 0, text);
    assert.deepEqual(result.err, [`warning: ${file} is not a valid fetch index and was ignored: the frames are fetched again`], text);
    assert.equal(figma.requests.length - before, 5, 'it fetched again');
    assert.deepEqual(Object.keys(indexOf(project)), [requestKey(link)], 'the index is valid again');
  }
  // a folder where the index should be: it cannot be read, and it cannot be replaced, which costs a warning and no more
  const unreadable = tmp(t);
  const blocked = path.join(designOf(unreadable), 'cache', 'index.json');
  fs.mkdirSync(blocked, { recursive: true });
  const result = await run(['fetch', unreadable, link], { env });
  assert.equal(result.code, 0, result.text);
  assert.equal(result.err.length, 2);
  assert.equal(result.err[0], `warning: ${blocked} is not a valid fetch index and was ignored: the frames are fetched again`);
  assert.match(result.err[1], /^warning: cannot update .*index\.json \(\w+\): the next fetch of this link calls Figma again$/);
  assert.equal(snapshotOf(lastJson(result).snapshot).frames.length, 3, 'the fetch itself succeeded');
  assert.deepEqual(fs.readdirSync(path.join(designOf(unreadable), 'cache')).sort(), ['AbCdEf', 'index.json'], 'no temporary file is left');
});

test('fetch: --refresh fetches again and updates the entry, and a later fetch reads the new version', async (t) => {
  const versions = {};
  const figma = await fakeFigma(t, { versions });
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const link = `${LINK}?node-id=0-1`;
  await run(['fetch', project, link], { env });
  versions.AbCdEf = '2300';
  const later = new Date('2026-10-13T10:30:00Z');
  const before = figma.requests.length;
  const refreshed = await run(['fetch', project, link, '--refresh'], { env, at: later });
  assert.equal(refreshed.code, 0, refreshed.text);
  assert.equal(figma.requests.length - before, 5);
  assert.deepEqual(indexOf(project)[requestKey(link)], { file_key: 'AbCdEf', version: '2300', folder: 'AbCdEf/2300', fetched_at: '2026-10-13T10:30:00Z' });
  assert.equal(sourceOf(project).version, '2300');
  const cached = await run(['fetch', project, link], { env });
  assert.deepEqual([lastJson(cached).cached, lastJson(cached).version, figma.requests.length - before], [true, '2300', 5]);
});

test('fetch: a saved copy whose design.json is gone, or an entry whose folder leaves the cache, is fetched again', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const link = `${LINK}?node-id=0-1`;
  const first = await run(['fetch', project, link], { env });
  fs.rmSync(path.join(lastJson(first).snapshot, 'design.json'));
  const gone = await run(['fetch', project, link], { env });
  assert.equal(gone.code, 0, gone.text);
  assert.equal(lastJson(gone).cached, undefined);
  assert.equal(figma.requests.length, 10);

  const index = indexOf(project);
  for (const folder of ['../../..', '..', 'AbCdEf/../../..', '/etc', 'AbCdEf', 'a/b/c']) {
    fs.writeFileSync(path.join(designOf(project), 'cache', 'index.json'), JSON.stringify({ [requestKey(link)]: { ...index[requestKey(link)], folder } }));
    const before = figma.requests.length;
    const result = await run(['fetch', project, link], { env });
    assert.equal(result.code, 0, folder);
    assert.deepEqual(result.err, [], folder);
    assert.equal(figma.requests.length - before, 5, `${folder} is not a saved copy`);
  }
});

test('fetch: two requests that share a folder do not serve each other\'s snapshot', async (t) => {
  const figma = await fakeFigma(t);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base };
  const project = tmp(t);
  const page = `${LINK}?node-id=0-1`;
  const one = `${LINK}?node-id=1-20`;
  await run(['fetch', project, page], { env });
  await run(['fetch', project, one], { env });
  assert.deepEqual(Object.keys(indexOf(project)), [requestKey(one)], 'the folder of the page now holds the one frame');
  const before = figma.requests.length;
  const again = await run(['fetch', project, page], { env });
  assert.equal(figma.requests.length - before, 5);
  assert.equal(snapshotOf(lastJson(again).snapshot).frames.length, 3);
});

test('fetch: an image that cannot be downloaded or is not a PNG is skipped; no usable image stops', async (t) => {
  const figma = await fakeFigma(t, {
    override: (r) => (r.path === '/img/checkout.png' ? { status: 404 } : r.path === '/img/dialog.png' ? { status: 200, body: 'not a picture' } : null),
  });
  const result = await run(['fetch', tmp(t), `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(snapshotOf(lastJson(result).snapshot).skipped, [
    { id: '1:20', reason: 'image could not be downloaded' }, { id: '1:31', reason: 'no image' }, { id: '1:32', reason: 'image is not a png' },
  ]);

  const none = await run(['fetch', tmp(t), `${LINK}?node-id=1-31`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(none.code, 1);
  assert.match(none.text, /no frame has an image \(1:31: no image\)/);
});

test('fetch: an unreachable API, an unsupported link and a link that is not Figma fail with one line and no token', async (t) => {
  const down = await run(['fetch', tmp(t), `${LINK}?node-id=0-1`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: 'http://127.0.0.1:1' } });
  assert.equal(down.code, 1);
  assert.match(down.text, /^cannot reach the Figma API at http:\/\/127\.0\.0\.1:1/);

  const board = await run(['fetch', tmp(t), 'https://www.figma.com/board/Xy9/Plan'], { env: { FIGMA_TOKEN: TOKEN } });
  assert.equal(board.code, 1);
  assert.match(board.text, /FigJam board links are not supported/);
  const other = await run(['fetch', tmp(t), 'https://example.com/design/AbCdEf/Shop'], { env: { FIGMA_TOKEN: TOKEN } });
  assert.equal(other.code, 1);
  assert.match(other.text, /not a Figma design, file or prototype link/);
});

test('fetch: a redirect from the API is refused and the token goes nowhere else', async (t) => {
  const elsewhere = await fakeFigma(t);
  const figma = await fakeFigma(t, { override: () => ({ status: 302, headers: { location: `${elsewhere.base}/v1/files/AbCdEf/nodes?ids=1%3A20` } }) });
  const result = await run(['fetch', tmp(t), `${LINK}?node-id=1-20`], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: figma.base } });
  assert.equal(result.code, 1);
  assert.equal(result.err.length, 1);
  assert.match(result.err[0], /^the Figma API at http:\/\/127\.0\.0\.1:\d+ answered with a redirect, which is refused/);
  assert.equal(figma.requests.length, 1);
  assert.deepEqual(elsewhere.requests, [], 'the redirect target received no request');
});

test('fetch: FIGMA_API_BASE must be https, or http on 127.0.0.1 or localhost, before any request', async (t) => {
  const project = tmp(t);
  for (const base of ['http://example.com', 'http://localhost.example.com', 'http://127.0.0.1.example.com', 'ftp://127.0.0.1', 'not a url', 'api.figma.com']) {
    const calls = [];
    const err = [];
    const code = await main(['fetch', project, `${LINK}?node-id=1-20`], {
      out: () => {}, err: (line) => err.push(line), env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: base }, now: () => NOW,
      fetch: async (...args) => { calls.push(args); throw new Error('no request expected'); },
    });
    assert.equal(code, 2, base);
    assert.match(err[0], /^FIGMA_API_BASE must be an https URL, or http:\/\/127\.0\.0\.1 or http:\/\/localhost /, base);
    assert.ok(!err.join('\n').includes(TOKEN));
    assert.deepEqual(calls, [], base);
  }
  for (const base of ['https://api.figma.com', 'https://figma.example.com/', 'http://127.0.0.1:8080', 'http://localhost:8080']) {
    const calls = [];
    const code = await main(['fetch', project, `${LINK}?node-id=1-20`], {
      out: () => {}, err: () => {}, env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: base }, now: () => NOW,
      fetch: async (url) => { calls.push(url); throw new Error('stop'); },
    });
    assert.equal(code, 1, base);
    assert.ok(calls[0].startsWith(base.replace(/\/+$/, '')), base);
  }
});

test('usage errors exit 2 with the usage text', async (t) => {
  const project = tmp(t);
  for (const args of [[], ['nope'], ['parse-url'], ['fetch', project], ['fetch', project, LINK, '--page'], ['fetch', project, LINK, '--wat'],
    ['fetch', project, LINK, '--frames'], ['fetch', project, LINK, '--frames', ''], ['fetch', project, LINK, '--frames', '1:2,,1:3'], ['fetch', project, LINK, '--frames', '1:2,x y'],
    ['fetch', project, `${LINK}?node-id=1-2`, '--page', '0:1'], ['import-png', project], ['import-mcp', project, '--key', 'K'],
    ['import-mcp', project, '--key', 'bad key!', '--metadata', 'm.xml', '--images', 'i.json']]) {
    const result = await run(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.err.join('\n'), /^usage: node figma\.mjs parse-url/m, JSON.stringify(args));
  }
});

// --- import-mcp --------------------------------------------------------------------------------------------------

const EXPECTED_MCP = {
  source: 'mcp',
  file_key: 'McpKey1',
  version: '2026-10-12',
  fetched_at: '2026-10-12T09:00:00Z',
  has: { nodes: true, text: false, font_size: false, links: false },
  frames: [
    {
      id: '1:10', name: 'Welcome', page: 'Mobile', width: 120, height: 240, image: 'frames/1.png', image_scale: 1, links: [],
      nodes: [
        NODE('1:11', 'TEXT', 'Welcome back', '1:10', { x: 10, y: 10, w: 100, h: 20 }),
        NODE('1:12', 'ROUNDED_RECTANGLE', 'Card', '1:10', { x: 10, y: 50, w: 100, h: 60 }),
        NODE('1:13', 'TEXT', 'Save & continue', '1:12', { x: 20, y: 60, w: 80, h: 16 }),
        NODE('1:14', 'INSTANCE', 'Button / Primary', '1:10', { x: 10, y: 200, w: 100, h: 40 }),
      ],
    },
    {
      id: '1:20', name: 'Checkout', page: 'Mobile', width: 120, height: 240, image: 'frames/2.png', image_scale: 1, links: [],
      nodes: [NODE('1:21', 'TEXT', 'Back', '1:20', { x: 10, y: 10, w: 40, h: 16 })],
    },
  ],
  flow_starts: [],
  arrows: [{ between: ['1:10', '1:20'], direction: 'unknown' }],
  skipped: [{ id: '1:30', reason: 'no image' }],
};

/** Writes metadata, images and optional nodes into a fresh folder and runs import-mcp. */
async function importMcp(t, figma, { metadata, images, nodes, key = 'McpKey1', env } = {}) {
  const dir = tmp(t);
  const project = tmp(t);
  fs.writeFileSync(path.join(dir, 'metadata.xml'), metadata);
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify(images ?? {
    '1:10': `${figma.base}/img/welcome.png`, '1:20': `${figma.base}/img/checkout.png`,
  }));
  const args = ['import-mcp', project, '--key', key, '--metadata', path.join(dir, 'metadata.xml'), '--images', path.join(dir, 'images.json')];
  if (nodes !== undefined) {
    fs.writeFileSync(path.join(dir, 'nodes.json'), nodes);
    args.push('--nodes', path.join(dir, 'nodes.json'));
  }
  const result = await run(args, { env: env ?? { FIGMA_API_BASE: figma.base } });
  const folder = path.join(project, '.ux-assessment', 'design', 'cache', key, '2026-10-12');
  return { ...result, project, folder };
}

test('import-mcp: parent-relative and page coordinates give the same snapshot', async (t) => {
  const figma = await fakeFigma(t);
  const relative = await importMcp(t, figma, { metadata: fixture('metadata-relative.xml') });
  const absolute = await importMcp(t, figma, { metadata: fixture('metadata-absolute.xml') });
  assert.equal(relative.code, 0, relative.text);
  assert.equal(absolute.code, 0, absolute.text);
  assert.deepEqual(snapshotOf(relative.folder), EXPECTED_MCP);
  assert.deepEqual(snapshotOf(absolute.folder), EXPECTED_MCP);
  assert.deepEqual(lastJson(relative), { snapshot: relative.folder, source: 'mcp', file_key: 'McpKey1', version: '2026-10-12', frames: 2, nodes: 5, skipped: 1 });
  assert.deepEqual(YAML.parse(fs.readFileSync(path.join(relative.project, '.ux-assessment', 'design', 'source.yaml'), 'utf8')), {
    source: 'mcp', link: null, file_key: 'McpKey1', version: '2026-10-12', frames: [{ id: '1:10', name: 'Welcome' }, { id: '1:20', name: 'Checkout' }],
  });
  assert.equal(pngSize(fs.readFileSync(path.join(relative.folder, 'frames', '2.png'))).width, 120);
});

test('import-mcp: nodes.json adds text, font size and links, and nodes the outline left out', async (t) => {
  const figma = await fakeFigma(t);
  const result = await importMcp(t, figma, { metadata: fixture('metadata-absolute.xml'), nodes: fixture('nodes.json') });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(result.err, []);
  const snapshot = snapshotOf(result.folder);
  assert.deepEqual(snapshot.has, { nodes: true, text: true, font_size: true, links: true });
  assert.deepEqual(snapshot.flow_starts, ['1:10']);
  assert.deepEqual(snapshot.frames.map((f) => f.links), [[], [{ trigger: 'click', action: 'navigate', to: '1:10' }]], 'a frame carries its own reactions');
  assert.deepEqual(snapshot.frames[0].nodes, [
    NODE('1:11', 'TEXT', 'Welcome back', '1:10', { x: 10, y: 10, w: 100, h: 20 }, { text: 'Welcome back', font_size: 20 }),
    NODE('1:12', 'ROUNDED_RECTANGLE', 'Card', '1:10', { x: 10, y: 50, w: 100, h: 60 }),
    NODE('1:13', 'TEXT', 'Save & continue', '1:12', { x: 20, y: 60, w: 80, h: 16 }, { text: 'Save & continue', font_size: 14 }),
    NODE('1:14', 'INSTANCE', 'Button / Primary', '1:10', { x: 10, y: 200, w: 100, h: 40 }, {
      image_fill: true, links: [{ trigger: 'click', action: 'navigate', to: '1:20' }],
    }),
    NODE('1:60', 'TEXT', 'Fine print', '1:10', { x: 10, y: 150, w: 60, h: 14 }, {
      text: 'Only in the script', links: [{ trigger: 'click', action: 'navigate', to: '1:20' }],
    }),
  ]);
  assert.deepEqual(snapshot.frames[1].nodes, [
    NODE('1:21', 'TEXT', 'Back', '1:20', { x: 10, y: 10, w: 40, h: 16 }, { text: 'Back', font_size: 14, links: [{ trigger: 'click', action: 'back', to: null }] }),
  ]);
});

test('import-mcp: an empty flowStartingPoints list falls back to the frames the links start from', async (t) => {
  const figma = await fakeFigma(t);
  const nodes = JSON.parse(fixture('nodes.json'));
  nodes.flowStartingPoints = [];
  nodes.frames[1].reactions = [];
  const result = await importMcp(t, figma, { metadata: fixture('metadata-absolute.xml'), nodes: JSON.stringify(nodes) });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(snapshotOf(result.folder).flow_starts, ['1:10']);
});

test('import-mcp: starting points that all lie outside the kept frames fall back to the frames the links start from', async (t) => {
  const figma = await fakeFigma(t);
  const nodes = JSON.parse(fixture('nodes.json'));
  nodes.flowStartingPoints = [{ nodeId: '9:99', name: 'On another page' }];
  nodes.frames[1].reactions = [];
  const result = await importMcp(t, figma, { metadata: fixture('metadata-absolute.xml'), nodes: JSON.stringify(nodes) });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(snapshotOf(result.folder).flow_starts, ['1:10']);
});

test('import-mcp: a nodes.json that covers one of two frames leaves text, font size and links marked absent and warns', async (t) => {
  const figma = await fakeFigma(t);
  const nodes = JSON.parse(fixture('nodes.json'));
  nodes.frames.pop();
  const result = await importMcp(t, figma, { metadata: fixture('metadata-absolute.xml'), nodes: JSON.stringify(nodes) });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(result.err, ['warning: nodes.json has no entry for 1 of 2 frames, so text, font size and links are marked as not read']);
  const snapshot = snapshotOf(result.folder);
  assert.deepEqual(snapshot.has, { nodes: true, text: false, font_size: false, links: false });
  assert.equal(snapshot.frames[0].nodes[0].text, 'Welcome back', 'what was given is still merged');
  assert.equal(snapshot.frames[1].nodes[0].text, null);
});

test('import-mcp: a nodes.json of the wrong shape warns and the run continues at the frames level', async (t) => {
  const figma = await fakeFigma(t);
  for (const nodes of ['{"frames": "nope"}', 'not json at all', '[]', '{"frames": [{"id": "1:10"}]}']) {
    const result = await importMcp(t, figma, { metadata: fixture('metadata-relative.xml'), nodes });
    assert.equal(result.code, 0, result.text);
    assert.equal(result.err.length, 1, nodes);
    assert.match(result.err[0], /^warning: .*nodes\.json is not the shape driver\/figma-read\.js returns; continuing without it/);
    assert.deepEqual(snapshotOf(result.folder), EXPECTED_MCP);
  }
});

test('import-mcp: an image URL that is not https is refused and its frame skipped', async (t) => {
  const figma = await fakeFigma(t);
  const refused = await importMcp(t, figma, {
    metadata: fixture('metadata-relative.xml'),
    images: { '1:10': 'http://example.com/welcome.png', '1:20': `${figma.base}/img/checkout.png` },
  });
  assert.equal(refused.code, 0, refused.text);
  const snapshot = snapshotOf(refused.folder);
  assert.deepEqual(snapshot.frames.map((f) => f.id), ['1:20']);
  assert.deepEqual(snapshot.skipped, [{ id: '1:10', reason: 'image url is not https' }, { id: '1:30', reason: 'no image' }]);

  const before = figma.requests.length;
  const loopback = await importMcp(t, figma, { metadata: fixture('metadata-relative.xml'), env: {}, images: { '1:10': `${figma.base}/img/welcome.png` } });
  assert.equal(loopback.code, 1);
  assert.match(loopback.text, /no frame has an image \(1:10: image url is not https; 1:20: no image; 1:30: no image\)/);
  assert.equal(figma.requests.length, before, 'a refused URL is never requested');
});

test('import-mcp: XML it cannot read stops and says the MCP source has never met the real server', async (t) => {
  const figma = await fakeFigma(t);
  for (const metadata of ['this is not xml', '<root><note id="1" name="x"/></root>', '']) {
    const result = await importMcp(t, figma, { metadata });
    assert.equal(result.code, 1);
    assert.match(result.text, /never been run against the real Figma server/);
    assert.match(result.text, /design mode report issue form/);
  }
});

test('import-mcp: a line between two frames is an arrow, in sections too; the rest are not', async (t) => {
  const figma = await fakeFigma(t);
  const frame = (id, x, y) => `<frame id="${id}" name="${id}" x="${x}" y="${y}" width="100" height="100" />`;
  const metadata = `<canvas id="0:1" name="Flow"><section id="9:0" name="Group" x="0" y="0" width="500" height="500">
    ${frame('A:1', 0, 0)}${frame('B:1', 200, 0)}${frame('C:1', 0, 300)}
    <line id="L:1" name="a to b" x="95" y="50" width="110" height="0" />
    <line id="L:2" name="same again" x="96" y="55" width="108" height="0" />
    <line id="L:3" name="too short" x="95" y="150" width="60" height="0" />
    <vector id="L:4" name="b to c" x="100" y="100" width="100" height="200" />
    <line id="L:5" name="a to a" x="10" y="20" width="80" height="0" />
  </section></canvas>`;
  const images = Object.fromEntries(['A:1', 'B:1', 'C:1'].map((id) => [id, `${figma.base}/img/square.png`]));
  const result = await importMcp(t, figma, { metadata, images });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(snapshotOf(result.folder).arrows, [
    { between: ['A:1', 'B:1'], direction: 'unknown' }, { between: ['B:1', 'C:1'], direction: 'unknown' },
  ]);

  const inside = `<canvas id="0:1" name="Flow">${frame('A:1', 0, 0).replace(' />', '><line id="L:9" name="inside" x="95" y="50" width="110" height="0" /></frame>')}${frame('B:1', 200, 0)}</canvas>`;
  const nested = await importMcp(t, figma, { metadata: inside, images: { 'A:1': images['A:1'], 'B:1': images['B:1'] } });
  assert.deepEqual(snapshotOf(nested.folder).arrows, []);
  assert.equal(snapshotOf(nested.folder).frames[0].nodes[0].type, 'LINE');
});

test('scanOutline: tolerates declarations, comments, entities, quotes and tags left open', () => {
  const roots = scanOutline("<?xml version='1.0'?><!-- c --><a id='1' name=\"x &lt;y&gt; &#65; &amp;\"><b id=\"2\"/><c id=\"3\"></a><d id='4'>text</d>");
  assert.deepEqual(roots, [
    { tag: 'a', attrs: { id: '1', name: 'x <y> A &' }, children: [{ tag: 'b', attrs: { id: '2' }, children: [] }, { tag: 'c', attrs: { id: '3' }, children: [] }] },
    { tag: 'd', attrs: { id: '4' }, children: [] },
  ]);
});

// --- import-png --------------------------------------------------------------------------------------------------

test('import-png: one frame per PNG file in name order, with no nodes', async (t) => {
  const folder = tmp(t);
  fs.writeFileSync(path.join(folder, '10.png'), pngBytes(40, 50, [1, 2, 3]));
  fs.writeFileSync(path.join(folder, '2.png'), pngBytes(30, 20, [1, 2, 3]));
  fs.writeFileSync(path.join(folder, 'Home.PNG'), pngBytes(60, 80, [1, 2, 3]));
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not an image');
  const project = tmp(t);
  const result = await run(['import-png', project, folder]);
  assert.equal(result.code, 0, result.text);
  const info = lastJson(result);
  assert.match(info.snapshot, /cache[\\/]png-[0-9a-f]{12}[\\/]2026-10-12$/);
  const { snapshot: snapshotDir, ...counts } = info;
  assert.deepEqual(counts, { source: 'png', file_key: info.file_key, version: '2026-10-12', frames: 3, nodes: 0, skipped: 0 });
  const frame = (id, name, width, height, n) => ({ id, name, page: null, width, height, image: `frames/${n}.png`, image_scale: 1, links: [], nodes: [] });
  assert.deepEqual(snapshotOf(snapshotDir), {
    source: 'png', file_key: info.file_key, version: '2026-10-12', fetched_at: '2026-10-12T09:00:00Z',
    has: { nodes: false, text: false, font_size: false, links: false },
    frames: [frame('png-1', '2', 30, 20, 1), frame('png-2', '10', 40, 50, 2), frame('png-3', 'Home', 60, 80, 3)],
    flow_starts: [], arrows: [], skipped: [],
  });
  assert.deepEqual(pngSize(fs.readFileSync(path.join(snapshotDir, 'frames', '3.png'))), { width: 60, height: 80 });
  const source = YAML.parse(fs.readFileSync(path.join(project, '.ux-assessment', 'design', 'source.yaml'), 'utf8'));
  assert.deepEqual([source.source, source.folder, source.file_key], ['png', path.resolve(folder), info.file_key]);

  assert.equal(lastJson(await run(['import-png', project, folder])).file_key, info.file_key, 'the same folder gives the same key');
  const other = tmp(t);
  fs.writeFileSync(path.join(other, 'a.png'), pngBytes(5, 5, [0, 0, 0]));
  assert.notEqual(lastJson(await run(['import-png', project, other])).file_key, info.file_key);
});

test('import-png: an empty folder, a missing folder and a file that is not a PNG fail', async (t) => {
  const project = tmp(t);
  const empty = await run(['import-png', project, tmp(t)]);
  assert.equal(empty.code, 1);
  assert.match(empty.text, /no PNG files in/);
  assert.match((await run(['import-png', project, path.join(project, 'missing')])).text, /cannot read the folder/);
  const fake = tmp(t);
  fs.writeFileSync(path.join(fake, 'shot.png'), 'plain text');
  const result = await run(['import-png', project, fake]);
  assert.equal(result.code, 1);
  assert.equal(result.text, 'shot.png is not a PNG file');
});

// --- figma-read.js -----------------------------------------------------------------------------------------------

// The script runs inside Figma against a real document, so the test is an allow list: anything it does not name is refused.
const FIGMA_MEMBERS = new Set(['mixed', 'getNodeByIdAsync']);
const CALLED_METHODS = new Set(['some', 'push', 'stringify', 'isArray', 'getNodeByIdAsync']);
const KEYWORDS_BEFORE_PAREN = new Set(['for', 'if', 'while', 'switch', 'catch', 'return', 'await', 'typeof', 'of', 'in']);
const BANNED_WORDS = /\b(?:fetch|XMLHttpRequest|WebSocket|eval|Function|require|import|new|delete|with|globalThis|window|self|process)\b|`/;
const MEMBER_END = /(?:\.\s*[\w$]+|\])\s*$/;
const ASSIGNMENT = /(?<![=!<>])(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])/g;

/** The code with comments removed and string contents emptied, so words inside them are not read as code. */
const codeOf = (source) => source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => (m[0] === '/' ? ' ' : '""'));

/** Everything in a script's text that it must not do if it is to be read-only. */
function readOnlyViolations(source) {
  const code = codeOf(source);
  const found = [];
  for (const word of code.match(new RegExp(BANNED_WORDS, 'g')) ?? []) found.push(`uses ${word}`);
  if (/\bfigma\b(?!\s*\.)/.test(code)) found.push('uses figma without a member');
  for (const [, member] of code.matchAll(/\bfigma\s*\.\s*([\w$]+)/g)) if (!FIGMA_MEMBERS.has(member)) found.push(`uses figma.${member}`);
  for (const [, method] of code.matchAll(/\.\s*([\w$]+)\s*\(/g)) if (!CALLED_METHODS.has(method)) found.push(`calls .${method}(`);
  const declared = new Set([...code.matchAll(/\b(?:const|let|function)\s+([\w$]+)/g)].map((m) => m[1]));
  for (const [, name] of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!declared.has(name) && !KEYWORDS_BEFORE_PAREN.has(name)) found.push(`calls ${name}(`);
  }
  if (/[\w$)\]]\s*\[/.test(code)) found.push('reads a member by a bracket expression');
  if (/\]\s*\(/.test(code)) found.push('calls a bracket expression');
  if (/(?:\.\s*[\w$]+|\])\s*(?:\+\+|--)|(?:\+\+|--)\s*[\w$]+\s*[.[]/.test(code)) found.push('increments a member');
  for (const match of code.matchAll(ASSIGNMENT)) if (MEMBER_END.test(code.slice(0, match.index))) found.push('assigns to a member');
  return found;
}

test('figma-read.js: does nothing but read the nodes it is given', () => {
  const code = fs.readFileSync(READ_SCRIPT, 'utf8');
  assert.deepEqual(readOnlyViolations(code), []);
  assert.equal(code.match(/^const FRAME_IDS = .*;$/gm)?.length, 1, 'one FRAME_IDS line for the orchestrator to replace');
});

test('figma-read.js: the read-only check refuses a write, a bracket write, a figma call, a request and a removal', () => {
  const code = fs.readFileSync(READ_SCRIPT, 'utf8');
  const before = 'return JSON.stringify({ flowStartingPoints: startingPoints, frames });';
  assert.ok(code.includes(before));
  const mutants = {
    "node.name = 'x'": 'assigns to a member',
    "node['name'] = 'x'": 'reads a member by a bracket expression',
    'figma.createRectangle()': 'uses figma.createRectangle',
    "fetch('https://example.com')": 'uses fetch',
    'node.remove()': 'calls .remove(',
  };
  for (const [statement, reason] of Object.entries(mutants)) {
    const found = readOnlyViolations(code.replace(before, `${statement};\n${before}`));
    assert.ok(found.includes(reason), `${statement} is refused as "${reason}" (found ${JSON.stringify(found)})`);
  }
  for (const statement of ['node.fills += 1', 'node.x++', 'Object.assign(node, {})', 'const f = figma', 'delete node.name', 'node.parent.children = []']) {
    assert.notDeepEqual(readOnlyViolations(code.replace(before, `${statement};\n${before}`)), [], statement);
  }
});

test('figma-read.js: on a frozen stand-in document it returns the shape import-mcp reads', async (t) => {
  const mixed = Symbol('mixed');
  const box = (x, y, width, height) => ({ x, y, width, height });
  const freeze = (value) => { Object.freeze(value); Object.values(value).forEach((inner) => inner && typeof inner === 'object' && !Object.isFrozen(inner) && freeze(inner)); return value; };
  const attach = (node, parent) => { node.parent = parent; (node.children ?? []).forEach((child) => attach(child, node)); return node; };
  const page = { id: '0:1', type: 'PAGE', name: 'Mobile', flowStartingPoints: [{ nodeId: '1:10', name: 'Start' }] };
  const welcome = attach({
    id: '1:10', type: 'FRAME', name: 'Welcome', visible: true, absoluteBoundingBox: box(100, 200, 120, 240), fills: [], reactions: [],
    children: [
      { id: '1:11', type: 'TEXT', name: 'Welcome back', visible: true, absoluteBoundingBox: box(110, 210, 100, 20), characters: 'Welcome back', fontSize: 20, fills: [{ type: 'SOLID' }], reactions: [] },
      {
        id: '1:12', type: 'RECTANGLE', name: 'Card', visible: true, absoluteBoundingBox: box(110, 250, 100, 60), fills: [{ type: 'IMAGE' }], reactions: [],
        children: [{ id: '1:13', type: 'TEXT', name: 'Save & continue', visible: true, absoluteBoundingBox: box(120, 260, 80, 16), characters: 'Save & continue', fontSize: mixed, fills: mixed, reactions: [] }],
      },
      {
        id: '1:14', type: 'INSTANCE', name: 'Button / Primary', visible: true, absoluteBoundingBox: box(110, 400, 100, 40), fills: [], children: [],
        reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '1:20', navigation: 'NAVIGATE' }] }],
      },
      { id: '1:15', type: 'VECTOR', name: 'Ghost', visible: false, absoluteBoundingBox: box(100, 200, 10, 10), fills: [], reactions: [] },
    ],
  }, page);
  const checkout = attach({
    id: '1:20', type: 'FRAME', name: 'Checkout', visible: true, absoluteBoundingBox: box(300, 200, 120, 240), fills: [], reactions: [],
    children: [{ id: '1:21', type: 'TEXT', name: 'Back', visible: true, absoluteBoundingBox: box(310, 210, 40, 16), characters: 'Back', fontSize: 14, fills: [], reactions: [{ trigger: { type: 'ON_CLICK' }, action: { type: 'BACK' } }] }],
  }, page);
  page.children = [welcome, checkout];
  const byId = new Map();
  const index = (node) => { byId.set(node.id, node); (node.children ?? []).forEach(index); };
  index(page);
  freeze(page);

  const source = fs.readFileSync(READ_SCRIPT, 'utf8').replace(/^const FRAME_IDS = .*;$/m, 'const FRAME_IDS = ["1:10", "1:20", "9:9"];');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const body = new AsyncFunction('figma', `'use strict';\n${source}`);
  const returned = await body({ mixed, getNodeByIdAsync: async (id) => byId.get(id) ?? null });
  assert.equal(typeof returned, 'string');
  const parsed = JSON.parse(returned);
  assert.deepEqual(parsed.flowStartingPoints, [{ nodeId: '1:10', name: 'Start' }]);
  assert.deepEqual(parsed.frames.map((f) => [f.id, f.name, f.nodes.length]), [['1:10', 'Welcome', 5], ['1:20', 'Checkout', 1]]);
  assert.deepEqual(parsed.frames[0].nodes[2], {
    id: '1:13', type: 'TEXT', name: 'Save & continue', parentId: '1:12', visible: true, absoluteBoundingBox: box(120, 260, 80, 16),
    characters: 'Save & continue', fontSize: null, imageFill: false, reactions: [],
  });

  const figma = await fakeFigma(t);
  const result = await importMcp(t, figma, { metadata: fixture('metadata-absolute.xml'), nodes: returned });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(result.err, []);
  const snapshot = snapshotOf(result.folder);
  assert.deepEqual(snapshot.has, { nodes: true, text: true, font_size: true, links: true });
  assert.deepEqual(snapshot.frames[0].nodes.map((n) => [n.id, n.text, n.font_size, n.image_fill, n.links.length]), [
    ['1:11', 'Welcome back', 20, false, 0], ['1:12', null, null, true, 0], ['1:13', 'Save & continue', null, false, 0], ['1:14', null, null, false, 1],
  ]);
  assert.deepEqual(snapshot.frames[1].nodes[0].links, [{ trigger: 'click', action: 'back', to: null }]);
});
