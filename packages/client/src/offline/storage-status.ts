/**
 * Local-storage-failure state (offline-and-pwa.md "When local storage
 * fails"): a tiny observable so any component (a top-level banner, the
 * outliner) can react without threading props through the tree. Never a
 * silent drop — every failure mode here ends in a surfaced, named status.
 */

export type StorageStatus =
  | 'ok'
  | 'quota-exceeded' // writes are failing with a quota error
  | 'unavailable' // IndexedDB itself is unavailable (private browsing, disabled)
  | 'memory-only'; // running with no persistence as a result of the above

type Listener = (status: StorageStatus) => void;

let current: StorageStatus = 'ok';
const listeners = new Set<Listener>();

export function getStorageStatus(): StorageStatus {
  return current;
}

export function setStorageStatus(status: StorageStatus): void {
  if (status === current) return;
  current = status;
  for (const fn of listeners) fn(status);
}

export function onStorageStatusChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.name === 'QuotaExceededErrorV2' || err.code === 22)
  );
}

/**
 * Detect IndexedDB availability at startup (private browsing / disabled
 * storage can make `indexedDB.open` throw or hang-then-reject). Called once
 * before any session is created so the "changes won't survive a reload"
 * banner can show immediately rather than after a confusing later failure.
 */
export async function detectStorageAvailability(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    setStorageStatus('unavailable');
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('oo-storage-probe');
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => resolve(); // another tab holds it open; IDB itself works
    });
  } catch {
    setStorageStatus('unavailable');
  }
}
