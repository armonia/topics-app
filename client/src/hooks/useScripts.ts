import { useEffect, useRef, useSyncExternalStore } from 'react';
import { scriptsApi } from '../lib/api';
import type { ScriptProcessInfo } from '../lib/api';
import type { WSMessage } from '../types';

const POLL_VISIBLE = 3000;
const POLL_BACKGROUND = 15000;

// ── Shared singleton store ──────────────────────────────────────────────────
// All consumers share the same poll interval and data, preventing duplicate fetches.

let scripts: ScriptProcessInfo[] = [];
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;
let fetchingNow = false;
let currentInterval = POLL_VISIBLE;
let visibleCount = 0; // number of visible subscribers
/**
 * How many mounted consumers hold the WS channel. A count, not a boolean: with
 * a boolean the FIRST consumer to unmount (a project window leaving residency)
 * set it to false while the others were still listening, and the shared poll
 * dropped from 15 s to 3 s for the rest of the session.
 */
let wsSubscribers = 0;
/** The serialized list last published: an identical answer publishes nothing. */
let scriptsKey = JSON.stringify(scripts);

function getSnapshot(): ScriptProcessInfo[] {
  return scripts;
}

function emit() {
  for (const l of listeners) l();
}

/**
 * Adopt `next` and notify, unless it is the list already published. Every
 * poll answers with a NEW array, and publishing it re-rendered every mounted
 * project sidebar (and its file tree) every 3 s with nothing changed. The
 * comparison covers every field, not just id/status/ports: watchers,
 * exitCode and completedAt are rendered too.
 */
function publish(next: ScriptProcessInfo[]): void {
  const key = JSON.stringify(next);
  if (key === scriptsKey) return;
  scripts = next;
  scriptsKey = key;
  emit();
}

async function fetchScripts() {
  if (fetchingNow) return;
  fetchingNow = true;
  try {
    const data = await scriptsApi.list();
    publish(data.scripts);
  } catch {
    // ignore errors
  } finally {
    fetchingNow = false;
  }
}

function updateInterval() {
  // Senza iscritti NON si poller. Sembra ovvio, e invece qui nasceva una
  // fuga: `markVisible(false)` gira nella pulizia dello smontaggio e chiama
  // questa funzione, che con `pollTimer` gia' azzerato dall'ultimo
  // disiscritto cadeva dritta nel `setInterval` qui sotto e RESUSCITAVA il
  // timer. Nessuno lo avrebbe piu' fermato: il prossimo `subscribe`
  // sovrascriveva `pollTimer` senza pulire quello vecchio, quindi ogni ciclo
  // apri/chiudi del pannello lasciava indietro un poll immortale — e i poll
  // orfani si sommano, ognuno con la sua fetch a `/api/scripts`.
  if (subscriberCount === 0) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    return;
  }
  const desired = visibleCount > 0
    ? (wsSubscribers > 0 ? POLL_BACKGROUND : POLL_VISIBLE)
    : POLL_BACKGROUND;
  if (desired === currentInterval && pollTimer) return;
  currentInterval = desired;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fetchScripts, currentInterval);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  subscriberCount++;
  if (subscriberCount === 1) {
    // First subscriber — start polling. La clearInterval NON e' ridondante:
    // raccoglie un eventuale timer gia' in volo invece di perderne il handle
    // riassegnando (era la seconda meta' della fuga descritta sopra).
    fetchScripts();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchScripts, currentInterval);
  }
  return () => {
    listeners.delete(listener);
    subscriberCount--;
    if (subscriberCount === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

// Called by WS handler when scripts:updated arrives
function handleWSUpdate(incoming: ScriptProcessInfo[]) {
  publish(incoming);
  // The broadcast snapshot omits ports (broadcastScriptsUpdate skips the lsof
  // lookup to stay cheap), so a freshly-started server shows its running dot
  // instantly but its :port link would otherwise wait up to one poll interval
  // (15s while WS-connected). Backfill the port-enriched list once. The 2s
  // server-side response cache + the `fetchingNow` guard prevent a fetch storm,
  // and scripts:updated only fires on discrete start/stop events (no loop).
  if (incoming.some(s => s.status === 'running' && (!s.ports || s.ports.length === 0))) {
    fetchScripts();
  }
}

// Called when a consumer attaches (true) or detaches (false) the WS channel.
function setWSConnected(connected: boolean) {
  const was = wsSubscribers > 0;
  wsSubscribers = connected ? wsSubscribers + 1 : Math.max(0, wsSubscribers - 1);
  const now = wsSubscribers > 0;
  if (was !== now) updateInterval();
  // On reconnect, fetch immediately to catch up
  if (now && !was) fetchScripts();
}

function markVisible(visible: boolean) {
  if (visible) visibleCount++;
  else visibleCount = Math.max(0, visibleCount - 1);
  updateInterval();
}

/** Test seam: the shared store, driven without React. */
export const __scriptsStoreForTests = {
  subscribe,
  getSnapshot,
  fetchScripts,
  handleWSUpdate,
  setWSConnected,
  markVisible,
  pollIntervalMs: () => (pollTimer ? currentInterval : null),
};

// ── Public hook ─────────────────────────────────────────────────────────────

interface UseScriptsOptions {
  projectPath?: string;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function useScripts({ projectPath, onMessage }: UseScriptsOptions = {}) {
  const allScripts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const visibleRef = useRef(false);

  // Track visibility
  useEffect(() => {
    visibleRef.current = true;
    markVisible(true);
    return () => {
      visibleRef.current = false;
      markVisible(false);
    };
  }, []);

  // Listen to WS messages
  useEffect(() => {
    if (!onMessage) return;
    const unsub = onMessage((msg: WSMessage) => {
      if (msg.type === 'scripts:updated' && Array.isArray(msg.scripts)) {
        handleWSUpdate(msg.scripts);
      }
    });
    setWSConnected(true);
    return () => {
      unsub();
      setWSConnected(false);
    };
  }, [onMessage]);

  // Filter by projectPath if provided
  const filtered = projectPath
    ? allScripts.filter(s => s.projectPath === projectPath)
    : allScripts;

  return {
    scripts: filtered,
    allScripts,
    refresh: fetchScripts,
    runningCount: filtered.filter(s => s.status === 'running').length,
  };
}
