/**
 * WHO GETS TO RESIZE A SHARED PAGE.
 *
 * One server-side browser context can have several viewers at once (the Mac
 * pane, a phone on the same Wi-Fi, a task drawer). Every pane streams its own
 * size from a ResizeObserver, and the server used to apply the last `resize`
 * that arrived. So a phone that merely OPENED the shared context reflowed the
 * page to 390 px wide for everybody, including the person typing on the Mac.
 * Nothing errored: the page just became a phone page under someone's hands.
 *
 * The rule is the one a shared desk has: the viewport belongs to whoever is
 * USING the page. The driver of a context is the DEVICE of the last input
 * (click, typing, wheel). Before anybody has touched it, the driver is the
 * first device that showed up on this context and is still connected, so a
 * single pane keeps working exactly as before. Everyone else is a spectator:
 * their `resize` is dropped, and their pane shows the page scaled and centred.
 *
 * THE IDENTITY IS THE DEVICE, NOT THE SOCKET, and the difference is the whole
 * reason this file was rewritten. A socket dies for reasons that have nothing
 * to do with who is working: the laptop sleeps, the server reloads, and the
 * Tauri shell swaps its native executor socket for a streaming one the moment
 * a second viewer turns the pane into a shared one. Keyed by socket, the Mac
 * that had been driving came back as a spectator and a phone that had never
 * been touched kept the viewport. Keyed by device, coming back is coming back.
 *
 * Two consequences are deliberate:
 *   - `seen` keeps a device in arrival order for the whole life of the context,
 *     even while it has no socket. That is what lets the Mac reclaim its place
 *     after the native-to-streaming swap, instead of queueing behind the phone.
 *   - the driver is remembered while it is away. Whoever used the page last
 *     gets it back on reconnection, unless somebody else used it meanwhile.
 *
 * The native executor is NOT a viewer. The Tauri shell opens a socket on the
 * same context to EXECUTE, not to watch (see `browser-viewer-count.ts`, which
 * excludes it from the audience for the same reason): it has no viewport to
 * impose, so it can neither drive nor resize. It stays in `seen` though, its
 * device did show up here first.
 *
 * `mousemove` deliberately does NOT claim the wheel. Passing the cursor over a
 * pane to read it is not driving, and if it were, a shared page would change
 * size under the hands of the person typing every time somebody else's mouse
 * crossed their own screen.
 *
 * Pure and injection-free on purpose: the arbitration is the part that must be
 * falsifiable in a unit test, without a socket or a headless browser.
 */

/** The input actions that claim the viewport. `mousemove` is not one of them. */
export const DRIVING_INPUT_ACTIONS = ['click', 'type', 'scroll', 'keypress'] as const;

export type DrivingInputAction = (typeof DRIVING_INPUT_ACTIONS)[number];

/** Does this `input` action make its sender the driver of the context? */
export function isDrivingInput(action: string): action is DrivingInputAction {
  return (DRIVING_INPUT_ACTIONS as readonly string[]).includes(action);
}

/**
 * Who is talking: the socket that carries the message, and the device behind
 * it. Two sockets of the same device are the same claimant.
 */
export interface ViewportClient {
  socket: string;
  device: string;
  /**
   * WHO the device belongs to, when we know it: a claimant of this owner that
   * comes back under a NEW device name inherits the seat of the one that is
   * gone. See `takeSeat`.
   */
  owner?: string;
}

