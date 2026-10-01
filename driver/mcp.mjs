#!/usr/bin/env node
// Stdio MCP server for the ux-assessment plugin. One process serves every persona session of a run
// (subagents share their parent's MCP connection — SPIKE Q1), each session with its own Chromium.
//   Persona tools : act, end_session           (the only tools agents/persona.md is given)
//   Harness tools : harness_start, harness_eval, harness_signals, harness_save_state, harness_stop (orchestrator only;
//                   harness_signals also goes to a verifier through persona-bridge.mjs, never to a persona)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session, VIEWPORTS } from './session.mjs';
import { registerPersonaTools, registerSignalsTool } from './persona-tools.mjs';
import { CLOCK_MODES } from './clock.mjs';

const sessions = new Map();
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const json = (v) => text(JSON.stringify(v, null, 2));

function get(id) {
  const s = sessions.get(id);
  if (s === null) throw new Error(`SESSION_STARTING: "${id}" is still starting.`);
  if (!s) throw new Error(`UNKNOWN_SESSION: no open browser session "${id}".`);
  return s;
}
// Any thrown error becomes a tool error result, never a crash of the server (other sessions keep running).
const safe = (fn) => async (args) => {
  try { return await fn(args); } catch (e) { return text(e.message.split('\n')[0], true); }
};

const server = new McpServer({ name: 'ux-assessment-browser', version: '0.1.0' });
const personaTools = registerPersonaTools(server, get);

server.registerTool('harness_start', {
  title: 'Harness: open a persona browser session',
  description: [
    'HARNESS ONLY — never give to personas. Launches a fresh Chromium for one persona, opens the entry URL (not counted as a step)',
    'and starts logging to <dir>/log.jsonl, <dir>/signals.jsonl and <dir>/screenshots/.',
    'Safety is enforced: navigating the page to a host other than the entry host, localhost, 127.0.0.1 or safety.allow_hosts is aborted',
    'and the persona is told to stop (external_navigation: stop, the default). Requests matching safety.stop_before are aborted the same way;',
    'safety.block patterns are aborted silently. Patterns are "/regex/flags" or a case-insensitive URL substring.',
    'File inputs, date/time/color inputs and permission prompts show visible stand-in dialogs.',
    'storage_state restores a state saved by harness_save_state (a returning, logged-in user).',
    'clock controlled lets the harness own page time (long in-app timers, deadlines at human speed); one value per run.',
  ].join(' '),
  inputSchema: {
    session: z.string().describe('Unique id, e.g. "<persona-id>".'),
    dir: z.string().describe('Absolute path of the persona run folder, e.g. <project>/.ux-assessment/runs/<date>/<persona-id>.'),
    url: z.string().describe('Entry URL the persona starts on.'),
    viewport: z.enum(Object.keys(VIEWPORTS)).optional().describe('Default desktop (1280x800); mobile-small is 360x640 touch.'),
    cap: z.number().int().min(1).max(200).optional().describe('Step cap (default 30).'),
    patience_budget: z.number().int().min(1).optional().describe('Frustration points before the persona gives up.'),
    fs: z.enum(['shim', 'none', 'native']).optional().describe('File pickers: shim (default, visible stand-in dialog), none (app falls back to downloads), native.'),
    autoplay: z.enum(['gesture', 'free']).optional().describe('Audio autoplay policy; gesture (default) matches desktop Chrome.'),
    headed: z.boolean().optional(),
    safety: z.object({
      external_navigation: z.enum(['stop', 'allow']).optional().describe('stop (default): leaving the app\'s hosts ends the test; allow: let it through.'),
      allow_hosts: z.array(z.string()).optional().describe('Extra host names the persona may navigate to (exact match).'),
      stop_before: z.array(z.object({ pattern: z.string(), label: z.string(), max: z.number().int().min(0).optional() })).optional()
        .describe('Requests to abort with a STOP note, e.g. {pattern: "/api/checkout", label: "payment"}. max: let the first N matching requests through, stop the next (default 0), e.g. {pattern: "/api/ask-ai", label: "asking the AI", max: 1}.'),
      block: z.array(z.string()).optional().describe('Requests to abort silently (analytics, e-mail sends).'),
    }).optional().describe('Enforced safety. Default {external_navigation: "stop"}.'),
    files: z.string().optional().describe('Absolute path of a folder whose files the <input type=file> stand-in offers.'),
    permissions: z.enum(['prompt', 'grant', 'deny']).optional().describe('Camera/microphone/MIDI/notifications/location: prompt (default, a visible Allow/Block prompt), grant, deny.'),
    storage_state: z.string().optional().describe('Absolute path of a state file saved by harness_save_state: start as a returning user.'),
    goal: z.string().optional().describe('The persona\'s goal, verbatim from its briefing\'s "What you want" line. GOAL_CHECK quotes it back before goal_achieved counts; nothing else sees it.'),
    clock: z.enum(CLOCK_MODES).optional().describe('Page time: real (default) or controlled (the harness owns timers: paused while the persona thinks, wait up to 600 s that ends when the screen changes). From the charter; the same for every session of a run.'),
  },
}, safe(async ({ session, dir, url, viewport, cap, patience_budget, fs, autoplay, headed, safety, files, permissions, storage_state, clock, goal }) => {
  if (sessions.has(session)) throw new Error(`SESSION_EXISTS: "${session}" is already open; stop it first.`);
  sessions.set(session, null); // reserve the id while Chromium starts (parallel starts)
  let s;
  try {
    s = await Session.start({ id: session, dir, url, viewport, cap, patienceBudget: patience_budget ?? null, fsMode: fs, autoplay, headed,
      safety, files, permissions, storageState: storage_state, clock, goal });
  } catch (e) { sessions.delete(session); throw e; }
  sessions.set(session, s);
  personaTools.setWaitCap(s.waitCap);
  return json({ session, dir: s.dir, url, viewport: s.viewport, cap: s.cap, patience_budget: s.patienceBudget, fs: s.fsMode,
    safety: { external_navigation: s.safety.external_navigation, allowed_hosts: [...s.allowedHosts] }, files: s.files, permissions: s.permissions,
    storage_state: s.storageState, clock: s.clockMode });
}));

server.registerTool('harness_save_state', {
  title: 'Harness: save a logged-in state',
  description: 'HARNESS ONLY. Saves cookies, localStorage and IndexedDB of the session to <path> (a Playwright storageState JSON) for later harness_start storage_state. Returns {path, cookies, origins} (counts). The file holds credentials: keep it out of git.',
  inputSchema: { session: z.string(), path: z.string().describe('Absolute path of the JSON file to write.') },
}, safe(async ({ session, path }) => json(await get(session).saveState(path))));

server.registerTool('harness_eval', {
  title: 'Harness: evaluate JS in a persona page',
  description: 'HARNESS ONLY. Evaluates a JS expression in the page for start-state setup or probes. Never counted as a step and grants no user activation. Returns the JSON value.',
  inputSchema: { session: z.string(), js: z.string() },
}, safe(async ({ session, js }) => json(await get(session).evalHarness(js) ?? null)));

registerSignalsTool(server, get);

server.registerTool('harness_stop', {
  title: 'Harness: close a persona session',
  description: 'HARNESS ONLY. Records final signals, closes the browser and deletes its profile. Returns the final summary.',
  inputSchema: { session: z.string() },
}, safe(async ({ session }) => {
  const s = get(session);
  const summary = await s.signals();
  await s.stop();
  sessions.delete(session);
  return json(summary);
}));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([...sessions.values()].filter(Boolean).map((s) => s.stop()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
