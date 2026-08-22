import { describe, it, expect, vi } from 'vitest';
import type {
  connectedPayload,
  onStatelessPayload,
  onDisconnectPayload,
  Connection,
} from '@hocuspocus/server';
import { REPLICA_SYNCED_PAYLOAD } from '@open-outliner/shared';
import { createConnectionRegistry } from '../src/crdt/connections.js';
import { createReplicaHooks, isValidReplicaId } from '../src/crdt/replica-hooks.js';
import type { Db } from '../src/db/db.js';

/**
 * Unit tests for the ADR-0019 ledger wiring in the Hocuspocus lifecycle hooks
 * (connected / onStateless / onDisconnect). The hooks were extracted from
 * `server.ts` so they can be driven here with the real connection registry and
 * a fake `Db` that records every query — no live server, no Postgres.
 *
 * The touchReplica upsert writes `[documentId, replicaId, last_synced_at, last_seen_at]`
 * where `last_synced_at` is NULL for a blocking touch (synced: false) and a Date
 * for an acknowledgement (synced: true). The tests assert on those params, so
 * they pin the ledger semantics without coupling to the SQL text.
 */

// The server only accepts well-formed UUID replica ids (clients mint
// crypto.randomUUID()); the hook treats anything else as a legacy client.
const REPLICA_A = 'a0000000-0000-4000-8000-00000000000a';

type QueryCall = { text: string; params: unknown[] };

function fakeDb(): { db: Db; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const db = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [] };
    }),
  } as unknown as Db;
  return { db, calls };
}

function fakeConnection(socketId: string): Connection {
  return { socketId, close: () => {} } as unknown as Connection;
}

/** Build a `connected` payload; `sessionId: undefined` simulates a missing auth context. */
function connectedData(overrides: {
  socketId?: string;
  sessionId?: string | undefined;
  replicaId?: string | null;
  documentName?: string;
} = {}): connectedPayload {
  const { socketId = 'socket-1', replicaId = REPLICA_A, documentName = 'doc-1' } = overrides;
  // `in` check: an explicit `undefined` must stay undefined (destructuring
  // defaults would treat it as absent and fall back to 'session-1').
  const sessionId = 'sessionId' in overrides ? overrides.sessionId : 'session-1';
  return {
    context: sessionId === undefined ? undefined : { sessionId },
    documentName,
    requestParameters: new URLSearchParams(replicaId == null ? {} : { replicaId }),
    socketId,
    connectionInstance: fakeConnection(socketId),
  } as unknown as connectedPayload;
}

function statelessData(payload: string, socketId = 'socket-1'): onStatelessPayload {
  return {
    connection: fakeConnection(socketId),
    documentName: 'doc-1',
    payload,
  } as unknown as onStatelessPayload;
}

function disconnectData(socketId = 'socket-1'): onDisconnectPayload {
  return { socketId, documentName: 'doc-1' } as unknown as onDisconnectPayload;
}

