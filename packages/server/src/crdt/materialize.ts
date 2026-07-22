import {
  ROOT_PARENT_SENTINEL,
  isRootParent,
  computeCycleRepairs,
  type ItemNodeSnapshot,
  type CycleNode,
  type CycleRepair,
} from '@open-outliner/shared';
import type { ProjectedItem } from '../db/items-repo.js';

/**
 * Pure projection logic: merged CRDT snapshots → the `items` rows to upsert
 * (yjs-projection.md, ADR-0006/0011/0012). No I/O — the DB write and the Yjs
 * repair-emit are the caller's job. This is the unit-testable core of the
 * materializer.
 */

export interface ProjectionResult {
  /** Rows to upsert into `items` (parent_id null = synthetic root). */
  rows: ProjectedItem[];
  /**
   * Cycle repairs the CRDT layer must emit as ordinary `move` writes (ADR-0012).
   * The projector DETECTS but never resolves; if the server is a participating
   * replica it emits these back into the Yjs doc, which re-projects cleanly.
   */
  repairs: CycleRepair[];
}

/**
 * Determine, for each item, whether it is effectively deleted under the LAZY
 * tombstone rule (ADR-0006/0011): an item is deleted if its own `deleted`
 * register is set OR any ancestor's is. Descendants are not tombstoned
 * individually — we filter under the nearest deleted ancestor at projection time.
 */
function computeEffectiveDeleted(
  snapshots: readonly ItemNodeSnapshot[],
): Map<string, boolean> {
  const byId = new Map<string, ItemNodeSnapshot>();
  for (const s of snapshots) byId.set(s.id, s);

  const memo = new Map<string, boolean>();

  function isDeleted(id: string, seen: Set<string>): boolean {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return false; // cycle guard; cycle repair handles structure
    seen.add(id);

    const node = byId.get(id);
    if (!node) return false;
    let result = node.deleted.isDeleted;
    if (!result && !isRootParent(node.move.parentId)) {
      const parent = node.move.parentId;
      if (byId.has(parent)) result = isDeleted(parent, seen);
    }
    memo.set(id, result);
    return result;
  }

  for (const s of snapshots) isDeleted(s.id, new Set());
  return memo;
}

/**
 * Project the merged snapshots. Sets `deleted` on each row per the lazy rule and
 * computes any cycle repairs. The caller upserts `rows` and emits `repairs`.
 *
 * @param nowMs physical clock reading for repair HLCs (pass in — never Date.now
 *   inside pure logic, for determinism/testability).
 * @param replicaId the server's replica id, stamped on emitted repair moves.
 */
export function projectSnapshots(
  snapshots: readonly ItemNodeSnapshot[],
  nowMs: number,
  replicaId: string,
): ProjectionResult {
  const effectiveDeleted = computeEffectiveDeleted(snapshots);

  const rows: ProjectedItem[] = snapshots.map((s) => ({
    id: s.id,
    parentId: isRootParent(s.move.parentId) ? null : s.move.parentId,
    rank: s.move.rank,
    type: s.type,
    content: s.content,
    note: s.note ?? null,
    isCompleted: s.isCompleted,
    isCollapsed: s.isCollapsed,
    deleted: effectiveDeleted.get(s.id) ?? s.deleted.isDeleted,
  }));

  // Cycle detection runs over LIVE structure only — a tombstoned subtree is out
  // of the tree and cannot form a user-visible cycle.
  const liveNodes: CycleNode[] = snapshots
    .filter((s) => !(effectiveDeleted.get(s.id) ?? false))
    .map((s) => ({
      id: s.id,
      parentId: s.move.parentId,
      rank: s.move.rank,
      hlc: s.move.hlc,
    }));

  const repairs = computeCycleRepairs(liveNodes, { replicaId, nowMs });
  return { rows, repairs };
}

export { ROOT_PARENT_SENTINEL };
