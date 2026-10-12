// The two tools a viewer is given in design mode: view and answer. A viewer has no other tool.
import { z } from 'zod';
import { ANSWER_SCHEMAS } from './static-session.mjs';

// The session reports its own refusals as results. A thrown error is the unknown id, or something unexpected (a file that
// would not write) whose message can hold the path of the run folder, which the viewer must not see.
const safe = (fn) => async (args) => {
  try { return await fn(args); } catch (error) {
    const message = String(error?.message).split('\n')[0];
    const text = message.startsWith('UNKNOWN_SESSION: ') ? message : 'FAILED: this call did not work. Try it once more.';
    return { content: [{ type: 'text', text }], isError: true };
  }
};

/** A tool result from a session result: the text, the picture as an image block when there is one, and an error flag for a refusal. */
function resultOf(result) {
  const content = [{ type: 'text', text: result.text }];
  if (result.png) content.push({ type: 'image', data: result.png.toString('base64'), mimeType: 'image/png' });
  return { content, ...(result.ok ? {} : { isError: true }) };
}

/** Registers `view` and `answer`. `lookup(id)` returns the open StaticSession of an id or throws UNKNOWN_SESSION. */
export function registerViewerTools(server, lookup) {
  server.registerTool('view', {
    title: 'Look at the screen',
    description: [
      'Look at the screen in front of you. The first call shows the top of the screen as a picture.',
      'If the screen is longer than the picture, call again with scroll "down" to see more, or "up" to go back.',
      'You can scroll only after you have given your first_look answer, and you can look only a limited number of times, so read with care.',
    ].join(' '),
    inputSchema: {
      session: z.string().describe('Your session id, exactly as given in your instructions.'),
      scroll: z.enum(['down', 'up']).optional().describe('Leave out to see the part you are on again.'),
    },
  }, safe(async ({ session, scroll }) => resultOf(await lookup(session).view({ scroll }))));

  server.registerTool('answer', {
    title: 'Give your answers',
    description: [
      'Give your answers about the screen in two parts, in this order: first_look, right after your first look and before you scroll,',
      'then after_reading, once you have read all of the screen. Send one part in each call, and each part only once.',
      'A point is [x, y] in pixels of the latest picture you were shown, counted from its top-left corner.',
      'If you cannot tell what something is for, say so with the confidence cannot_tell instead of guessing.',
    ].join(' '),
    inputSchema: {
      session: z.string().describe('Your session id, exactly as given in your instructions.'),
      first_look: ANSWER_SCHEMAS.first_look.optional(),
      after_reading: ANSWER_SCHEMAS.after_reading.optional(),
    },
  }, safe(async ({ session, first_look, after_reading }) => resultOf(await lookup(session).answer({ first_look, after_reading }))));
}