describe('replica hooks — ADR-0019 ledger wiring (connected/onStateless/onDisconnect)', () => {
  it('connected registers the socket and writes a BLOCKING ledger row (last_synced_at NULL)', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });

    await hooks.connected(connectedData());

    const live = registry.liveConnections();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      socketId: 'socket-1',
      sessionId: 'session-1',
      documentName: 'doc-1',
      replicaId: REPLICA_A,
      synced: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toBe('doc-1');
    expect(calls[0]!.params[1]).toBe(REPLICA_A);
    expect(calls[0]!.params[2]).toBeNull(); // synced:false → GC stays blocked
    expect(calls[0]!.params[3]).toBeInstanceOf(Date);
  });

  it('connected without an authenticated session does nothing (no register, no ledger write)', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });

    await hooks.connected(connectedData({ sessionId: undefined }));

    expect(registry.liveConnections()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('connected without a replicaId (legacy client) registers but writes no ledger row', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });

    await hooks.connected(connectedData({ replicaId: null }));

    expect(registry.liveConnections()[0]!.replicaId).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('isValidReplicaId accepts only well-formed UUIDs', () => {
    expect(isValidReplicaId(REPLICA_A)).toBe(true);
    expect(isValidReplicaId(REPLICA_A.toUpperCase())).toBe(true); // case-insensitive
    expect(isValidReplicaId(crypto.randomUUID())).toBe(true);
    expect(isValidReplicaId(undefined)).toBe(false);
    expect(isValidReplicaId('replica-a')).toBe(false); // not a UUID
    expect(isValidReplicaId('')).toBe(false);
    // A 36-char string that is not a UUID must not sneak past a length check.
    expect(isValidReplicaId('x'.repeat(36))).toBe(false);
    // Hostile/oversized values never become ledger keys.
    expect(isValidReplicaId(`${REPLICA_A}'; DROP TABLE replica_sync--`)).toBe(false);
    expect(isValidReplicaId('x'.repeat(10_000))).toBe(false);
  });

  it('connected with a MALFORMED replicaId registers without one (legacy path, no ledger write)', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });

    // A hostile client probing the ledger with a non-UUID parameter: the
    // socket stays registered (the live-connection GC gate still covers it)
    // but nothing is written to replica_sync.
    await hooks.connected(connectedData({ replicaId: 'fake-replica-not-a-uuid' }));

    expect(registry.liveConnections()).toHaveLength(1);
    expect(registry.liveConnections()[0]!.replicaId).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('connected survives a ledger write failure: logs, keeps the connection registered', async () => {
    const registry = createConnectionRegistry();
    const db = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as Db;
    const logs: string[] = [];
    const hooks = createReplicaHooks({ db, connections: registry, log: (m) => logs.push(m) });

    await expect(hooks.connected(connectedData())).resolves.toBeUndefined();
    expect(registry.liveConnections()).toHaveLength(1); // connection not killed
    expect(logs[0]).toMatch(/replica ledger write failed on connect/);
  });

  it('onStateless ignores non-ack payloads entirely', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });
    await hooks.connected(connectedData());
    calls.length = 0;

    await hooks.onStateless(statelessData('awareness.stuff'));

    expect(registry.liveConnections()[0]!.synced).toBe(false); // not marked synced
    expect(calls).toHaveLength(0);
  });

  it('onStateless with the replica.synced ack marks the socket synced and persists it immediately', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });
    await hooks.connected(connectedData());
    calls.length = 0;

    await hooks.onStateless(statelessData(REPLICA_SYNCED_PAYLOAD));

    expect(registry.liveConnections()[0]!.synced).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toBe('doc-1');
    expect(calls[0]!.params[1]).toBe(REPLICA_A);
    expect(calls[0]!.params[2]).toBeInstanceOf(Date); // synced:true → ack timestamp
  });

  it('onStateless for a legacy socket (no replicaId) marks it synced but writes no row', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });
    await hooks.connected(connectedData({ replicaId: null }));

    await hooks.onStateless(statelessData(REPLICA_SYNCED_PAYLOAD));

    expect(registry.liveConnections()[0]!.synced).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('onDisconnect for a fully-synced replica refreshes last_synced_at', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });
    await hooks.connected(connectedData());
    await hooks.onStateless(statelessData(REPLICA_SYNCED_PAYLOAD));
    calls.length = 0;

    await hooks.onDisconnect(disconnectData());

    expect(registry.liveConnections()).toHaveLength(0); // unregistered
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[1]).toBe(REPLICA_A);
    expect(calls[0]!.params[2]).toBeInstanceOf(Date); // synced:true → refresh
  });

  it('onDisconnect for a never-synced replica keeps last_synced_at NULL (still blocks GC)', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });
    await hooks.connected(connectedData());
    calls.length = 0;

    await hooks.onDisconnect(disconnectData());

    expect(registry.liveConnections()).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[2]).toBeNull(); // synced:false → blocking
  });

  it('onDisconnect for a legacy socket (no replicaId) writes no ledger row', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });
    await hooks.connected(connectedData({ replicaId: null }));
    calls.length = 0;

    await hooks.onDisconnect(disconnectData());

    expect(registry.liveConnections()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('onDisconnect for an unknown socket is a no-op', async () => {
    const registry = createConnectionRegistry();
    const { db, calls } = fakeDb();
    const hooks = createReplicaHooks({ db, connections: registry });

    await hooks.onDisconnect(disconnectData('never-registered'));

    expect(calls).toHaveLength(0);
    expect(registry.liveConnections()).toHaveLength(0);
  });

  it('onDisconnect survives a ledger write failure: logs, socket already removed', async () => {
    const registry = createConnectionRegistry();
    const ok = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Db;
    const hooks = createReplicaHooks({ db: ok, connections: registry });
    await hooks.connected(connectedData());

    const failing = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as Db;
    const logs: string[] = [];
    const failingHooks = createReplicaHooks({ db: failing, connections: registry, log: (m) => logs.push(m) });

    await expect(failingHooks.onDisconnect(disconnectData())).resolves.toBeUndefined();
    expect(registry.liveConnections()).toHaveLength(0); // socket was already unregistered
    expect(logs[0]).toMatch(/replica ledger write failed on disconnect/);
  });
});
