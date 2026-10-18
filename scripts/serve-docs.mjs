// Serves the repo on http://127.0.0.1:4173 (loopback only) so docs/backdrops/index.html can load the
// built package (dist/backdrops/index.js) as an ES module, which browsers refuse over file://.
// Usage: npm run build && node scripts/serve-docs.mjs   (or: npm run demo:backdrops)
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const port = Number(process.env.PORT ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root + sep) && path !== root) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
    statSync(path);
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(path).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`Backdrop demo: http://127.0.0.1:${port}/docs/backdrops/`);
});
