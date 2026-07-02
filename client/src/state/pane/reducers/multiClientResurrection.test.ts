import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { selectSyncableSnapshot } from "../selectors";
import type { PaneState, Pane } from "../types";

/**
 * Multi-client resurrection probes. Models two independent stores (A and B)
 * that sync through the server: each client PUTs its `selectSyncableSnapshot`
 * and the other hydrates it as HYDRATE_FROM_SNAPSHOT with a monotonic
 * server_seq. Reproduces the "closed tab reappears" bug in the presence of a
 * live second client whose state is stale.
 */

const blank = (): PaneState => ({
  panes: {},
  groups: {},
  projects: {},
  closedStack: [],
  focusedPaneId: null,
  groupOrder: [],
  spaces: {},
  activeSpaceId: "space:default",
  lastSeq: 0,
  lastServerSeq: 0,
});

const open = (s: PaneState, id: string, type: Pane["type"] = "browser") =>
  paneReducer(s, { type: "OPEN_PANE", payload: { id, type, groupId: "group:default" } });

const close = (s: PaneState, id: string) => {
  let idx = 0;
  const g = s.groups["group:default"];
  if (g) idx = g.paneIds.indexOf(id);
  paneReducer(s, { type: "CLOSE_PANE", payload: { id, groupId: "group:default", groupIndex: idx } });
};

let serverSeq = 0;
// Emulate the server: A PUTs, the server bumps server_seq, B hydrates the PUT.
const sync = (from: PaneState, to: PaneState) => {
  const snap = selectSyncableSnapshot(from);
  serverSeq += 1;
  paneReducer(to, {
    type: "HYDRATE_FROM_SNAPSHOT",
    payload: { snapshot: { ...snap, server_seq: serverSeq, seq: serverSeq } },
  });
};

const hasPane = (s: PaneState, id: string) =>
  Boolean(s.panes[id]) && (s.groups["group:default"]?.paneIds ?? []).includes(id);

describe("multi-client: close on B stays closed while A is alive", () => {
  test("A opens X, syncs to B; B closes X; A does an unrelated open and re-syncs — X must not resurrect on B", () => {
    serverSeq = 0;
    const A = blank();
    const B = blank();

    // A opens X, both converge.
    open(A, "browser:X");
    sync(A, B);
    expect(hasPane(B, "browser:X")).toBe(true);

    // B closes X (tombstone on B). B PUTs → A drops X.
    close(B, "browser:X");
    sync(B, A);
    expect(hasPane(A, "browser:X")).toBe(false);

    // A opens an unrelated Y and PUTs. A's closedStack still has X's tombstone
    // (it hydrated from B), so this is the well-behaved case.
    open(A, "browser:Y");
    sync(A, B);
    expect(hasPane(B, "browser:X")).toBe(false); // must stay closed
    expect(hasPane(B, "browser:Y")).toBe(true);
  });

  test("STALE A never learned about the close: A holds X with an EMPTY closedStack and PUTs at a higher seq", () => {
    serverSeq = 0;
    const A = blank();
    const B = blank();

    // Both independently hold X open (as if from an earlier converged state),
    // but A's closedStack is empty — A is the stale client that never saw the
    // close.
    open(A, "browser:X");
    open(B, "browser:X");

    // B closes X.
    close(B, "browser:X");
    expect(hasPane(B, "browser:X")).toBe(false);

    // A (stale) PUTs its state: panes={X}, closedStack=[]. B hydrates it.
    sync(A, B);

    // B's LOCAL tombstone must beat A's stale snapshot.
    expect(hasPane(B, "browser:X")).toBe(false);
  });
});

describe("multi-client: reopen on one client, close on the other", () => {
  test("B closes X; A (stale, still open) re-syncs; B REOPENS X locally — reopen must win", () => {
    serverSeq = 0;
    const A = blank();
    const B = blank();
    open(A, "browser:X");
    sync(A, B);

    close(B, "browser:X");
    // A is stale (still has X, empty closedStack) and PUTs.
    sync(A, B);
    expect(hasPane(B, "browser:X")).toBe(false); // tombstone holds

    // Now the user REOPENS X on B. OPEN_PANE must clear the tombstone so the
    // reopen survives the next stale sync from A.
    open(B, "browser:X");
    expect(hasPane(B, "browser:X")).toBe(true);
    // A (still stale, still lists X, empty closedStack) syncs again.
    sync(A, B);
    expect(hasPane(B, "browser:X")).toBe(true); // reopen must survive
  });
});

describe("multi-client: tombstone FIFO overflow lets a stale peer resurrect", () => {
  // KNOWN PRE-EXISTING LIMITATION (not today's regression). The closedStack is
  // both the "recently closed" (⌘⇧T) UI list AND the durable tombstone, and it
  // is FIFO-bounded at CLOSED_STACK_MAX (50). A DURABLE (browser/terminal/
  // utility) pane whose tombstone is evicted after 50 other closes can be
  // resurrected by a stale peer that still lists it. Chats are NOT affected —
  // they carry the durable server-authoritative `archived` flag (this is the
  // defence the Fissati bug removed from pinned chats; restored by making
  // pinned chats archive on close). Fixing this class for durable panes means
  // separating the unbounded per-id closed-marker from the bounded recently-
  // closed list — deferred as out of scope for the pinned-chat regression.
  test.skip("after 50+ closes the oldest tombstone is evicted; a stale peer that still lists it resurrects the pane", () => {
    serverSeq = 0;
    const A = blank();
    const B = blank();

    // A opens X and a converged state syncs to B.
    open(A, "browser:X");
    sync(A, B);
    expect(hasPane(B, "browser:X")).toBe(true);

    // B closes X — tombstone recorded on B.
    close(B, "browser:X");
    expect(B.closedStack.some((r) => r.id === "browser:X")).toBe(true);

    // The user then closes 50 OTHER tabs on B, pushing X's tombstone out of the
    // FIFO-bounded (CLOSED_STACK_MAX = 50) closedStack.
    for (let i = 0; i < 55; i++) {
      open(B, `browser:filler-${i}`);
      close(B, `browser:filler-${i}`);
    }
    // X's tombstone has been evicted by the FIFO bound.
    expect(B.closedStack.some((r) => r.id === "browser:X")).toBe(false);

    // A (stale) still lists X and PUTs at a higher seq. With the tombstone gone,
    // the union resurrects X on B.
    sync(A, B);
    expect(hasPane(B, "browser:X")).toBe(false);
  });
});
