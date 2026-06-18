/**
 * browserSpawner — lightweight bidirectional registry of which chat (topic)
 * spawned which browser context.
 *
 * Used to render two reciprocal affordances:
 *  - in the chat header: a "→ Browser" button when this chat has spawned a
 *    browser pane (focuses the spawned browser pane).
 *  - in the browser URL bar: a "↩ Back" button when this browser was spawned
 *    from a chat (focuses the spawning chat pane).
 *
 * Storage: sessionStorage so the relationship survives in-renderer reloads
 * (Cmd+R, Vite HMR) but doesn't bleed across user-restarted Electron sessions
 * — a fresh app launch should not resurrect stale spawner pointers to panes
 * that may not exist anymore. The Map is in-memory; sessionStorage is a
 * write-through cache.
 *
 * The store is paired bidirectionally on every write so consumers can query
 * either direction in O(1) without scanning.
 */

const STORAGE_KEY = 'topics:browser-spawners:v1';

type SpawnerMap = {
  /** browser contextId → spawner topicId */
  browserToTopic: Record<string, string>;
  /** spawner topicId → browser contextId (last spawn wins) */
  topicToBrowser: Record<string, string>;
};

let state: SpawnerMap = load();
const listeners = new Set<() => void>();

function load(): SpawnerMap {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { browserToTopic: {}, topicToBrowser: {} };
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.browserToTopic &&
      parsed.topicToBrowser
    ) {
      return parsed as SpawnerMap;
    }
  } catch {
    /* swallow — corrupt storage falls through to empty map */
  }
  return { browserToTopic: {}, topicToBrowser: {} };
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private-mode — in-memory state still works */
  }
}

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function setBrowserSpawner(browserContextId: string, spawnerTopicId: string): void {
  if (!browserContextId || !spawnerTopicId) return;
  const prevTopic = state.browserToTopic[browserContextId];
  // No-op when nothing actually changes — avoids notify storms when the
  // same chat re-opens the same browser repeatedly.
  if (prevTopic === spawnerTopicId) return;

  // Remove the old reciprocal entry if this browser already had a different
  // spawner, so topicToBrowser never points at a stale chat.
  const next: SpawnerMap = {
    browserToTopic: { ...state.browserToTopic, [browserContextId]: spawnerTopicId },
    topicToBrowser: { ...state.topicToBrowser, [spawnerTopicId]: browserContextId },
  };
  if (prevTopic && prevTopic !== spawnerTopicId && next.topicToBrowser[prevTopic] === browserContextId) {
    delete next.topicToBrowser[prevTopic];
  }
  state = next;
  persist();
  notify();
}

export function getBrowserSpawner(browserContextId: string): string | null {
  return state.browserToTopic[browserContextId] ?? null;
}

export function getSpawnedBrowser(spawnerTopicId: string): string | null {
  return state.topicToBrowser[spawnerTopicId] ?? null;
}

export function clearBrowserSpawner(browserContextId: string): void {
  const topic = state.browserToTopic[browserContextId];
  if (!topic) return;
  const next: SpawnerMap = {
    browserToTopic: { ...state.browserToTopic },
    topicToBrowser: { ...state.topicToBrowser },
  };
  delete next.browserToTopic[browserContextId];
  if (next.topicToBrowser[topic] === browserContextId) {
    delete next.topicToBrowser[topic];
  }
  state = next;
  persist();
  notify();
}

export function subscribeBrowserSpawner(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// React hook — re-renders on any spawner-map mutation. Cheap: the store is
// per-tab and changes only on browser open / chat close, not on every render.
import { useSyncExternalStore } from 'react';

export function useBrowserSpawner(browserContextId: string | null): string | null {
  return useSyncExternalStore(
    subscribeBrowserSpawner,
    () => (browserContextId ? getBrowserSpawner(browserContextId) : null),
    () => null,
  );
}

export function useSpawnedBrowser(spawnerTopicId: string | null): string | null {
  return useSyncExternalStore(
    subscribeBrowserSpawner,
    () => (spawnerTopicId ? getSpawnedBrowser(spawnerTopicId) : null),
    () => null,
  );
}

/**
 * The whole spawner→browser map (key: chat topicId or terminal paneId →
 * browser contextId). Lets a tab bar look up "did THIS tab open a browser?" for
 * every tab without breaking the rules of hooks (one subscription, then plain
 * reads per tab). The map object identity changes on every mutation (state is
 * replaced immutably), so this re-renders exactly when the relationship changes.
 */
const EMPTY_MAP: Record<string, string> = {};
export function useSpawnedBrowserMap(): Record<string, string> {
  return useSyncExternalStore(
    subscribeBrowserSpawner,
    () => state.topicToBrowser,
    () => EMPTY_MAP,
  );
}
