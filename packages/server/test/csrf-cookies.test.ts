import { describe, it, expect } from 'vitest';
import { generateCsrfToken, verifyCsrfToken } from '../src/http/csrf.js';
import { parseCookies, serializeCookie } from '../src/http/cookies.js';

describe('CSRF double-submit', () => {
  it('accepts a matching cookie/header pair and rejects a mismatch', () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(token, token)).toBe(true);
    expect(verifyCsrfToken(token, generateCsrfToken())).toBe(false);
  });

  it('rejects when either side is missing', () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(undefined, token)).toBe(false);
    expect(verifyCsrfToken(token, undefined)).toBe(false);
    expect(verifyCsrfToken(undefined, undefined)).toBe(false);
  });
});

describe('cookie parse/serialize', () => {
  it('parses a Cookie header into a map', () => {
    expect(parseCookies('a=1; b=hello%20world; c=')).toEqual({ a: '1', b: 'hello world', c: '' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('serializes httpOnly/sameSite/secure attributes', () => {
    const cookie = serializeCookie('oo_session', 'abc123', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAgeSec: 3600,
    });
    expect(cookie).toContain('oo_session=abc123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('clears a cookie with Max-Age=0', () => {
    const cookie = serializeCookie('oo_session', '', { expiresNow: true });
    expect(cookie).toContain('Max-Age=0');
  });
});
