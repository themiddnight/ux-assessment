#!/usr/bin/env node
// Planner commands of design mode. No model call.
//   node design.mjs frames <snapshot folder>
//   node design.mjs crop <snapshot folder> --frame <frame id> --node <node id> --out <png file>
//   node design.mjs judge <run folder> --design <snapshot folder> [--key <key.yaml>]
// `crop` writes the picture of one node for the user to confirm a keyed target: the frame image around the node, the node outlined.
// `judge` reads every sub-folder of the run that holds a design-log.jsonl (its name is the viewer id) and writes
// design-results.json and perception.jsonl into the run folder. A viewer folder may hold viewer.json,
// {"vision": "normal" | "low", "reading_style": "read-all" | "skim" | "icons-only"}, which sets how its instruments are run;
// without it both are the defaults, normal and read-all. The device comes from the frame width.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { crop, encode, outlineBox, readImageInside } from './perception/image.mjs';
import { hitTest, sceneOf } from './perception/scene.mjs';
import { measure, textLoad, wordCount, WORD_BUDGETS } from './perception/instruments.mjs';
import { TOUCH_MAX_WIDTH, writePrivate } from './static-session.mjs';

const USAGE = [
  'usage: node design.mjs frames <snapshot folder>',
  '       node design.mjs crop <snapshot folder> --frame <frame id> --node <node id> --out <png file>',
  '       node design.mjs judge <run folder> --design <snapshot folder> [--key <key.yaml>]',
].join('\n');
const TIERS = Object.freeze(['keyed', 'goal', 'blind']);
const VISIONS = Object.freeze(['normal', 'low']);
/** How much of the frame around a node `crop` keeps on each side, in frame pixels, so the user sees what surrounds the target. */
export const CROP_MARGIN = 48;
/** Text that is a default label of a design tool, with an optional number after it ("Button 2"). Compared in lower case. */
export const PLACEHOLDER_LABELS = Object.freeze(['label', 'button', 'heading', 'text', 'title', 'placeholder']);
/** A text that holds one of these is filler, whatever else it says. */
export const LOREM_PHRASES = Object.freeze(['lorem ipsum', 'dolor sit amet']);
/** A frame with more placeholder words than this share is listed as not simulated. */
export const PLACEHOLDER_LIMIT = 0.3;
const LABEL_RE = new RegExp(`^(?:${PLACEHOLDER_LABELS.join('|')})(?:\\s+\\d+)?$`);

/** A failure caused by the command line, which the usage text explains. */
class UsageError extends Error {}

const round2 = (v) => Math.round(v * 100) / 100;
const unique = (items) => [...new Set(items)];

function readJson(file, what) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`cannot read ${what}`); }
}

function readSnapshot(dir) {
  const snapshot = readJson(path.join(dir, 'design.json'), `design.json in ${dir}`);
  if (snapshot == null || !Array.isArray(snapshot.frames) || snapshot.has == null) throw new Error(`design.json in ${dir} is not a design snapshot`);
  return snapshot;
}

// --- frames ------------------------------------------------------------------------------------------------------

/** True when the text is a default label or filler. */
export function isPlaceholder(text) {
  const t = text.trim().toLowerCase();
  return LABEL_RE.test(t) || LOREM_PHRASES.some((phrase) => t.includes(phrase));
}

/** Placeholder words over all words of the scene's text, to 2 decimals; null when the source gave no text or the frame has no words. */
export function placeholderShare(scene) {
  if (!scene.has.text) return null;
  let all = 0;
  let placeholder = 0;
  for (const e of scene.elements) {
    if (e.text == null || e.text.trim() === '') continue;
    const n = wordCount(e.text);
    all += n;
    if (isPlaceholder(e.text)) placeholder += n;
  }
  return all === 0 ? null : round2(placeholder / all);
}

const clickLinks = (links) => links.filter((l) => l.trigger === 'click');

/** The frames a flow reaches from `start` by click links that navigate, in order of discovery (breadth first, nodes before the frame's own links). */
function reachable(snapshot, start) {
  const byId = new Map(snapshot.frames.map((f) => [f.id, f]));
  const found = [start];
  for (let i = 0; i < found.length; i++) {
    const frame = byId.get(found[i]);
    const links = [...frame.nodes.flatMap((n) => n.links ?? []), ...(frame.links ?? [])];
    for (const link of clickLinks(links)) {
      if (link.action === 'navigate' && byId.has(link.to) && !found.includes(link.to)) found.push(link.to);
    }
  }
  return found;
}

