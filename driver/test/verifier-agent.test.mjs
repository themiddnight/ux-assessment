import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Normalize line endings: a Windows checkout (core.autocrlf) turns \n into \r\n.
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('verifier agent: sonnet, exactly the browser verify tools plus Read, self-contained verdict rules', () => {
  const text = read('agents/verifier.md');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)[1];
  assert.match(front, /^name: verifier$/m);
  assert.match(front, /^model: sonnet$/m);
  assert.deepEqual(front.match(/^tools: (.*)$/m)[1].split(',').map((t) => t.trim()).sort(), [
    'Read', 'mcp__plugin_ux-assessment_browser__act', 'mcp__plugin_ux-assessment_browser__end_session',
    'mcp__plugin_ux-assessment_browser__harness_signals']);
  for (const verdict of ['reproduced', 'not_reproduced', 'unreachable', 'changed']) assert.match(text, new RegExp(`\`${verdict}\``));
  assert.match(text, /```yaml\nid: F-03\nverdict: not_reproduced\nat_step: 3\n/);
  assert.doesNotMatch(text, /knowledge\//); // Codex verifiers cannot read plugin files
});

test('knowledge/verify.md carries the brief template the skills fill in', () => {
  const text = read('knowledge/verify.md');
  for (const line of ['Session id: <finding id>', 'What makes it true:', 'You have at most 15 actions.']) assert.ok(text.includes(line), line);
});
