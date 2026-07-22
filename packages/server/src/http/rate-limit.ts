/**
 * In-memory rate limiter for the login, presign, and WS-connect edges
 * (ADR-0014 / security-and-multitenancy.md open item). Single-node only —
 * correct for the V1 self-host topology (one app container per Compose,
 * self-hosting.md); a multi-node deployment needs a shared store (Redis),
 * same open item as the session store (ADR-0014 consequences).
 *
 * Fixed-window counter keyed by an arbitrary string (caller decides: IP,
 * `ip:email`, userId, ...).
 */

export interface RateLimiterOptions {
  /** Max allowed hits inside one window. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimiter {
  /** Records a hit for `key` and returns whether it is still within budget. */
  check(key: string): boolean;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, { count: number; windowStart: number }>();

  function sweep(now: number): void {
    // Bound memory: drop windows that have long since expired. Cheap enough
    // to run on every check given V1's expected self-host scale.
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > opts.windowMs) hits.delete(key);
    }
  }

  return {
    check(key: string): boolean {
      const now = Date.now();
      sweep(now);
      const entry = hits.get(key);
      if (!entry || now - entry.windowStart > opts.windowMs) {
        hits.set(key, { count: 1, windowStart: now });
        return true;
      }
      entry.count += 1;
      return entry.count <= opts.limit;
    },
  };
}
