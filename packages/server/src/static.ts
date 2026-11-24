// Static files for the web UI, with an SPA fallback.
//
// The build is produced by `npm run build:web` (SvelteKit, adapter-static) into
// apps/web/build. Hashed assets are immutable; index.html is never cached, so a
// rebuilt UI is picked up on the next reload.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { sendError, type Handler } from './http.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>rfmail</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #10151c; color: #e6edf3; }
  main { max-width: 34rem; padding: 2rem; }
  code { background: #1b2430; padding: .15rem .4rem; border-radius: .25rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  p { color: #9fb0c0; }
</style></head>
<body><main>
  <h1>rfmail backend is running</h1>
  <p>The web interface has not been built yet. Run
     <code>npm run build:web</code> and reload this page.</p>
  <p>The API is available at <code>/api/status</code>.</p>
</main></body></html>`;

export function createStaticHandler(uiDir: string): Handler {
  const root = resolve(uiDir);

  return (ctx) => {
    const { req, res, url } = ctx;
    if (url.pathname.startsWith('/api/')) {
      sendError(res, 404, 'no such API route');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed');
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendError(res, 400, 'invalid path');
      return;
    }

    let target = resolve(join(root, normalize(pathname)));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      sendError(res, 403, 'forbidden');
      return;
    }
    if (existsSync(target) && statSync(target).isDirectory()) {
      target = join(target, 'index.html');
    }
    if (!existsSync(target)) {
      // A missing file with an extension is a 404; anything else is a
      // client-side route and gets the SPA shell.
      if (extname(pathname) !== '') {
        sendError(res, 404, 'not found');
        return;
      }
      target = join(root, 'index.html');
    }
    if (!existsSync(target)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(PLACEHOLDER);
      return;
    }

    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    const immutable = target.includes(`${sep}_app${sep}immutable${sep}`);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}
