#!/usr/bin/env node
// Design snapshot sources (design mode): a Figma link, Figma MCP output or a folder of PNG files become one snapshot on disk.
//   node figma.mjs parse-url <text> | fetch <project> <url> [--refresh] [--page <id>] [--frames <id,id,...>] | import-png <project> <folder>
//   node figma.mjs import-mcp <project> --key <file key> --metadata <xml file> --images <json file> [--nodes <json file>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { warnOutsideProfile } from './paths.mjs';

const USAGE = [
  'usage: node figma.mjs parse-url <text>',
  '       node figma.mjs fetch <project> <url> [--refresh] [--page <id>] [--frames <id,id,...>]',
  '       node figma.mjs import-mcp <project> --key <file key> --metadata <xml file> --images <json file> [--nodes <json file>]',
  '       node figma.mjs import-png <project> <folder>',
].join('\n');
const DEFAULT_API_BASE = 'https://api.figma.com';
const MAX_RETRY_AFTER = 60;
const IDS_PER_REQUEST = 50;
// A design run looks at 12 frames at most, and every frame is one image download that counts against Figma's image render.
const FRAME_LIST_LIMIT = 24;
const ARROW_REACH = 40;
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);
const LINE_TYPES = new Set(['LINE', 'VECTOR', 'ARROW']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEY_RE = /^[A-Za-z0-9_-]+$/;
const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);
const UNSUPPORTED = { board: 'FigJam board links', slides: 'Figma Slides links', community: 'Figma Community links' };

/** A failure whose whole message, not only its first line, is the advice for the user. */
class Stop extends Error {}
/** A command line the usage text explains. */
class UsageError extends Error {}

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const round2 = (value) => Math.round(value * 100) / 100;
const round4 = (value) => Math.round(value * 10000) / 10000;
const finite = (value) => (value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

// --- links -------------------------------------------------------------------------------------------------------

const count = (text, char) => text.split(char).length - 1;

/** A link found in prose loses the full stop, comma or bracket that closes the sentence, but not a bracket the link itself opens. */
function trimLink(raw) {
  let link = raw;
  for (;;) {
    const trimmed = link.replace(/[.,;:!?]+$/, '');
    if (trimmed.endsWith(')') && count(trimmed, ')') > count(trimmed, '(')) link = trimmed.slice(0, -1);
    else if (trimmed.endsWith(']') && count(trimmed, ']') > count(trimmed, '[')) link = trimmed.slice(0, -1);
    else if (trimmed !== link) link = trimmed;
    else return link;
  }
}

/** The first Figma design, file or prototype link in free text, as {kind, file_key, node_id, start_node_id}. */
export function parseFigmaUrl(text) {
  let unsupported = null;
  for (const raw of String(text).match(/https?:\/\/[^\s<>"'`]+/gi) ?? []) {
    let url;
    try { url = new URL(trimLink(raw)); } catch { continue; }
    if (!FIGMA_HOSTS.has(url.hostname.toLowerCase())) continue;
    const parts = url.pathname.split('/').filter(Boolean);
    if (['design', 'file', 'proto'].includes(parts[0])) {
      const key = parts[2] === 'branch' && parts[3] && parts[0] !== 'proto' ? parts[3] : parts[1];
      if (!key || !KEY_RE.test(key)) continue;
      const id = (value) => {
        const converted = value == null ? '' : value.replace(/-/g, ':');
        return /^[\w:;.]+$/.test(converted) ? converted : null;
      };
      return {
        kind: parts[0] === 'proto' ? 'proto' : 'design', file_key: key,
        node_id: id(url.searchParams.get('node-id')), start_node_id: id(url.searchParams.get('starting-point-node-id')),
      };
    }
    if (!unsupported && Object.hasOwn(UNSUPPORTED, parts[0])) {
      unsupported = {
        kind: 'unsupported',
        reason: `${UNSUPPORTED[parts[0]]} are not supported. Give a link to a Figma design, file or prototype (/design/, /file/ or /proto/), or a folder of PNG files.`,
      };
    }
  }
  return unsupported ?? { kind: 'none' };
}

// --- PNG ---------------------------------------------------------------------------------------------------------

/** Width and height from the PNG header, or null when the bytes are not a PNG. */
export function pngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// --- prototype links ---------------------------------------------------------------------------------------------

const TRIGGERS = { ON_CLICK: 'click', ON_PRESS: 'click', ON_HOVER: 'hover', MOUSE_ENTER: 'hover', MOUSE_LEAVE: 'hover', ON_DRAG: 'drag', AFTER_TIMEOUT: 'timeout' };
const NAVIGATIONS = { OVERLAY: 'overlay', SWAP: 'swap', CHANGE_TO: 'swap', SCROLL_TO: 'scroll' };

function actionOf(action, frameIds) {
  const other = { action: 'other', to: null };
  if (!isObject(action)) return other;
  if (action.type === 'BACK') return { action: 'back', to: null };
  if (action.type === 'URL') return { action: 'url', to: null };
  if (action.type !== 'NODE') return other;
  if (action.navigation === 'NAVIGATE') return frameIds.has(action.destinationId) ? { action: 'navigate', to: action.destinationId } : other;
  return NAVIGATIONS[action.navigation] ? { action: NAVIGATIONS[action.navigation], to: null } : other;
}

/** REST `interactions` or Plugin API `reactions` (`actions`, or the legacy single `action`) → snapshot links. */
export function linksOf(interactions, frameIds) {
  const links = [];
  for (const item of Array.isArray(interactions) ? interactions : []) {
    if (!isObject(item)) continue;
    const trigger = TRIGGERS[item.trigger?.type] ?? 'other';
    const actions = Array.isArray(item.actions) && item.actions.length ? item.actions : item.action ? [item.action] : [];
    for (const action of actions) links.push({ trigger, ...actionOf(action, frameIds) });
  }
  return links;
}

// --- raw frames → snapshot ---------------------------------------------------------------------------------------
// A raw frame: {id, name, page, pageId, box (page coordinates), png, interactions, nodes}. A raw node: {id, parent, type,
// name, visible, box (page coordinates) or null, text, fontSize, imageFill, interactions}. Every source builds these.

function normalizeNodes(frame, frameIds) {
  const byId = new Map(frame.nodes.map((node) => [node.id, node]));
  const anchors = new Map();
  /** The nearest kept ancestor of a node id (the frame at the top), or null when a hidden node is above it. */
  const anchor = (id) => {
    if (id === frame.id || !byId.has(id)) return frame.id;
    if (anchors.has(id)) return anchors.get(id);
    anchors.set(id, null); // a cycle ends here as hidden
    const node = byId.get(id);
    const above = node.visible === false ? null : anchor(node.parent);
    const result = above === null ? null : node.box ? node.id : above;
    anchors.set(id, result);
    return result;
  };
  const nodes = [];
  for (const node of frame.nodes) {
    const parent = anchor(node.parent);
    if (node.visible === false || !node.box || parent === null) continue;
    nodes.push({
      id: node.id, type: node.type, name: node.name, parent,
      box: { x: round2(node.box.x - frame.box.x), y: round2(node.box.y - frame.box.y), w: round2(node.box.w), h: round2(node.box.h) },
      text: node.text, font_size: node.fontSize, image_fill: node.imageFill, links: linksOf(node.interactions, frameIds),
    });
  }
  return nodes;
}

const distanceToBox = (p, b) => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));

/** Candidate end pairs of a box: the line is not known to run along either diagonal, so try both, and the two mid-edge pairs. */
function endPairs(b) {
  return [
    [{ x: b.x, y: b.y + b.h / 2 }, { x: b.x + b.w, y: b.y + b.h / 2 }],
    [{ x: b.x + b.w / 2, y: b.y }, { x: b.x + b.w / 2, y: b.y + b.h }],
    [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }],
    [{ x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }],
  ];
}

