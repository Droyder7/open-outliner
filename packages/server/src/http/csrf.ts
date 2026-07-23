import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CSRF protection for the cookie-authenticated `/rpc` edge (ADR-0014 "CSRF
 * protection is required on the REST edge"). Double-submit cookie: a
 * non-httpOnly `oo_csrf` cookie is set alongside the session cookie at
 * Login/Signup; the client must echo its value back as the `X-CSRF-Token`
 * header on every mutating call. A cross-site form/script can trigger the
 * cookie to be sent automatically but cannot read it to set the header
 * (same-origin policy), so the header/cookie match proves the request
 * originated from same-origin JS.
 */

export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function verifyCsrfToken(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (!cookieToken || !headerToken) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(headerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
