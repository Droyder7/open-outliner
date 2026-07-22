/**
 * Minimal cookie parse/serialize — no framework dependency. Session cookie is
 * httpOnly (never readable by JS); the CSRF cookie is deliberately not
 * httpOnly so client JS can echo it back as a header (double-submit, below).
 */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  maxAgeSec?: number;
  /** Omit to clear the cookie (Max-Age=0). */
  expiresNow?: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path ?? '/'}`);
  if (opts.expiresNow) {
    segments.push('Max-Age=0');
  } else if (opts.maxAgeSec !== undefined) {
    segments.push(`Max-Age=${Math.floor(opts.maxAgeSec)}`);
  }
  segments.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.secure) segments.push('Secure');
  if (opts.httpOnly) segments.push('HttpOnly');
  return segments.join('; ');
}