/** Hand-drawn lines with one end within 40 px of one frame and the other within 40 px of another. The direction is never known. */
function arrowsOf(frames, lines) {
  const arrows = [];
  const seen = new Set();
  for (const line of lines) {
    const near = (point) => frames
      .filter((frame) => (frame.pageId ?? null) === (line.pageId ?? null))
      .map((frame) => ({ id: frame.id, d: distanceToBox(point, frame.box) }))
      .filter((hit) => hit.d <= ARROW_REACH)
      .sort((a, b) => a.d - b.d)[0];
    let best = null;
    for (const [from, to] of endPairs(line.box)) {
      const a = near(from);
      const b = near(to);
      if (a && b && a.id !== b.id && (!best || a.d + b.d < best.d)) best = { d: a.d + b.d, ids: [a.id, b.id] };
    }
    if (!best) continue;
    const between = best.ids.sort((x, y) => frames.findIndex((f) => f.id === x) - frames.findIndex((f) => f.id === y));
    if (!seen.has(between.join('|'))) {
      seen.add(between.join('|'));
      arrows.push({ between, direction: 'unknown' });
    }
  }
  return arrows;
}

/** For each frame its own links and its normalized nodes, with link targets resolved among these frames only. */
function linkedFrames(frames) {
  const ids = new Set(frames.map((frame) => frame.id));
  return frames.map((frame) => ({ links: linksOf(frame.interactions, ids), nodes: normalizeNodes(frame, ids) }));
}

/** The flow starts: the given starting points that are among the frames, else the frames that have a link and that no other frame's link reaches. */
function startsOf(frames, linked, given) {
  const ids = new Set(frames.map((frame) => frame.id));
  const starts = [...new Set(given ?? [])].filter((id) => ids.has(id));
  if (starts.length) return starts;
  const pointedAt = new Set();
  const linking = new Set();
  frames.forEach((frame, i) => {
    for (const link of [...linked[i].nodes.flatMap((node) => node.links), ...linked[i].links]) {
      linking.add(frame.id);
      if (link.to && link.to !== frame.id) pointedAt.add(link.to);
    }
  });
  return frames.map((frame) => frame.id).filter((id) => linking.has(id) && !pointedAt.has(id));
}

