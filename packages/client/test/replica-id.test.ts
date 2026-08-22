import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getOrCreateReplicaId,
  getOrCreateTabReplicaId,
  claimReplicaId,
  type ReplicaClaimChannel,
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

/**
 * Minimal BroadcastChannel stand-ins: channels in one group deliver a
 * postMessage to every OTHER member's onmessage (real channels never deliver
 * to the sender), synchronously for determinism. Delivery to a member with no
 * listener (yet) is dropped, like a real channel — a claim announced before
 * the other tab is listening is simply not seen, which the protocol tolerates
 * because every joining tab announces its own claim. Each channel records what
 * it sent (`sent`) so tests can assert on replies.
 */
class FakeChannel implements ReplicaClaimChannel {
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: string[] = [];
  private group: FakeChannel[] = [];

  join(group: FakeChannel[]): void {
    this.group = group;
    group.push(this);
  }

  postMessage(data: string): void {
    this.sent.push(data);
    for (const other of this.group) {
      if (other !== this) other.onmessage?.({ data });
    }
  }

  close(): void {
    this.onmessage = null;
  }
}

/** Wire n channels into one delivery group. */
function channelGroup(n: number): FakeChannel[] {
  const group: FakeChannel[] = [];
  for (let i = 0; i < n; i++) {
    const ch = new FakeChannel();
    ch.join(group);
  }
  return group;
}

/** A tab whose sessionStorage already holds `id` — a live tab, or a duplicate. */
function tabWithId(id: string): { storage: Pick<Storage, 'getItem' | 'setItem'>; entries: Map<string, string> } {
  const tab = fakeTab();
  tab.entries.set(REPLICA_ID_KEY, id);
  return tab;
}

describe('claimReplicaId — duplicate-tab duel (ADR-0009 note, 2026-08-22)', () => {
  it('the duplicate tab loses the duel: it re-mints, persists, and notifies; the original keeps its id', () => {
    // Tab A is already live with id id-X.
    const [chA, chB] = channelGroup(2);
    const tabA = tabWithId('id-X');
    const original = claimReplicaId(tabA.storage, chA, () => 'should-not-mint');

    // "Duplicate Tab": tab B's sessionStorage is a copy holding the SAME id.
    const tabB = tabWithId('id-X');
    const remints: string[] = [];
    const duplicate = claimReplicaId(tabB.storage, chB, () => 'id-Y', (id) => remints.push(id));

    expect(original.get()).toBe('id-X'); // holder wins the duel
    expect(duplicate.get()).toBe('id-Y'); // duplicate re-minted
    expect(remints).toEqual(['id-Y']);
    expect(tabB.entries.get(REPLICA_ID_KEY)).toBe('id-Y'); // healed in storage
    expect(tabA.entries.get(REPLICA_ID_KEY)).toBe('id-X'); // original untouched
  });

  it('after a re-mint the duplicate defends its NEW id and stays silent for the old one', () => {
    const [chA, chB] = channelGroup(2);
    claimReplicaId(tabWithId('id-X').storage, chA, () => 'unused');
    const duplicate = claimReplicaId(tabWithId('id-X').storage, chB, () => 'id-Y');
    expect(duplicate.get()).toBe('id-Y');

    // Someone claims the duplicate's new id → defended. Someone claims the id
    // it lost → no reply (it no longer holds it).
    chB.onmessage?.({ data: 'claim:id-Y' });
    chB.onmessage?.({ data: 'claim:id-X' });
    expect(chB.sent.filter((m) => m.startsWith('taken:'))).toEqual(['taken:id-Y']);
  });

  it('a holder replies taken only for the id it holds; foreign claims and takens are ignored', () => {
    const [chA] = channelGroup(1);
    const tab = tabWithId('id-X');
    const claim = claimReplicaId(tab.storage, chA, () => 'should-not-mint');

    chA.onmessage?.({ data: 'claim:id-X' }); // claim for our id → defended
    chA.onmessage?.({ data: 'claim:id-Z' }); // someone else's id → not ours
    chA.onmessage?.({ data: 'taken:id-Z' }); // taken for an id we don't hold → ignored
    expect(chA.sent).toEqual(['claim:id-X', 'taken:id-X']);
    expect(claim.get()).toBe('id-X'); // no spurious re-mint
  });

  it('two tabs with distinct ids never duel', () => {
    const [chA, chB] = channelGroup(2);
    const remints: string[] = [];
    const a = claimReplicaId(tabWithId('id-A').storage, chA, () => 'unused');
    const b = claimReplicaId(tabWithId('id-B').storage, chB, () => 'unused', (id) => remints.push(id));
    expect(a.get()).toBe('id-A');
    expect(b.get()).toBe('id-B');
    expect(remints).toEqual([]);
    expect(chA.sent).toEqual(['claim:id-A']);
    expect(chB.sent).toEqual(['claim:id-B']);
  });

  it('a re-minted id is itself defensible: a third tab seeded with it loses too', () => {
    const [chA, chB, chC] = channelGroup(3);
    claimReplicaId(tabWithId('id-X').storage, chA, () => 'unused');
    const firstDuplicate = claimReplicaId(tabWithId('id-X').storage, chB, () => 'id-Y');
    expect(firstDuplicate.get()).toBe('id-Y');

    // A tab duplicated from the re-minted tab shares id-Y and must lose.
    const secondDuplicate = claimReplicaId(tabWithId('id-Y').storage, chC, () => 'id-Z');
    expect(secondDuplicate.get()).toBe('id-Z');
    expect(firstDuplicate.get()).toBe('id-Y'); // the first duplicate keeps id-Y
  });

  it('stop() detaches: a stopped tab no longer answers claims', () => {
    const [chA] = channelGroup(1);
    const claim = claimReplicaId(tabWithId('id-X').storage, chA, () => 'unused');
    claim.stop();
    // onmessage is cleared, so delivering a claim is a no-op — no reply.
    chA.onmessage?.({ data: 'claim:id-X' });
    expect(chA.sent).toEqual(['claim:id-X']);
    expect(claim.get()).toBe('id-X');
  });

  it('works without a channel (no BroadcastChannel): the id is minted and stable', () => {
    const { storage } = fakeTab();
    const claim = claimReplicaId(storage, undefined, () => 'id-1');
    expect(claim.get()).toBe('id-1');
    expect(claim.get()).toBe('id-1');
    claim.stop();
  });
});
