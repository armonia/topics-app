import { useSyncExternalStore } from 'react';
import { subscribeFrames } from '../lib/wsFrameBus';

const SETTING_KEY = 'topics.native-pane-memory-eviction';
const NOTICE_KEY = 'topics.native-pane-memory-notices';
const listeners = new Set<() => void>();
let wired = false;
let pressure = false;
let enabled = readEnabled();
let notices = readNotices();

function readEnabled(): boolean {
  try { return localStorage.getItem(SETTING_KEY) !== 'false'; } catch { return true; }
}

function readNotices(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTICE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function wire(): void {
  if (wired) return;
  wired = true;
  subscribeFrames((frame) => {
    const f = frame as { type?: string; pressure?: unknown } | null;
    if (!f || f.type !== 'memory:pressure' || typeof f.pressure !== 'boolean' || pressure === f.pressure) return;
    pressure = f.pressure;
    notify();
  }, { types: ['memory:pressure'] });
}

export function subscribeNativePaneMemory(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNativePaneMemoryPressure(): boolean {
  wire();
  return pressure;
}

export function isNativePaneMemoryEvictionEnabled(): boolean {
  return enabled;
}

export function setNativePaneMemoryEvictionEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  try { localStorage.setItem(SETTING_KEY, String(next)); } catch { /* session still works */ }
  notify();
}

export function useNativePaneMemoryPressure(): boolean {
  return useSyncExternalStore(subscribeNativePaneMemory, getNativePaneMemoryPressure, () => false);
}

export function useNativePaneMemoryEvictionEnabled(): boolean {
  return useSyncExternalStore(subscribeNativePaneMemory, () => enabled, () => true);
}

export function markNativePaneMemoryEvicted(contextId: string): void {
  if (notices.has(contextId)) return;
  notices = new Set(notices).add(contextId);
  try { localStorage.setItem(NOTICE_KEY, JSON.stringify([...notices])); } catch { /* best effort */ }
  notify();
}

export function clearNativePaneMemoryNotice(contextId: string): void {
  if (!notices.has(contextId)) return;
  const next = new Set(notices);
  next.delete(contextId);
  notices = next;
  try { localStorage.setItem(NOTICE_KEY, JSON.stringify([...notices])); } catch { /* best effort */ }
  notify();
}

export function hasNativePaneMemoryNotice(contextId: string): boolean {
  return notices.has(contextId);
}

export function useNativePaneMemoryNotice(contextId: string): boolean {
  return useSyncExternalStore(
    subscribeNativePaneMemory,
    () => hasNativePaneMemoryNotice(contextId),
    () => false,
  );
}
