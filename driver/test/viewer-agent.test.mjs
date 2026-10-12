import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { THRESHOLDS, WORD_BUDGETS, READING_WORDS_PER_MINUTE } from '../perception/instruments.mjs';

// Normalize line endings: a Windows checkout (core.autocrlf) turns \n into \r\n.
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const frontmatter = (text) => text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const section = (text, heading) => {
  const from = text.indexOf(`\n${heading}`);
  assert.ok(from >= 0, `the heading ${heading}`);
  const to = text.indexOf('\n## ', from + 1);
  return text.slice(from, to < 0 ? undefined : to);
};

test('viewer agent: sonnet, exactly view and answer, and nothing a viewer must not know about', () => {
  const text = read('agents/viewer.md');
  const front = frontmatter(text);
  assert.match(front, /^name: viewer$/m);
  assert.match(front, /^model: sonnet$/m);
  assert.match(front, /^description: \S.*Dispatched by the ux-assessment skill.*; not for general use\.$/m);
  assert.deepEqual(front.match(/^tools: (.*)$/m)[1].split(',').map((t) => t.trim()), [
    'mcp__plugin_ux-assessment_browser__view', 'mcp__plugin_ux-assessment_browser__answer']);
  assert.doesNotMatch(text, /knowledge\//); // an agent cannot read plugin files
  for (const word of ['Figma', 'frame', 'layer']) assert.doesNotMatch(text, new RegExp(`\\b${word}s?\\b`, 'i'), `agents/viewer.md says "${word}"`);
  for (const word of ['`first_look`', '`after_reading`', '`cannot_tell`', '`cannot_find`']) assert.ok(text.includes(word), `agents/viewer.md names ${word}`);
});

test('the main skill routes with figma.mjs parse-url and marks design mode experimental', () => {
  const skill = read('skills/ux-assessment/SKILL.md');
  assert.match(skill, /node "\$PLUGIN\/driver\/figma\.mjs" parse-url "<words>"/);
  assert.ok(skill.indexOf('figma.mjs" parse-url') < skill.indexOf('**State menu**'), 'the mode is decided before the state menu');
  const design = section(skill, '## D. Design mode');
  assert.match(design, /knowledge\/design\.md/);
  assert.match(design, /\bexperimental\b/);
  assert.match(design, /never been run on a real Figma file/);
  assert.match(design, /ux-assessment:viewer/);
  assert.ok(skill.includes('.ux-assessment/design/cache/'), 'the .gitignore offer covers the design cache');
});

test('the routing block runs parse-url only on a figma.com word, needs no URL for a PNG folder, and falls back to app', () => {
  const skill = read('skills/ux-assessment/SKILL.md');
  const block = skill.slice(skill.indexOf('**App or design**'), skill.indexOf('**State menu**')).replace(/[ \t]*\n[ \t]*/g, ' ');
  assert.match(block, /does not contain `figma\.com`, do not run the command below: the kind is `none`/);
  assert.match(block, /take only the words of that text that contain `figma\.com`/);
  assert.match(block, /node "\$PLUGIN\/driver\/figma\.mjs" parse-url "<words>"/);
  assert.match(block, /If the command fails, the kind is `none` and the run is an app run\./);
  const row = block.split('| ').find((cell) => cell.startsWith('A path to an existing folder'));
  assert.match(row, /and the request holds no URL \(no text that starts with `http:\/\/` or `https:\/\/`\)/);
  assert.match(block, /App mode: no Figma link or PNG folder in the request\./);
  assert.doesNotMatch(block, /the request has an app URL/);
});

test('the README keeps the same design lines out of git as the skill offers', () => {
  const designLines = (text) => text.split('\n').filter((line) => /^\.ux-assessment\/.*design/.test(line)).sort();
  const offered = designLines(read('skills/ux-assessment/SKILL.md'));
  assert.deepEqual(offered, ['.ux-assessment/design/cache/', '.ux-assessment/runs/*/*/design-log.jsonl']);
  assert.deepEqual(designLines(read('README.md')), offered);
});

test('the Codex skill says design mode is not supported', () => {
  assert.match(read('codex/skills/ux-assessment/SKILL.md'), /[Dd]esign mode is not supported on Codex/);
});

test('knowledge/perception.md states every number the instruments use', () => {
  const text = read('knowledge/perception.md');
  const numbers = (value) => (typeof value === 'number' ? [value] : Object.values(value).flatMap(numbers));
  const all = [...numbers(THRESHOLDS), ...numbers(WORD_BUDGETS), READING_WORDS_PER_MINUTE];
  assert.equal(all.length, 11);
  for (const n of all) assert.match(text, new RegExp(`(?<![\\d.])${String(n).replace('.', '\\.')}(?![\\d]|\\.\\d)`), `knowledge/perception.md states ${n}`);
  for (const style of Object.keys(WORD_BUDGETS)) assert.ok(text.includes(`\`${style}\``), `knowledge/perception.md names ${style}`);
});

test('knowledge/design.md names each command in the quoted form and forbids reusing an app finding id', () => {
  const text = read('knowledge/design.md');
  for (const command of ['figma.mjs" fetch', 'figma.mjs" import-mcp', 'figma.mjs" import-png', 'design.mjs" frames', 'design.mjs" judge']) {
    assert.ok(text.includes(`node "$PLUGIN/driver/${command}`), `knowledge/design.md runs ${command}`);
  }
  assert.doesNotMatch(text, /node \$PLUGIN\//, 'an unquoted node $PLUGIN/ command');
  assert.match(text, /Never reuse the id of a finding from an app run\./);
  for (const name of ['design-results.json', 'perception.jsonl', 'viewer.json', 'harness_design_start', '"kind": "design"']) assert.ok(text.includes(name), name);
});

test('the finding record has a source, the card has vision, and triage knows a design run', () => {
  assert.match(read('knowledge/triage.md'), /^source: persona\s+# persona \| instrument \| comprehension/m);
  assert.match(read('knowledge/triage.md'), /knowledge\/design\.md/);
  assert.match(read('knowledge/personas.md'), /^vision: normal\s+# normal \| low/m);
  const triage = read('agents/triage.md');
  assert.match(triage, /knowledge\/design\.md/);
  assert.match(triage, /design-results\.json/);
  assert.match(triage, /perception\.jsonl/);
});
