import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Normalize line endings: a Windows checkout (core.autocrlf) turns \n into \r\n.
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const frontmatter = (text) => text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const OUTCOMES = ['fix', 'keep', 'ask'];

test('decide agent: opus, the planner-side tools, all three outcomes, follows the rules file', () => {
  const text = read('agents/decide.md');
  const front = frontmatter(text);
  assert.match(front, /^name: decide$/m);
  assert.match(front, /^model: opus$/m);
  assert.match(front, /^description: \S.*Dispatched by the ux-assessment skill/m);
  assert.deepEqual(front.match(/^tools: (.*)$/m)[1].split(',').map((t) => t.trim()), ['Read', 'Grep', 'Glob', 'Bash', 'Write']);
  for (const outcome of OUTCOMES) assert.match(text, new RegExp(`\`${outcome}\``));
  assert.match(text, /knowledge\/decide\.md/);
  assert.match(text, /decisions\.yaml/);
});

test('knowledge/decide.md: the three outcomes, the decisions.yaml example, the limits on the agent', () => {
  const text = read('knowledge/decide.md');
  for (const outcome of OUTCOMES) {
    assert.match(text, new RegExp(`\`${outcome}\``));
    assert.match(text, new RegExp(`^ {4}decision: ${outcome}\\b`, 'm'), `an example with decision: ${outcome}`);
  }
  for (const key of ['decision:', 'sources:', 'quote:', 'reason:', 'options:', 'guard:']) assert.ok(text.includes(key), key);
  assert.match(text, /decide\.mjs" record/);
  assert.match(text, /persona briefing/);
});

test('the decide, result and settings skills have name and description frontmatter with the slash form', () => {
  for (const name of ['decide', 'result', 'settings']) {
    const text = read(`skills/${name}/SKILL.md`);
    const front = frontmatter(text);
    assert.match(front, new RegExp(`^name: ${name}$`, 'm'), `skills/${name}: name`);
    assert.match(front, new RegExp(`^description: \\S.*/ux-assessment:${name}\\b`, 'm'), `skills/${name}: description`);
    assert.match(text, /`\$PLUGIN` is a placeholder/);
    assert.doesNotMatch(text, /node \$PLUGIN\//, `skills/${name}: an unquoted node $PLUGIN/ command`);
    assert.doesNotMatch(text, /probe\.mjs" deps/, `skills/${name} needs no browser`);
  }
});

test('the main skill and the Codex skill run the decide step and the board, and point to the three skill files', () => {
  for (const rel of ['skills/ux-assessment/SKILL.md', 'codex/skills/ux-assessment/SKILL.md']) {
    const text = read(rel);
    assert.match(text, /decide\.mjs" record/, `${rel}: decide.mjs record`);
    assert.match(text, /ledger\.mjs" board/, `${rel}: ledger.mjs board`);
    for (const name of ['result', 'settings']) assert.ok(text.includes(`$PLUGIN/skills/${name}/SKILL.md`), `${rel}: skills/${name}`);
    assert.match(text, /F-03 · <title_local>/, `${rel}: the id rule`);
  }
  const main = read('skills/ux-assessment/SKILL.md');
  assert.ok(main.includes('$PLUGIN/skills/decide/SKILL.md'));
  assert.match(main, /^## 9b\. Decide/m);
  assert.match(read('codex/skills/ux-assessment/SKILL.md'), /knowledge\/decide\.md/);
});

test('triage writes title_local and names findings by id and title', () => {
  const rules = read('knowledge/triage.md');
  assert.match(rules, /^title_local: /m);
  assert.match(rules, /F-03 · <title_local>/);
  assert.match(read('agents/triage.md'), /title_local/);
  assert.match(read('knowledge/verify.md'), /F-03 · <title_local>/);
});