/** The snapshot of spec section 4 and the PNG bytes of its frames, in order. */
function assemble({ source, fileKey, version, fetchedAt, has, frames, flowStarts, lines = [], skipped }) {
  const linked = linkedFrames(frames);
  const outFrames = frames.map((frame, i) => ({
    id: frame.id, name: frame.name, page: frame.page ?? null, width: round2(frame.box.w), height: round2(frame.box.h),
    image: `frames/${i + 1}.png`, image_scale: round4(pngSize(frame.png).width / frame.box.w), ...linked[i],
  }));
  const snapshot = {
    source, file_key: fileKey, version, fetched_at: fetchedAt, has, frames: outFrames, flow_starts: startsOf(frames, linked, flowStarts),
    arrows: arrowsOf(frames, lines.filter((line) => frames.length > 1 && line.box)), skipped,
  };
  return { snapshot, pngs: frames.map((frame) => frame.png) };
}

// --- writing -----------------------------------------------------------------------------------------------------

const segment = (value) => {
  const clean = String(value).replace(/[^\w.-]/g, '_');
  return clean === '.' || clean === '..' ? '_' : clean;
};

// The cache folder holds one folder per saved copy and index.json, which maps a request to its folder. source.yaml is only the
// record of the current source, so fetching another file does not make a copy forget the way back to it.
const INDEX_FILE = 'index.json';
const FOLDER_RE = /^[\w.-]+\/[\w.-]+$/;

/** The key of a `fetch` request in index.json: a JSON array, so no choice of link can make two requests collide. */
const requestKey = (link, page, frames) => JSON.stringify(['rest', link, page ?? null, frames ? [...frames].sort() : null]);

/** The folder an index entry names, or null when it would not lie directly inside the cache folder. */
function savedFolder(cache, folder) {
  const parts = folder.split('/');
  return FOLDER_RE.test(folder) && !parts.includes('.') && !parts.includes('..') ? path.join(cache, ...parts) : null;
}

/** The index, or an empty one when the file is absent, unreadable or not the shape written below (then with a warning). */
function readIndex(ctx, cache) {
  const file = path.join(cache, INDEX_FILE);
  const ignored = () => {
    ctx.err(`warning: ${file} is not a valid fetch index and was ignored: the frames are fetched again`);
    return {};
  };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return error.code === 'ENOENT' ? {} : ignored(); }
  let doc = null;
  try { doc = JSON.parse(text); } catch { /* not JSON: ignored below */ }
  const entry = (value) => isObject(value) && ['file_key', 'version', 'folder', 'fetched_at'].every((field) => typeof value[field] === 'string');
  return isObject(doc) && Object.values(doc).every(entry) ? doc : ignored();
}

/** Saves the request under its key and forgets every other request whose folder this one has just replaced. The index is written by rename. */
function recordRequest(ctx, cache, { key, index }, entry) {
  for (const [other, { folder }] of Object.entries(index)) if (folder === entry.folder) delete index[other];
  index[key] = entry;
  const file = path.join(cache, INDEX_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    ctx.err(`warning: cannot update ${file} (${error.code ?? error.message}): the next fetch of this link calls Figma again`);
  }
}

function writeSource(design, sourceDoc, snapshot) {
  const frames = snapshot.frames.map((frame) => ({ id: frame.id, name: frame.name }));
  fs.writeFileSync(path.join(design, 'source.yaml'), YAML.stringify({ ...sourceDoc, file_key: snapshot.file_key, version: snapshot.version, frames }), { mode: 0o600 });
}

function writeSnapshot(ctx, project, { snapshot, pngs }, sourceDoc, request) {
  warnOutsideProfile({ root: project, warn: ctx.err });
  const design = path.join(project, '.ux-assessment', 'design');
  const cache = path.join(design, 'cache');
  const folder = `${segment(snapshot.file_key)}/${segment(snapshot.version)}${request?.suffix ?? ''}`;
  const dir = path.join(cache, ...folder.split('/'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true, mode: 0o700 });
  pngs.forEach((png, i) => fs.writeFileSync(path.join(dir, 'frames', `${i + 1}.png`), png, { mode: 0o600 }));
  // design.json goes last: a folder that has it is complete
  fs.writeFileSync(path.join(dir, 'design.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  writeSource(design, sourceDoc, snapshot);
  if (request) recordRequest(ctx, cache, request, { file_key: snapshot.file_key, version: snapshot.version, folder, fetched_at: snapshot.fetched_at });
  return dir;
}

function report(ctx, dir, snapshot, extra = {}) {
  ctx.out(JSON.stringify({
    snapshot: dir, source: snapshot.source, file_key: snapshot.file_key, version: snapshot.version,
    frames: snapshot.frames.length, nodes: snapshot.frames.reduce((sum, frame) => sum + frame.nodes.length, 0), skipped: snapshot.skipped.length, ...extra,
  }));
}

function finish(ctx, project, assembled, sourceDoc, request = null) {
  if (!assembled.snapshot.frames.length) {
    const why = assembled.snapshot.skipped.map((s) => `${s.id}: ${s.reason}`).join('; ');
    throw new Stop(`no frame has an image${why ? ` (${why})` : ''}`);
  }
  const dir = writeSnapshot(ctx, project, assembled, sourceDoc, request);
  report(ctx, dir, assembled.snapshot);
  return 0;
}

// --- images ------------------------------------------------------------------------------------------------------

function imageUrlAllowed(raw, env) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(env.FIGMA_API_BASE));
}

