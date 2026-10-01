import { z } from 'zod';
import { ACTION_TYPES, EVENTS, OUTCOMES } from './session.mjs';

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
const safe = (fn) => async (args) => {
  try { return await fn(args); } catch (error) { return text(error.message.split('\n')[0], true); }
};

/** The act tool's description. It states the session's wait cap: 10 s, or 600 s under clock: controlled. */
export function actDescription(waitCap = 10) {
  return [
    'Your only way to use the app. Each call is one step: say what you see and feel, then do exactly one action.',
    'Returns what the screen looks like afterwards. Coordinates are screen pixels in the latest screenshot (top-left is 0,0).',
    'Actions: look (just look — your first look is free), click {x,y}, double_click {x,y}, drag {x,y,to_x,to_y},',
    'type {text} (types into whatever has focus), press_key {key, e.g. "Enter", "Escape", "Tab", "Control+z"},',
    `scroll {dy: pixels, positive = down; optional x,y where to scroll}, wait {seconds ≤ ${waitCap}}, reload, back.`,
    'Always describe the target in words in "target" (e.g. "the green Play button").',
  ].join(' ');
}

export function registerPersonaTools(server, session, { waitCap = 10 } = {}) {
  const act = server.registerTool('act', {
    title: 'Do one thing in the browser',
    description: actDescription(waitCap),
    inputSchema: {
      session: z.string().describe('Your session id, exactly as given in your briefing.'),
      observation: z.string().describe('FACT: what you see on the screen right now, before acting. Quote visible text verbatim.'),
      reaction: z.string().describe('REACTION: what you think or feel about it, in character, thinking aloud.'),
      event: z.enum(EVENTS).describe('Frustration event caused by what you just saw, or "none".'),
      frustration_delta: z.number().describe('Frustration points this observation adds (0 if none).'),
      action: z.object({
        type: z.enum(ACTION_TYPES), target: z.string().optional().describe('What you are aiming at, in your own words.'),
        x: z.number().optional(), y: z.number().optional(), to_x: z.number().optional(), to_y: z.number().optional(),
        text: z.string().optional(), key: z.string().optional(), dy: z.number().optional(), seconds: z.number().optional(),
      }),
    },
  }, safe(async ({ session: id, action, ...fields }) => {
    const current = session(id);
    const driverAction = action.type === 'drag'
      ? { ...action, from: { x: action.x, y: action.y }, to: { x: action.to_x, y: action.to_y } }
      : action;
    if (action.type === 'drag') for (const key of ['x', 'y', 'to_x', 'to_y']) delete driverAction[key];
    const result = await current.act({ ...fields, action: driverAction });
    const content = [{ type: 'text', text: result.text }];
    if (result.png) content.push({ type: 'image', data: result.png.toString('base64'), mimeType: 'image/png' });
    return { content, ...(result.ok ? {} : { isError: true }) };
  }));

  server.registerTool('end_session', {
    title: 'Finish your session',
    description: 'Call when you are done: goal reached, you give up, you ran out of steps or patience, or you reached a step you were told to stop before. Records your exit interview. Required: your session counts only once this answers "Exit interview recorded", so call it before you write your final reply; if it answers GOAL_CHECK, follow that and call it again.',
    inputSchema: {
      session: z.string(), outcome: z.enum(OUTCOMES),
      final_observation: z.string().describe('FACT: what the screen shows now, at the end (your evidence for the outcome).'),
      exit_interview: z.object({
        what_it_is_for: z.string().describe('In your own words: what is this app for?'),
        would_come_back: z.enum(['yes', 'no', 'maybe']),
        reason: z.string().describe('A concrete reason for coming back or not.'),
        most_confusing: z.string().describe('What confused you most.'),
      }),
    },
  }, safe(async ({ session: id, outcome, final_observation, exit_interview }) =>
    text(session(id).end({ outcome, final_observation, exit_interview }))));

  let cap = waitCap;
  return {
    /** The shared MCP server hosts every session of a run: state the cap of the session started last. */
    setWaitCap(next) {
      if (next === cap) return;
      cap = next;
      act.update({ description: actDescription(cap) }); // sends tools/list_changed
    },
  };
}

/** Harness signals for one session. The orchestrator and a verifier get this tool; a persona never does. */
export function registerSignalsTool(server, session) {
  server.registerTool('harness_signals', {
    title: 'Harness: what actually happened',
    description: 'For the orchestrator and the verifier; a persona never gets this tool. Step count, frustration, audio stats, file/download/picker events, page errors, OPFS files.',
    inputSchema: { session: z.string() },
  }, safe(async ({ session: id }) => text(JSON.stringify(await session(id).signals(), null, 2))));
}
