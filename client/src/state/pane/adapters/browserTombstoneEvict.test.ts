import { describe, test, expect } from "bun:test";
import { usePaneStore } from "../store";
import { __evictRemotelyClosedBrowserPanesForTests as evict } from "./tombstoneSync";

/**
 * Cross-device browser-close eviction. When a browser tab is closed on another
 * device the close-tombstone syncs here; this bridge must EVICT the matching
 * open pane live (not just block a future resurrection) — the "l'ho chiusa da
 * app, ma sta ancora su pwa" bug. Guards: a pane re-opened after the close
 * survives (causal), and only a recent close evicts (TTL).
 *
 * @covers CD-CLOSE-01, CD-CLOSE-02
 */

const dispatch = (a: Parameters<ReturnType<typeof usePaneStore.getState>["dispatch"]>[0]) =>
  usePaneStore.getState().dispatch(a);

let seq = 1000;
/** Reset the singleton to a known state, then open a browser pane. When
 *  `openedAt` is omitted we strip it (models a legacy/sanitised pane — exactly
 *  the shape the real stuck pane had) via a HYDRATE that carries no openedAt. */
function reset(): void {
  seq += 1;
  dispatch({ type: "HYDRATE_FROM_SNAPSHOT", payload: { snapshot: { panes: {}, groups: {}, groupOrder: [], closedStack: [], tombstones: {}, spaces: {}, server_seq: seq, seq } } });
}
function openBrowser(ctx: string, openedAt?: number): void {
  dispatch({ type: "OPEN_PANE", payload: { id: `browser:${ctx}`, type: "browser", groupId: "group:default" } });
  if (openedAt === undefined) {
    // Drop openedAt to model a legacy pane (OPEN_PANE always stamps one).
    usePaneStore.setState((s) => {
      const p = s.panes[`browser:${ctx}`];
      if (p) delete (p as { openedAt?: number }).openedAt;
      return s;
    });
  }
}
const isOpen = (ctx: string) =>
  Boolean(usePaneStore.getState().panes[`browser:${ctx}`]) &&
  (usePaneStore.getState().groups["group:default"]?.paneIds ?? []).includes(`browser:${ctx}`);

describe("cross-device browser close eviction", () => {
  test("evicts an open pane (no openedAt) when a fresh remote tombstone arrives", () => {
    reset();
    openBrowser("A");
    expect(isOpen("A")).toBe(true);
    evict([{ id: "A", ts: Date.now() }]);
    expect(isOpen("A")).toBe(false);
  });

  test("KEEPS a pane re-opened AFTER the close (openedAt newer than the tombstone)", () => {
    reset();
    const now = Date.now();
    openBrowser("B", now); // opened now
    evict([{ id: "B", ts: now - 10_000 }]); // close happened 10s BEFORE the reopen
    expect(isOpen("B")).toBe(true);
  });

  test("IGNORES a stale close outside the TTL window (won't strip a long-open tab)", () => {
    reset();
    openBrowser("C");
    evict([{ id: "C", ts: Date.now() - 10 * 60 * 1000 }]); // 10 min ago
    expect(isOpen("C")).toBe(true);
  });

  test("no-op when the pane isn't open here", () => {
    reset();
    expect(() => evict([{ id: "ghost", ts: Date.now() }])).not.toThrow();
    expect(isOpen("ghost")).toBe(false);
  });
});