export interface ViewportArbiter {
  /** A client attached to the context (WS open). Arrival order is kept. */
  noteConnect(contextId: string, client: ViewportClient): void;
  /**
   * This socket is the native executor of the shell: it executes, it does not
   * watch. It leaves the audience and can never drive nor resize.
   */
  noteExecutor(contextId: string, client: ViewportClient): void;
  /** A client sent a driving input: its device becomes the driver. */
  noteInput(contextId: string, client: ViewportClient): void;
  /**
   * A client detached (WS close). The context is forgotten with its last
   * socket. Returns the device that inherits the viewport when the departure
   * CHANGED the driver, so the caller can go ask it for its size: nobody else
   * will, the new driver's pane deduplicates a size it has already sent.
   */
  noteDisconnect(contextId: string, client: ViewportClient): string | undefined;
  /** May this client's `resize` be applied to the shared page? */
  canResize(contextId: string, client: ViewportClient): boolean;
  /** Which device currently owns the viewport, if anybody is connected. */
  driverDevice(contextId: string): string | undefined;
}

interface ContextState {
  /**
   * Devices in order of first appearance on this context, kept even while a
   * device is disconnected. The first one still present is the fallback driver.
   */
  seen: string[];
  /** Connected VIEWER sockets per device. A device with none is not present. */
  viewers: Map<string, Set<string>>;
  /** Every connected socket, viewers and executors: the state dies with them. */
  sockets: Set<string>;
  /**
   * Every socket of a device, viewers AND executors. A device is GONE only when
   * this is empty: the Tauri shell watching nothing while it executes is still
   * sitting here, and its seat is not free.
   */
  attached: Map<string, Set<string>>;
  /**
   * Who took the seat of a device that was gone, while it was gone. A seat is
   * lent, not given: the predecessor coming back takes it straight back, unless
   * the heir has used the page meanwhile and earned it.
   */
  succession: Map<string, string>;
  /** Owner of each device in `seen`, when the caller knows it. */
  owners: Map<string, string>;
  /** Device of the last driving input, remembered while it is away. */
  driver?: string;
}

