/**
 * Hybrid Logical Clock (ADR-0009).
 *
 * The move/tombstone clock. A total order across replicas that respects real
 * time when device clocks are roughly sane. `replicaId` is the final,
 * deterministic tie-break — unique per client install (NOT the user id), so the
 * comparison is total and every replica independently picks the same winner.
 */

export interface Hlc {
  readonly wallMs: number;
  readonly counter: number;
  readonly replicaId: string;
}

/**
 * Compare two HLC stamps. Returns <0 if a<b, 0 if equal, >0 if a>b.
 * Lexicographic on (wallMs, counter, replicaId) — later wins (ADR-0009).
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.replicaId !== b.replicaId) return a.replicaId < b.replicaId ? -1 : 1;
  return 0;
}

/** True iff `candidate` is strictly greater than `current` (the apply condition). */
export function hlcGreaterThan(candidate: Hlc, current: Hlc): boolean {
  return compareHlc(candidate, current) > 0;
}

/**
 * Advance the local clock for a local structural event (ADR-0009 update rule).
 *
 * `wallMs = max(prevWallMs, physicalNowMs)`; if the wall time did not advance,
 * bump the counter, else reset it to 0.
 */
export function tickHlc(prev: Hlc | undefined, physicalNowMs: number, replicaId: string): Hlc {
  if (prev === undefined) {
    return { wallMs: physicalNowMs, counter: 0, replicaId };
  }
  const wallMs = Math.max(prev.wallMs, physicalNowMs);
  const counter = wallMs === prev.wallMs ? prev.counter + 1 : 0;
  return { wallMs, counter, replicaId };
}

/**
 * Reconcile the local clock on receiving/merging a remote stamp `m`
 * (standard HLC merge, ADR-0009). Keeps the local clock monotonic and ahead of
 * anything it has observed.
 */
export function receiveHlc(
  local: Hlc | undefined,
  remote: Hlc,
  physicalNowMs: number,
  replicaId: string,
): Hlc {
  const localWall = local?.wallMs ?? 0;
  const localCounter = local?.counter ?? 0;
  const wallMs = Math.max(localWall, remote.wallMs, physicalNowMs);

  let counter: number;
  if (wallMs === localWall && wallMs === remote.wallMs) {
    counter = Math.max(localCounter, remote.counter) + 1;
  } else if (wallMs === localWall) {
    counter = localCounter + 1;
  } else if (wallMs === remote.wallMs) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { wallMs, counter, replicaId };
}

export function isHlc(value: unknown): value is Hlc {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.wallMs === 'number' &&
    typeof v.counter === 'number' &&
    typeof v.replicaId === 'string'
  );
}