/** The PNG bytes behind an image URL, or the reason the frame is skipped. The Figma token is never sent here. */
async function downloadImage(ctx, url) {
  if (typeof url !== 'string' || !url) return { reason: 'no image' };
  if (!imageUrlAllowed(url, ctx.env)) return { reason: 'image url is not https' };
  let png;
  try {
    const res = await ctx.fetch(url);
    if (!res.ok) return { reason: 'image could not be downloaded' };
    png = Buffer.from(await res.arrayBuffer());
  } catch { return { reason: 'image could not be downloaded' }; }
  return pngSize(png) ? { png } : { reason: 'image is not a png' };
}

/** Fills `png` on the raw frames that have one; the others go to `skipped`. */
async function attachImages(ctx, rawFrames, urls) {
  const kept = [];
  const skipped = [];
  for (const frame of rawFrames) {
    const got = await downloadImage(ctx, urls.get(frame.id));
    if (got.png) kept.push({ ...frame, png: got.png });
    else skipped.push({ id: frame.id, reason: got.reason });
  }
  return { kept, skipped };
}

// --- REST --------------------------------------------------------------------------------------------------------

const TOKEN_HELP = [
  'Make a Figma personal access token with the scope file_content:read (Figma, Settings, Security, Personal access tokens).',
  'The token\'s user must be able to open the file. Then set the environment variable FIGMA_TOKEN,',
  'or put figma_token: <token> in .ux-assessment/secrets.local.yaml. You can also export the frames to a folder of PNG files',
  'and run: node figma.mjs import-png <project> <folder>',
];
const EXPORT_HELP = [
  'Export the frames by hand instead: in Figma select the frames, add an export setting (PNG, 1x) and export them into one folder,',
  'then run: node figma.mjs import-png <project> <folder>',
];

function tokenFor(project, env) {
  if (env.FIGMA_TOKEN?.trim()) return env.FIGMA_TOKEN.trim();
  try {
    const doc = YAML.parse(fs.readFileSync(path.join(project, '.ux-assessment', 'secrets.local.yaml'), 'utf8'));
    if (typeof doc?.figma_token === 'string' && doc.figma_token.trim()) return doc.figma_token.trim();
  } catch { /* no file, or not YAML: no token */ }
  return null;
}

/** The token goes to this host, so it is Figma's, or a machine of the user's own for tests. */
function checkApiBase(base) {
  let url = null;
  try { url = new URL(base); } catch { /* refused below */ }
  const local = url?.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url?.protocol !== 'https:' && !local) throw new UsageError('FIGMA_API_BASE must be an https URL, or http://127.0.0.1 or http://localhost (the Figma token is sent there)');
}

async function api(ctx, pathAndQuery) {
  for (;;) {
    let res;
    try {
      // a redirect would carry the token header to whatever host it names
      res = await ctx.fetch(`${ctx.base}${pathAndQuery}`, { headers: { 'X-Figma-Token': ctx.token }, redirect: 'error' });
    } catch (error) {
      if (error.cause?.message === 'unexpected redirect') throw new Error(`the Figma API at ${ctx.base} answered with a redirect, which is refused so that the token stays with that host`);
      throw new Error(`cannot reach the Figma API at ${ctx.base}: ${error.cause?.code ?? error.message}`);
    }
    if (res.status === 429) {
      const header = res.headers.get('retry-after');
      const wait = header === null || header.trim() === '' ? Infinity : Number(header);
      if (ctx.waited || !Number.isFinite(wait) || wait < 0 || wait > MAX_RETRY_AFTER) {
        throw new Stop(['Figma is rate limiting this token and the wait is too long (or it already waited once).', ...EXPORT_HELP].join('\n'));
      }
      ctx.waited = true;
      await ctx.sleep(wait * 1000);
      continue;
    }
    if (res.status === 403 || res.status === 404) throw new Stop([`Figma answered ${res.status} for ${pathAndQuery.split('?')[0]}.`, ...TOKEN_HELP].join('\n'));
    if (!res.ok) throw new Error(`the Figma API answered ${res.status} for ${pathAndQuery.split('?')[0]}`);
    return res.json();
  }
}

const boxOf = (b) => (isObject(b) && [b.x, b.y, b.width, b.height].every(Number.isFinite) ? { x: b.x, y: b.y, w: b.width, h: b.height } : null);
const hasImageFill = (fills) => Array.isArray(fills) && fills.some((fill) => fill?.type === 'IMAGE' && fill.visible !== false);