export function createViewportArbiter(): ViewportArbiter {
  const contexts = new Map<string, ContextState>();

  const present = (state: ContextState, device: string): boolean =>
    (state.viewers.get(device)?.size ?? 0) > 0;

  /**
   * Nothing of this device is connected any more, not even a socket that only
   * executes. Being gone is what frees a seat, and watching is not the test:
   * the native shell of the Mac is not watching and is very much still here.
   */
  const gone = (state: ContextState, device: string): boolean =>
    (state.attached.get(device)?.size ?? 0) === 0;

  const current = (state: ContextState | undefined): string | undefined => {
    if (!state) return undefined;
    if (state.driver && present(state, state.driver)) return state.driver;
    return state.seen.find((device) => present(state, device));
  };

  const ensure = (contextId: string): ContextState => {
    const existing = contexts.get(contextId);
    if (existing) return existing;
    const born: ContextState = {
      seen: [], viewers: new Map(), sockets: new Set(), owners: new Map(),
      attached: new Map(), succession: new Map(),
    };
    contexts.set(contextId, born);
    return born;
  };

  /**
   * A claimant nobody has seen on this context yet takes its place in the
   * queue. If the SAME OWNER left behind a claimant that is no longer present,
   * the newcomer takes over its seat, and its steering wheel if it had one.
   *
   * That is the Mac coming back under a new name: the updater relaunches the
   * app, the page is reloaded, or the pane is dragged into a new window. The
   * pane name lives in the session storage of a webview that died with it, so
   * the same screen reappears as a stranger. Without this, a phone that is
   * only watching holds the viewport until somebody at the Mac touches
   * something, which is the bug this whole file is about, one restart later.
   *
   * Only from an ABSENT predecessor, and only within one owner: two panes of
   * the same machine both open stay two claimants, because two windows are two
   * screens and a viewport is about the screen.
   */
  const takeSeat = (state: ContextState, client: ViewportClient): void => {
    const orphans = client.owner === undefined
      ? []
      : state.seen.filter((device) =>
        state.owners.get(device) === client.owner && gone(state, device));
    const predecessor = orphans.find((device) => device === state.driver) ?? orphans[0];
    if (predecessor === undefined) {
      state.seen.push(client.device);
      return;
    }
    state.seen[state.seen.indexOf(predecessor)] = client.device;
    state.owners.delete(predecessor);
    state.viewers.delete(predecessor);
    state.succession.set(predecessor, client.device);
    // If the predecessor was itself sitting in a borrowed seat, the debt moves
    // on with the seat: whoever lent it is owed by whoever holds it now.
    for (const [lender, heir] of state.succession) {
      if (heir === predecessor) state.succession.set(lender, client.device);
    }
    if (state.driver === predecessor) state.driver = client.device;
  };

  /**
   * The claimant that lent its seat is back. It takes it, and the heir goes
   * where it belongs, at the end of the queue: it did arrive later.
   *
   * This is the same screen as before (same name, same owner) and the seat was
   * only warm. The heir keeps it for good the moment it USES the page, and
   * `noteInput` cancels the debt then.
   */
  const reclaimSeat = (state: ContextState, client: ViewportClient): boolean => {
    const heir = state.succession.get(client.device);
    if (heir === undefined) return false;
    state.succession.delete(client.device);
    const at = state.seen.indexOf(heir);
    if (at < 0) return false;
    state.seen[at] = client.device;
    state.seen.push(heir);
    if (state.driver === heir) state.driver = client.device;
    return true;
  };

  return {
    noteConnect(contextId, client) {
      const state = ensure(contextId);
      state.sockets.add(client.socket);
      const own = state.attached.get(client.device) ?? new Set<string>();
      own.add(client.socket);
      state.attached.set(client.device, own);
      if (!state.seen.includes(client.device) && !reclaimSeat(state, client)) {
        takeSeat(state, client);
      }
      if (client.owner !== undefined) state.owners.set(client.device, client.owner);
      const sockets = state.viewers.get(client.device) ?? new Set<string>();
      sockets.add(client.socket);
      state.viewers.set(client.device, sockets);
    },

    noteExecutor(contextId, client) {
      const state = contexts.get(contextId);
      if (!state) return;
      // It stays a connected socket (the context lives while it is open) and it
      // stays in `seen` (its device did show up here), it just stops being part
      // of the audience.
      state.viewers.get(client.device)?.delete(client.socket);
    },

    noteInput(contextId, client) {
      const state = contexts.get(contextId);
      // An input from a socket we never saw connect (a REST caller, an agent
      // tool, the native executor) does not make it the driver: it has no
      // viewport to impose.
      if (!state || !state.viewers.get(client.device)?.has(client.socket)) return;
      state.driver = client.device;
      // Using the page settles the debt: a seat taken over from somebody away
      // stops being borrowed the moment the heir does something with it.
      for (const [lender, heir] of state.succession) {
        if (heir === client.device) state.succession.delete(lender);
      }
    },

    noteDisconnect(contextId, client) {
      const state = contexts.get(contextId);
      if (!state) return undefined;
      const before = current(state);
      state.sockets.delete(client.socket);
      const own = state.attached.get(client.device);
      own?.delete(client.socket);
      if (own && own.size === 0) state.attached.delete(client.device);
      const sockets = state.viewers.get(client.device);
      sockets?.delete(client.socket);
      if (sockets && sockets.size === 0) state.viewers.delete(client.device);
      // `seen` and `owners` keep the departed device: it is what lets the same
      // owner inherit the seat when it comes back under another name.
      if (state.sockets.size === 0) {
        contexts.delete(contextId);
        return undefined;
      }
      const after = current(state);
      // The driver of record is kept even though it is away: if it comes back
      // before anybody else touches the page, it finds its viewport again.
      return after && after !== before ? after : undefined;
    },

    canResize(contextId, client) {
      const state = contexts.get(contextId);
      // No state at all: first `resize` of a context whose socket has not been
      // registered (REST fallback, tests). Nobody to protect, let it through.
      if (!state) return true;
      if (!state.viewers.get(client.device)?.has(client.socket)) return false;
      return current(state) === client.device;
    },

    driverDevice(contextId) {
      return current(contexts.get(contextId));
    },
  };
}
