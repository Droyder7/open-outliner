/**
 * Convergent cycle resolution (ADR-0012).
 *
 * `parentId` is a per-item LWW register, so two concurrent, individually-valid
 * moves can combine into a cycle (A moves X under Y while B moves Y under X).
 * After merge every replica agrees on the cyclic state — so the repair must be a
 * pure function of the merged state that every replica computes identically and
 * emits as an ordinary HLC-stamped `move` write (never a projector veto).
 *
 * The rule (ADR-0012):
 *  1. Identify the cycle (the set of items whose parent edges form the loop).
 *  2. Break the edge with the greatest `move.hlc` — the YOUNGEST move on the
 *     cycle (the one that closed the loop) is the one reverted.
 *  3. Reparent that freed item to top level, with a fresh rank at the end of the
 *     root's children (seeded deterministically by the freed item's id) and a
 *     new HLC strictly greater than every HLC on the broken cycle.
 *
 * "Reparent to the synthetic root" (ADR-0012) means becoming a CHILD of the
 * document's one root item, not taking on the root's own null-sentinel parentId
 * — exactly one item per document may have that (yjs-schema.md, enforced by
 * `items_one_root_per_doc_idx`). The root item can never itself be on a cycle
 * (its parent is the sentinel, never another item), so it is always a safe,
 * always-existing reparent target.
 *
 * This module computes the repairs; applying them (writing the Yjs `move`) is
 * the caller's job.
 */

import { compareHlc, tickHlc, type Hlc } from './hlc.js';
import { rankAfter, compareRank } from './fractional-index.js';
import { isRootParent } from './yjs-schema.js';

/** Minimal structural view of an item the repair needs. */
export interface CycleNode {
  readonly id: string;
  readonly parentId: string;
  readonly rank: string;
  readonly hlc: Hlc;
}

/** A repair to apply: reparent `itemId` under the document's root item. */
export interface CycleRepair {
  readonly itemId: string;
  /** The document's root item id (freed item becomes its child — top level). */
  readonly newParentId: string;
  readonly newRank: string;
  readonly newHlc: Hlc;
  /** The cycle this repair breaks (ids), for surfacing/testing. */
  readonly cycle: readonly string[];
}

interface RepairContext {
  /** The emitting replica's id (goes into the repair HLC). */
  readonly replicaId: string;
  /** Physical clock reading for the repair HLC tick. */
  readonly nowMs: number;
}

/**
 * Find every distinct cycle in the parent graph. A node whose parent is the root
 * sentinel, or whose parent id is absent from the node set, is not on a cycle.
 * Each cycle is returned once, as the list of ids on the loop.
 *
 * Because every node has at most one outgoing edge (its parent), the parent
 * graph is a functional graph: each weakly-connected component contains at most
 * one cycle, so a single walk per unsettled node finds them all.
 */
export function detectCycles(nodes: readonly CycleNode[]): string[][] {
  const byId = new Map<string, CycleNode>();
  for (const n of nodes) byId.set(n.id, n);

  const settled = new Set<string>();
  const cycles: string[][] = [];

  for (const start of nodes) {
    if (settled.has(start.id)) continue;

    const path: string[] = [];
    const indexInPath = new Map<string, number>();
    let cur: CycleNode | undefined = start;

    while (cur !== undefined && !settled.has(cur.id)) {
      const seenAt = indexInPath.get(cur.id);
      if (seenAt !== undefined) {
        // Closed a loop: the slice from its first occurrence to here.
        cycles.push(path.slice(seenAt));
        break;
      }
      indexInPath.set(cur.id, path.length);
      path.push(cur.id);

      if (isRootParent(cur.parentId)) break;
      cur = byId.get(cur.parentId); // undefined => dangling parent, not a cycle
    }

    // Every id on this walk is now settled — reachable to root, a dangling
    // parent, or a known cycle. None starts a new distinct cycle.
    for (const id of path) settled.add(id);
  }

  return cycles;
}

/**
 * Compute the deterministic repair for a single cycle:
 *  - freed item = the cycle member with the greatest `move.hlc`,
 *  - reparented under the root item at end-of-children rank (seeded by freed id),
 *  - with an HLC strictly greater than every HLC on the cycle.
 */
function repairForCycle(
  cycle: readonly string[],
  byId: ReadonlyMap<string, CycleNode>,
  rootItemId: string,
  rootChildRanks: readonly string[],
  ctx: RepairContext,
): CycleRepair {
  let freed = byId.get(cycle[0]!)!;
  let maxHlc = freed.hlc;
  for (const id of cycle) {
    const node = byId.get(id)!;
    if (compareHlc(node.hlc, maxHlc) > 0) {
      maxHlc = node.hlc;
      freed = node;
    }
  }

  // End of the root's current children — deterministic across replicas since it
  // is derived from merged state. Seed the jitter by the freed item's id.
  const lastRootRank =
    rootChildRanks.length > 0
      ? rootChildRanks.reduce((a, b) => (compareRank(a, b) >= 0 ? a : b))
      : null;
  const newRank = rankAfter(lastRootRank, freed.id);

  // A new HLC strictly greater than every HLC on the cycle: tick from the cycle
  // max so wallMs/counter dominate, stamped with the emitting replica.
  const newHlc = tickHlc(maxHlc, Math.max(ctx.nowMs, maxHlc.wallMs), ctx.replicaId);

  return {
    itemId: freed.id,
    newParentId: rootItemId,
    newRank,
    newHlc,
    cycle: [...cycle],
  };
}

/**
 * Detect every cycle in the merged state and return the repair for each. The
 * caller applies each repair as a normal `move`-register write; re-running on
 * already-repaired state yields no repairs (idempotent, ADR-0012).
 *
 * Returns no repairs (rather than throwing) if the node set has no root item —
 * that is a different, non-cycle problem (a document missing its synthetic
 * root) outside this module's scope.
 */
export function computeCycleRepairs(nodes: readonly CycleNode[], ctx: RepairContext): CycleRepair[] {
  const byId = new Map<string, CycleNode>();
  for (const n of nodes) byId.set(n.id, n);

  const root = nodes.find((n) => isRootParent(n.parentId));
  const cycles = detectCycles(nodes);
  if (!root || cycles.length === 0) return [];

  const rootChildRanks: string[] = [];
  for (const n of nodes) if (n.parentId === root.id) rootChildRanks.push(n.rank);

  return cycles.map((cycle) => repairForCycle(cycle, byId, root.id, rootChildRanks, ctx));
}
