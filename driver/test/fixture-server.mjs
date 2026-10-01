// Serves test/fixtures over http://127.0.0.1:<port> (OPFS and pickers need a real origin, not about:blank).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

export async function startFixtureServer() {
  const requests = []; // {method, path, cookie} of every request, for tests that check what reached the server
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/redirect') { // /redirect?to=<url>: a server redirect that also sets a cookie
      res.writeHead(Number(u.searchParams.get('status') ?? 302), { location: u.searchParams.get('to'), 'set-cookie': 'hop=1; path=/' });
      res.end();
      return;
    }
    if (u.pathname === '/slow') { // /slow?ms=<n>: answers after n ms of real time
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('slow'); }, Number(u.searchParams.get('ms') ?? 1500));
      return;
    }
    if (u.pathname === '/hang') return; // never answers: a hanging call or a long poll
    const name = u.pathname.slice(1) || 'basic.html';
    const file = path.join(DIR, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, requests, url: (p) => `http://127.0.0.1:${port}/${p}`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}
