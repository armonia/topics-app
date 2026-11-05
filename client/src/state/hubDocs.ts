/**
 * WHOLE DOCUMENTS OF THE USAGE HUB, read once and shared: the agents' context
 * (`/api/hub/contesto`) and the feature map (`/api/hub/features`).
 *
 * The row in System shows a number out of each (the weight of Claude Code,
 * how many features Jarvis is behind on) and the level or the view behind it
 * shows the whole document: one read serves both, and opening System again
 * within `maxAgeMs` reads nothing. The map is about 250 KB and changes once a
 * day, the context is cached by the hub for a minute: neither is worth a read
 * per gesture. A failed read keeps the last answer and says so (`down`).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';

export interface HubDoc {
  data: unknown;
  /** reading: nothing answered yet; ok: the last read answered; down: it did not. */
  state: 'reading' | 'ok' | 'down';
  /** When the hub last answered (ms). */
  okAt: number | null;
}

/** The two documents: the agents' context and the feature map. */
export const HUB_CONTEXT_DOC = '/api/hub/contesto';
export const HUB_FEATURES_DOC = '/api/hub/features';

const EMPTY: HubDoc = { data: null, state: 'reading', okAt: null };
const docs = new Map<string, HubDoc>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function put(path: string, doc: HubDoc): void {
  docs.set(path, doc);
  for (const l of listeners) l();
}

/**
 * Read the document now, one read per path at a time. `fresh` waits for a read
 * already in flight and then reads again: an answer asked for before a write
 * must not stand for the state after it.
 */
export function readHubDoc(path: string, fresh = false): Promise<void> {
  const running = inFlight.get(path);
  if (running) return fresh ? running.then(() => readHubDoc(path)) : running;
  const p = apiFetch(path, { cache: 'no-store' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      put(path, { data: await r.json(), state: 'ok', okAt: Date.now() });
    })
    .catch(() => {
      const prev = docs.get(path) ?? EMPTY;
      put(path, { ...prev, state: 'down' });
    })
    .finally(() => { inFlight.delete(path); });
  inFlight.set(path, p);
  return p;
}

/** The document, read when `enabled` and older than `maxAgeMs`; `reread` reads it again now. */
export function useHubDoc(path: string, enabled: boolean, maxAgeMs: number): HubDoc & { reread: () => Promise<void> } {
  const doc = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => docs.get(path) ?? EMPTY,
  );
  useEffect(() => {
    if (!enabled) return;
    const cur = docs.get(path);
    if (!cur || cur.state !== 'ok' || cur.okAt === null || Date.now() - cur.okAt > maxAgeMs) void readHubDoc(path);
  }, [enabled, path, maxAgeMs]);
  const reread = useCallback(() => readHubDoc(path, true), [path]);
  return { ...doc, reread };
}
