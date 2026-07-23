import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { offlineDb } from '../src/offline/db.js';
import { callOrQueue, flushOutbox, isQueueable } from '../src/offline/outbox.js';
import { getStorageStatus, setStorageStatus } from '../src/offline/storage-status.js';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('isQueueable', () => {
  it('lists only the naturally-idempotent mutations', () => {
    expect(isQueueable('UpdateItem')).toBe(true);
    expect(isQueueable('InviteMember')).toBe(true);
    expect(isQueueable('RemoveMember')).toBe(true);
    expect(isQueueable('CreateDocument')).toBe(false);
    expect(isQueueable('GetItems')).toBe(false);
  });
});

describe('offline mutation outbox', () => {
  beforeEach(async () => {
    await offlineDb.outbox.clear();
    setOnline(true);
    setStorageStatus('ok');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls through immediately when online and the server responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ ok: true, result: { item: { id: 'x', version: 2 } } })),
    );
    const result = await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'x',
      version: 1,
      fields: { note: 'hi' },
    });
    expect(result).toEqual({ queued: false, result: { item: { id: 'x', version: 2 } } });
    expect(await offlineDb.outbox.count()).toBe(0);
  });

  it('queues a queueable mutation while offline instead of failing', async () => {
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn());
    const result = await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'x',
      version: 1,
      fields: { note: 'hi' },
    });
    expect(result).toEqual({ queued: true });
    expect(await offlineDb.outbox.count()).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('queues on a network-level fetch failure even while navigator.onLine lies', async () => {
    setOnline(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await callOrQueue('InviteMember', { workspaceId: 'w1', email: 'a@e.test' });
    expect(result).toEqual({ queued: true });
    expect(await offlineDb.outbox.count()).toBe(1);
  });

  it('does not queue non-queueable methods offline — fails fast instead', async () => {
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      callOrQueue('CreateDocument', { workspaceId: 'w1', title: 't' }),
    ).rejects.toThrow();
    expect(await offlineDb.outbox.count()).toBe(0);
  });

  it('does not queue a genuine server-side rejection (network is fine)', async () => {
    setOnline(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ok: false, error: { code: 'forbidden', message: 'nope' } }),
        ),
    );
    await expect(callOrQueue('RemoveMember', { workspaceId: 'w1', userId: 'u1' })).rejects.toThrow(
      'nope',
    );
    expect(await offlineDb.outbox.count()).toBe(0);
  });

  it('flushOutbox replays queued entries in order and clears them on success', async () => {
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn());
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'a',
      version: 1,
      fields: { note: '1' },
    });
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'b',
      version: 1,
      fields: { note: '2' },
    });
    expect(await offlineDb.outbox.count()).toBe(2);

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const parsed = JSON.parse(init.body as string) as { params: { id: string } };
        calls.push(parsed.params.id);
        return jsonResponse({ ok: true, result: { item: { id: parsed.params.id, version: 2 } } });
      }),
    );
    await flushOutbox();
    expect(calls).toEqual(['a', 'b']);
    expect(await offlineDb.outbox.count()).toBe(0);
  });

  it('drops a queued entry that comes back version_conflict or not_found (superseded)', async () => {
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn());
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'a',
      version: 1,
      fields: { note: '1' },
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ok: false, error: { code: 'version_conflict', message: 'stale' } }),
        ),
    );
    await flushOutbox();
    expect(await offlineDb.outbox.count()).toBe(0);
  });

  it('stops at the first still-offline/transient failure, preserving order for next attempt', async () => {
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn());
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'a',
      version: 1,
      fields: { note: '1' },
    });
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'b',
      version: 1,
      fields: { note: '2' },
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await flushOutbox();
    expect(await offlineDb.outbox.count()).toBe(2); // nothing dropped, network still down
  });

  it('purges the whole outbox and reports offline-access-loss on an unauthorized replay', async () => {
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn());
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'a',
      version: 1,
      fields: { note: '1' },
    });
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'b',
      version: 1,
      fields: { note: '2' },
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ok: false, error: { code: 'unauthorized', message: 'revoked' } }),
        ),
    );
    const onAccessRevoked = vi.fn();
    await flushOutbox(onAccessRevoked);
    expect(await offlineDb.outbox.count()).toBe(0);
    expect(onAccessRevoked).toHaveBeenCalledOnce();
  });

  it('surfaces quota-exceeded via storage-status instead of throwing', async () => {
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn());
    const putSpy = vi
      .spyOn(offlineDb.outbox, 'put')
      .mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
    await callOrQueue('UpdateItem', {
      documentId: 'd1',
      id: 'a',
      version: 1,
      fields: { note: '1' },
    });
    expect(getStorageStatus()).toBe('quota-exceeded');
    putSpy.mockRestore();
  });
});
