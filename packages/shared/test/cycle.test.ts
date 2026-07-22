import { describe, it, expect } from 'vitest';
import { detectCycles, computeCycleRepairs, type CycleNode } from '../src/cycle.js';
import { ROOT_PARENT_SENTINEL } from '../src/yjs-schema.js';
import { rankBetween, rankAfter } from '../src/fractional-index.js';
import type { Hlc } from '../src/hlc.js';

const R0 = rankBetween(null, null);
const R1 = rankAfter(R0);
const R2 = rankAfter(R1);

const hlc = (wallMs: number, counter: number, replicaId: string): Hlc => ({
  wallMs,
  counter,
  replicaId,
});

function node(id: string, parentId: string, rank: string, h: Hlc): CycleNode {
  return { id, parentId, rank, hlc: h };
}

describe('detectCycles', () => {
  it('finds no cycle in an acyclic tree', () => {
    const nodes = [
      node('root', ROOT_PARENT_SENTINEL, R0, hlc(1, 0, 'r')),
      node('x', 'root', R0, hlc(1, 0, 'r')),
      node('y', 'x', R0, hlc(1, 0, 'r')),
    ];
    expect(detectCycles(nodes)).toEqual([]);
  });

  it('detects a 2-cycle (A↔B swap)', () => {
    const nodes = [
      node('X', 'Y', R0, hlc(5, 0, 'A')),
      node('Y', 'X', R1, hlc(9, 0, 'B')),
    ];
    const cycles = detectCycles(nodes);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual(['X', 'Y']);
  });

  it('detects a 3-cycle', () => {
    const nodes = [
      node('A', 'B', R0, hlc(1, 0, 'r')),
      node('B', 'C', R1, hlc(2, 0, 'r')),
      node('C', 'A', R2, hlc(3, 0, 'r')),
    ];
    const cycles = detectCycles(nodes);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual(['A', 'B', 'C']);
  });

  it('does not treat a dangling parent as a cycle', () => {
    const nodes = [node('x', 'ghost', R0, hlc(1, 0, 'r'))];
    expect(detectCycles(nodes)).toEqual([]);
  });
});

describe('computeCycleRepairs — deterministic, convergent (ADR-0012)', () => {
  it('breaks the YOUNGEST edge and reparents that item under the root item', () => {
    // X.parent=Y (older move), Y.parent=X (younger move) — Y closed the loop.
    // A root item must exist in the doc (yjs-schema.md invariant); it is never
    // itself part of a cycle (its parent is the sentinel, not another item).
    const nodes = [
      node('root', ROOT_PARENT_SENTINEL, R0, hlc(1, 0, 'r')),
      node('X', 'Y', R1, hlc(5, 0, 'A')),
      node('Y', 'X', R2, hlc(9, 0, 'B')),
    ];
    const repairs = computeCycleRepairs(nodes, { replicaId: 'server', nowMs: 1000 });
    expect(repairs).toHaveLength(1);
    // The greatest HLC is Y's — Y is freed to become a child of the root item.
    expect(repairs[0]!.itemId).toBe('Y');
    expect(repairs[0]!.newParentId).toBe('root');
  });

  it('two independent replicas compute the byte-identical repair target', () => {
    const nodes = [
      node('root', ROOT_PARENT_SENTINEL, R0, hlc(1, 0, 'r')),
      node('X', 'Y', R1, hlc(5, 0, 'A')),
      node('Y', 'X', R2, hlc(9, 0, 'B')),
    ];
    // Different emitting replicas + different physical clocks.
    const repairA = computeCycleRepairs(nodes, { replicaId: 'replica-1', nowMs: 1000 });
    const repairB = computeCycleRepairs(nodes, { replicaId: 'replica-2', nowMs: 7777 });
    // Same freed item, same target parent, same rank — the placement converges.
    expect(repairA[0]!.itemId).toBe(repairB[0]!.itemId);
    expect(repairA[0]!.newParentId).toBe(repairB[0]!.newParentId);
    expect(repairA[0]!.newRank).toBe(repairB[0]!.newRank);
  });

  it('the repair HLC strictly dominates every HLC on the cycle', () => {
    const cycleMax = hlc(9, 0, 'B');
    const nodes = [
      node('root', ROOT_PARENT_SENTINEL, R0, hlc(1, 0, 'r')),
      node('X', 'Y', R1, hlc(5, 0, 'A')),
      node('Y', 'X', R2, cycleMax),
    ];
    const repairs = computeCycleRepairs(nodes, { replicaId: 'server', nowMs: 10 });
    const rh = repairs[0]!.newHlc;
    // Strictly greater than the max cycle HLC.
    expect(
      rh.wallMs > cycleMax.wallMs ||
        (rh.wallMs === cycleMax.wallMs && rh.counter > cycleMax.counter),
    ).toBe(true);
  });

  it('is idempotent — no repair on an already-acyclic tree', () => {
    const nodes = [
      node('root', ROOT_PARENT_SENTINEL, R0, hlc(1, 0, 'r')),
      node('Y', 'root', R1, hlc(10, 0, 'server')),
      node('X', 'Y', R0, hlc(5, 0, 'A')),
    ];
    expect(computeCycleRepairs(nodes, { replicaId: 'server', nowMs: 1000 })).toEqual([]);
  });
});
