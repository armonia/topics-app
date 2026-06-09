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
let wsConnected = false;

function getSnapshot(): ScriptProcessInfo[] {
  return scripts;
}

function emit() {
  for (const l of listeners) l();
}

async function fetchScripts() {
  if (fetchingNow) return;
  fetchingNow = true;
  try {
    const data = await scriptsApi.list();
    scripts = data.scripts;
    emit();
  } catch {
    // ignore errors
  } finally {
    fetchingNow = false;
  }
}

function updateInterval() {
  const desired = visibleCount > 0
    ? (wsConnected ? POLL_BACKGROUND : POLL_VISIBLE)
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
    // First subscriber — start polling
    fetchScripts();
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
  scripts = incoming;
  emit();
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

// Called by WS handler to set connection state
function setWSConnected(connected: boolean) {
  const was = wsConnected;
  wsConnected = connected;
  if (was !== connected) updateInterval();
  // On reconnect, fetch immediately to catch up
  if (connected && !was) fetchScripts();
}

function markVisible(visible: boolean) {
  if (visible) visibleCount++;
  else visibleCount = Math.max(0, visibleCount - 1);
  updateInterval();
}

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
