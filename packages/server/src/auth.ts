// Web session cookies.
//
// The token carries the user id, an expiry and a CSRF nonce, signed with the
// secret from the config file. HttpOnly and SameSite=Strict; Secure is added
// when the UI is served over TLS. State-changing requests must echo the CSRF
// nonce in a header, which a cross-site form post cannot do.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'rfmail_session';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionPayload {
  uid: number;
  csrf: string;
  /** Epoch seconds. */
  exp: number;
}

export class Sessions {
  private readonly secret: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error('session secret is empty');
    this.secret = Buffer.from(secret, 'utf8');
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(uid: number, maxAgeSeconds: number = MAX_AGE_SECONDS): { token: string; payload: SessionPayload } {
    const payload: SessionPayload = {
      uid,
      csrf: randomBytes(18).toString('base64url'),
      exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return { token: `${encoded}.${this.sign(encoded)}`, payload };
  }

  verify(token: string): SessionPayload | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const encoded = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = this.sign(encoded);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const payload = parsed as SessionPayload;
      if (typeof payload.uid !== 'number' || typeof payload.csrf !== 'string' || typeof payload.exp !== 'number') {
        return null;
      }
      if (payload.exp * 1000 < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  cookieHeader(token: string, secure: boolean): string {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${MAX_AGE_SECONDS}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookieHeader(secure: boolean): string {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}
