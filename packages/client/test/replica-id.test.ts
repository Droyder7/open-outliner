import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getOrCreateReplicaId,
  getOrCreateTabReplicaId,
  REPLICA_ID_KEY,
} from '../src/replica-id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

describe('getOrCreateTabReplicaId — never throws, even without sessionStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.removeItem(REPLICA_ID_KEY);
  });

  it('mints a UUID in sessionStorage and returns it on every call', () => {
    const first = getOrCreateTabReplicaId();
    expect(first).toMatch(UUID_RE);
    expect(window.sessionStorage.getItem(REPLICA_ID_KEY)).toBe(first);
    expect(getOrCreateTabReplicaId()).toBe(first);
  });

  it('falls back to an in-memory id when sessionStorage access throws (e.g. Safari, cookies blocked)', () => {
    // The property access itself throws — the case that would otherwise crash
    // createSession before the editor opens.
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('Access is denied for this document', 'SecurityError');
    });

    const first = getOrCreateTabReplicaId();
    expect(first).toMatch(UUID_RE);
    // Stable for the page's lifetime — one replica per page load, GC-safe
    // (the server registers a blocking row per connect; the ack clears it).
    expect(getOrCreateTabReplicaId()).toBe(first);
  });
});
