import { describe, it, expect } from 'vitest';
import {
  buildInsertMove,
  buildMove,
  buildDelete,
  buildUndelete,
  buildRootMove,
} from '../src/item-commands.js';
import { hlcGreaterThan, compareHlc } from '../src/hlc.js';
import { ROOT_PARENT_SENTINEL } from '../src/yjs-schema.js';
import { compareRank, rankBetween, rankAfter } from '../src/fractional-index.js';

const ctx = (nowMs: number, replicaId = 'r1') => ({ nowMs, replicaId });

describe('move register is atomic — parentId+rank+hlc built together (ADR-0010)', () => {
  it('buildMove returns all three fields as one value', () => {
    const move = buildMove('parent-1', 'aM', undefined, ctx(100));
    expect(move.parentId).toBe('parent-1');
    expect(move.rank).toBe('aM');
    expect(move.hlc).toEqual({ wallMs: 100, counter: 0, replicaId: 'r1' });
  });

  it('every structural write mints a fresh, strictly-greater HLC — even a same-parent reorder', () => {
    const rankA = rankBetween(null, null);
    const rankB = rankAfter(rankA);
    const first = buildMove('p', rankA, undefined, ctx(100));
    const reorder = buildMove('p', rankB, first.hlc, ctx(100)); // same parent, new rank, same wall time
    expect(hlcGreaterThan(reorder.hlc, first.hlc)).toBe(true);
    expect(reorder.parentId).toBe('p');
    expect(reorder.rank).toBe(rankB);
  });

  it('insert between bounds lands strictly between them', () => {
    const lo = rankBetween(null, null);
    const hi = rankAfter(lo);
    const move = buildInsertMove('child-1', 'p', lo, hi, undefined, ctx(50));
    expect(move.parentId).toBe('p');
    expect(compareRank(lo, move.rank)).toBeLessThan(0);
    expect(compareRank(move.rank, hi)).toBeLessThan(0);
  });

  it('the winner of two concurrent moves contributes BOTH its parent and its rank (no tear)', () => {
    // Replica A and B move the same item concurrently to different placements.
    const a = buildMove('parent-A', rankBetween(null, null), undefined, { nowMs: 100, replicaId: 'A' });
    const b = buildMove('parent-B', rankBetween(null, null), undefined, { nowMs: 200, replicaId: 'B' });
    // Apply-iff-strictly-greater: whichever wins contributes its WHOLE value.
    const winner = compareHlc(b.hlc, a.hlc) > 0 ? b : a;
    expect(winner).toBe(b);
    expect(winner.parentId).toBe('parent-B');
    expect(winner.rank).toBe(b.rank); // B's rank, paired with B's parent
  });

  it('root move uses the null-sentinel parent', () => {
    const root = buildRootMove(rankBetween(null, null), ctx(10));
    expect(root.parentId).toBe(ROOT_PARENT_SENTINEL);
  });
});

describe('deleted register (ADR-0011)', () => {
  it('delete sets isDeleted true with a fresh HLC', () => {
    const del = buildDelete(undefined, ctx(100));
    expect(del.isDeleted).toBe(true);
  });

  it('undo carries a strictly-greater HLC so it deterministically beats the delete', () => {
    const del = buildDelete(undefined, ctx(100));
    const undo = buildUndelete(del.hlc, ctx(100));
    expect(undo.isDeleted).toBe(false);
    expect(hlcGreaterThan(undo.hlc, del.hlc)).toBe(true);
  });

  it('an offline replica holding an older delete loses to a newer undo on merge', () => {
    const del = buildDelete(undefined, { nowMs: 100, replicaId: 'A' });
    const undo = buildUndelete(del.hlc, { nowMs: 100, replicaId: 'A' });
    // The undo dominates; item is live after merge.
    const winner = compareHlc(undo.hlc, del.hlc) > 0 ? undo : del;
    expect(winner.isDeleted).toBe(false);
  });
});
