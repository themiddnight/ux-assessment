import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFixtureServer } from './fixture-server.mjs';
import { Session } from '../session.mjs';
import { startPersonaBridge } from '../persona-bridge.mjs';

test('persona bridge exposes only two tools to one session', async () => {
  const fixture = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-bridge-'));
  const session = await Session.start({ id: 'only', dir, url: fixture.url('basic.html') });
  const bridge = await startPersonaBridge(session);
  const client = new Client({ name: 'bridge-test', version: '0' });
  try {
    // Change the token's last hex digit to a different one (a fixed '0' left the URL valid 1 time in 16).
    const wrongUrl = bridge.url.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    assert.equal((await fetch(wrongUrl, { method: 'POST' })).status, 404);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['act', 'end_session']);
    const wrong = await client.callTool({ name: 'act', arguments: {
      session: 'wrong', observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action: { type: 'look' },
    } });
    assert.equal(wrong.isError, true);
    assert.match(wrong.content[0].text, /UNKNOWN_SESSION/);
    const look = await client.callTool({ name: 'act', arguments: {
      session: 'only', observation: 'o', reaction: 'r', event: 'none', frustration_delta: 0, action: { type: 'look' },
    } });
    assert.equal(look.isError, undefined);
    assert.ok(look.content.some((c) => c.type === 'image'));
  } finally {
    await client.close();
    await bridge.close();
    await session.stop();
    await fixture.close();
  }
});

test('verifier bridge adds harness_signals for its own session only', async () => {
  const fixture = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-bridge-v-'));
  const session = await Session.start({ id: 'F-03', dir, url: fixture.url('basic.html'), cap: 15 });
  const bridge = await startPersonaBridge(session, { role: 'verifier' });
  const client = new Client({ name: 'bridge-test', version: '0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['act', 'end_session', 'harness_signals']);
    const signals = await client.callTool({ name: 'harness_signals', arguments: { session: 'F-03' } });
    assert.equal(JSON.parse(signals.content[0].text).cap, 15);
    const other = await client.callTool({ name: 'harness_signals', arguments: { session: 'core' } });
    assert.equal(other.isError, true);
    await assert.rejects(startPersonaBridge(session, { role: 'planner' }), /role must be "persona" or "verifier"/);
  } finally {
    await client.close();
    await bridge.close();
    await session.stop();
    await fixture.close();
  }
});

test('the bridge states its session\'s wait cap in the act description', async () => {
  const fixture = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxa-bridge-'));
  const session = await Session.start({ id: 'timed', dir, url: fixture.url('clock.html'), clock: 'controlled' });
  const bridge = await startPersonaBridge(session);
  const client = new Client({ name: 'bridge-test', version: '0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
    const act = (await client.listTools()).tools.find((t) => t.name === 'act');
    assert.match(act.description, /wait \{seconds ≤ 600\}/);
  } finally {
    await client.close();
    await bridge.close();
    await session.stop();
    await fixture.close();
  }
});