/** What a snapshot allows (design-mode spec section 5): `images`, `frames`, `static` or `flows`. */
export function levelOf(snapshot) {
  const { has } = snapshot;
  if (!has.nodes) return 'images';
  if (!has.text) return 'frames';
  return has.links && flowsOf(snapshot).length ? 'flows' : 'static';
}

function flowsOf(snapshot) {
  const ids = new Set(snapshot.frames.map((f) => f.id));
  return (snapshot.flow_starts ?? []).filter((id) => ids.has(id)).map((start) => ({ start, frames: reachable(snapshot, start) }));
}

function framesReport(dir) {
  const snapshot = readSnapshot(dir);
  const frames = snapshot.frames.map((frame) => {
    const scene = sceneOf(frame, { has: snapshot.has });
    return {
      id: frame.id, name: frame.name, page: frame.page ?? null, width: frame.width, height: frame.height, touch: frame.width <= TOUCH_MAX_WIDTH,
      words: textLoad(scene)?.words ?? null, placeholder_share: placeholderShare(scene),
      controls: scene.elements.filter((e) => e.kind === 'control').length,
      links: clickLinks([...frame.nodes.flatMap((n) => n.links ?? []), ...(frame.links ?? [])]).length,
    };
  });
  const arrows = snapshot.arrows ?? [];
  return {
    level: levelOf(snapshot), ...(arrows.length ? { order_hint: true } : {}), has: snapshot.has, frames,
    flows: flowsOf(snapshot), arrows, skipped: snapshot.skipped ?? [],
  };
}

// --- crop --------------------------------------------------------------------------------------------------------

function cropNode(dir, frameId, nodeId, outFile) {
  if (!outFile) throw new Error('crop needs --out, the file to write');
  const snapshot = readSnapshot(dir);
  if (!snapshot.has.nodes) throw new Error('the snapshot has no nodes, so there is nothing to crop');
  const frame = snapshot.frames.find((f) => f.id === frameId);
  if (!frame) throw new Error(`no frame ${frameId} in the snapshot`);
  const target = frame.nodes.find((n) => n.id === nodeId);
  if (!target) throw new Error(`frame ${frameId} has no node ${nodeId}`);
  if (typeof frame.image !== 'string') throw new Error(`frame ${frameId} has no image`);
  const image = readImageInside(dir, frame.image);
  if (!image) throw new Error(`cannot read the image of frame ${frameId}`);

  // the margin is in frame pixels and is cut at the frame, then everything is moved to image pixels
  const scale = frame.image_scale ?? 1;
  const { box } = target;
  const part = {
    x0: Math.max(0, Math.floor((box.x - CROP_MARGIN) * scale)), y0: Math.max(0, Math.floor((box.y - CROP_MARGIN) * scale)),
    x1: Math.min(image.width, Math.ceil(Math.min(box.x + box.w + CROP_MARGIN, frame.width) * scale)),
    y1: Math.min(image.height, Math.ceil(Math.min(box.y + box.h + CROP_MARGIN, frame.height) * scale)),
  };
  const around = crop(image, { x: part.x0, y: part.y0, w: part.x1 - part.x0, h: part.y1 - part.y0 });
  const inside = { x: box.x * scale - part.x0, y: box.y * scale - part.y0, w: box.w * scale, h: box.h * scale };
  if (!around.width || inside.x >= around.width || inside.y >= around.height || inside.x + inside.w <= 0 || inside.y + inside.h <= 0) {
    throw new Error(`node ${nodeId} lies outside the image of frame ${frameId}`);
  }
  const file = path.resolve(outFile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writePrivate(file, encode(outlineBox(around, inside)));
  return { out: file, frame: frameId, node: nodeId, box };
}

// --- judge -------------------------------------------------------------------------------------------------------

/** A key.yaml (base design 5.2) as {tier, intents: Map frame → {intent, intent_source}, targets: Map frame → [node ids]}. Without a file the tier is blind. */
function readKey(file) {
  const key = { tier: 'blind', intents: new Map(), targets: new Map() };
  if (!file) return key;
  let doc;
  try { doc = YAML.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`cannot read key file ${file}`); }
  if (doc == null || typeof doc !== 'object' || !TIERS.includes(doc.tier)) throw new Error(`${file} needs tier: ${TIERS.join(' | ')}`);
  key.tier = doc.tier;
  for (const [id, entry] of Object.entries(doc.frames ?? {})) {
    key.intents.set(id, { intent: entry?.intent ?? null, intent_source: entry?.intent_source ?? null });
  }
  for (const goal of doc.goals ?? []) {
    for (const step of goal?.steps ?? []) {
      if (step?.frame == null || step?.target == null) continue;
      const frame = String(step.frame);
      key.targets.set(frame, unique([...(key.targets.get(frame) ?? []), String(step.target)]));
    }
  }
  return key;
}

