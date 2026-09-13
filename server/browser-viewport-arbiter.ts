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
 * USING the page. The driver of a context is the client of the last input
 * (click, typing, wheel). Before anybody has touched it, the driver is the
 * first client that connected and is still connected, so a single pane keeps
 * working exactly as before. Everyone else is a spectator: their `resize` is
 * dropped, and their pane shows the page scaled and centred instead.
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

export interface ViewportArbiter {
  /** A client attached to the context (WS open). Order of arrival is kept. */
  noteConnect(contextId: string, clientId: string): void;
  /** A client sent a driving input: it becomes the driver of the context. */
  noteInput(contextId: string, clientId: string): void;
  /** A client detached (WS close). The context is forgotten with its last one. */
  noteDisconnect(contextId: string, clientId: string): void;
  /** May this client's `resize` be applied to the shared page? */
  canResize(contextId: string, clientId: string): boolean;
  /** Who currently owns the viewport, if anybody is connected. */
  driver(contextId: string): string | undefined;
}

interface ContextState {
  /** Connected clients, in arrival order. First one is the fallback driver. */
  order: string[];
  /** Client of the last driving input, while it is still connected. */
  driver?: string;
}

export function createViewportArbiter(): ViewportArbiter {
  const contexts = new Map<string, ContextState>();

  const current = (state: ContextState | undefined): string | undefined => {
    if (!state) return undefined;
    return state.driver ?? state.order[0];
  };

  return {
    noteConnect(contextId, clientId) {
      const state = contexts.get(contextId) ?? { order: [] };
      if (!state.order.includes(clientId)) state.order.push(clientId);
      contexts.set(contextId, state);
    },

    noteInput(contextId, clientId) {
      const state = contexts.get(contextId);
      // An input from a client we never saw connect (a REST caller, an agent
      // tool) does not make it the driver: it has no viewport to impose.
      if (!state || !state.order.includes(clientId)) return;
      state.driver = clientId;
    },

    noteDisconnect(contextId, clientId) {
      const state = contexts.get(contextId);
      if (!state) return;
      state.order = state.order.filter((id) => id !== clientId);
      // The driver left: the wheel goes back up for grabs, so the oldest
      // remaining pane drives until somebody touches the page again. Keeping
      // the dead client as driver would freeze the viewport for everybody.
      if (state.driver === clientId) state.driver = undefined;
      if (state.order.length === 0) contexts.delete(contextId);
    },

    canResize(contextId, clientId) {
      const state = contexts.get(contextId);
      // No state at all: first `resize` of a context whose socket has not been
      // registered (REST fallback, tests). Nobody to protect, let it through.
      if (!state) return true;
      if (!state.order.includes(clientId)) return false;
      return current(state) === clientId;
    },

    driver(contextId) {
      return current(contexts.get(contextId));
    },
  };
}
