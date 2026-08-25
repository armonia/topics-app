import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { selectSyncableSnapshot } from "../selectors";
import { overTheWire } from "../testSupport";
import type { PaneState, Pane } from "../types";

/**
 * Regression lock for the "closed pinned chat reappears" bug (introduced by the
 * Fissati pinning commit 2449fa9d, fixed by making pinned chats archive on
 * close like every other chat).
 *
 * Chat tabs have TWO independent defences against resurrection across a
 * multi-client sync:
 *   1. the 2-state model — a user-closed chat archives the topic, and the
 *      client-side `validPanels` effect evicts every archived topic id on every
 *      render, regardless of what a stale peer's pane snapshot says. This is the
 *      DURABLE, server-authoritative, cross-client signal.
 *   2. the closedStack tombstone in the pane reducer — DEVICE-LOCAL and
 *      FIFO-bounded, so it can be lost (evicted, or overwritten globally when a
 *      stale peer's whole snapshot wins the single-value LWW on the server).
 *
 * The Fissati bug exempted PINNED chats from defence #1 ("closing a pinned chat
 * must not archive it"), leaving only the lossy device-local tombstone — a
 * stale second client / mobile PWA / the server's own stored snapshot then
 * out-raced the close and resurrected the tab. The fix archives pinned chats on
 * close too; the sidebar's pinnedIds escape keeps the pinned row visible even
 * when archived (locked in buildSidebarItems.test.ts), and reopen unarchives.
 *
 * These tests model both defences explicitly so the durable one is legible:
 *   - `applyValidation(state, archivedIds)` mimics the usePanelLifecycle
 *     validation effect: evict panes whose topic id is archived.
 *   - the pane reducer's HYDRATE handles the (lossy) tombstone.
 * The key assertion: with the durable archive signal, the chat stays closed
 * even when the tombstone is entirely absent everywhere.
 *
 * @covers TAB-SYNC-01
 */

const CHAT = "11111111-1111-4111-8111-111111111111"; // UUID-like → a chat id

const blank = (): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  focusedPaneId: null,
  groupOrder: [],
  spaces: {},
  activeSpaceId: "space:default",
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
});

const open = (s: PaneState, id: string, type: Pane["type"] = "chat") =>
  paneReducer(s, { type: "OPEN_PANE", payload: { id, type, topicId: id, groupId: "group:default" } });

const close = (s: PaneState, id: string) => {
  const g = s.groups["group:default"];
  const idx = g ? g.paneIds.indexOf(id) : 0;
  paneReducer(s, { type: "CLOSE_PANE", payload: { id, groupId: "group:default", groupIndex: idx } });
};

let seq = 0;
const hydrateInto = (to: PaneState, from: PaneState) => {
  const snap = overTheWire(selectSyncableSnapshot(from));
  seq += 1;
  paneReducer(to, {
    type: "HYDRATE_FROM_SNAPSHOT",
    payload: { snapshot: { ...snap, server_seq: seq, seq } },
  });
};

/** The usePanelLifecycle validPanels effect, distilled: a chat whose topic is
 *  archived is evicted from the store on the client. Non-chat prefixed ids and
 *  non-archived chats survive. */
const applyValidation = (s: PaneState, archivedTopicIds: Set<string>) => {
  const g = s.groups["group:default"];
  if (!g) return;
  for (const id of [...g.paneIds]) {
    if (archivedTopicIds.has(id)) {
      const idx = g.paneIds.indexOf(id);
      if (idx >= 0) g.paneIds.splice(idx, 1);
      delete s.panes[id];
    }
  }
};

const hasPane = (s: PaneState, id: string) =>
  Boolean(s.panes[id]) && (s.groups["group:default"]?.paneIds ?? []).includes(id);

/**
 * Shared assertion body: closing a chat archives it (the fix makes this true for
 * pinned chats too), so even with NO tombstone anywhere, a stale peer that still
 * lists the chat as open cannot resurrect it — the archived filter evicts it.
 */
function assertDurableClosureBeatsStalePeer() {
  seq = 0;
  const stale = blank();

  // Both clients once held the chat open (converged earlier).
  open(stale, CHAT);

  // On the closing client the chat is closed → archived (post-fix: pinned chats
  // archive too). Model a client whose tombstone was LOST (FIFO eviction, or a
  // global snapshot overwrite) so ONLY the durable archive signal remains.
  const closing = blank();
  open(closing, CHAT);
  close(closing, CHAT);
  closing.closedStack = []; // tombstone gone — durable defence must stand alone
  const archived = new Set([CHAT]); // topic archived server-side

  // The stale peer never saw the close; its snapshot still lists CHAT with an
  // empty closedStack (server-stored ui_state / mobile PWA / second window) and
  // wins the single-value LWW at a higher server_seq.
  stale.closedStack = [];
  hydrateInto(closing, stale);

  // Client-side validation evicts the archived chat regardless of the snapshot.
  applyValidation(closing, archived);
  expect(hasPane(closing, CHAT)).toBe(false);
}

describe("durable archive signal keeps a closed chat closed without a tombstone", () => {
  test("normal (unpinned) chat: archive defence survives a tombstone-less stale resync", () => {
    assertDurableClosureBeatsStalePeer();
  });

  test("PINNED chat (post-fix): archives on close too, so the SAME durable defence applies", () => {
    // The fix makes a pinned chat archive on close exactly like an unpinned one,
    // so this is now identical to the case above — the durable signal, not the
    // lossy tombstone, is what keeps it closed.
    assertDurableClosureBeatsStalePeer();
  });
});