/** A viewer's folder: its log lines and its instrument settings. */
function readViewer(run, name, err) {
  const dir = path.join(run, name);
  const lines = [];
  fs.readFileSync(path.join(dir, 'design-log.jsonl'), 'utf8').split('\n').forEach((text, i) => {
    if (text.trim() === '') return;
    try { lines.push(JSON.parse(text)); } catch { err(`warning: ${name}/design-log.jsonl line ${i + 1} is not JSON and was skipped`); }
  });
  let settings = {};
  if (fs.existsSync(path.join(dir, 'viewer.json'))) settings = readJson(path.join(dir, 'viewer.json'), `${name}/viewer.json`);
  const vision = settings.vision ?? 'normal';
  const readingStyle = settings.reading_style ?? 'read-all';
  if (!VISIONS.includes(vision)) throw new Error(`${name}/viewer.json: vision must be ${VISIONS.join(' or ')}`);
  if (!Object.hasOwn(WORD_BUDGETS, readingStyle)) throw new Error(`${name}/viewer.json: reading_style must be ${Object.keys(WORD_BUDGETS).join(', ')}`);
  return { viewer: name, lines, vision, readingStyle };
}

/** The frame visits in a viewer's log, in order: where it went, what it saw, what it answered, how the session ended. */
function visitsOf(lines) {
  const visits = [];
  let current = null;
  const begin = (frame) => { current = { frame, images: [], first_look: null, after_reading: null, moved_to: null, ended: null }; visits.push(current); };
  for (const line of lines) {
    if (!current || line.type === 'start') begin(line.frame);
    if (line.type === 'navigate') { current.moved_to = line.to; begin(line.to); }
    if (line.type === 'view' && typeof line.image === 'string') current.images.push(line.image);
    if (line.type === 'answer') current[line.part] = line.answer;
    if (line.type === 'end') current.ended = line.reason;
  }
  return visits;
}

function chainOf(byId, id) {
  const chain = [];
  for (let e = byId.get(id); e && !chain.includes(e.id); e = byId.get(e.parent)) chain.push(e.id);
  return chain;
}

/**
 * hit, miss, cannot_find or no_target for a first click. A click hits when the keyed target is the element it landed on or
 * above it, or sits in the same control as the click (a label inside the pressed button).
 */
function verdictOf(click, targets, scene) {
  const hit = { element: click.element ?? null, control: click.control ?? null };
  if (click.result === 'cannot_find') return { hit: null, target: targets[0] ?? null, verdict: 'cannot_find' };
  if (!targets.length) return { hit, target: null, verdict: 'no_target' };
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const above = hit.element ? chainOf(byId, hit.element) : [];
  const controlOf = (id) => chainOf(byId, id).find((x) => byId.get(x).kind === 'control') ?? null;
  const matched = targets.find((target) => above.includes(target) || (hit.control != null && controlOf(target) === hit.control));
  return { hit, target: matched ?? targets[0], verdict: matched ? 'hit' : 'miss' };
}

function viewerResult(viewer, visits, scenes, key) {
  return visits.map((visit) => {
    const scene = scenes.get(visit.frame);
    const { pressable = [], first_click: click, ...reading } = visit.after_reading ?? {};
    const targets = scene?.has.nodes ? key.targets.get(visit.frame) ?? [] : [];
    return {
      frame: visit.frame,
      screenshots: visit.images.map((image) => path.posix.join(viewer, image)),
      complete: visit.first_look != null && visit.after_reading != null,
      first_look: visit.first_look,
      after_reading: visit.after_reading && reading,
      pressable_hits: pressable,
      first_click: click ? { result: click.result, point: click.point ?? null, ...verdictOf(click, targets, scene) } : null,
      moved_to: visit.moved_to,
      ended: visit.ended,
    };
  });
}

