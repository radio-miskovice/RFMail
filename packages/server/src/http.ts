// A very small HTTP router: exact segments plus `:param` captures.
//
// No framework: the API is a few dozen routes, and keeping the request path
// explicit makes the auth and CSRF checks impossible to bypass by accident.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserRecord } from '@rfmail/store';
import type { SessionPayload } from './auth.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  session: SessionPayload | null;
  remote: string;
  /** Present only when a valid session resolved to an enabled account. */
  user?: UserRecord;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  readonly fields: Record<string, string> | undefined;
  readonly extra: Record<string, unknown> | undefined;

  constructor(
    status: number,
    message: string,
    fields?: Record<string, string>,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.extra = extra;
  }
}

export class Router {
  private readonly routes: Route[] = [];
  private fallback: Handler | null = null;

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter((segment) => segment !== ''),
      handler,
    });
    return this;
  }

  /** Handler for anything no route matched (static files, SPA fallback). */
  setFallback(handler: Handler): void {
    this.fallback = handler;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter((segment) => segment !== '');
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pattern = route.segments[i] ?? '';
        const value = parts[i] ?? '';
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(value);
        } else if (pattern !== value) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  async dispatch(ctx: Ctx): Promise<boolean> {
    const matched = this.match(ctx.req.method ?? 'GET', ctx.url.pathname);
    if (!matched) {
      if (!this.fallback) return false;
      await this.fallback(ctx);
      return true;
    }
    Object.assign(ctx.params, matched.params);
    await matched.handler(ctx);
    return true;
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(req: IncomingMessage, limit = 64 * 1024): Promise<T> {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'malformed JSON body');
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Uint8Array,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    ...extraHeaders,
  });
  res.end(Buffer.from(body));
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(res, status, { error: message, ...extra });
}
