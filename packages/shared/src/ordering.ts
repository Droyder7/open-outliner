/**
 * Total sibling order `(rank, id)` — ADR-0005.
 *
 * `rank` is NOT unique; ties are legal and broken deterministically by `id`.
 * Every consumer (editor visible-order flattening, materializer readback,
 * export) MUST sort by this comparator, never by `rank` alone.
 */

import { compareRank } from './fractional-index.js';

export interface Ordered {
  readonly id: string;
  readonly rank: string;
}

/** Compare two siblings by `(rank, id)` byte-wise. Returns <0, 0, or >0. */
export function compareOrder(a: Ordered, b: Ordered): number {
  const r = compareRank(a.rank, b.rank);
  if (r !== 0) return r;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Sort siblings into their read order. Returns a new array (stable by comparator). */
export function sortSiblings<T extends Ordered>(items: readonly T[]): T[] {
  return [...items].sort(compareOrder);
}
