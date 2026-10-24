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

    expect(calls).toHaveLength(2); // one round trip per tick
    for (const call of calls) {
      expect(call.params).toEqual([
        ['doc-1', 'doc-1'],
        ['replica-a', 'replica-b'],
        [true, false], // only synced replicas may advance last_synced_at
        expect.any(Date),
      ]);
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

  it('defers ticks while a batch is pending, then takes a fresh connection snapshot', async () => {
    vi.useFakeTimers();
    const connections = [entry('s1', 'doc-1', 'replica-a', false)];
    let finish!: () => void;
    const query = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ rows: [] });
    const heartbeat = startReplicaHeartbeat(
      { query } as unknown as Db,
      fakeRegistry(connections),
      1_000,
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(query).toHaveBeenCalledTimes(1);
    connections[0]!.synced = true;
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![1][2]).toEqual([false]);
    expect(query.mock.calls[1]![1][2]).toEqual([true]);
    heartbeat.stop();
  });

  it('logs a failed batch and allows the next tick to retry', async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ rows: [] });
    const log = vi.fn();
    const heartbeat = startReplicaHeartbeat(
      { query } as unknown as Db,
      fakeRegistry([entry('s1', 'doc-1', 'replica-a', true)]),
      1_000,
      log,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('replica heartbeat failed: database unavailable');
    heartbeat.stop();
  });
});
