import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixtureServer } from './fixture-server.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp.mjs');
let fx, client;
before(async () => {
  fx = await startFixtureServer();
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'inherit' }));
});
after(async () => { await client.close(); await fx.close(); });

const call = (name, args) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const step = (session, action, extra = {}) => ({
  session, observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action, ...extra,
});

test('lists exactly the persona and harness tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['act', 'end_session', 'harness_eval', 'harness_save_state', 'harness_signals', 'harness_start', 'harness_stop']);
  const start = tools.find((t) => t.name === 'harness_start');
  for (const k of ['safety', 'files', 'permissions', 'storage_state']) assert.ok(start.inputSchema.properties[k], k);
  assert.deepEqual(start.inputSchema.required.sort(), ['dir', 'session', 'url']);
  const act = tools.find((t) => t.name === 'act');
  assert.deepEqual(act.inputSchema.required.sort(), ['action', 'event', 'frustration_delta', 'observation', 'reaction', 'session']);
});

test('full persona session over MCP: start, look, act, drag, cap, end, stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-mcp-'));
  const started = await call('harness_start', { session: 'p1', dir, url: fx.url('basic.html'), cap: 3, patience_budget: 5 });
  assert.equal(started.isError, undefined, textOf(started));

  const look = await call('act', step('p1', { type: 'look' }));
  assert.match(textOf(look), /Free first look · frustration 0\/5/);
  const img = look.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.ok(Buffer.from(img.data, 'base64').length > 1000);

  const clicked = await call('act', step('p1', { type: 'click', x: 160, y: 120, target: 'Add one' }));
  assert.match(textOf(clicked), /Step 1 of 3/);
  assert.equal(JSON.parse(textOf(await call('harness_eval', { session: 'p1', js: "document.getElementById('count').textContent" }))), '1');

  const dragged = await call('act', step('p1', { type: 'drag', x: 10, y: 10, to_x: 200, to_y: 10 }));
  assert.equal(dragged.isError, undefined, textOf(dragged));

  const invalid = await call('act', step('p1', { type: 'click', x: 99999, y: 1 }));
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /INVALID_ACTION/);

  await call('act', step('p1', { type: 'wait', seconds: 1 }));
  const capped = await call('act', step('p1', { type: 'click', x: 160, y: 120 }));
  assert.equal(capped.isError, true);
  assert.match(textOf(capped), /^STEP_CAP_REACHED \(3\)/);

  const ended = await call('end_session', {
    session: 'p1', outcome: 'step_cap', final_observation: 'The number shows 1',
    exit_interview: { what_it_is_for: 'Counting', would_come_back: 'no', reason: 'Nothing to do', most_confusing: 'The empty space' },
  });
  assert.match(textOf(ended), /recorded/);

  const signals = JSON.parse(textOf(await call('harness_signals', { session: 'p1' })));
  assert.equal(signals.steps, 3);
  assert.equal(signals.over, 'STEP_CAP_REACHED');
  assert.equal(signals.ended, true);
  assert.equal(signals.outcome, 'step_cap', 'the persona\'s outcome is in the signals for run.json');

  const stopped = await call('harness_stop', { session: 'p1' });
  assert.equal(stopped.isError, undefined);
  assert.match(textOf(stopped), /"outcome":\s*"step_cap"/);
  const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.find((e) => e.step === 2).action, { type: 'drag', from: { x: 10, y: 10 }, to: { x: 200, y: 10 } });
  assert.equal(log.at(-1).end.exit_interview.would_come_back, 'no');
  assert.equal(log.at(-1).end.final_observation, 'The number shows 1');
  assert.equal(log.at(-1).end.final_screenshot, 'screenshots/s04.png');
});

test('unknown or stopped sessions are tool errors, and the server keeps serving', async () => {
  const r = await call('act', step('nope', { type: 'look' }));
  assert.equal(r.isError, true);
  assert.match(textOf(r), /UNKNOWN_SESSION/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-mcp-'));
  await call('harness_start', { session: 'p2', dir, url: fx.url('basic.html') });
  const dup = await call('harness_start', { session: 'p2', dir, url: fx.url('basic.html') });
  assert.match(textOf(dup), /SESSION_EXISTS/);
  await call('harness_stop', { session: 'p2' });
  const after = await call('act', step('p2', { type: 'look' }));
  assert.match(textOf(after), /UNKNOWN_SESSION/);
  const bad = await call('harness_eval', { session: 'nope', js: '1' });
  assert.equal(bad.isError, true);
});

test('two sessions in one server stay separate', async () => {
  const [d1, d2] = [fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-mcp-')), fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-mcp-'))];
  await Promise.all([
    call('harness_start', { session: 'a', dir: d1, url: fx.url('basic.html') }),
    call('harness_start', { session: 'b', dir: d2, url: fx.url('basic.html') }),
  ]);
  await Promise.all([
    call('act', step('a', { type: 'click', x: 160, y: 120 })),
    call('act', step('a', { type: 'click', x: 160, y: 120 })),
    call('act', step('b', { type: 'click', x: 160, y: 120 })),
  ]);
  const count = async (s) => JSON.parse(textOf(await call('harness_eval', { session: s, js: "document.getElementById('count').textContent" })));
  assert.equal(await count('a'), '2');
  assert.equal(await count('b'), '1');
  await Promise.all([call('harness_stop', { session: 'a' }), call('harness_stop', { session: 'b' })]);
});

