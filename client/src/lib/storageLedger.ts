import { useSyncExternalStore } from 'react';
import { foldKey } from './devStorageProbe';

export interface StorageDiscard {
  key: string;
  quota: number;
  denied: number;
  lastAt: number;
  lastChars: number;
  userData: boolean;
}

export interface StorageDiscardSnapshot {
  total: number;
  quota: number;
  userData: number;
  keys: readonly StorageDiscard[];
}

type SetItem = (this: Storage, key: string, value: string) => void;

// Keys that hold text the user typed or a message not yet delivered, read
// from the real call sites: OUTBOUND_QUEUE_KEY and EXPIRED_QUEUE_KEY in
// hooks/outboundQueue.ts, PREFIX in components/Chat/askDraft.ts, the
// QUEUE/CLAIM/HOLD/LIFT prefixes in state/chatQueue.ts, and the composer
// text key `draft:<topicId>` in components/Chat/ChatPane.tsx. The keys in
// lib/composerMemory.ts hold provider and effort selections, not typed
// text, so they stay out on purpose.
const USER_DATA_PREFIXES: readonly string[] = [
  'messages-outbound-queue',
  'messages-expired-queue',
  'topics:ask-draft:',
  'msgQueue:',
  'draft:',
];

const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024;

const discards = new Map<string, StorageDiscard>();
const warned = new Set<string>();
const listeners = new Set<() => void>();
let cached: StorageDiscardSnapshot | null = null;
let installed = false;
let originalSetItem: SetItem | null = null;

function isUserDataKey(key: string): boolean {
  for (const prefix of USER_DATA_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { name?: unknown; code?: unknown };
  return (
    record.name === 'QuotaExceededError' ||
    record.code === 22 ||
    record.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  );
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must not break the storage path it observes.
    }
  }
}

function recordRefusedWrite(target: Storage, key: string, value: string, error: unknown): void {
  let local: unknown;
  try {
    local = (globalThis as { localStorage?: unknown }).localStorage;
  } catch {
    return;
  }
  if (target !== local) return;
  const folded = foldKey(key);
  let row = discards.get(folded);
  if (!row) {
    row = { key: folded, quota: 0, denied: 0, lastAt: 0, lastChars: 0, userData: isUserDataKey(key) };
    discards.set(folded, row);
  }
  if (isQuotaError(error)) row.quota += 1;
  else row.denied += 1;
  row.lastAt = Date.now();
  row.lastChars = value.length;
  if (!warned.has(folded)) {
    warned.add(folded);
    console.warn(
      `[storage] localStorage refused a write for key "${folded}": the quota is full or the write was denied, and the caller keeps its previous behavior`,
    );
  }
  cached = null;
  notify();
}

export function installStorageLedger(): void {
  if (installed) return;
  if (typeof Storage === 'undefined') return;
  const chained: SetItem = Storage.prototype.setItem;
  originalSetItem = chained;
  Storage.prototype.setItem = function ledgerSetItem(this: Storage, key: string, value: string): void {
    try {
      chained.call(this, key, value);
    } catch (error) {
      recordRefusedWrite(this, key, value, error);
      throw error;
    }
  };
  installed = true;
}

function buildSnapshot(): StorageDiscardSnapshot {
  const rows = [...discards.values()].map((row) => ({ ...row }));
  rows.sort((a, b) => b.quota + b.denied - (a.quota + a.denied) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let total = 0;
  let quota = 0;
  let userData = 0;
  for (const row of rows) {
    total += row.quota + row.denied;
    quota += row.quota;
    if (row.userData) userData += row.quota + row.denied;
  }
  return { total, quota, userData, keys: rows };
}

export function getStorageDiscards(): StorageDiscardSnapshot {
  if (!cached) cached = buildSnapshot();
  return cached;
}

export function subscribeStorageDiscards(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStorageDiscards(): StorageDiscardSnapshot {
  return useSyncExternalStore(subscribeStorageDiscards, getStorageDiscards, getStorageDiscards);
}

export function measureStorageUsage(): { usedBytes: number; limitBytes: number } {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    if (!store) return { usedBytes: 0, limitBytes: STORAGE_LIMIT_BYTES };
    let used = 0;
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key === null) continue;
      const value = store.getItem(key);
      used += 2 * (key.length + (value === null ? 0 : value.length));
    }
    return { usedBytes: used, limitBytes: STORAGE_LIMIT_BYTES };
  } catch {
    return { usedBytes: 0, limitBytes: STORAGE_LIMIT_BYTES };
  }
}

export function resetStorageLedgerForTests(): void {
  if (typeof Storage !== 'undefined' && installed && originalSetItem) {
    Storage.prototype.setItem = originalSetItem;
  }
  installed = false;
  originalSetItem = null;
  const hadRows = discards.size > 0;
  discards.clear();
  warned.clear();
  cached = null;
  if (hadRows) notify();
}
