import * as Y from 'yjs';
import { DOCUMENT_SCHEMA_VERSION } from '@open-outliner/shared';
import { createRpcClient, RpcClientError } from '../rpc.js';
import { library, toBase64, fromBase64, type Account } from './library.js';
export type SaveState =
  | 'Saving locally'
  | 'Saved locally'
  | 'Pending sync'
  | 'Saved on server'
  | 'Reconnect to sync'
  | 'Storage error'
  | 'Sync error';
export function synchronizeDocument(
  doc: Y.Doc,
  documentId: string,
  account: Account,
  status: (state: SaveState) => void,
) {
  const rpc = createRpcClient();
  let stopped = false;
  let running = false;
  let queued = Promise.resolve();
  let storageFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const enqueue = (bytes: Uint8Array, origin: unknown) => {
    if (origin === 'remote' || origin === 'pending-replay') return;
    status('Saving locally');
    queued = queued
      .then(async () => {
        await library.pending.put({
          id: crypto.randomUUID(),
          accountId: account.id,
          documentId,
          bytes: bytes.slice(),
          createdAt: Date.now(),
        });
        await library.documents.update(documentId, { modifiedAt: Date.now() });
        status(account.id === 'local' ? 'Saved locally' : 'Pending sync');
      })
      .catch(() => {
        storageFailed = true;
        status('Storage error');
      });
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 400);
  };
  async function flush() {
    if (stopped || running || account.id === 'local' || !navigator.onLine) return;
    running = true;
    try {
      await queued;
      if (storageFailed) {
        status('Storage error');
        return;
      }
      if (stopped) return;
      const who = await rpc.call('WhoAmI', {});
      if (who.userId !== account.id) {
        status('Reconnect to sync');
        return;
      }
      const local = await library.documents.get(documentId);
      if (!local || local.accountId !== account.id) return;
      const workspaceId = local.workspaceId ?? who.workspaceIds[0];
      if (!workspaceId) return;
      if (!local.registered) {
        await rpc.call('CreateDocument', { workspaceId, documentId, title: local.title });
        await library.documents.update(documentId, { registered: true, workspaceId });
      }
      const pending = await library.pending
        .where('[accountId+documentId]')
        .equals([account.id, documentId])
        .sortBy('createdAt');
      for (const update of pending) {
        if (stopped) return;
        const receipt = await rpc.call('PersistDocumentUpdate', {
          documentId,
          batchId: update.id,
          schemaVersion: DOCUMENT_SCHEMA_VERSION,
          update: toBase64(update.bytes),
        });
        if (receipt.batchId !== update.id) throw new Error('Invalid persistence receipt');
        await library.pending.delete(update.id);
      }
      const state = await rpc.call('GetDocumentState', {
        documentId,
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
      });
      if (stopped) return;
      Y.applyUpdate(doc, fromBase64(state.update), 'remote');
      const remaining = await library.pending
        .where('[accountId+documentId]')
        .equals([account.id, documentId])
        .count();
      status(remaining ? 'Pending sync' : 'Saved on server');
    } catch (err) {
      status(
        err instanceof RpcClientError && ['unauthorized', 'forbidden'].includes(err.code)
          ? 'Reconnect to sync'
          : 'Sync error',
      );
    } finally {
      running = false;
    }
  }
  const reconnect = () => void flush();
  window.addEventListener('online', reconnect);
  const interval = setInterval(reconnect, 5000);
  doc.on('update', enqueue);
  return {
    async restore() {
      const pending = await library.pending
        .where('[accountId+documentId]')
        .equals([account.id, documentId])
        .sortBy('createdAt');
      for (const update of pending) Y.applyUpdate(doc, update.bytes, 'pending-replay');
    },
    capture() {
      enqueue(Y.encodeStateAsUpdate(doc), null);
    },
    flush,
    stop() {
      stopped = true;
      doc.off('update', enqueue);
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('online', reconnect);
    },
  };
}
