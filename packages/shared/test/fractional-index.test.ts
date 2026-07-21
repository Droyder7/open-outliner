import { describe, it, expect } from 'vitest';
import {
  rankBetween,
  rankAfter,
  rankBefore,
  openSpace,
  compareRank,
} from '../src/fractional-index.js';

/** Assert byte-wise strict ordering a < b (matches Postgres COLLATE "C"). */
function expectOrdered(a: string, b: string) {
  expect(compareRank(a, b)).toBeLessThan(0);
}

describe('rankBetween — strictly between bounds, byte-wise', () => {
  it('lands strictly between two adjacent ranks', () => {
    const a = rankBetween(null, null); // a valid generated key
    const b = rankAfter(a);
    const mid = rankBetween(a, b, 'seed');
    expectOrdered(a, mid);
    expectOrdered(mid, b);
  });

  it('appends after an open upper bound', () => {
    const a = rankBetween(null, null);
    const r = rankAfter(a, 's1');
    expectOrdered(a, r);
  });

  it('prepends before an open lower bound', () => {
    const m = rankBetween(null, null);
    const r = rankBefore(m, 's1');
    expectOrdered(r, m);
  });

  it('rejects lower >= upper', () => {
    const a = rankBetween(null, null);
    const b = rankAfter(a);
    expect(() => rankBetween(b, a)).toThrow();
    expect(() => rankBetween(a, a)).toThrow();
  });

  it('append 1000× keeps keys short and strictly increasing', () => {
    let prev = rankAfter(null, 'a');
    let maxLen = prev.length;
    for (let i = 0; i < 1000; i++) {
      const next = rankAfter(prev, `x${i}`);
      expectOrdered(prev, next);
      maxLen = Math.max(maxLen, next.length);
      prev = next;
    }
    // Appending at the end is the cheap, common path — stays tiny.
    expect(maxLen).toBeLessThan(12);
  });

  it('balanced (midpoint) inserts keep keys short over 1000 ops', () => {
    // Plain midpoints (no jitter) inserted at spread positions — the realistic,
    // non-adversarial pattern. Jitter is tested separately; it trades a little
    // length for collision-spread and is not part of this length bound.
    const keys = [rankBetween(null, null)];
    let probe = 0;
    for (let i = 0; i < 1000; i++) {
      probe = (probe * 2 + 1) % (keys.length || 1); // spread, not front-biased
      const idx = Math.min(probe, keys.length - 1);
      const lo = keys[idx] ?? null;
      const hi = keys[idx + 1] ?? null;
      const mid = rankBetween(lo, hi); // no seed → plain shortest midpoint
      if (lo !== null) expectOrdered(lo, mid);
      if (hi !== null) expectOrdered(mid, hi);
      keys.splice(idx + 1, 0, mid);
    }
    const maxLen = Math.max(...keys.map((k) => k.length));
    expect(maxLen).toBeLessThan(20);
  });
});

describe('collision handling (ADR-0005) — total order is (rank, id), never rank alone', () => {
  it('two different seeds between the same bounds usually differ (jitter)', () => {
    const a = rankBetween(null, null);
    const b = rankAfter(rankAfter(rankAfter(a))); // widen the gap so buckets differ
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) results.add(rankBetween(a, b, `item-${i}`));
    expect(results.size).toBeGreaterThan(1);
  });

  it('openSpace on an exact collision produces a valid rank strictly greater than the shared one', () => {
    const shared = rankBetween(null, null);
    const r = openSpace(shared, shared, 'item-1');
    expectOrdered(shared, r);
    // Result is itself a valid key usable as a future bound.
    expect(() => rankAfter(r)).not.toThrow();
  });

  it('openSpace between a collided pair does not require touching neighbors', () => {
    const lo = rankBetween(null, null);
    const hi = rankAfter(lo);
    const r = openSpace(lo, hi, 'item-x');
    expectOrdered(lo, r);
    expectOrdered(r, hi);
  });

  it('two offline clients between the same bounds converge to a stable order via (rank, id)', () => {
    const lo = rankBetween(null, null);
    const hi = rankAfter(rankAfter(lo));
    const clientA = { id: 'aaaa', rank: rankBetween(lo, hi, 'aaaa') };
    const clientB = { id: 'bbbb', rank: rankBetween(lo, hi, 'bbbb') };
    const cmp = (x: typeof clientA, y: typeof clientA) => {
      const r = compareRank(x.rank, y.rank);
      return r !== 0 ? r : x.id < y.id ? -1 : 1;
    };
    const order = [clientA, clientB].sort(cmp);
    const order2 = [clientB, clientA].sort(cmp);
    expect(order.map((o) => o.id)).toEqual(order2.map((o) => o.id));
  });
});

describe('COLLATE "C" byte-order assumptions', () => {
  it('digit < uppercase < lowercase (ASCII byte order)', () => {
    expectOrdered('0', 'A');
    expectOrdered('A', 'a');
    expectOrdered('Z', 'a');
  });

  it('shorter string sorts before its own extension (prefix rule)', () => {
    expectOrdered('a', 'aa');
    expectOrdered('a', 'a0');
  });
});