function restNodes(frame) {
  const out = [];
  const walk = (children, parent) => {
    for (const node of Array.isArray(children) ? children : []) {
      if (!isObject(node) || typeof node.id !== 'string') continue;
      const isText = node.type === 'TEXT';
      out.push({
        id: node.id, parent, type: String(node.type), name: String(node.name ?? ''), visible: node.visible !== false, box: boxOf(node.absoluteBoundingBox),
        text: isText && typeof node.characters === 'string' ? node.characters : null,
        fontSize: isText && Number.isFinite(node.style?.fontSize) ? node.style.fontSize : null,
        imageFill: hasImageFill(node.fills), interactions: node.interactions,
      });
      walk(node.children, node.id);
    }
  };
  walk(frame.children, frame.id);
  return out;
}

/** Top-level frames of a page or section, through sections, plus the lines that sit beside them. */
function collectTopLevel(container, pageId, found) {
  for (const child of Array.isArray(container.children) ? container.children : []) {
    if (!isObject(child) || child.visible === false) continue;
    if (child.type === 'SECTION') collectTopLevel(child, pageId, found);
    else if (FRAME_TYPES.has(child.type)) found.frames.push({ node: child, pageId });
    else if (LINE_TYPES.has(child.type)) found.lines.push({ id: child.id, box: boxOf(child.absoluteBoundingBox), pageId });
  }
}

/** `-f` and 8 hex digits of the sorted frame ids, so two selections of one file version are two folders; nothing without a selection. */
const folderSuffix = (frames) => (frames ? `-f${crypto.createHash('sha256').update([...frames].sort().join(',')).digest('hex').slice(0, 8)}` : '');

async function fetchRest(ctx, project, link, { refresh, page, frames }) {
  const parsed = parseFigmaUrl(link);
  if (parsed.kind === 'unsupported') throw new Error(parsed.reason);
  if (parsed.kind === 'none') throw new Error('the link is not a Figma design, file or prototype link (/design/, /file/ or /proto/)');
  if (page && (parsed.node_id || parsed.start_node_id)) throw new UsageError('--page is for a link that names no node');

  const design = path.join(project, '.ux-assessment', 'design');
  const cache = path.join(design, 'cache');
  const request = { key: requestKey(link, page, frames), suffix: folderSuffix(frames), index: readIndex(ctx, cache) };
  const saved = !refresh && Object.hasOwn(request.index, request.key) ? savedFolder(cache, request.index[request.key].folder) : null;
  if (saved) {
    let snapshot = null;
    try { snapshot = JSON.parse(fs.readFileSync(path.join(saved, 'design.json'), 'utf8')); } catch { /* the copy is gone or unreadable: fetch again */ }
    if (Array.isArray(snapshot?.frames)) {
      warnOutsideProfile({ root: project, warn: ctx.err });
      writeSource(design, { source: 'rest', link, page: page ?? null }, snapshot);
      report(ctx, saved, snapshot, { cached: true });
      return 0;
    }
  }

  checkApiBase(ctx.base);
  ctx.token = tokenFor(project, ctx.env);
  if (!ctx.token) throw new Stop(['No Figma token was found.', ...TOKEN_HELP].join('\n'));

  const key = parsed.file_key;
  const files = `/v1/files/${encodeURIComponent(key)}`;
  const startFrame = parsed.kind === 'proto' ? parsed.start_node_id ?? parsed.node_id : null;
  let target = page ?? startFrame ?? parsed.node_id;
  if (!target || startFrame) {
    const listing = await api(ctx, `${files}?depth=2`);
    const pages = (listing.document?.children ?? []).filter((p) => isObject(p) && p.type === 'CANVAS');
    if (!target) {
      if (pages.length === 0) throw new Error('the file has no pages');
      if (pages.length > 1) {
        ctx.out(JSON.stringify({ file_key: key, pages: pages.map((p) => ({ id: p.id, name: p.name, children: Array.isArray(p.children) ? p.children.length : 0 })) }));
        return 3;
      }
      target = pages[0].id;
    } else {
      target = pages.find((p) => (p.children ?? []).some((child) => child?.id === target))?.id ?? target;
    }
  }

  const data = await api(ctx, `${files}/nodes?ids=${encodeURIComponent(target)}`);
  const doc = data.nodes?.[target]?.document;
  if (!isObject(doc)) throw new Error(`the file has no node ${target}`);
  const found = { frames: [], lines: [] };
  if (doc.type === 'CANVAS' || doc.type === 'SECTION') collectTopLevel(doc, doc.type === 'CANVAS' ? doc.id : null, found);
  else if (FRAME_TYPES.has(doc.type)) found.frames.push({ node: doc, pageId: null });
  else throw new Error(`node ${target} is a ${doc.type}; link a page, a section or a frame`);

  if (frames) {
    const known = new Set(found.frames.map(({ node }) => node.id));
    const unknown = frames.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`not a frame of the linked page or section: ${unknown.join(', ')}`);
    found.frames = found.frames.filter(({ node }) => frames.includes(node.id));
  }

  const skipped = [];
  const raw = [];
  for (const { node, pageId } of found.frames) {
    const box = boxOf(node.absoluteBoundingBox);
    if (!box || box.w <= 0 || box.h <= 0) skipped.push({ id: node.id, reason: 'no box' });
    else raw.push({ id: node.id, name: String(node.name ?? ''), page: doc.type === 'CANVAS' ? doc.name : null, pageId, box, interactions: node.interactions, nodes: restNodes(node) });
  }
  const now = ctx.now();
  let version = typeof data.version === 'string' || typeof data.version === 'number' ? String(data.version) : null;
  if (!version) {
    version = now.toISOString().slice(0, 10);
    ctx.err('warning: the Figma response has no version; the fetch date stands in for it');
  }
  const points = doc.type === 'CANVAS' && Array.isArray(doc.flowStartingPoints) ? doc.flowStartingPoints.map((p) => p?.nodeId) : null;
  const flowStarts = startFrame ? [startFrame, ...(points ?? [])] : points;

  if (!frames && raw.length > FRAME_LIST_LIMIT) {
    const linked = linkedFrames(raw);
    const starts = startsOf(raw, linked, flowStarts);
    ctx.out(JSON.stringify({
      file_key: key, version, too_many_frames: raw.length, limit: FRAME_LIST_LIMIT,
      frames: raw.map((frame, i) => ({
        id: frame.id, name: frame.name, width: round2(frame.box.w), height: round2(frame.box.h),
        links: [...linked[i].nodes.flatMap((n) => n.links), ...linked[i].links].filter((l) => l.trigger === 'click' && l.action === 'navigate').length,
        flow_start: starts.includes(frame.id),
      })),
    }));
    return 4;
  }

  const urls = new Map();
  for (let i = 0; i < raw.length; i += IDS_PER_REQUEST) {
    const ids = raw.slice(i, i + IDS_PER_REQUEST).map((frame) => frame.id).join(',');
    const images = await api(ctx, `/v1/images/${encodeURIComponent(key)}?ids=${encodeURIComponent(ids)}&format=png&scale=1`);
    if (images.err) throw new Error(`Figma could not render the frames: ${images.err}`);
    for (const [id, url] of Object.entries(images.images ?? {})) urls.set(id, url);
  }
  const { kept, skipped: noImage } = await attachImages(ctx, raw, urls);

  const assembled = assemble({
    source: 'rest', fileKey: key, version, fetchedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    has: { nodes: true, text: true, font_size: true, links: true }, frames: kept,
    flowStarts, lines: found.lines, skipped: [...skipped, ...noImage],
  });
  return finish(ctx, project, assembled, { source: 'rest', link, page: page ?? null }, request);
}

