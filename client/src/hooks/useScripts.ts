import { useEffect, useRef, useSyncExternalStore } from 'react';
import { scriptsApi } from '../lib/api';
import type { ScriptProcessInfo } from '../lib/api';
import type { WSMessage } from '../types';
import { DEFAULT_VISIBLE_INTERVAL_ENV, startVisibleInterval, type VisibleIntervalEnv } from '../state/documentVisibility';

const POLL_VISIBLE = 3000;
const POLL_BACKGROUND = 15000;

// ── Shared singleton store ──────────────────────────────────────────────────
// All consumers share the same poll interval and data, preventing duplicate fetches.

let scripts: ScriptProcessInfo[] = [];
const listeners = new Set<() => void>();
/** Stops the poll; null when none runs. The poll sleeps while the page is hidden. */
let stopPoll: (() => void) | null = null;
let visibility: VisibleIntervalEnv = DEFAULT_VISIBLE_INTERVAL_ENV;
let subscriberCount = 0;
/**
 * How many mounted consumers draw ports (the Processes panel). Ports cost the
 * server an lsof and wake its process detection: asked for only while one is
 * mounted, not by the sidebars that only count the running rows.
 */
let portsConsumers = 0;
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
    const data = await scriptsApi.list({ ports: portsConsumers > 0 });
    publish(data.scripts);
  } catch {
    // ignore errors
  } finally {
    fetchingNow = false;
  }
}

function updateInterval() {
  // No subscribers, no poll. `markVisible(false)` runs in the unmount cleanup
  // and calls this after the last unsubscribe has stopped the poll: falling
  // through to the restart below brought back a poll nobody stopped, one more
  // per open/close of the panel, each with its own fetch of `/api/scripts`.
  if (subscriberCount === 0) {
    endPoll();
    return;
  }
  const desired = visibleCount > 0
    ? (wsSubscribers > 0 ? POLL_BACKGROUND : POLL_VISIBLE)
    : POLL_BACKGROUND;
  if (desired === currentInterval && stopPoll) return;
  currentInterval = desired;
  startPoll();
}

/** (Re)start the poll at `currentInterval`, replacing the one running. */
function startPoll() {
  stopPoll?.();
  stopPoll = startVisibleInterval(fetchScripts, currentInterval, visibility);
}

function endPoll() {
  stopPoll?.();
  stopPoll = null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  subscriberCount++;
  if (subscriberCount === 1) {
    // First subscriber — start polling. `startPoll` stops any poll still
    // running before replacing it: overwriting its handle was the other half
    // of the leak above.
    fetchScripts();
    startPoll();
  }
  return () => {
    listeners.delete(listener);
    subscriberCount--;
    if (subscriberCount === 0) endPoll();
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
  if (portsConsumers > 0 && incoming.some(s => s.status === 'running' && (!s.ports || s.ports.length === 0))) {
    fetchScripts();
  }
}

// Called when a consumer that draws ports mounts (true) or unmounts (false).
function markPorts(drawn: boolean) {
  const before = portsConsumers;
  portsConsumers = drawn ? portsConsumers + 1 : Math.max(0, portsConsumers - 1);
  // The panel that opens gets its ports now, not at the next poll.
  if (before === 0 && portsConsumers > 0) fetchScripts();
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
  markPorts,
  pollIntervalMs: () => (stopPoll ? currentInterval : null),
  /** A scripted page visibility in place of the document's; null restores it. */
  setVisibility: (env: VisibleIntervalEnv | null) => { visibility = env ?? DEFAULT_VISIBLE_INTERVAL_ENV; },
};

// ── Public hook ─────────────────────────────────────────────────────────────

interface UseScriptsOptions {
  projectPath?: string;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /** This consumer draws the rows' ports (the Processes panel). */
  ports?: boolean;
}

export function useScripts({ projectPath, onMessage, ports = false }: UseScriptsOptions = {}) {
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

  useEffect(() => {
    if (!ports) return;
    markPorts(true);
    return () => markPorts(false);
  }, [ports]);

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
