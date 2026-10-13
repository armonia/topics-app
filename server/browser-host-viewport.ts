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
  /** A viewer's pane size (its `resize` frames, deduplicated by the viewer). */
  noteSize(contextId: string, device: string, width: number, height: number): void;
  /** A viewer used the page: a driving input, or a `resize` that says `driving`. */
  noteRemoteUse(contextId: string, device: string): void;
  /** The Mac used the page in its own pane. */
  noteHostUse(contextId: string): void;
  /** A viewer's last socket on the context closed. */
  noteViewerGone(contextId: string, device: string): void;
  /** A host declared itself, or came back: it starts at its own size. */
  noteHostReady(contextId: string): void;
  /** The context is no longer hosted, for good. */
  forget(contextId: string): void;
  /** The device whose size the host is showing, if any. */
  driver(contextId: string): string | undefined;
}

interface Size { width: number; height: number }

interface ContextState {
  sizes: Map<string, Size>;
  driver?: string;
  /** What the host was last told: a size, null for its own, undefined for nothing yet. */
  told?: Size | null;
}

export function createHostViewport(deps: HostViewportDeps): HostViewport {
  const contexts = new Map<string, ContextState>();
  const ensure = (contextId: string): ContextState => {
    let state = contexts.get(contextId);
    if (!state) {
      state = { sizes: new Map() };
      contexts.set(contextId, state);
    }
    return state;
  };

  /** Tell the host what it should show now, unless it is showing it already. */
  const tell = (contextId: string, state: ContextState): void => {
    const size = state.driver !== undefined ? state.sizes.get(state.driver) : undefined;
    // A driver whose size is not known yet keeps whatever the host shows: its
    // `resize` is on its way (the claim carries one) and will be applied then.
    if (state.driver !== undefined && !size) return;
    const next = size ?? null;
    const told = state.told;
    if (told !== undefined && (told === null ? next === null : next !== null && told.width === next.width && told.height === next.height)) return;
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
      state.driver = device;
      tell(contextId, state);
    },
    noteHostUse(contextId) {
      const state = contexts.get(contextId);
      if (!state || state.driver === undefined) return;
      state.driver = undefined;
      tell(contextId, state);
    },
    noteViewerGone(contextId, device) {
      const state = contexts.get(contextId);
      if (!state) return;
      state.sizes.delete(device);
      if (state.driver !== device) return;
      state.driver = undefined;
      tell(contextId, state);
    },
    noteHostReady(contextId) {
      const state = contexts.get(contextId);
      if (!state) return;
      // A host that comes back has forgotten what it was told: a blip of its
      // socket must not cost the device that was using the page its layout.
      state.told = undefined;
      if (state.driver !== undefined) tell(contextId, state);
    },
    forget(contextId) {
      contexts.delete(contextId);
    },
    driver: (contextId) => contexts.get(contextId)?.driver,
  };
}
