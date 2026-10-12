// The scene of one design frame (design-mode spec 6.1): its image plus classified elements, and the hit test.
// All boxes and points are frame pixels, with the frame's top-left corner as the origin.

/** Name patterns that make a component or instance a control. Matched case-insensitively as whole words. */
export const DEFAULT_PATTERNS = Object.freeze([
  'button', 'btn', 'input', 'field', 'checkbox', 'radio', 'toggle', 'switch', 'tab', 'link', 'chip', 'select', 'dropdown', 'menu item',
]);
const CONTROL_TYPES = new Set(['COMPONENT', 'INSTANCE', 'COMPONENT_SET']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// camelCase is split and separators become spaces, so "menuItem", "Menu_Item" and "menu-item" all read as "menu item".
const words = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[\s_\-./]+/g, ' ').trim();

function nameMatcher(patterns) {
  const alternatives = patterns.map((p) => escapeRe(words(p))).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'iu');
  return (name) => alternatives !== '' && re.test(words(name ?? ''));
}

/** The kind of a node: `control`, `text`, `image` or `container`. A text node that carries a click link is a control. */
function kindOf(node, matches) {
  if ((node.links ?? []).some((l) => l.trigger === 'click')) return 'control';
  if (CONTROL_TYPES.has(node.type) && matches(node.name)) return 'control';
  if (node.type === 'TEXT') return 'text';
  if (node.image_fill) return 'image';
  return 'container';
}

/** The scene of one snapshot frame. `image` is a decoded image or null, `has` is the snapshot's `has`. */
export function sceneOf(frame, { image = null, has, patterns = DEFAULT_PATTERNS } = {}) {
  if (!has) throw new TypeError('sceneOf needs the snapshot `has`');
  const matches = nameMatcher(patterns);
  return {
    frame: frame.id,
    width: frame.width,
    height: frame.height,
    image,
    imageScale: frame.image_scale ?? 1,
    links: frame.links ?? [],
    has: { nodes: false, text: false, font_size: false, links: false, ...has },
    elements: (frame.nodes ?? []).map((n) => ({
      id: n.id,
      parent: n.parent ?? null,
      kind: kindOf(n, matches),
      box: n.box,
      text: n.text ?? null,
      fontSize: n.font_size ?? null,
      links: n.links ?? [],
    })),
  };
}

const indexes = new WeakMap();
function indexOf(scene) {
  let ix = indexes.get(scene);
  if (!ix) {
    const byId = new Map(scene.elements.map((e) => [e.id, e]));
    const depth = new Map();
    const depthOf = (e) => {
      let d = 0;
      for (let p = byId.get(e.parent), seen = new Set(); p && !seen.has(p.id); p = byId.get(p.parent)) { seen.add(p.id); d++; }
      return d;
    };
    for (const e of scene.elements) depth.set(e.id, depthOf(e));
    ix = { byId, depth };
    indexes.set(scene, ix);
  }
  return ix;
}

const inside = (b, p) => b.w > 0 && b.h > 0 && p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;

/**
 * The click link that answers among a list: a navigate or back link when there is one, because one interaction with
 * several actions is several links and the test can show only those two, else the first click link.
 */
function clickLinkOf(links) {
  const clicks = links.filter((l) => l.trigger === 'click');
  return clicks.find((l) => l.action === 'navigate' || l.action === 'back') ?? clicks[0] ?? null;
}

/**
 * What a point lands on: `element` is the deepest element holding it (the later one when two are
 * equally deep), `control` the nearest control at or above it, `link` the click link of the nearest
 * element at or above it that has one, or else that of the frame itself. Each is null when there is none.
 */
export function hitTest(scene, point) {
  const { byId, depth } = indexOf(scene);
  let element = null;
  for (const e of scene.elements) {
    if (inside(e.box, point) && (!element || depth.get(e.id) >= depth.get(element.id))) element = e;
  }
  let control = null;
  let link = null;
  const seen = new Set();
  for (let e = element; e && !seen.has(e.id); e = byId.get(e.parent)) {
    seen.add(e.id);
    if (!control && e.kind === 'control') control = e;
    link ??= clickLinkOf(e.links);
  }
  link ??= clickLinkOf(scene.links);
  return { element, control, link };
}
