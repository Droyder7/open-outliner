import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/http/rate-limit.js';

describe('rate limiter', () => {
  it('allows up to the limit then rejects within the window', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(false);
  });

  it('tracks keys independently', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('b')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(false);
  });
});
