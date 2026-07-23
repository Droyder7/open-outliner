import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectStorageAvailability,
  getStorageStatus,
  isQuotaError,
  onStorageStatusChange,
  setStorageStatus,
} from '../src/offline/storage-status.js';

describe('storage-status', () => {
  beforeEach(() => setStorageStatus('ok'));

  it('notifies listeners on change and de-duplicates same-status sets', () => {
    const seen: string[] = [];
    const unsubscribe = onStorageStatusChange((s) => seen.push(s));
    setStorageStatus('quota-exceeded');
    setStorageStatus('quota-exceeded'); // no-op, already current
    setStorageStatus('ok');
    unsubscribe();
    setStorageStatus('unavailable'); // no listener anymore
    expect(seen).toEqual(['quota-exceeded', 'ok']);
    expect(getStorageStatus()).toBe('unavailable');
  });

  it('detects a working IndexedDB (fake-indexeddb in this test env) as ok', async () => {
    await detectStorageAvailability();
    expect(getStorageStatus()).toBe('ok');
  });

  it('recognizes a QuotaExceededError', () => {
    expect(isQuotaError(new DOMException('x', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError(new Error('nope'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});
