import { describe, it, expect } from 'vitest';
import { getOrCreateReplicaId, REPLICA_ID_KEY } from '../src/replica-id.js';

/** A minimal in-memory Storage stand-in: one instance = one tab. */
function fakeTab(): { storage: Pick<Storage, 'getItem' | 'setItem'>; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    storage: {
      getItem: (k) => entries.get(k) ?? null,
      setItem: (k, v) => {
        entries.set(k, v);
      },
    },
  };
}

describe('replica-id — per-tab identity (ADR-0019)', () => {
  it('mints one id per tab and returns the same id across calls in that tab', () => {
    const { storage } = fakeTab();
    const first = getOrCreateReplicaId(storage, () => 'id-A');
    const second = getOrCreateReplicaId(storage, () => 'id-B');
    expect(first).toBe('id-A');
    expect(second).toBe('id-A'); // existing id wins — never re-minted
  });

  it('two tabs get distinct ids (no shared replica_sync row)', () => {
    const tab1 = fakeTab();
    const tab2 = fakeTab();
    const id1 = getOrCreateReplicaId(tab1.storage, () => 'tab-1');
    const id2 = getOrCreateReplicaId(tab2.storage, () => 'tab-2');
    expect(id1).toBe('tab-1');
    expect(id2).toBe('tab-2');
    expect(id1).not.toBe(id2);
  });

  it('persists the minted id under the shared key', () => {
    const { storage, entries } = fakeTab();
    getOrCreateReplicaId(storage, () => 'id-1');
    expect(entries.get(REPLICA_ID_KEY)).toBe('id-1');
  });
});
