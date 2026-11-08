/**
 * The Claude proxy's activity log (`/api/switchboard/activity`, with
 * `/profiles` for the labels), read in the background and again every minute
 * while the window is visible, as the hub's page did (usage-hub public/app.js:
 * prefetch, then a refresh every 60 s). One reading for every reader: the
 * bell's button (an expired token lights it with the panel closed), the
 * account rows of «Now» and the History's «Account Claude» lines.
 *
 * Only while somebody reads and the hub is part of this installation (the
 * readers pass `useHubEverRead()`): without the hub the network stays silent
 * (HUBBR-04). A failed read drops the old log, so nothing shows it as current.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';
import { startVisibleInterval, type VisibleIntervalEnv } from './documentVisibility';

export interface ProxyActivity {
  activity: unknown;
  profiles: unknown;
  /** When it was read: the readers measure «the last hour» from here. */
  readAt: number;
}

/** The hub's page read the log again every minute. */
export const PROXY_ACTIVITY_REFRESH_MS = 60_000;

type Fetch = (path: string) => Promise<Response>;

export interface ProxyActivityDeps {
  fetch: Fetch;
  env?: VisibleIntervalEnv;
  now?: () => number;
}

let current: ProxyActivity | null = null;
const listeners = new Set<() => void>();
let readers = 0;
let stopTimer: (() => void) | null = null;
let deps: ProxyActivityDeps = { fetch: apiFetch };

function announce(): void {
  for (const cb of listeners) cb();
}

async function readJson(path: string): Promise<unknown> {
  try {
    const resp = await deps.fetch(path);
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

/** Reads the log now; every reader sees the result. */
export async function refreshProxyActivity(): Promise<void> {
  const [activity, profiles] = await Promise.all([readJson('/api/switchboard/activity'), readJson('/api/switchboard/profiles')]);
  current = activity === null ? null : { activity, profiles, readAt: (deps.now ?? Date.now)() };
  announce();
}

/** One more reader: the first starts the reading and the minute's timer, the last one out stops it. */
export function retainProxyActivity(): () => void {
  readers += 1;
  if (readers === 1) {
    void refreshProxyActivity();
    stopTimer = startVisibleInterval(() => { void refreshProxyActivity(); }, PROXY_ACTIVITY_REFRESH_MS, deps.env);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    readers -= 1;
    if (readers === 0) { stopTimer?.(); stopTimer = null; }
  };
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const snapshot = () => current;

/** Tests only: the log as the readers see it. */
export const _readProxyActivityForTests = (): ProxyActivity | null => current;

/** The log as last read, or null: not read yet, the proxy silent, or `enabled` false. */
export function useProxyActivity(enabled: boolean): ProxyActivity | null {
  useEffect(() => (enabled ? retainProxyActivity() : undefined), [enabled]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  return enabled ? value : null;
}

/** Tests only: a fake fetch and clock, and a clean store. */
export function _resetProxyActivityForTests(next: ProxyActivityDeps): void {
  stopTimer?.();
  stopTimer = null;
  readers = 0;
  current = null;
  listeners.clear();
  deps = next;
}
