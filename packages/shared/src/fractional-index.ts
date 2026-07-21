/**
 * Fractional indexing for sibling order (ADR-0005, fractional-indexing.md).
 *
 * A `rank` is a short string that sorts lexicographically (byte-wise, matching
 * Postgres `COLLATE "C"`) between its neighbors. Inserting/moving between two
 * siblings computes a new rank for ONLY the moved item — never a neighbor.
 *
 * The midpoint engine is the production-proven `fractional-indexing` package
 * (rocicorp), whose default base-62 alphabet
 * `0-9 A-Z a-z` is exactly ASCII / `COLLATE "C"` order, so client-generated
 * ranks and Postgres byte-ordering agree without a custom collation. On top of
 * it this module adds the ADR-0005 rules the raw library does not:
 *
 *  - **Jitter** at generation time: instead of always returning the single
 *    deterministic midpoint (which makes two offline clients inserting
 *    "between A and B" collide every time), pick one of N evenly-spaced slots by
 *    a seed (the moved item's id), spreading concurrent inserts apart.
 *  - **`openSpace`** for inserting next to a prior offline rank collision.
 *  - **`(rank, id)` total order** (see ordering.ts) — `rank` is never unique.
 */

import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** Number of jitter buckets a seeded insert spreads across. */
const JITTER_BUCKETS = 16;

/** Byte-wise (COLLATE "C") string comparison. Returns <0, 0, or >0. */
export function compareRank(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Deterministic bucket in [0, buckets) from a seed (FNV-1a 32-bit). */
function seededBucket(seed: string, buckets: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % buckets;
}

/**
 * Compute a rank strictly between `lower` and `upper` in byte order.
 *
 * `lower === null` means "before the first child" (open lower bound);
 * `upper === null` means "after the last child" (open upper bound).
 *
 * When `seed` is non-empty, the result is jittered: one of `JITTER_BUCKETS`
 * evenly-spaced candidate ranks is chosen by the seed, so two replicas inserting
 * between the same bounds while offline usually land on different ranks instead
 * of colliding on one deterministic midpoint. An empty seed returns the plain
 * deterministic midpoint (used where spread is irrelevant, e.g. a fresh root).
 *
 * Guarantees `lower < result < upper` byte-wise. Touches no other item.
 */
export function rankBetween(lower: string | null, upper: string | null, seed = ''): string {
  if (lower !== null && upper !== null && compareRank(lower, upper) >= 0) {
    throw new RangeError(
      `rankBetween requires lower < upper, got ${JSON.stringify(lower)} >= ${JSON.stringify(upper)}`,
    );
  }
  if (seed === '') return generateKeyBetween(lower, upper);

  const candidates = generateNKeysBetween(lower, upper, JITTER_BUCKETS);
  const pick = candidates[seededBucket(seed, JITTER_BUCKETS)];
  // generateNKeysBetween always returns exactly N keys for N>0; this is a
  // defensive fallback for the impossible empty case.
  return pick ?? generateKeyBetween(lower, upper);
}

/** Rank after the last child (open upper bound). */
export function rankAfter(lower: string | null, seed = ''): string {
  return rankBetween(lower, null, seed);
}

/** Rank before the first child (open lower bound). */
export function rankBefore(upper: string | null, seed = ''): string {
  return rankBetween(null, upper, seed);
}

/**
 * Generate `n` strictly-increasing ranks between two bounds in one call
 * (e.g. pasting a run of siblings). Deterministic, no jitter — the caller owns a
 * contiguous slot, so spread is unnecessary and evenly-spaced keys stay shortest.
 */
export function ranksBetween(lower: string | null, upper: string | null, n: number): string[] {
  if (n <= 0) return [];
  return generateNKeysBetween(lower, upper, n);
}

/**
 * `openSpace` (ADR-0005): compute a rank for the item being inserted/moved
 * between a pair that may share a rank (a prior offline collision). It extends
 * key length if needed so the moved item sorts cleanly, and NEVER renumbers the
 * existing siblings.
 *
 * On an exact collision (`lower === upper`) no rank sorts strictly between them,
 * so we mint a valid key strictly *after* the shared rank and let `(rank, id)`
 * break the remaining tie deterministically. The result is always a well-formed
 * order key (safe to use as a bound for future inserts).
 */
export function openSpace(lower: string | null, upper: string | null, seed = ''): string {
  if (lower !== null && upper !== null && compareRank(lower, upper) === 0) {
    return rankBetween(lower, null, seed);
  }
  return rankBetween(lower, upper, seed);
}
