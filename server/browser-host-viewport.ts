/**
 * THE VIEWPORT OF A PAGE THE MAC'S NATIVE PANE HOSTS (TOPIC-BROWSER-05).
 *
 * A shared page takes the size of whoever is using it. On the server's Chromium
 * that is a `resize` the arbiter lets through. A page the Mac hosts
 * (NATIVE-HOST-01) is not the server's to resize: it is the Mac's WKWebView,
 * laid out at the Mac's slot, and an iPad that used it got the Mac's layout
 * scaled down and letterboxed, its own `resize` dropped on the floor.
 *
 * So the Mac is the driver until another device uses the page. Then the server
 * tells the host to lay the page out at that device's size (`host_viewport`
 * with a size), and to give it back to its own slot (`host_viewport` without
 * one) when the Mac uses it again or the device goes away.
 *
 * Keyed by device (`viewportClaimantOf`), like the arbiter and for its reason:
 * a phone's socket dies and comes back, the phone is the same phone.
 *
 * Pure, with the sending injected.
 */

/** Server -> host: lay the page out at this size, or (no size) at your own. */
export interface HostViewportCommand {
  type: "host_viewport";
  width?: number;
  height?: number;
}

export interface HostViewportDeps {
  send(contextId: string, cmd: HostViewportCommand): void;
}

export interface HostViewport {
  /**
   * A viewer's pane size (its `resize` frames, deduplicated by the viewer).
   * Kept whoever serves the page: a pane that sent it while the server's
   * Chromium did never says it again once the Mac hosts.
   */
  noteSize(contextId: string, device: string, width: number, height: number): void;
  /** A viewer used the page: a driving input, or a `resize` that says `driving`. */
  noteRemoteUse(contextId: string, device: string): void;
  /**
   * How a viewer shows the page: laid out on its own (BROWSER-DOM-LAYOUT-01)
   * or at the page's size. One that lays it out on its own never drives the
   * host's size, and using the page gives it back to the Mac's slot.
   */
  noteLayout(contextId: string, device: string, own: boolean): void;
  /** The Mac used the page in its own pane. */
  noteHostUse(contextId: string): void;
  /** A viewer's last socket on the context closed. */
  noteViewerGone(contextId: string, device: string): void;
  /** No pane of this device shows the page any more: it is not using it. Its size stays. */
  noteViewerHidden(contextId: string, device: string): void;
  /**
   * A pane of this device shows the page again. If it was the one using the
   * page when it left, and nobody has used the page since, it still is.
   */
  noteViewerShown(contextId: string, device: string): void;
  /**
   * A host declared itself, or came back. It shows the device that was using
   * the page again, unless the Mac's user used the page while it was away.
   */
  noteHostReady(contextId: string, usedWhileAway?: boolean): void;
  /** The server's Chromium took the context over: nobody drives a host. The sizes stay. */
  forget(contextId: string): void;
  /** The device whose size the host is showing, if any. */
  driver(contextId: string): string | undefined;
}

interface Size { width: number; height: number }

interface ContextState {
  sizes: Map<string, Size>;
  /** Devices that lay the page out at their own size and never drive the host's. */
  own: Set<string>;
  driver?: string;
  /** The driver whose panes all left the screen, while nobody else has used the page. */
  away?: string;
  /**
   * What the host was last told: a size, or null for its own. Null too for a
   * host that has just declared itself: it starts at its own size.
   */
  told: Size | null;
}

export function createHostViewport(deps: HostViewportDeps): HostViewport {
  const contexts = new Map<string, ContextState>();
  const ensure = (contextId: string): ContextState => {
    let state = contexts.get(contextId);
    if (!state) {
      state = { sizes: new Map(), own: new Set(), told: null };
      contexts.set(contextId, state);
    }
    return state;
  };

  /** Nobody else's size: the page goes back to the Mac's slot. */
  const giveBack = (contextId: string, state: ContextState): void => {
    state.away = undefined;
    if (state.driver === undefined) return;
    state.driver = undefined;
    tell(contextId, state);
  };

  /** Tell the host what it should show now, unless it is showing it already. */
  const tell = (contextId: string, state: ContextState): void => {
    const size = state.driver !== undefined ? state.sizes.get(state.driver) : undefined;
    // A driver whose size is not known yet keeps whatever the host shows: its
    // `resize` is on its way (the claim carries one) and will be applied then.
    if (state.driver !== undefined && !size) return;
    const next = size ?? null;
    const told = state.told;
    if (told === null ? next === null : next !== null && told.width === next.width && told.height === next.height) return;
    state.told = next;
    deps.send(contextId, next ? { type: "host_viewport", width: next.width, height: next.height } : { type: "host_viewport" });
  };

  return {
    noteSize(contextId, device, width, height) {
      if (!(width > 0 && height > 0)) return;
      const state = ensure(contextId);
      state.sizes.set(device, { width: Math.round(width), height: Math.round(height) });
      if (state.driver === device) tell(contextId, state);
    },
    noteRemoteUse(contextId, device) {
      const state = ensure(contextId);
      if (state.own.has(device)) { giveBack(contextId, state); return; }
      state.driver = device;
      state.away = undefined;
      tell(contextId, state);
    },
    noteLayout(contextId, device, own) {
      if (!own) {
        contexts.get(contextId)?.own.delete(device);
        return;
      }
      const state = ensure(contextId);
      state.own.add(device);
      if (state.away === device) state.away = undefined;
      if (state.driver === device) giveBack(contextId, state);
    },
    noteHostUse(contextId) {
      const state = contexts.get(contextId);
      if (state) giveBack(contextId, state);
    },
    noteViewerGone(contextId, device) {
      const state = contexts.get(contextId);
      if (!state) return;
      state.sizes.delete(device);
      state.own.delete(device);
      if (state.away === device) state.away = undefined;
      if (state.driver === device) {
        state.driver = undefined;
        tell(contextId, state);
      }
      if (state.sizes.size === 0 && state.own.size === 0 && state.driver === undefined) contexts.delete(contextId);
    },
    noteViewerHidden(contextId, device) {
      const state = contexts.get(contextId);
      if (!state || state.driver !== device) return;
      state.driver = undefined;
      state.away = device;
      tell(contextId, state);
    },
    noteViewerShown(contextId, device) {
      const state = contexts.get(contextId);
      if (!state || state.driver !== undefined || state.away !== device) return;
      state.driver = device;
      state.away = undefined;
      tell(contextId, state);
    },
    noteHostReady(contextId, usedWhileAway = false) {
      const state = contexts.get(contextId);
      if (!state) return;
      // A host that comes back has forgotten what it was told, and starts at
      // its own size: a blip of its socket must not cost the device that was
      // using the page its layout. Unless the Mac took the page back meanwhile.
      state.told = null;
      if (usedWhileAway) { state.driver = undefined; state.away = undefined; }
      if (state.driver !== undefined) tell(contextId, state);
    },
    forget(contextId) {
      const state = contexts.get(contextId);
      if (!state) return;
      state.driver = undefined;
      state.away = undefined;
      state.told = null;
    },
    driver: (contextId) => contexts.get(contextId)?.driver,
  };
}
