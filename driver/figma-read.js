// Read-only script for Figma's `use_figma` tool (Plugin API). Node never runs it: the orchestrator passes it to the tool.
// It reads text, font size, image fills and prototype reactions of the frames named on the FRAME_IDS line, and changes nothing.
// How to use it: copy this file's text, replace the whole `const FRAME_IDS = ...;` line with the node ids of the frames,
// for example `const FRAME_IDS = ["12:34", "12:58"];`, and pass the result as the code of `use_figma`.
// It is written as the body of an async function and ends with `return` of a JSON string. Whether `use_figma` runs code
// that way has not been checked against the real tool; if it does not, wrap the body in a function the tool calls.
// Save the returned string to a file and give that file to `import-mcp` as `--nodes`. Its shape:
//   {"flowStartingPoints": [{"nodeId", "name"}],
//    "frames": [{"id", "name", "absoluteBoundingBox", "reactions", "nodes": [
//      {"id", "type", "name", "parentId", "visible", "absoluteBoundingBox", "characters", "fontSize", "imageFill", "reactions"}]}]}
const FRAME_IDS = [];

const mixed = figma.mixed;
const plain = (value) => (value === mixed || value === undefined ? null : value);

const describe = (node, parentId) => ({
  id: node.id,
  type: node.type,
  name: node.name,
  parentId,
  visible: node.visible !== false,
  absoluteBoundingBox: plain(node.absoluteBoundingBox),
  characters: node.type === 'TEXT' ? plain(node.characters) : null,
  fontSize: node.type === 'TEXT' && typeof node.fontSize === 'number' ? node.fontSize : null,
  imageFill: Array.isArray(node.fills) && node.fills.some((fill) => fill.type === 'IMAGE' && fill.visible !== false),
  reactions: Array.isArray(node.reactions) ? node.reactions : [],
});

const collect = (node, parentId, into) => {
  for (const child of 'children' in node ? node.children : []) {
    into.push(describe(child, parentId));
    collect(child, child.id, into);
  }
};

const startingPoints = [];
const frames = [];
for (const id of FRAME_IDS) {
  const frame = await figma.getNodeByIdAsync(id);
  if (!frame || !('children' in frame)) continue;
  const nodes = [];
  collect(frame, frame.id, nodes);
  const frameInfo = describe(frame, frame.parent ? frame.parent.id : null);
  frames.push({ id: frame.id, name: frame.name, absoluteBoundingBox: frameInfo.absoluteBoundingBox, reactions: frameInfo.reactions, nodes });
  let page = frame.parent;
  while (page && page.type !== 'PAGE') page = page.parent;
  for (const point of page && Array.isArray(page.flowStartingPoints) ? page.flowStartingPoints : []) {
    if (!startingPoints.some((known) => known.nodeId === point.nodeId)) startingPoints.push({ nodeId: point.nodeId, name: point.name });
  }
}

return JSON.stringify({ flowStartingPoints: startingPoints, frames });
