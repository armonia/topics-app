/**
 * A close on one device, a reopen on the other: the reopen survives the merge.
 *
 * @covers TAB-SYNC-01
 */
import { describe, expect, test } from "bun:test";
import { paneReducer } from "./panes";
import { selectSyncableSnapshot } from "../selectors";
import { blankPaneState, overTheWire } from "../testSupport";
import type { PaneState } from "../types";

const GROUP_ID = "group:default";
const PANE_ID = "topic:X";

function dispatch(state: PaneState, action: Parameters<typeof paneReducer>[1]): void {
  paneReducer(state, action);
  if (action.type === "HYDRATE_FROM_SNAPSHOT") return;
  state.lastSeq += 1;
}

function putAndHydrate(from: PaneState, to: PaneState, serverSeq: number): void {
  const wireValue = overTheWire(selectSyncableSnapshot(from));
  const snapshot = {
    ...wireValue,
    lastSeq: Math.max(to.lastSeq, serverSeq),
    server_seq: serverSeq,
    seq: serverSeq,
  };
  dispatch(to, { type: "HYDRATE_FROM_SNAPSHOT", payload: { snapshot } });
}

describe("cross-device close then reopen", () => {
  test("B reopens X after A closes it, and A keeps X after hydrating B", () => {
    const A = blankPaneState();
    const B = blankPaneState();

    dispatch(A, {
      type: "OPEN_PANE",
      payload: { id: PANE_ID, type: "chat", groupId: GROUP_ID, topicId: "X" },
    });
    putAndHydrate(A, B, 1);
    expect(B.groups[GROUP_ID]?.paneIds).toContain(PANE_ID);

    dispatch(A, {
      type: "CLOSE_PANE",
      payload: { id: PANE_ID, groupId: GROUP_ID, groupIndex: 0 },
    });
    expect(A.tombstones[PANE_ID]?.seq).toBe(A.lastSeq);
    putAndHydrate(A, B, 2);
    expect(B.groups[GROUP_ID]?.paneIds).not.toContain(PANE_ID);

    dispatch(B, {
      type: "OPEN_PANE",
      payload: { id: PANE_ID, type: "chat", groupId: GROUP_ID, topicId: "X" },
    });
    putAndHydrate(B, A, 3);

    expect(A.panes[PANE_ID]?.openedSeq).toBeGreaterThan(A.tombstones[PANE_ID]?.seq ?? 0);
    expect(A.groups[GROUP_ID]?.paneIds).toContain(PANE_ID);
  });
});
