#!/usr/bin/env node
// Stdio MCP server for the ux-assessment plugin. One process serves every persona session of a run
// (subagents share their parent's MCP connection — SPIKE Q1), each session with its own Chromium.
//   Persona tools : act, end_session           (the only tools agents/persona.md is given)
//   Viewer tools  : view, answer               (design mode: a static session, no browser)
//   Harness tools : harness_start, harness_design_start, harness_eval, harness_signals, harness_save_state, harness_stop
//                   (orchestrator only; harness_signals also goes to a verifier through persona-bridge.mjs, never to a persona;
//                   harness_signals and harness_stop take either kind of session)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session, VIEWPORTS } from './session.mjs';
import { registerPersonaTools, registerSignalsTool } from './persona-tools.mjs';
import { registerViewerTools } from './viewer-tools.mjs';
import { StaticSession, DEFAULT_VIEWS_PER_FRAME } from './static-session.mjs';
import { CLOCK_MODES } from './clock.mjs';

// Browser sessions and static (design mode) sessions are separate registries: act and end_session never reach a static
// session, view and answer never reach a browser one, and an id lives in one registry at most.
const sessions = new Map();
const designSessions = new Map();
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const json = (v) => text(JSON.stringify(v, null, 2));

function get(id) {
  const s = sessions.get(id);
  if (s === null) throw new Error(`SESSION_STARTING: "${id}" is still starting.`);
  if (!s) throw new Error(`UNKNOWN_SESSION: no open browser session "${id}".`);
  return s;
}
function getDesign(id) {
  const s = designSessions.get(id);
  if (!s) throw new Error(`UNKNOWN_SESSION: no open session "${id}".`);
  return s;
}
const getAny = (id) => designSessions.get(id) ?? get(id);
// Any thrown error becomes a tool error result, never a crash of the server (other sessions keep running).
const safe = (fn) => async (args) => {
  try { return await fn(args); } catch (e) { return text(e.message.split('\n')[0], true); }
};

const server = new McpServer({ name: 'ux-assessment-browser', version: '0.1.0' });
const personaTools = registerPersonaTools(server, get);
registerViewerTools(server, getDesign);

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
    expectations: z.boolean().optional().describe('true for a persona session: act then requires "expect" before a click, double_click, drag, type or press_key, and "expectation_met" on the call after it. Leave out for a setup login or a verifier.'),
    goal: z.string().optional().describe('The persona\'s goal, verbatim from its briefing\'s "What you want" line. GOAL_CHECK quotes it back before goal_achieved counts; nothing else sees it.'),
    clock: z.enum(CLOCK_MODES).optional().describe('Page time: real (default) or controlled (the harness owns timers: paused while the persona thinks, wait up to 600 s that ends when the screen changes). From the charter; the same for every session of a run.'),
  },
}, safe(async ({ session, dir, url, viewport, cap, patience_budget, fs, autoplay, headed, safety, files, permissions, storage_state, clock, goal, expectations }) => {
  if (sessions.has(session) || designSessions.has(session)) throw new Error(`SESSION_EXISTS: "${session}" is already open; stop it first.`);
  sessions.set(session, null); // reserve the id while Chromium starts (parallel starts)
  let s;
  try {
    s = await Session.start({ id: session, dir, url, viewport, cap, patienceBudget: patience_budget ?? null, fsMode: fs, autoplay, headed,
      safety, files, permissions, storageState: storage_state, clock, goal, expectations });
  } catch (e) { sessions.delete(session); throw e; }
  sessions.set(session, s);
  personaTools.setWaitCap(s.waitCap);
  return json({ session, dir: s.dir, url, viewport: s.viewport, cap: s.cap, patience_budget: s.patienceBudget, fs: s.fsMode,
    safety: { external_navigation: s.safety.external_navigation, allowed_hosts: [...s.allowedHosts] }, files: s.files, permissions: s.permissions,
    storage_state: s.storageState, clock: s.clockMode, expectations: s.expectations });
}));

server.registerTool('harness_design_start', {
  title: 'Harness: open a viewer session on a design frame',
  description: [
    'HARNESS ONLY. Opens a static session for one viewer on one frame of a design snapshot folder (written by figma.mjs) and starts logging to',
    '<dir>/design-log.jsonl and <dir>/screenshots/. No browser is launched. The viewer gets the tools view and answer and nothing else.',
    'A frame at most 480 px wide is a touch device. follow_links lets the harness move the viewer along the prototype links by its first click',
    '(it needs first_click); a flow ends after 8 frames. first_click true asks the viewer where it would click first for its goal.',
    'The frame must have an image. The viewer is never told frame names, layer names or the file.',
  ].join(' '),
  inputSchema: {
    session: z.string().describe('Unique id, e.g. "<persona-id>-<frame>". Not shared with a browser session.'),
    dir: z.string().describe('Absolute path of the viewer run folder, e.g. <project>/.ux-assessment/runs/<date>/<viewer-id>.'),
    design: z.string().describe('Absolute path of the snapshot folder that holds design.json and frames/.'),
    frame: z.string().describe('Id of the frame to show first, e.g. "12:34".'),
    follow_links: z.boolean().optional().describe('true for a flow: the first click is hit-tested and moves the viewer. Default false.'),
    first_click: z.boolean().optional().describe('true for the tiers goal and keyed: after_reading must carry first_click. Default false.'),
    views_per_frame: z.number().int().min(1).max(100).optional().describe(`Most view calls per frame (default ${DEFAULT_VIEWS_PER_FRAME}).`),
  },
}, safe(async ({ session, dir, design, frame, follow_links, first_click, views_per_frame }) => {
  if (sessions.has(session) || designSessions.has(session)) throw new Error(`SESSION_EXISTS: "${session}" is already open; stop it first.`);
  const s = StaticSession.start({
    id: session, dir, design, frame, followLinks: follow_links ?? false, firstClick: first_click ?? false, viewsPerFrame: views_per_frame ?? DEFAULT_VIEWS_PER_FRAME,
  });
  designSessions.set(session, s);
  return json({ session, dir: s.dir, design: s.design, frame, device: s.device, frame_size: s.frameSize, fold_height: s.foldHeight,
    follow_links: s.followLinks, first_click: s.firstClick, views_per_frame: s.viewsPerFrame });
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

registerSignalsTool(server, getAny);

server.registerTool('harness_stop', {
  title: 'Harness: close a persona session',
  description: 'HARNESS ONLY. Records final signals, closes the browser and deletes its profile. Returns the final summary. Also closes a viewer session (harness_design_start), which has no browser.',
  inputSchema: { session: z.string() },
}, safe(async ({ session }) => {
  const s = getAny(session);
  let summary;
  if (designSessions.has(session)) { // a viewer has no page to read first, and stopping first makes `over` say "stopped" for an unfinished one
    await s.stop();
    summary = await s.signals();
  } else {
    summary = await s.signals();
    await s.stop();
  }
  sessions.delete(session);
  designSessions.delete(session);
  return json(summary);
}));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([...sessions.values(), ...designSessions.values()].filter(Boolean).map((s) => s.stop()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
