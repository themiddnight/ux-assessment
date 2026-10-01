import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerPersonaTools, registerSignalsTool } from './persona-tools.mjs';

/** The roles a bridge (and the Codex runner) serves. A verifier also gets harness_signals. */
export const ROLES = ['persona', 'verifier'];

export function checkRole(role) {
  if (!ROLES.includes(role)) throw new Error(`role must be ${ROLES.map((r) => `"${r}"`).join(' or ')}`);
  return role;
}

/** Start a short-lived, one-session MCP endpoint for a persona or a verifier. The caller owns the browser. */
export async function startPersonaBridge(session, { role = 'persona' } = {}) {
  checkRole(role);
  const token = crypto.randomBytes(32).toString('hex');
  const pathname = `/mcp/${token}`;
  const transports = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.url !== pathname) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const mcp = new McpServer({ name: 'ux-assessment-persona', version: '0.1.0' });
    const lookup = (id) => {
      if (id !== session.id) throw new Error('UNKNOWN_SESSION: this browser belongs to another persona.');
      return session;
    };
    registerPersonaTools(mcp, lookup, { waitCap: session.waitCap });
    if (role === 'verifier') registerSignalsTool(mcp, lookup);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transports.add(transport);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      transports.delete(transport);
      await transport.close();
      await mcp.close();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}${pathname}`,
    port: server.address().port,
    close: async () => {
      server.closeAllConnections();
      await Promise.allSettled([...transports].map((t) => t.close()));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
