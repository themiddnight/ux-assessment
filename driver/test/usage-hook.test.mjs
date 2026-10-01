import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sumTranscript, briefingId, hookRecords, runHook, readMarker, markerPath, usagePath, isMain, projectRootOf } from '../usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = path.join(HERE, '..', 'usage.mjs');
const FIXTURES = path.join(HERE, 'fixtures');
const AGENT = path.join(FIXTURES, 'claude-subagent-transcript.jsonl');
const MAIN = path.join(FIXTURES, 'claude-main-transcript.jsonl');
const SONNET = { input: 8, cache_write: 1200, cache_write_1h: 1000, cached_input: 41000, output: 170 };
const HAIKU = { input: 10, cache_write: 0, cache_write_1h: 0, cached_input: 500, output: 5 };
const OPUS = { input: 14, cache_write: 5800, cache_write_1h: 0, cached_input: 5000, output: 450 };

const project = (t, { marker = null, dir = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (dir) fs.mkdirSync(path.join(root, '.ux-assessment'), { recursive: true });
  if (marker != null) fs.writeFileSync(markerPath(root), marker);
  return root;
};
const input = (name, over) => ({ ...JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')), transcript_path: MAIN, agent_transcript_path: AGENT, ...over });
const readLines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

test('sumTranscript: per model, the last line per message.id, no <synthetic>, a half-written last line skipped, CRLF too', () => {
  const text = fs.readFileSync(AGENT, 'utf8');
  const want = { 'claude-sonnet-5-5': SONNET, 'claude-haiku-4-5': HAIKU };
  assert.deepEqual(sumTranscript(text), want);
  assert.deepEqual(sumTranscript(text.replace(/\r?\n/g, '\r\n')), want);
  assert.deepEqual(sumTranscript(fs.readFileSync(MAIN, 'utf8'), { skipSidechain: true }), { 'claude-opus-5-5': OPUS });
  assert.deepEqual(sumTranscript(''), {});
});

test('briefingId: the Session id line of the first user message only', () => {
  assert.equal(briefingId(fs.readFileSync(AGENT, 'utf8')), 'core');
  assert.equal(briefingId(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Brief\nSession id: F-03\n' }] } })), 'F-03');
  assert.equal(briefingId(JSON.stringify({ type: 'user', message: { content: 'no id here' } })), null);
});

test('SubagentStop: one record per model for a ux-assessment agent, id from the briefing, run from the marker', (t) => {
  const cwd = project(t, { marker: '2026-09-29\n' });
  const records = hookRecords(input('hook-subagent-stop.json', { cwd }), { t: 'T' });
  assert.deepEqual(records, [
    { t: 'T', harness: 'claude', role: 'persona', id: 'core', model: 'claude-sonnet-5-5', ...SONNET, source: 'hook', run: '2026-09-29' },
    { t: 'T', harness: 'claude', role: 'persona', id: 'core', model: 'claude-haiku-4-5', ...HAIKU, source: 'hook', run: '2026-09-29' },
  ]);
  assert.equal(fs.readFileSync(markerPath(cwd), 'utf8'), '2026-09-29\n', 'SubagentStop never claims the marker');
});

test('SubagentStop: no Session id → agent_id; no marker → run null; foreign or internal agents and a missing .ux-assessment/ → nothing', (t) => {
  const cwd = project(t);
  const noBrief = path.join(cwd, 'agent.jsonl');
  fs.writeFileSync(noBrief, fs.readFileSync(AGENT, 'utf8').split('\n').slice(1).join('\n'));
  const [first] = hookRecords(input('hook-subagent-stop.json', { cwd, agent_type: 'ux-assessment:verifier', agent_transcript_path: noBrief }), { t: 'T' });
  assert.deepEqual([first.role, first.id, first.run], ['verifier', 'a1b2c3', null]);
  assert.deepEqual(hookRecords(input('hook-subagent-stop.json', { cwd, agent_type: 'general-purpose' })), []);
  assert.deepEqual(hookRecords(input('hook-subagent-stop.json', { cwd, agent_type: '' })), []);
  assert.deepEqual(hookRecords(input('hook-subagent-stop.json', { cwd: project(t, { dir: false }) })), []);
});

test('a cwd below the project (the orchestrator ran `cd .ux-assessment/runs/<run>`) records into the nearest ancestor with .ux-assessment/', async (t) => {
  const root = project(t, { marker: '2026-09-29\n' });
  const cwd = path.join(root, '.ux-assessment', 'runs', '2026-09-29');
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(projectRootOf(cwd), root);
  assert.equal(projectRootOf(path.join(root, 'src')), root, 'a directory that does not exist yet still resolves');
  const [persona] = hookRecords(input('hook-subagent-stop.json', { cwd }), { t: 'T' });
  assert.deepEqual([persona.role, persona.run], ['persona', '2026-09-29']);
  await runHook({ stdin: Readable.from([JSON.stringify(input('hook-subagent-stop.json', { cwd }))]), t: 'T' });
  await runHook({ stdin: Readable.from([JSON.stringify(input('hook-stop.json', { cwd }))]), t: 'T' });
  assert.deepEqual(readLines(usagePath(root)).map((r) => r.role), ['persona', 'persona', 'orchestrator']);
  assert.equal(fs.existsSync(path.join(cwd, '.ux-assessment')), false, 'nothing is written below the project root');
  assert.deepEqual(readMarker(root), { run: '2026-09-29', session: 's-main' });
  assert.equal(projectRootOf(project(t, { dir: false })), null);
});

test('Stop: nothing without active-run; the first Stop claims the marker and records the whole conversation as orchestrator', (t) => {
  assert.deepEqual(hookRecords(input('hook-stop.json', { cwd: project(t) })), []);
  const cwd = project(t, { marker: '2026-09-29\r\n' });
  assert.deepEqual(hookRecords(input('hook-stop.json', { cwd }), { t: 'T' }), [
    { t: 'T', harness: 'claude', role: 'orchestrator', id: 's-main', model: 'claude-opus-5-5', ...OPUS, source: 'hook', run: '2026-09-29' },
  ]);
  assert.deepEqual(readMarker(cwd), { run: '2026-09-29', session: 's-main' });
  assert.equal(hookRecords(input('hook-stop.json', { cwd }), { t: 'T' }).length, 1, 'the same session records again (cumulative)');
});

test('a Stop from another session records nothing once the marker is claimed', (t) => {
  const cwd = project(t, { marker: '2026-09-29\ns-main\n' });
  assert.deepEqual(hookRecords(input('hook-stop.json', { cwd, session_id: 's-later' })), []);
  assert.deepEqual(readMarker(cwd), { run: '2026-09-29', session: 's-main' });
});

test('a Stop whose transcript cannot be read throws and leaves the marker unclaimed', (t) => {
  const cwd = project(t, { marker: '2026-09-29\n' });
  assert.throws(() => hookRecords(input('hook-stop.json', { cwd, transcript_path: path.join(cwd, 'missing.jsonl') })), (e) => e.code === 'ENOENT');
  assert.deepEqual(readMarker(cwd), { run: '2026-09-29', session: null });
});

test('readMarker: an invalid run name or no file is no marker; a leading BOM is ignored', (t) => {
  assert.deepEqual(readMarker(project(t, { marker: '\uFEFF2026-09-29\r\ns-main\r\n' })), { run: '2026-09-29', session: 's-main' });
  assert.equal(readMarker(project(t)), null);
  assert.equal(readMarker(project(t, { marker: '../x\n' })), null);
  assert.equal(readMarker(project(t, { marker: '\n' })), null);
});

test('runHook appends the records and swallows every error', async (t) => {
  const cwd = project(t, { marker: '2026-09-29\n' });
  await runHook({ stdin: Readable.from([JSON.stringify(input('hook-subagent-stop.json', { cwd }))]), t: 'T' });
  assert.equal(readLines(usagePath(cwd)).length, 2);
  await runHook({ stdin: Readable.from(['{not json']) });
  await runHook({ stdin: Readable.from([JSON.stringify(input('hook-subagent-stop.json', { cwd, agent_transcript_path: path.join(cwd, 'missing.jsonl') }))]) });
  assert.equal(readLines(usagePath(cwd)).length, 2);
});

test('CLI hook: exit 0 and no output, whatever stdin holds', (t) => {
  const cwd = project(t, { marker: '2026-09-29\n' });
  const run = (stdinText) => spawnSync(process.execPath, [USAGE, 'hook'], { input: stdinText, encoding: 'utf8', cwd });
  for (const stdinText of [JSON.stringify(input('hook-subagent-stop.json', { cwd })), JSON.stringify(input('hook-stop.json', { cwd })), '', 'garbage',
    JSON.stringify(input('hook-subagent-stop.json', { cwd, agent_transcript_path: path.join(cwd, 'missing.jsonl') }))]) {
    const r = run(stdinText);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], JSON.stringify(stdinText).slice(0, 60));
  }
  assert.equal(readLines(usagePath(cwd)).length, 3, 'two subagent models + one orchestrator');
});

test('isMain: matches through a symlink, not another module, not without argv[1]', (t) => {
  const url = new URL('../usage.mjs', import.meta.url).href;
  assert.equal(isMain(url, USAGE), true);
  assert.equal(isMain(url, AGENT), false);
  assert.equal(isMain(url, undefined), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'driver');
  try { fs.symlinkSync(path.dirname(USAGE), link, 'junction'); } catch { t.skip('no symlink permission'); return; }
  assert.equal(isMain(url, path.join(link, 'usage.mjs')), true);
});

test('CLI: an unknown command prints the usage line and exits 1', () => {
  const r = spawnSync(process.execPath, [USAGE, 'bogus'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^usage: node usage\.mjs /);
});

test('usage.mjs imports only node: builtins at top level (the hook runs on every Stop)', () => {
  const source = fs.readFileSync(USAGE, 'utf8');
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((s) => !s.startsWith('node:')), []);
});

test('hooks/hooks.json: SubagentStop for ux-assessment agents and Stop, both the usage hook with a 10 s timeout', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/driver/usage.mjs" hook';
  assert.deepEqual(Object.keys(hooks).sort(), ['Stop', 'SubagentStop']);
  assert.equal(hooks.SubagentStop[0].matcher, '^ux-assessment:');
  for (const event of ['Stop', 'SubagentStop']) {
    assert.deepEqual(hooks[event][0].hooks, [{ type: 'command', command, timeout: 10 }]);
  }
});