test('parallel sessions: interleaved concurrent acts keep logs, screenshots and notes apart', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-par-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-par-'));
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-par-')), 'a.json');
  const started = await Promise.all([
    call('harness_start', { session: 'pa', dir: dirA, url: fx.url('safety.html'), safety: { stop_before: [{ pattern: '/api/pay', label: 'payment' }] }, permissions: 'deny' }),
    call('harness_start', { session: 'pb', dir: dirB, url: fx.url('select.html'), files: dirB }),
  ]);
  for (const r of started) assert.equal(r.isError, undefined, textOf(r));
  const texts = { pa: [], pb: [] };
  const actBoth = async (a, b) => {
    const [ra, rb] = await Promise.all([call('act', step('pa', a)), call('act', step('pb', b))]);
    texts.pa.push(textOf(ra));
    texts.pb.push(textOf(rb));
  };
  await actBoth({ type: 'look' }, { type: 'look' });
  await actBoth({ type: 'click', x: 180, y: 178 }, { type: 'click', x: 180, y: 110 }); // A: Pay (stop-before) · B: opens the select list
  await actBoth({ type: 'click', x: 900, y: 600 }, { type: 'press_key', key: 'Escape' });
  assert.ok(texts.pa[1].includes('STOP: this would take you to "payment"'), texts.pa[1]);
  assert.ok(!texts.pb.join('\n').includes('STOP'), 'no note crosses to B');

  const saved = JSON.parse(textOf(await call('harness_save_state', { session: 'pa', path: statePath })));
  assert.deepEqual(saved, { path: statePath, cookies: 0, origins: 0 });

  const sigA = JSON.parse(textOf(await call('harness_signals', { session: 'pa' })));
  const sigB = JSON.parse(textOf(await call('harness_signals', { session: 'pb' })));
  assert.equal(sigA.stop_before, 'payment');
  assert.equal(sigB.stop_before, null);
  assert.ok(!sigA.events.some((e) => e.type.startsWith('picker-select')), 'B\'s select stand-in is not logged in A');
  assert.ok(sigB.events.some((e) => e.type === 'picker-select-shown'));
  assert.ok(!sigB.events.some((e) => e.type === 'stop-before'));

  const log = (dir) => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const [dir, page] of [[dirA, 'safety.html'], [dirB, 'select.html']]) {
    const entries = log(dir);
    assert.equal(entries.length, 3);
    assert.ok(entries.every((e) => e.url.includes(page)), `${dir}: ${entries.map((e) => e.url)}`);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'screenshots')).sort(), ['s01.png', 's02.png', 's03.png']);
    assert.deepEqual(entries.map((e) => e.screenshot), ['screenshots/s01.png', 'screenshots/s02.png', 'screenshots/s03.png']);
  }

  await call('harness_stop', { session: 'pa' });
  const still = await call('act', step('pb', { type: 'click', x: 180, y: 110 }));
  assert.equal(still.isError, undefined, textOf(still));
  assert.match(textOf(still), /Step 3 of 30/);
  await call('harness_stop', { session: 'pb' });
});

test('harness_start takes clock; act states the wait cap of the session started last', async () => {
  const actOf = async () => (await client.listTools()).tools.find((t) => t.name === 'act').description;
  const { tools } = await client.listTools();
  assert.deepEqual(tools.find((t) => t.name === 'harness_start').inputSchema.properties.clock.enum, ['real', 'controlled']);
  assert.equal(tools.find((t) => t.name === 'harness_start').inputSchema.properties.goal.type, 'string');
  assert.match(await actOf(), /wait \{seconds ≤ 10\}/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxs-mcp-clock-'));
  const started = await call('harness_start', { session: 'clk', dir, url: fx.url('clock.html'), clock: 'controlled' });
  assert.equal(started.isError, undefined, textOf(started));
  assert.equal(JSON.parse(textOf(started)).clock, 'controlled');
  assert.match(await actOf(), /wait \{seconds ≤ 600\}/);
  const bad = await call('act', step('clk', { type: 'wait', seconds: 601 }));
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /between 0 and 600/);
  await call('harness_stop', { session: 'clk' });
  const bogus = await call('harness_start', { session: 'clk2', dir, url: fx.url('clock.html'), clock: 'fast' }).then((r) => r.isError, () => true);
  assert.equal(bogus, true);
  await call('harness_start', { session: 'clk3', dir, url: fx.url('clock.html') });
  assert.match(await actOf(), /wait \{seconds ≤ 10\}/);
  await call('harness_stop', { session: 'clk3' });
});
