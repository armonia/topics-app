/**
 * The browser tab must restore to its page after a window restart — same as a
 * chat tab restores its conversation. That requires pane.url to survive the
 * full persistence chain: UPDATE_PANE writes it, sanitizeSnapshot preserves it
 * on hydrate, and selectSyncableSnapshot keeps it on the outbound server PUT.
 *
 * @covers BROWSER-CHAT-01
 */
import { describe, test, expect } from "bun:test";
import { paneReducer } from "./reducers/panes";
import { sanitizeSnapshot } from "./reducers/sanitizeSnapshot";
import { selectSyncableSnapshot } from "./selectors";
import type { PaneState } from "./types";
import { blankPaneState as blankState } from "./testSupport";

function withBrowserPane(): PaneState {
  const state = blankState();
  paneReducer(state, {
    type: "OPEN_PANE",
    payload: { id: "browser:ctx-1", type: "browser", title: "", groupId: "group:default" },
  });
  return state;
}

describe("browser pane url persistence", () => {
  test("UPDATE_PANE writes url onto an existing pane", () => {
    const state = withBrowserPane();
    paneReducer(state, {
      type: "UPDATE_PANE",
      payload: { id: "browser:ctx-1", updates: { url: "https://example.com/page" } },
    });
    expect(state.panes["browser:ctx-1"].url).toBe("https://example.com/page");
  });

  test("UPDATE_PANE is a no-op for an unknown pane id", () => {
    const state = withBrowserPane();
    paneReducer(state, {
      type: "UPDATE_PANE",
      payload: { id: "browser:missing", updates: { url: "https://x" } },
    });
    expect(state.panes["browser:missing"]).toBeUndefined();
  });

  test("UPDATE_PANE never lets the merge change id or type", () => {
    const state = withBrowserPane();
    paneReducer(state, {
      type: "UPDATE_PANE",
      payload: {
        id: "browser:ctx-1",
        // Deliberately attempt to mutate id/type — the reducer must ignore both.
        updates: { id: "evil", type: "chat", url: "https://ok" },
      },
    });
    expect(state.panes["browser:ctx-1"].id).toBe("browser:ctx-1");
    expect(state.panes["browser:ctx-1"].type).toBe("browser");
    expect(state.panes["browser:ctx-1"].url).toBe("https://ok");
    expect(state.panes["evil"]).toBeUndefined();
  });

  test("sanitizeSnapshot preserves pane.url on hydrate (server round-trip)", () => {
    const clean = sanitizeSnapshot({
      panes: { "browser:ctx-1": { id: "browser:ctx-1", type: "browser", url: "https://example.com/x" } },
      groups: { "group:default": { id: "group:default", paneIds: ["browser:ctx-1"], splitRatio: 0.5, splitAxis: "horizontal" } },
      groupOrder: ["group:default"],
    });
    expect(clean!.panes!["browser:ctx-1"].url).toBe("https://example.com/x");
  });

  test("selectSyncableSnapshot keeps url so it reaches the server PUT", () => {
    const state = withBrowserPane();
    paneReducer(state, {
      type: "UPDATE_PANE",
      payload: { id: "browser:ctx-1", updates: { url: "https://example.com/keep" } },
    });
    const snap = selectSyncableSnapshot(state) as { panes: Record<string, { url?: string }> };
    expect(snap.panes["browser:ctx-1"].url).toBe("https://example.com/keep");
  });

  test("round-trip: write → sync → hydrate restores the url", () => {
    const state = withBrowserPane();
    paneReducer(state, {
      type: "UPDATE_PANE",
      payload: { id: "browser:ctx-1", updates: { url: "https://example.com/roundtrip" } },
    });
    const outbound = selectSyncableSnapshot(state);
    const rehydrated = sanitizeSnapshot(outbound as Record<string, unknown>);
    expect(rehydrated!.panes!["browser:ctx-1"].url).toBe("https://example.com/roundtrip");
  });
});

describe("browser pane title + titleSource persistence", () => {
  test("UPDATE_PANE writes title + titleSource onto an existing pane", () => {
    const state = withBrowserPane();
    paneReducer(state, {
      type: "UPDATE_PANE",
      payload: { id: "browser:ctx-1", updates: { title: "Example Domain", titleSource: "auto" } },
    });
    expect(state.panes["browser:ctx-1"].title).toBe("Example Domain");
    expect(state.panes["browser:ctx-1"].titleSource).toBe("auto");
  });

  test("a user rename round-trips (titleSource='user' survives sync + hydrate)", () => {
    // Risk #7: a missing sanitize whitelist entry would silently drop
    // titleSource on the server round-trip, letting the page-title poll
    // resurrect the auto title over a manual rename after a reload.
    const state = withBrowserPane();
    paneReducer(state, {
      type: "UPDATE_PANE",
      payload: { id: "browser:ctx-1", updates: { title: "My tab", titleSource: "user" } },
    });
    const outbound = selectSyncableSnapshot(state);
    const rehydrated = sanitizeSnapshot(outbound as Record<string, unknown>);
    expect(rehydrated!.panes!["browser:ctx-1"].title).toBe("My tab");
    expect(rehydrated!.panes!["browser:ctx-1"].titleSource).toBe("user");
  });

  test("sanitizeSnapshot drops a bogus titleSource value", () => {
    const clean = sanitizeSnapshot({
      panes: { "browser:ctx-1": { id: "browser:ctx-1", type: "browser", title: "x", titleSource: "bogus" } },
      groups: { "group:default": { id: "group:default", paneIds: ["browser:ctx-1"], splitRatio: 0.5, splitAxis: "horizontal" } },
      groupOrder: ["group:default"],
    });
    expect(clean!.panes!["browser:ctx-1"].titleSource).toBeUndefined();
  });
});
