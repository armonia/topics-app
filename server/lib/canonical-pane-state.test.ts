/**
 * A project pane saved through a symlink must be served under the folder's
 * real path, with a tombstone on the raw id so a device that still holds the
 * raw copy in localStorage does not show the project twice.
 *
 * @covers PROJ-ID-04
 */
import { describe, it, expect } from "bun:test";
import { canonicalPaneSnapshot, projectPanesKeyRenames, projectPaneId } from "./canonical-pane-state";
import { projectPanesKey } from "../../shared/project-keys";
import { computeCascade } from "../services/pane-retirement-cascade";

const RAW = "/workspace/link/app";
const CANON = "/workspace/real/app";
const OTHER = "/home/x/other";
const rawId = projectPaneId(RAW);
const canonId = projectPaneId(CANON);

/** Only the link resolves; everything else is already canonical. */
const canon = (p: string) => (p === RAW ? CANON : p);

function rawOnly() {
  return {
    panes: {
      [rawId]: { id: rawId, type: "project", title: "app", projectPath: RAW, stableKey: rawId, openedSeq: 7 },
      "terminal:t1": { id: "terminal:t1", type: "terminal", title: "sh", terminalSessionId: "s1" },
      [projectPaneId(OTHER)]: { id: projectPaneId(OTHER), type: "project", title: "other", projectPath: OTHER },
    },
    groups: {
      "group:default": { id: "group:default", paneIds: ["terminal:t1", rawId, projectPaneId(OTHER)], splitRatio: 0.5, splitAxis: "horizontal" },
    },
    groupOrder: ["group:default"],
    focusedPaneId: rawId,
    closedStack: [{ id: "browser:b1", pane: { id: "browser:b1", type: "browser", title: "b" }, projectPath: RAW, level: "project", tabOrderSnapshot: [rawId, "browser:b1"] }],
    tombstones: { "browser:b1": { at: 5, seq: 3 } },
    lastSeq: 9,
  };
}

describe("canonicalPaneSnapshot", () => {
  it("a raw pane alone is renamed, with its projectPath and every reference", () => {
    const { value, pairs } = canonicalPaneSnapshot(rawOnly(), canon, 1000) as { value: any; pairs: unknown };
    expect(pairs).toEqual([{ raw: RAW, canon: CANON }]);
    expect(Object.keys(value.panes).sort()).toEqual(["terminal:t1", canonId, projectPaneId(OTHER)].sort());
    expect(value.panes[canonId]).toMatchObject({ id: canonId, projectPath: CANON, stableKey: canonId, openedSeq: 7 });
    expect(value.groups["group:default"].paneIds).toEqual(["terminal:t1", canonId, projectPaneId(OTHER)]);
    expect(value.focusedPaneId).toBe(canonId);
    expect(value.closedStack[0].projectPath).toBe(CANON);
    expect(value.closedStack[0].tabOrderSnapshot).toEqual([canonId, "browser:b1"]);
  });

  it("the raw id gets a tombstone; existing tombstones stay where they are", () => {
    const { value } = canonicalPaneSnapshot(rawOnly(), canon, 1000) as { value: any };
    expect(value.tombstones[rawId]).toEqual({ at: 1000, seq: 0 });
    expect(value.tombstones["browser:b1"]).toEqual({ at: 5, seq: 3 });
    expect(value.tombstones[canonId]).toBeUndefined();
  });

  it("raw AND canonical present: the raw pane is dropped, its tab slot points at the existing one", () => {
    const input = rawOnly() as any;
    input.panes[canonId] = { id: canonId, type: "project", title: "app (real)", projectPath: CANON };
    input.groups["group:split"] = { id: "group:split", paneIds: [canonId], splitRatio: 0.5, splitAxis: "vertical" };
    input.groupOrder = ["group:default", "group:split"];
    const { value } = canonicalPaneSnapshot(input, canon, 1000) as { value: any };
    expect(value.panes[canonId].title).toBe("app (real)");
    expect(value.panes[rawId]).toBeUndefined();
    // One home per pane: the first group claiming the id keeps it.
    expect(value.groups["group:default"].paneIds).toEqual(["terminal:t1", canonId, projectPaneId(OTHER)]);
    expect(value.groups["group:split"].paneIds).toEqual([]);
    expect(value.tombstones[rawId]).toEqual({ at: 1000, seq: 0 });
  });

  it("an already canonical snapshot comes back untouched, same reference", () => {
    const input = rawOnly();
    const { value, pairs } = canonicalPaneSnapshot(input, (p) => p, 1000);
    expect(pairs).toEqual([]);
    expect(value).toBe(input);
  });

  it("is idempotent: the output run again changes nothing", () => {
    const first = canonicalPaneSnapshot(rawOnly(), canon, 1000);
    const second = canonicalPaneSnapshot(first.value, canon, 2000);
    expect(second.pairs).toEqual([]);
    expect(second.value).toBe(first.value);
  });

  it("a corrupt id, a non-object and a snapshot without panes are left alone", () => {
    expect(canonicalPaneSnapshot(null, canon).value).toBeNull();
    expect(canonicalPaneSnapshot("x", canon).value).toBe("x");
    const noPanes = { groups: {} };
    expect(canonicalPaneSnapshot(noPanes, canon).value).toBe(noPanes);
    const bad = { panes: { "project:%E0%A4%A": { id: "project:%E0%A4%A" } } };
    expect(canonicalPaneSnapshot(bad, canon).value).toBe(bad);
  });
});

describe("projectPanesKeyRenames", () => {
  it("uses the shared hash, one rename per raw path", () => {
    expect(projectPanesKeyRenames([{ raw: RAW, canon: CANON }, { raw: RAW, canon: CANON }])).toEqual([
      { from: projectPanesKey(RAW), to: projectPanesKey(CANON) },
    ]);
  });
});

describe("the tombstone on the raw id is harmless for the retirement cascade", () => {
  it("retires the raw pane id with NO topic and NO terminal session", () => {
    const prev = rawOnly();
    const next = canonicalPaneSnapshot(prev, canon, 1000).value;
    // `browser:b1` is the fixture's pre-existing close, already on the books.
    const { retire, reopen } = computeCascade({ prev, next, alreadyRetired: new Set(["browser:b1"]) });
    expect(retire).toEqual([{ paneId: rawId, closedAt: 1000 }]);
    expect(reopen).toEqual([]);
  });
});
