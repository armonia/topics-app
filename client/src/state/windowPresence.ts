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
import { currentWindowLabel } from '../lib/shell/tauri';

/** One tab a window holds. Chats, terminals, projects, browsers alike — a
 *  window is the group its tabs belong to, so the group has to know all of
 *  them. See `PresenceTab` in types/index.ts for the wire contract. */
export interface PresenceWindowTab {
  id: string;
  type: string;
  title?: string;
}

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
  /** Lo Spazio (gruppo) che questa finestra ospita da sola (`?space=`). È il
   *  fatto su cui la barra dei gruppi decide se un chip commuta qui o porta
   *  davanti un'altra finestra. */
  spaceId?: string;
  /** Topic ids this window currently holds open. */
  topicIds: string[];
  /** The topic focused inside that window, if any. */
  focusedTopicId?: string;
  /** Every tab the window holds, in its own order. Absent from a window running
   *  a client that predates the field — read it through `windowTabs()`, which
   *  falls back to the topic ids so an older peer still lists something. */
  tabs?: PresenceWindowTab[];
}

/**
 * The tabs of a window, with the pre-`tabs` fallback in ONE place.
 *
 * A window that announces no tabs is not an empty window; it is a window whose
 * client only knew how to announce chats. Falling back keeps its row populated
 * instead of rendering a heading over nothing.
 */
export function windowTabs(w: PresenceWindow): PresenceWindowTab[] {
  if (w.tabs && w.tabs.length > 0) return w.tabs;
  return w.topicIds.map((id) => ({ id, type: 'chat' }));
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
 * I GRUPPI che vivono in una finestra loro: `spaceId → windowLabel`.
 *
 * È il fatto su cui la barra dei gruppi decide se un chip commuta qui o porta
 * davanti un'altra finestra. Solo le finestre che dichiarano UNO spazio
 * (`?space=<id>`) contano — la principale non ne dichiara nessuno.
 *
 * Escludersi per ID non basta, ed è la stessa lezione della vecchia sezione
 * "Finestre": `windowId` sta in `sessionStorage` e ne nasce uno NUOVO ogni
 * volta che quello storage è vuoto, quindi la stessa finestra può annunciarsi
 * con id diversi. Il `windowLabel`, quando c'è, È l'identità della finestra del
 * sistema operativo. Sul web il label manca e lì le altre tab sono davvero
 * altre finestre, quindi il secondo filtro si applica solo quando c'è.
 */
export function computeSpaceWindows(
  windows: Record<string, PresenceWindow>,
  selfWindowId: string,
  selfWindowLabel?: string | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of Object.values(windows)) {
    if (!w.spaceId || !w.windowLabel) continue;
    if (w.windowId === selfWindowId) continue;
    if (selfWindowLabel && w.windowLabel === selfWindowLabel) continue;
    // Primo che parla, vince: due finestre sullo stesso gruppo non dovrebbero
    // esistere (`window_detach_space` alza quella aperta invece di clonarla), e
    // se succedesse comunque l'ordine di iterazione è l'unica risposta onesta.
    if (!map.has(w.spaceId)) map.set(w.spaceId, w.windowLabel);
  }
  return map;
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

/**
 * Gli stessi gruppi-in-finestra di `useSpaceWindows`, ma letti ADESSO e fuori
 * da React.
 *
 * Serve a chi decide dentro un gesto — sciogliere un gruppo appena svuotato,
 * per esempio — dove non c'è un componente a cui appendere un hook. Nessuna
 * copia della regola: stessa funzione pura, stessi due filtri (il proprio id e
 * il proprio label).
 */
export function spaceWindowsNow(): Map<string, string> {
  return computeSpaceWindows(
    useWindowPresenceStore.getState().windows,
    ownWindowId(),
    currentWindowLabel(),
  );
}

/** See computeSpaceWindows — i gruppi che vivono in una finestra loro. */
export function useSpaceWindows(): Map<string, string> {
  const windows = useWindowPresenceStore((s) => s.windows);
  // Anche il PROPRIO label, non solo il proprio id: vedi computeSpaceWindows.
  const selfLabel = currentWindowLabel();
  return useMemo(() => computeSpaceWindows(windows, ownWindowId(), selfLabel), [windows, selfLabel]);
}
