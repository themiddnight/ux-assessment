#!/usr/bin/env node
// Pixel diff of two screenshots for triage: `node png-diff.mjs a.png b.png`.
// Prints {changed, ratio, box} with the harness's own thresholds (visual.mjs); box is in image px.
import fs from 'node:fs';
import { decode, diff } from './visual.mjs';

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error('usage: node png-diff.mjs a.png b.png');
  process.exit(2);
}
const a = decode(fs.readFileSync(fileA));
const b = decode(fs.readFileSync(fileB));
const d = diff(a, b);
let changed = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
for (let i = 0; i < d.length; i++) {
  if (!d[i]) continue;
  changed++;
  const x = i % b.width, y = (i / b.width) | 0;
  if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
}
const box = changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
console.log(JSON.stringify({ changed, ratio: +(changed / d.length).toFixed(4), box, size_changed: a.width !== b.width || a.height !== b.height }));