/** Element ids a viewer pointed at in a visit: the element and the control under each point it gave. */
function pointedIds({ first_look: look, after_reading: reading }) {
  const located = [look?.main_action, ...(reading?.pressable ?? []), reading?.first_click].filter((p) => p?.point);
  return located.flatMap((p) => [p.element, p.control]).filter(Boolean);
}

const THRESHOLD_OF = { contrast: (e) => e.thresholds.contrast, target_size: (e) => e.thresholds.target_size, icon_only: () => null };
const VALUE_OF = { contrast: (e) => e.contrast, target_size: (e) => e.target_size, icon_only: (e) => e.icon_only };

/**
 * The instruments for one frame, once for each way of looking that a viewer who reached it has (with nobody there, the defaults).
 * An element is used when a viewer pointed at it or it is a keyed target; the values of the frame are used when a viewer reached it.
 */
function inspectFrame(frame, scene, { snapshot, key, viewers, visitsBy }) {
  const touch = frame.width <= TOUCH_MAX_WIDTH;
  const keyed = new Set(snapshot.has.nodes ? key.targets.get(frame.id) ?? [] : []);
  const reached = viewers
    .map((v) => ({ v, visits: visitsBy.get(v.viewer).filter((visit) => visit.frame === frame.id) })).filter((r) => r.visits.length);
  const pointedBy = new Map(); // element id → viewer ids
  for (const { v, visits } of reached) {
    for (const id of unique(visits.flatMap(pointedIds))) pointedBy.set(id, [...(pointedBy.get(id) ?? []), v.viewer]);
  }
  const lines = [];
  const findings = [];
  const settings = reached.length ? unique(reached.map(({ v }) => `${v.vision}|${v.readingStyle}`)) : ['normal|read-all'];
  for (const setting of settings) {
    const [vision, readingStyle] = setting.split('|');
    const group = reached.filter(({ v }) => `${v.vision}|${v.readingStyle}` === setting).map(({ v }) => v.viewer);
    const values = measure(scene, { touch, vision, readingStyle });
    const base = { frame: frame.id, touch, vision, reading_style: readingStyle };
    const raise = (line, instrument, value, threshold) => findings.push({
      element: line.element, instrument, value, threshold, viewers: line.used_by, keyed: line.keyed, vision, reading_style: readingStyle,
    });
    for (const { id, thresholds, below, ...numbers } of values.elements) {
      const by = group.filter((viewer) => pointedBy.get(id)?.includes(viewer));
      const line = { ...base, element: id, ...numbers, thresholds, below, used: by.length > 0 || keyed.has(id), used_by: by, keyed: keyed.has(id) };
      lines.push(line);
      const entry = { thresholds, ...numbers };
      if (line.used) for (const instrument of below) raise(line, instrument, VALUE_OF[instrument](entry), THRESHOLD_OF[instrument](entry));
    }
    const { words, reading_seconds, word_budget, below } = values.frame;
    const line = { ...base, element: null, kind: 'frame', words, reading_seconds, word_budget, below, used: group.length > 0, used_by: group, keyed: false };
    lines.push(line);
    if (line.used) for (const instrument of below) raise(line, instrument, words, word_budget);
  }
  const order = new Map(scene.elements.map((e, i) => [e.id, i]));
  const pointed = [...pointedBy].sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
  return {
    lines,
    report: {
      frame: frame.id,
      intent: key.intents.get(frame.id)?.intent ?? null,
      intent_source: key.intents.get(frame.id)?.intent_source ?? null,
      viewers_pointed: pointed.map(([element, who]) => ({ element, viewers: who })),
      instrument_findings: findings,
    },
  };
}

/** What the run could not simulate: skipped frames, data the source lacked, placeholder frames and link actions a viewer met. */
function notSimulatedOf(snapshot, inPlay, scenes, viewers) {
  const { has } = snapshot;
  const out = (snapshot.skipped ?? []).map((entry) => ({ kind: 'skipped_frame', frame: entry.id, reason: entry.reason }));
  if (!has.nodes) out.push({ kind: 'instruments', reason: 'the source gave no nodes' });
  else {
    if (!has.text) out.push({ kind: 'text', reason: 'the source gave no text: text_load, icon_only and the placeholder check were not run' });
    else if (!has.font_size) out.push({ kind: 'font_size', reason: 'the source gave no font size: all text is measured against 4.5' });
    if (!has.links) out.push({ kind: 'links', reason: 'the source gave no prototype links: no link was followed' });
  }
  for (const frame of inPlay) {
    const share = placeholderShare(scenes.get(frame.id));
    if (share != null && share > PLACEHOLDER_LIMIT) out.push({ kind: 'placeholder_frame', frame: frame.id, share });
  }
  for (const viewer of viewers) {
    for (const line of viewer.lines) {
      if (line.type === 'end' && line.reason === 'unsupported') out.push({ kind: 'link_action', action: line.action ?? null, frame: line.frame, viewer: viewer.viewer });
    }
  }
  return out;
}

