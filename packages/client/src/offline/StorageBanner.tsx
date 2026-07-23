import { useEffect, useState } from 'react';
import { getStorageStatus, onStorageStatusChange, type StorageStatus } from './storage-status.js';

const MESSAGES: Record<Exclude<StorageStatus, 'ok'>, string> = {
  'quota-exceeded': 'Storage full — free up space or some offline edits may not persist.',
  unavailable: "This browser's local storage is unavailable — changes won't survive a reload.",
  'memory-only': "Local storage isn't working — changes won't survive a reload.",
};

/** Surfaces local-storage failure states (offline-and-pwa.md); never a silent drop. */
export function StorageBanner(): JSX.Element | null {
  const [status, setStatus] = useState<StorageStatus>(getStorageStatus());

  useEffect(() => onStorageStatusChange(setStatus), []);

  if (status === 'ok') return null;
  return <div className="storage-banner">{MESSAGES[status]}</div>;
}