// --- the Figma MCP server ----------------------------------------------------------------------------------------

const decodeEntities = (value) => value
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A tolerant tag scanner: the elements of an XML-like outline as {tag, attrs, children}. Text, comments and declarations are ignored. */
export function scanOutline(text) {
  const roots = [];
  const stack = [];
  const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  for (const match of text.matchAll(tagRe)) {
    const [, closing, tag, rest, selfClosing] = match;
    if (!tag) continue;
    if (closing) {
      const at = stack.map((el) => el.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const attrs = {};
    for (const [, name, double, single] of rest.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[name] = decodeEntities(double ?? single);
    const element = { tag, attrs, children: [] };
    (stack.length ? stack[stack.length - 1].children : roots).push(element);
    if (!selfClosing) stack.push(element);
  }
  return roots;
}

const MCP_FRAME_TAGS = new Set(['frame', 'component', 'component-set']);
const MCP_LINE_TAGS = new Set(['line', 'vector', 'arrow']);
const typeOf = (tag) => tag.replace(/-/g, '_').toUpperCase();

/** One reading of the outline's coordinates: raw frames and lines in page coordinates. */
function readOutline(roots, parentRelative) {
  const frames = [];
  const lines = [];
  const place = (el, offset) => {
    const x = finite(el.attrs.x);
    const y = finite(el.attrs.y);
    const w = finite(el.attrs.width);
    const h = finite(el.attrs.height);
    const origin = parentRelative ? { x: offset.x + (x ?? 0), y: offset.y + (y ?? 0) } : { x: x ?? offset.x, y: y ?? offset.y };
    const hasBox = x !== null && y !== null && w !== null && h !== null;
    return { origin, box: hasBox ? { x: parentRelative ? origin.x : x, y: parentRelative ? origin.y : y, w, h } : null };
  };
  const hidden = (el) => el.attrs.visible === 'false' || el.attrs.hidden === 'true';
  const descendants = (children, parent, offset, out) => {
    for (const el of children) {
      const at = place(el, offset);
      const id = el.attrs.id;
      if (id) out.push({ id, parent, type: typeOf(el.tag), name: el.attrs.name ?? '', visible: !hidden(el), box: at.box, text: null, fontSize: null, imageFill: false, interactions: [] });
      descendants(el.children, id ?? parent, at.origin, out);
    }
  };
  const walk = (els, offset, page) => {
    for (const el of els) {
      const at = place(el, offset);
      if (MCP_FRAME_TAGS.has(el.tag) && el.attrs.id && !hidden(el)) {
        const nodes = [];
        descendants(el.children, el.attrs.id, at.origin, nodes);
        frames.push({ id: el.attrs.id, name: el.attrs.name ?? '', page: page.name, pageId: page.id, box: at.box, interactions: [], nodes });
      } else if (MCP_LINE_TAGS.has(el.tag) && el.attrs.id && !hidden(el)) {
        lines.push({ id: el.attrs.id, box: at.box, pageId: page.id });
      } else if (!el.attrs.id || ['canvas', 'page', 'document', 'section'].includes(el.tag)) {
        const isPage = el.tag === 'canvas' || el.tag === 'page';
        walk(el.children, at.origin, isPage ? { id: el.attrs.id ?? null, name: el.attrs.name ?? null } : page);
      }
    }
  };
  walk(roots, { x: 0, y: 0 }, { id: null, name: null });
  return { frames, lines };
}

/** How many nodes lie inside their frame under one reading of the coordinates. */
function insideCount({ frames }) {
  let count = 0;
  for (const frame of frames) {
    if (!frame.box) continue;
    for (const node of frame.nodes) {
      const b = node.box;
      if (b && b.x >= frame.box.x - 1 && b.y >= frame.box.y - 1 && b.x + b.w <= frame.box.x + frame.box.w + 1 && b.y + b.h <= frame.box.y + frame.box.h + 1) count++;
    }
  }
  return count;
}

const NODES_SHAPE = 'nodes.json must be {"frames": [{"id", "nodes": [...]}], "flowStartingPoints": [...]} as driver/figma-read.js returns it';

function readNodesFile(file, warn) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { doc = null; }
  const valid = isObject(doc) && Array.isArray(doc.frames)
    && doc.frames.every((frame) => isObject(frame) && typeof frame.id === 'string' && Array.isArray(frame.nodes) && frame.nodes.every((n) => isObject(n) && typeof n.id === 'string'));
  if (!valid) {
    warn(`warning: ${file} is not the shape driver/figma-read.js returns; continuing without it (${NODES_SHAPE})`);
    return null;
  }
  return doc;
}

/** The nodes of figma-read.js for one frame, in raw form. */
function rawFromReader(entry) {
  return entry.nodes.map((node) => ({
    id: node.id, parent: typeof node.parentId === 'string' ? node.parentId : entry.id, type: String(node.type), name: String(node.name ?? ''), visible: node.visible !== false,
    box: boxOf(node.absoluteBoundingBox),
    text: typeof node.characters === 'string' ? node.characters : null,
    fontSize: Number.isFinite(node.fontSize) ? node.fontSize : null,
    imageFill: node.imageFill === true, interactions: node.reactions,
  }));
}

async function importMcp(ctx, project, { key, metadata, images, nodes }) {
  if (!KEY_RE.test(key)) throw new UsageError('--key must be a Figma file key');
  const read = (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { throw new Error(`cannot read ${file}`); }
  };
  const roots = scanOutline(read(metadata));
  const readings = [readOutline(roots, true), readOutline(roots, false)];
  const chosen = insideCount(readings[1]) > insideCount(readings[0]) ? readings[1] : readings[0];
  if (!chosen.frames.length) {
    throw new Stop([
      `${metadata} holds no frame this importer can read.`,
      'The MCP source has never been run against the real Figma server, so the metadata format is a guess.',
      'Please report it with the design mode report issue form, and use the REST source or a folder of PNG files meanwhile.',
    ].join('\n'));
  }

  let urls;
  try { urls = new Map(Object.entries(JSON.parse(read(images)))); } catch (error) {
    if (error.message.startsWith('cannot read')) throw error;
    throw new Error(`${images} is not a JSON map from node id to image URL`);
  }
  const reader = nodes ? readNodesFile(nodes, ctx.err) : null;

  const skipped = [];
  const raw = [];
  for (const frame of chosen.frames) {
    if (!frame.box || frame.box.w <= 0 || frame.box.h <= 0) { skipped.push({ id: frame.id, reason: 'no box' }); continue; }
    const entry = reader?.frames.find((candidate) => candidate.id === frame.id);
    if (entry) {
      // Plugin API data is authoritative where both have a node; the outline still supplies nodes the script did not list
      const fromReader = rawFromReader(entry);
      const byId = new Map(fromReader.map((node) => [node.id, node]));
      const inOutline = new Set(frame.nodes.map((node) => node.id));
      frame.nodes = [...frame.nodes.map((node) => byId.get(node.id) ?? node), ...fromReader.filter((node) => !inOutline.has(node.id))];
      frame.interactions = entry.reactions ?? [];
      frame.box = boxOf(entry.absoluteBoundingBox) ?? frame.box;
    }
    raw.push(frame);
  }
  const { kept, skipped: noImage } = await attachImages(ctx, raw, urls);

  const missing = reader ? kept.filter((frame) => !reader.frames.some((entry) => entry.id === frame.id)).length : 0;
  if (missing) ctx.err(`warning: nodes.json has no entry for ${missing} of ${kept.length} frames, so text, font size and links are marked as not read`);
  const covered = Boolean(reader) && missing === 0;

  const now = ctx.now();
  const points = reader && Array.isArray(reader.flowStartingPoints) ? reader.flowStartingPoints.map((p) => p?.nodeId) : null;
  const date = now.toISOString().slice(0, 10);
  const assembled = assemble({
    source: 'mcp', fileKey: key, version: date, fetchedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    has: { nodes: true, text: covered, font_size: covered, links: covered }, frames: kept,
    flowStarts: points, lines: chosen.lines, skipped: [...skipped, ...noImage],
  });
  return finish(ctx, project, assembled, { source: 'mcp', link: null });
}

// --- a folder of PNG files ---------------------------------------------------------------------------------------

function importPng(ctx, project, folder) {
  const dir = path.resolve(folder);
  let names;
  try { names = fs.readdirSync(dir); } catch { throw new Error(`cannot read the folder ${dir}`); }
  names = names.filter((name) => name.toLowerCase().endsWith('.png') && fs.statSync(path.join(dir, name)).isFile())
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
  if (!names.length) throw new Error(`no PNG files in ${dir}`);
  const frames = names.map((name, i) => {
    const png = fs.readFileSync(path.join(dir, name));
    const size = pngSize(png);
    if (!size) throw new Error(`${name} is not a PNG file`);
    return { id: `png-${i + 1}`, name: name.slice(0, -4), page: null, pageId: null, box: { x: 0, y: 0, w: size.width, h: size.height }, png, interactions: [], nodes: [] };
  });
  const now = ctx.now();
  const assembled = assemble({
    source: 'png', fileKey: `png-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12)}`, version: now.toISOString().slice(0, 10),
    fetchedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'), has: { nodes: false, text: false, font_size: false, links: false }, frames, flowStarts: [], skipped: [],
  });
  return finish(ctx, project, assembled, { source: 'png', folder: dir });
}

// --- command line ------------------------------------------------------------------------------------------------

/** Positional words, then the flags: `booleans` take no value, `valued` take one. */
function parseArgs(argv, { booleans = [], valued = [] }) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (booleans.includes(arg)) flags[arg] = true;
    else if (valued.includes(arg)) {
      if (argv[i + 1] === undefined) throw new UsageError(`${arg} needs a value`);
      flags[arg] = argv[++i];
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Frame ids from `--frames`: comma separated, `-` or `:` inside an id, no repeats. */
function parseFrameIds(text) {
  const ids = text.split(',').map((id) => id.trim().replace(/-/g, ':'));
  if (!ids.every((id) => /^[\w:;.]+$/.test(id))) throw new UsageError('--frames needs frame ids separated by commas');
  return [...new Set(ids)];
}

/**
 * Runs one command and returns its exit code: 0 done, 1 failed or stopped, 2 usage, 3 the link names no page and the caller must choose one,
 * 4 the page or section holds more frames than FRAME_LIST_LIMIT and the caller must choose some with --frames.
 */
export async function main(argv, {
  out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`),
  env = process.env, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, now = () => new Date(),
} = {}) {
  const ctx = { out, err, env, fetch: fetchImpl, sleep, now, base: (env.FIGMA_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, ''), token: null, waited: false };
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'parse-url': {
        if (!rest.length) throw new UsageError('parse-url needs the text to look in');
        out(JSON.stringify(parseFigmaUrl(rest.join(' '))));
        return 0;
      }
      case 'fetch': {
        const { positional, flags } = parseArgs(rest, { booleans: ['--refresh'], valued: ['--page', '--frames'] });
        if (positional.length !== 2) throw new UsageError('fetch needs a project and a link');
        const frames = flags['--frames'] === undefined ? null : parseFrameIds(flags['--frames']);
        return await fetchRest(ctx, path.resolve(positional[0]), positional[1], { refresh: Boolean(flags['--refresh']), page: flags['--page'] ?? null, frames });
      }
      case 'import-mcp': {
        const { positional, flags } = parseArgs(rest, { valued: ['--key', '--metadata', '--images', '--nodes'] });
        if (positional.length !== 1 || !flags['--key'] || !flags['--metadata'] || !flags['--images']) {
          throw new UsageError('import-mcp needs a project, --key, --metadata and --images');
        }
        return await importMcp(ctx, path.resolve(positional[0]), { key: flags['--key'], metadata: flags['--metadata'], images: flags['--images'], nodes: flags['--nodes'] });
      }
      case 'import-png': {
        const { positional } = parseArgs(rest, {});
        if (positional.length !== 2) throw new UsageError('import-png needs a project and a folder');
        return importPng(ctx, path.resolve(positional[0]), positional[1]);
      }
      default:
        throw new UsageError(command ? `unknown command ${command}` : 'no command given');
    }
  } catch (error) {
    // the token travels in a header only, but nothing that reaches a log may carry it
    const text = (error instanceof Stop ? error.message : String(error.message).split('\n')[0]);
    err(ctx.token ? text.split(ctx.token).join('[token]') : text);
    if (error instanceof UsageError) {
      err(USAGE);
      return 2;
    }
    return 1;
  }
}

const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