function judge(run, designDir, keyFile, err) {
  const snapshot = readSnapshot(designDir);
  const key = readKey(keyFile);
  const names = fs.readdirSync(run, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(run, d.name, 'design-log.jsonl'))).map((d) => d.name).sort();
  if (!names.length) throw new Error(`no viewer folder with a design-log.jsonl in ${run}`);
  const viewers = names.map((name) => readViewer(run, name, err));
  const visitsBy = new Map(viewers.map((v) => [v.viewer, visitsOf(v.lines)]));
  const scenes = new Map(snapshot.frames.map((f) => [f.id, sceneOf(f, { image: readImageInside(designDir, f.image), has: snapshot.has })]));
  if (snapshot.has.nodes) {
    for (const [frame, targets] of key.targets) {
      for (const target of targets) {
        if (scenes.has(frame) && !scenes.get(frame).elements.some((e) => e.id === target)) err(`warning: key target ${target} is not an element of frame ${frame}`);
      }
    }
  }

  // keyed frames are in play too, so that a target nobody reached still gets its values
  const inPlay = snapshot.frames.filter((f) => key.intents.has(f.id) || key.targets.has(f.id)
    || [...visitsBy.values()].some((visits) => visits.some((visit) => visit.frame === f.id)));
  const inspected = inPlay.map((frame) => inspectFrame(frame, scenes.get(frame.id), { snapshot, key, viewers, visitsBy }));
  const doc = {
    level: levelOf(snapshot), tier: key.tier, has: snapshot.has,
    viewers: viewers.map((v) => ({ viewer: v.viewer, frames: viewerResult(v.viewer, visitsBy.get(v.viewer), scenes, key) })),
    frames: inspected.map((i) => i.report),
    not_simulated: notSimulatedOf(snapshot, inPlay, scenes, viewers),
  };
  const lines = inspected.flatMap((i) => i.lines);
  const resultsFile = path.join(run, 'design-results.json');
  const perceptionFile = path.join(run, 'perception.jsonl');
  fs.writeFileSync(resultsFile, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(perceptionFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), { mode: 0o600 });
  return { results: resultsFile, perception: perceptionFile, viewers: viewers.length, frames: inspected.length, elements: lines.length };
}

// --- command line ------------------------------------------------------------------------------------------------

function parseArgs(argv, valued) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.includes(arg)) {
      if (argv[i + 1] === undefined) throw new UsageError(`${arg} needs a value`);
      flags[arg] = argv[++i];
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 usage. */
export function main(argv, { out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'frames': {
        const { positional } = parseArgs(rest, []);
        if (positional.length !== 1) throw new UsageError('frames needs a snapshot folder');
        out(JSON.stringify(framesReport(path.resolve(positional[0])), null, 2));
        return 0;
      }
      case 'crop': {
        const { positional, flags } = parseArgs(rest, ['--frame', '--node', '--out']);
        if (positional.length !== 1 || !flags['--frame'] || !flags['--node']) throw new UsageError('crop needs a snapshot folder, --frame and --node');
        out(JSON.stringify(cropNode(path.resolve(positional[0]), flags['--frame'], flags['--node'], flags['--out'])));
        return 0;
      }
      case 'judge': {
        const { positional, flags } = parseArgs(rest, ['--design', '--key']);
        if (positional.length !== 1 || !flags['--design']) throw new UsageError('judge needs a run folder and --design');
        out(JSON.stringify(judge(path.resolve(positional[0]), path.resolve(flags['--design']), flags['--key'] ? path.resolve(flags['--key']) : null, err)));
        return 0;
      }
      default:
        throw new UsageError(command ? `unknown command ${command}` : 'no command given');
    }
  } catch (error) {
    err(String(error.message).split('\n')[0]);
    if (error instanceof UsageError) {
      err(USAGE);
      return 2;
    }
    return 1;
  }
}

const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
