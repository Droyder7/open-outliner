import { describe, it, expect, vi, afterEach } from 'vitest';
import { startReplicaHeartbeat } from '../src/crdt/replica-heartbeat.js';
import type { ConnectionRegistry, RegisteredConnection } from '../src/crdt/connections.js';
import type { Db } from '../src/db/db.js';

function fakeRegistry(connections: RegisteredConnection[]): ConnectionRegistry {
  return { liveConnections: () => connections } as unknown as ConnectionRegistry;
}

/** A Db whose `query` records every call (the repo calls db.query under the hood). */
function fakeDb(): { db: Db; calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  const db = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [] };
    }),
  } as unknown as Db;
  return { db, calls };
}

function entry(
  socketId: string,
  documentName: string,
  replicaId: string | undefined,
  synced: boolean,
): RegisteredConnection {
  return {
    socketId,
    sessionId: 'session',
    documentName,
    ...(replicaId !== undefined ? { replicaId } : {}),
    synced,
    connection: { close: () => {} } as never,
  };
}

describe('replica-ack heartbeat (ADR-0019)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches live connections each tick, passing the synced flag through', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry([
      entry('s1', 'doc-1', 'replica-a', true), // fully synced → advances last_synced_at
      entry('s2', 'doc-1', 'replica-b', false), // still initial-syncing → liveness only
    ]);
    const { db, calls } = fakeDb();

    const heartbeat = startReplicaHeartbeat(db, registry, 5_000);
    await vi.advanceTimersByTimeAsync(10_000); // two ticks

    expect(calls).toHaveLength(4);
    const [firstTick, secondTick] = [calls.slice(0, 2), calls.slice(2)];

    for (const tick of [firstTick, secondTick]) {
      const touchA = tick[0]!;
      const touchB = tick[1]!;
      expect(touchA.params[0]).toBe('doc-1');
      expect(touchA.params[1]).toBe('replica-a');
      expect(touchA.params[2]).not.toBeNull(); // synced → timestamp
      expect(touchB.params[0]).toBe('doc-1');
      expect(touchB.params[1]).toBe('replica-b');
      expect(touchB.params[2]).toBeNull(); // not synced → NULL keeps GC blocked
    }

    heartbeat.stop();
  });

  it('never touches legacy connections without a replicaId', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry([entry('s1', 'doc-1', undefined, true)]);
    const { db, calls } = fakeDb();

    const heartbeat = startReplicaHeartbeat(db, registry, 5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);

    heartbeat.stop();
  });

  it('stop() halts future ticks', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry([entry('s1', 'doc-1', 'replica-a', true)]);
    const { db, calls } = fakeDb();

    const heartbeat = startReplicaHeartbeat(db, registry, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });
});
