import { describe, it, expect } from 'vitest';
import { REPLICA_SYNCED_PAYLOAD } from '@open-outliner/shared';
import { syncAckPayload } from '../src/sync-ack.js';

describe('syncAckPayload — ADR-0019 client ack decision', () => {
  it('acknowledges exactly when the provider reports synced (initial sync / reconnect)', () => {
    expect(syncAckPayload(true)).toBe(REPLICA_SYNCED_PAYLOAD);
  });

  it('sends nothing on any not-synced provider state', () => {
    expect(syncAckPayload(false)).toBeNull();
  });

  it('uses the same wire constant the server compares against', () => {
    expect(syncAckPayload(true)).toBe('replica.synced');
    // The server's onStateless hook gates on the shared constant (replica-hooks.ts),
    // so this round-trips: client sends → server recognizes.
    expect(REPLICA_SYNCED_PAYLOAD).toBe('replica.synced');
  });
});
