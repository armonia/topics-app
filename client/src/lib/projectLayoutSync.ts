/**
 * Sync project window layouts to server ui_state table.
 * localStorage remains the fast-paint cache; server is the durable store.
 */

const DEBOUNCE_MS = 2000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Server key for a project layout */
function serverKey(projectPath: string): string {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = projectPath.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }
  return `project-layout-${Math.abs(hash).toString(36)}`;
}

/** Save project layout to both localStorage and server (debounced) */
export function saveProjectLayout(localKey: string, projectPath: string, state: any): void {
  // Write localStorage immediately
  try { localStorage.setItem(localKey, JSON.stringify(state)); } catch {}

  // Debounced server PUT
  const key = serverKey(projectPath);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    fetch(`/api/ui-state/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => {});
  }, DEBOUNCE_MS));
}

/** Load project layout: try localStorage first, then server */
export function loadProjectLayout(localKey: string, projectPath: string): any | null {
  // Fast-paint from localStorage
  try {
    const raw = localStorage.getItem(localKey);
    if (raw) {
      // Also fire async server fetch to ensure localStorage is up-to-date
      fetchAndCacheProjectLayout(localKey, projectPath);
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

/** Async fetch from server and update localStorage cache */
async function fetchAndCacheProjectLayout(localKey: string, projectPath: string): Promise<void> {
  try {
    const key = serverKey(projectPath);
    const res = await fetch(`/api/ui-state/${encodeURIComponent(key)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data) {
      try { localStorage.setItem(localKey, JSON.stringify(data)); } catch {}
    }
  } catch {}
}
