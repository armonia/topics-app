/**
 * windowPresence — cross-window presence over the WS presence channel.
 *
 * A "window" here is any connected client context (a browser tab, the main
 * Tauri window, or a detached `detach-*` window). Each announces its identity
 * plus the topics it currently holds; the server rebroadcasts the FULL list to
 * everyone on hello / presence:announce / socket-close. This store projects that
 * snapshot so the sidebar can render "open in another window" affordances and
 * the origin can show a "in un'altra finestra" marker.
 *
 * Everything here is EPHEMERAL — fed only from live WS frames, never persisted
 * (a detached window is a device-local OS fact whose lifetime is exactly its
 * socket's). The `windows` map self-heals: a dead socket drops out server-side
 * and the next broadcast omits it.
 *
 * Modeled on state/projectFocus.ts (a lightweight standalone zustand store off
 * the hot App.tsx ⇄ usePanelLifecycle path). Fed by the module-level WS frame
 * bus, so it works before React mounts and needs no hook wiring.
 */
import { create } from 'zustand';
import { useMemo } from 'react';
import { subscribeFrames } from '../lib/wsFrameBus';

export interface PresenceWindow {
  /** Client-stable window id (sessionStorage `topics-window-id`). */
  windowId: string;
  /** The server-side socket id (diagnostic; not used for identity). */
  clientId: string;
  /** Tauri window label (`detach-*`) when detached — the arg to
   *  `window_focus_label`. Absent for web tabs / the main window. */
  windowLabel?: string;
  /** True for a popped-out OS window. */
  detached?: boolean;
  /** Topic ids this window currently holds open. */
  topicIds: string[];
  /** The topic focused inside that window, if any. */
  focusedTopicId?: string;
}

interface WindowPresenceState {
  windows: Record<string, PresenceWindow>;
  /** Replace the whole set from a `presence:windows` snapshot. */
  setWindows: (windows: PresenceWindow[]) => void;
}

export const useWindowPresenceStore = create<WindowPresenceState>((set) => ({
  windows: {},
  setWindows: (list) =>
    set(() => {
      const next: Record<string, PresenceWindow> = {};
      for (const w of list) next[w.windowId] = w;
      return { windows: next };
    }),
}));

/** Stable action for non-React callers (the frame-bus subscriber). */
export const windowPresenceActions = {
  setWindows: (windows: PresenceWindow[]) =>
    useWindowPresenceStore.getState().setWindows(windows),
};

/**
 * Wire the presence store to the WS frame bus. Idempotent — safe to call once
 * at module load. Returns the unsubscribe fn (unused in practice; the store
 * lives for the app's lifetime).
 */
let initialized = false;
export function initWindowPresence(): () => void {
  if (initialized) return () => {};
  initialized = true;
  return subscribeFrames(
    (frame) => {
      const f = frame as { type?: string; windows?: PresenceWindow[] };
      if (f?.type === 'presence:windows' && Array.isArray(f.windows)) {
        windowPresenceActions.setWindows(f.windows);
      }
    },
    { types: ['presence:windows'] },
  );
}

/** This window's own id, so selectors can exclude it (a topic open HERE is not
 *  "open elsewhere"). Mirrors useSidebarAndLayout's getWindowId. */
function ownWindowId(): string {
  try {
    return sessionStorage.getItem('topics-window-id') ?? '';
  } catch {
    return '';
  }
}

// ── Pure selectors (unit-testable; no React, no sessionStorage) ──────────────

/**
 * Map of topicId → {windowId, windowLabel} for topics held in a window OTHER
 * than `selfWindowId`. First-seen wins when a topic is open in several other
 * windows (arbitrary but stable enough for a single "focus that window"
 * affordance). Drives the sidebar gate + AppWindow glyph.
 */
export function computeDetachedTopicMap(
  windows: Record<string, PresenceWindow>,
  selfWindowId: string,
): Map<string, { windowId: string; windowLabel?: string }> {
  const map = new Map<string, { windowId: string; windowLabel?: string }>();
  for (const w of Object.values(windows)) {
    if (w.windowId === selfWindowId) continue;
    for (const topicId of w.topicIds) {
      if (!map.has(topicId)) {
        map.set(topicId, { windowId: w.windowId, windowLabel: w.windowLabel });
      }
    }
  }
  return map;
}

/** All DETACHED windows other than `selfWindowId` (drives DetachedWindowMarker,
 *  the in-grid "this lives in another window" card). */
export function computeDetachedWindows(
  windows: Record<string, PresenceWindow>,
  selfWindowId: string,
): PresenceWindow[] {
  return Object.values(windows).filter((w) => w.detached && w.windowId !== selfWindowId);
}

/**
 * EVERY other window — detached or not — for the sidebar's "Finestre" section.
 *
 * Distinct from computeDetachedWindows on purpose: that one answers "which
 * popped-out windows hold this topic", so it filters `detached`. This one
 * answers "where is my stuff open", which must include the MAIN window too —
 * otherwise a detached window's own sidebar lists its siblings but silently
 * omits the window it was torn off from (the section would claim to show all
 * windows while hiding the most important one).
 *
 * Ordered: the non-detached (main) window first, then detached ones, so the
 * list reads root-first instead of in Object.values insertion order.
 */
export function computeOtherWindows(
  windows: Record<string, PresenceWindow>,
  selfWindowId: string,
): PresenceWindow[] {
  const others = Object.values(windows).filter((w) => w.windowId !== selfWindowId);
  return [
    ...others.filter((w) => !w.detached),
    ...others.filter((w) => w.detached),
  ];
}

// ── React hooks (thin wrappers over the pure selectors) ──────────────────────

/** See computeDetachedTopicMap — excludes THIS window's id. */
export function useDetachedTopicMap(): Map<string, { windowId: string; windowLabel?: string }> {
  const windows = useWindowPresenceStore((s) => s.windows);
  return useMemo(() => computeDetachedTopicMap(windows, ownWindowId()), [windows]);
}

/** See computeDetachedWindows — excludes THIS window's id. */
export function useDetachedWindows(): PresenceWindow[] {
  const windows = useWindowPresenceStore((s) => s.windows);
  return useMemo(() => computeDetachedWindows(windows, ownWindowId()), [windows]);
}

/** See computeOtherWindows — every other window, main included. */
export function useOtherWindows(): PresenceWindow[] {
  const windows = useWindowPresenceStore((s) => s.windows);
  return useMemo(() => computeOtherWindows(windows, ownWindowId()), [windows]);
}
