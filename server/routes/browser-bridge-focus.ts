/**
 * Mounting half of `browser/focus-pane`: the plain `browser:focus-pane`
 * broadcast only wakes a window that already shows the pane, so when nobody
 * attaches in time the primary window is nudged to mount one with the same
 * `browser:force-open` fallback open-pane uses (cards 6e893f97, 05105d29).
 * The context already has a live page, so the forced pane is seeded with its
 * CURRENT url instead of a fresh navigation.
 */

import type { OutboundMessage } from "../../shared/ws-outbound";

export interface FocusPaneFlowDeps {
  broadcastToAll: (message: OutboundMessage) => void;
  waitForAttachedPane: (contextId: string, budgetMs: number) => Promise<boolean>;
  paneWaitMs: number;
  currentUrl: (contextId: string) => string | undefined;
}

/** Returns whether a pane ended up mounted for the context. */
export function makeFocusPaneFlow(deps: FocusPaneFlowDeps): (contextId: string) => Promise<boolean> {
  return async (contextId) => {
    deps.broadcastToAll({ type: "browser:focus-pane", contextId });
    if (await deps.waitForAttachedPane(contextId, deps.paneWaitMs)) return true;
    deps.broadcastToAll({ type: "browser:force-open", contextId, url: deps.currentUrl(contextId) ?? "" });
    return deps.waitForAttachedPane(contextId, deps.paneWaitMs);
  };
}
