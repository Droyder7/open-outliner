import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChildren, insertItem } from '@open-outliner/crdt';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createSession, type Session } from '../src/session.js';
import { REPLICA_ID_KEY } from '../src/replica-id.js';

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: vi.fn().mockImplementation(() => ({
    whenSynced: Promise.resolve(),
    destroy: vi.fn(),
  })),
}));
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: vi.fn().mockImplementation(() => ({
    synced: true,
    destroy: vi.fn(),
    sendStateless: vi.fn(),
  })),
}));

describe('session duplicate-tab identity', () => {
  let session: Session | undefined;

  afterEach(() => {
    session?.destroy();
    session = undefined;
    sessionStorage.removeItem(REPLICA_ID_KEY);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('uses the fresh identity for future HLC stamps as well as the sync connection', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_SYNC_URL', 'ws://localhost/collaboration');
    const channels: { onmessage: ((event: { data: string }) => void) | null }[] = [];
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: ((event: { data: string }) => void) | null = null;
        postMessage = vi.fn();
        close = vi.fn();
        constructor() {
          channels.push(this);
        }
      },
    );

    const originalId = '11111111-1111-4111-8111-111111111111';
    sessionStorage.setItem(REPLICA_ID_KEY, originalId);
    session = createSession('22222222-2222-4222-8222-222222222222');
    await vi.advanceTimersByTimeAsync(50);
    await session.whenReady;
    const seededNodes = getChildren(session.doc, session.rootId);
    expect(seededNodes[0]!.hlc.replicaId).toBe(originalId);

    // The original tab answers the duplicate's claim after the editor is ready.
    channels[0]!.onmessage!({ data: `taken:${originalId}` });
    const freshId = sessionStorage.getItem(REPLICA_ID_KEY)!;
    expect(freshId).not.toBe(originalId);
    expect(session.actor.replicaId).toBe(freshId);
    expect(HocuspocusProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        parameters: { replicaId: freshId, schemaVersion: '2' },
      }),
    );

    const itemId = crypto.randomUUID();
    insertItem(session.doc, itemId, session.rootId, undefined, session.actor);
    expect(
      getChildren(session.doc, session.rootId).find((node) => node.id === itemId)!.hlc.replicaId,
    ).toBe(freshId);
    // Existing stamps must remain untouched by the identity change.
    expect(
      getChildren(session.doc, session.rootId).find((node) => node.id === seededNodes[0]!.id)!.hlc
        .replicaId,
    ).toBe(originalId);
  });
});
