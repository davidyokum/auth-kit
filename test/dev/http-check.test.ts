import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDevRouteAbsent, DEV_SIGNIN_MARKER, DEV_SIGNIN_MARKER_HEADER } from '../../src/dev/index.js';

let server: Server | undefined;
const seen: { method: string; host: string; url: string }[] = [];

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  seen.length = 0;
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', host: req.headers.host ?? '', url: req.url ?? '' });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('checkDevRouteAbsent (against a local stand-in for next start)', () => {
  it('passes when every forged request gets a plain 404', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 404;
      res.end('This page could not be found.');
    });
    const result = await checkDevRouteAbsent({ baseUrl: base });
    expect(result.ok).toBe(true);
    expect(seen.map((s) => s.host)).toContain('localhost' + base.slice(base.lastIndexOf(':')));
    expect(seen.map((s) => s.host)).toContain('[::1]' + base.slice(base.lastIndexOf(':')));
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(['POST', 'GET', 'DELETE']));
    expect(seen.every((s) => s.url === '/api/dev/sign-in')).toBe(true);
  });

  it('fails when the route answers (the dev route shipped)', async () => {
    const base = await serve((req, res) => {
      if (req.headers.host?.startsWith('localhost')) {
        res.setHeader(DEV_SIGNIN_MARKER_HEADER, DEV_SIGNIN_MARKER);
        res.statusCode = 200;
        res.end('{"ok":true}');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const result = await checkDevRouteAbsent({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.probes.find((p) => !p.ok)?.problem).toMatch(/marker/);
  });

  it('fails on a 401 from the auth proxy, and says to make the route public', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 401;
      res.end();
    });
    const result = await checkDevRouteAbsent({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.probes[0]?.problem).toMatch(/publicRoutes/);
  });

  it('fails on anything but 404, and when nothing answers', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 405;
      res.end();
    });
    expect((await checkDevRouteAbsent({ baseUrl: base })).probes[0]?.problem).toBe('got 405, not 404');
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const down = await checkDevRouteAbsent({ baseUrl: base, timeoutMs: 2000 });
    expect(down.ok).toBe(false);
    expect(down.probes[0]?.problem).toMatch(/request failed/);
  });
});
