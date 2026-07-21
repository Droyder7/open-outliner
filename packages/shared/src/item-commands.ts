/**
 * Pure builders for the structural mutations (api-and-write-path.md command
 * surface, realized as atomic `move`/`deleted` register writes — ADR-0010/0011).
 *
 * These compute the *next register value* for a mutation. They do not touch Yjs
 * — the editor binding (Phase 4) applies the returned register as one atomic
 * `move`-value replacement in a single Yjs transaction. Keeping the computation
 * pure is what lets both the editor and unit tests share identical logic.
 */

import { tickHlc, type Hlc } from './hlc.js';
import { rankBetween, rankAfter } from './fractional-index.js';
import { ROOT_PARENT_SENTINEL } from './yjs-schema.js';
import type { MoveRegister, DeletedRegister } from './yjs-schema.js';

export interface ClockContext {
  readonly replicaId: string;
  readonly nowMs: number;
}

/**
 * Build the `move` register for placing `itemId` under `parentId`, between the
 * two given sibling ranks (either bound null = open end). The rank jitter is
 * seeded by the item id so concurrent offline inserts spread instead of colliding.
 */
export function buildInsertMove(
  itemId: string,
  parentId: string,
  lowerRank: string | null,
  upperRank: string | null,
  prevHlc: Hlc | undefined,
  ctx: ClockContext,
): MoveRegister {
  const rank = rankBetween(lowerRank, upperRank, itemId);
  return { parentId, rank, hlc: tickHlc(prevHlc, ctx.nowMs, ctx.replicaId) };
}

/**
 * Build the `move` register for a re-parent/reorder of `itemId` to `newParentId`
 * at an explicit `newRank`. Always mints a fresh HLC — even a reorder within the
 * same parent rewrites the whole atomic register (ADR-0010).
 */
export function buildMove(
  newParentId: string,
  newRank: string,
  prevHlc: Hlc | undefined,
  ctx: ClockContext,
): MoveRegister {
  return { parentId: newParentId, rank: newRank, hlc: tickHlc(prevHlc, ctx.nowMs, ctx.replicaId) };
}

/** Build the `move` register that appends `itemId` to the end of `parentId`'s children. */
export function buildAppendMove(
  itemId: string,
  parentId: string,
  lastRank: string | null,
  prevHlc: Hlc | undefined,
  ctx: ClockContext,
): MoveRegister {
  return {
    parentId,
    rank: rankAfter(lastRank, itemId),
    hlc: tickHlc(prevHlc, ctx.nowMs, ctx.replicaId),
  };
}

/** Build a `deleted` register that tombstones an item (ADR-0011). */
export function buildDelete(prevHlc: Hlc | undefined, ctx: ClockContext): DeletedRegister {
  return { isDeleted: true, hlc: tickHlc(prevHlc, ctx.nowMs, ctx.replicaId) };
}

/** Build a `deleted` register that undoes a tombstone (strictly-greater HLC, ADR-0011). */
export function buildUndelete(prevHlc: Hlc | undefined, ctx: ClockContext): DeletedRegister {
  return { isDeleted: false, hlc: tickHlc(prevHlc, ctx.nowMs, ctx.replicaId) };
}

/** The synthetic-root move for a freshly created document's root item. */
export function buildRootMove(rootRank: string, ctx: ClockContext): MoveRegister {
  return {
    parentId: ROOT_PARENT_SENTINEL,
    rank: rootRank,
    hlc: tickHlc(undefined, ctx.nowMs, ctx.replicaId),
  };
}
