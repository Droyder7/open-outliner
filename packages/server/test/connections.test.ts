import { describe, it, expect, vi } from 'vitest';
import type { Connection } from '@hocuspocus/server';
import { createConnectionRegistry } from '../src/crdt/connections.js';

/** A fake Hocuspocus Connection — only `close` is exercised by the registry. */
function fakeConnection(close = vi.fn()): Connection {
  return { close } as unknown as Connection;
}

describe('connection registry (ADR-0019 replica tracking)', () => {
  it('registers a connection with document + replicaId and exposes it live', () => {
    const registry = createConnectionRegistry();
    const conn = fakeConnection();
    registry.register('s1', 'session-1', 'doc-1', 'replica-a', conn);

    const live = registry.liveConnections();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      socketId: 's1',
      sessionId: 'session-1',
      documentName: 'doc-1',
      replicaId: 'replica-a',
      synced: false,
    });
    expect(registry.liveSessionIds()).toEqual(['session-1']);
  });

  it('records a connection without a replicaId (legacy client)', () => {
    const registry = createConnectionRegistry();
    registry.register('s1', 'session-1', 'doc-1', undefined, fakeConnection());

    expect(registry.liveConnections()[0]!.replicaId).toBeUndefined();
  });

  it('markSynced flips the flag and returns the updated entry', () => {
    const registry = createConnectionRegistry();
    registry.register('s1', 'session-1', 'doc-1', 'replica-a', fakeConnection());

    const entry = registry.markSynced('s1');
    expect(entry?.synced).toBe(true);
    expect(registry.liveConnections()[0]!.synced).toBe(true);

    // Unknown socket: no-op, returns undefined.
    expect(registry.markSynced('nope')).toBeUndefined();
  });

  it('unregister removes the socket, returns the entry, and is idempotent', () => {
    const registry = createConnectionRegistry();
    registry.register('s1', 'session-1', 'doc-1', 'replica-a', fakeConnection());

    const entry = registry.unregister('s1');
    expect(entry?.documentName).toBe('doc-1');
    expect(entry?.replicaId).toBe('replica-a');
    expect(registry.liveConnections()).toHaveLength(0);
    expect(registry.liveSessionIds()).toHaveLength(0);
    expect(registry.unregister('s1')).toBeUndefined();
  });

  it('closeSession force-closes every socket of a session and leaves others alone', () => {
    const registry = createConnectionRegistry();
    const revocable = fakeConnection();
    const alsoRevocable = fakeConnection();
    const other = fakeConnection();
    registry.register('s1', 'session-1', 'doc-1', 'replica-a', revocable);
    registry.register('s2', 'session-1', 'doc-1', 'replica-b', alsoRevocable);
    registry.register('s3', 'session-2', 'doc-2', 'replica-c', other);

    registry.closeSession('session-1');

    expect(revocable.close).toHaveBeenCalledTimes(1);
    expect(alsoRevocable.close).toHaveBeenCalledTimes(1);
    expect(other.close).not.toHaveBeenCalled();

    // The registry keeps the entries until the socket's close event lands in
    // `onDisconnect` — closeSession only force-closes the sockets (ADR-0014).
    expect(registry.liveSessionIds()).toEqual(['session-1', 'session-2']);
  });
});
