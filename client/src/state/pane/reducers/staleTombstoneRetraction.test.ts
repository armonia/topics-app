import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { selectLocalSnapshot } from "../selectors";
import { sanitizeSnapshot } from "./sanitizeSnapshot";
import { DEFAULT_SPACE_ID } from "../types";
import type { PaneState, Pane } from "../types";

/**
 * Regression contract for the "opening a stale webapp closes the desktop's
 * topic tabs" bug (2026-07-12).
 *
 * Root cause: durable tombstone retraction is a local DELETE that never
 * crosses the wire — the maps merge by UNION, so a peer that slept through a
 * close-then-reopen cycle (a rarely-opened webapp with weeks-old localStorage)
 * still holds the dead marker. On boot it merged the server's fresh snapshot,
 * membership-stripped the re-opened pane (deterministic ids: topic tabs = the
 * topic UUID), and its first PUT closed the tab on every client.
 *
 * Fix: `Pane.openedAt` — stamped on every closed→open transition — makes the
 * comparison CAUSAL: a close marker only beats a pane whose openedAt predates
 * it. A marker older than the pane's (re)open is stale and is RETRACTED
 * (tombstone + closedStack records), on both hydrate halves:
 *   - strip half: the incoming LWW-newer snapshot lists the pane as open;
 *   - union half: the local live pane is newer than the incoming marker.
 * Panes without openedAt (legacy) keep the old marker-wins behavior.
 */

const T_OPEN_OLD = 1_000_000; // original open, long ago
const T_CLOSE = 2_000_000; //   close recorded by some client
const T_REOPEN = 3_000_000; //  deliberate re-open AFTER the close

const blank = (): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  spaces: {},
  activeSpaceId: DEFAULT_SPACE_ID,
  focusedPaneId: null,
  groupOrder: [],
  lastSeq: 0,
  lastServerSeq: 0,
});

const openPane = (
  state: PaneState,
  id: string,
  opts: { type?: Pane["type"]; openedAt?: number } = {},
) =>
  paneReducer(state, {
    type: "OPEN_PANE",
    payload: {
      id,
      type: opts.type ?? "chat",
      groupId: "group:default",
      ...(opts.openedAt !== undefined ? { openedAt: opts.openedAt } : {}),
    },
  });

const hydrate = (state: PaneState, snapshot: Record<string, unknown>, serverSeq = 999) =>
  paneReducer(state, {
    type: "HYDRATE_FROM_SNAPSHOT",
    payload: { snapshot: { ...snapshot, server_seq: serverSeq, seq: serverSeq } },
  });

const paneIds = (s: PaneState) => s.groups["group:default"]?.paneIds ?? [];

/** Minimal wire-shaped snapshot listing `panes` open in group:default. */
const snapshotWith = (
  panes: Record<string, Partial<Pane> & { id: string }>,
  extra: Record<string, unknown> = {},
) => ({
  panes: Object.fromEntries(
    Object.entries(panes).map(([id, p]) => [id, { type: "chat", ...p }]),
  ),
  groups: {
    "group:default": {
      id: "group:default",
      paneIds: Object.keys(panes),
      splitRatio: 0.5,
      splitAxis: "horizontal",
    },
  },
  groupOrder: ["group:default"],
  closedStack: [],
  ...extra,
});

describe("strip half: incoming snapshot lists a pane the local client tombstoned", () => {
  test("stale local marker (webapp boot) — pane re-opened elsewhere survives, marker retracted", () => {
    // The stale webapp: holds a weeks-old tombstone for topic X, no pane X.
    const s = blank();
    s.tombstones["topic-X"] = T_CLOSE;
    s.closedStack.push({
      id: "topic-X",
      closedAt: T_CLOSE,
      pane: { id: "topic-X", type: "chat", title: "X" },
      groupId: "group:default",
      groupIndex: 0,
      level: "app",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: 1,
    });
    // Server hydrate: X was re-opened on the desktop AFTER the close.
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X", openedAt: T_REOPEN } }));

    expect(s.panes["topic-X"]).toBeDefined();
    expect(paneIds(s)).toContain("topic-X");
    // Marker retracted everywhere so this client's next PUT can't re-close the
    // tab on its peers (the second half of the original bug).
    expect(s.tombstones["topic-X"]).toBeUndefined();
    expect(s.closedStack.some((r) => r.id === "topic-X")).toBe(false);
  });

  test("marker NEWER than the pane's open (wake-from-sleep stale PUT) — strip still wins", () => {
    // This client closed X at T_CLOSE; a peer that slept through the close
    // wakes and PUTs its stale state still listing X open since T_OPEN_OLD.
    const s = blank();
    s.tombstones["topic-X"] = T_CLOSE;
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X", openedAt: T_OPEN_OLD } }));

    expect(s.panes["topic-X"]).toBeUndefined();
    expect(paneIds(s)).not.toContain("topic-X");
    expect(s.tombstones["topic-X"]).toBe(T_CLOSE); // marker survives
  });

  test("legacy incoming pane without openedAt — marker wins (pre-field behavior)", () => {
    const s = blank();
    s.tombstones["topic-X"] = T_CLOSE;
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X" } }));

    expect(s.panes["topic-X"]).toBeUndefined();
    expect(s.tombstones["topic-X"]).toBe(T_CLOSE);
  });
});

describe("union half: incoming snapshot carries a marker for a pane open locally", () => {
  test("local pane re-opened AFTER the incoming marker — kept, marker not merged", () => {
    // The desktop: topic X deliberately re-opened at T_REOPEN.
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN });
    // A stale peer's PUT: no pane X, but its ancient tombstone for X rides in.
    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": T_CLOSE } }));

    expect(s.panes["topic-X"]).toBeDefined();
    expect(paneIds(s)).toContain("topic-X");
    expect(s.tombstones["topic-X"]).toBeUndefined();
  });

  test("stale closedStack record alone (no tombstone) is also beaten by a newer open", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN });
    hydrate(
      s,
      snapshotWith(
        {},
        {
          closedStack: [
            {
              id: "topic-X",
              closedAt: T_CLOSE,
              pane: { id: "topic-X", type: "chat", title: "X" },
              groupId: "group:default",
              groupIndex: 0,
              level: "app",
              focusedAtClose: false,
              tabOrderSnapshot: [],
              seq: 1,
            },
          ],
        },
      ),
    );

    expect(s.panes["topic-X"]).toBeDefined();
    expect(paneIds(s)).toContain("topic-X");
    // The stale undo record must not survive either — it would re-close the
    // pane on every peer via their union filter on our next PUT.
    expect(s.closedStack.some((r) => r.id === "topic-X")).toBe(false);
  });

  test("incoming marker NEWER than the local open — genuine remote close, pane dropped", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_OPEN_OLD });
    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": T_CLOSE } }));

    expect(s.panes["topic-X"]).toBeUndefined();
    expect(paneIds(s)).not.toContain("topic-X");
    expect(s.tombstones["topic-X"]).toBe(T_CLOSE);
  });

  test("local legacy pane without openedAt — incoming marker wins (pre-field behavior)", () => {
    const s = blank();
    openPane(s, "topic-X");
    delete s.panes["topic-X"].openedAt; // simulate a pane persisted before the field
    hydrate(s, snapshotWith({}, { tombstones: { "topic-X": T_CLOSE } }));

    expect(s.panes["topic-X"]).toBeUndefined();
  });
});

describe("openedAt lifecycle", () => {
  test("OPEN_PANE stamps a fresh insert; re-OPEN of an already-open pane preserves it", () => {
    const s = blank();
    const before = Date.now();
    openPane(s, "topic-X");
    const stamped = s.panes["topic-X"].openedAt;
    expect(typeof stamped).toBe("number");
    expect(stamped as number).toBeGreaterThanOrEqual(before);

    // Re-OPEN (persistBrowserPane-style re-entry) must NOT restamp — a passive
    // refresh must not outrank a peer's genuine concurrent close.
    openPane(s, "topic-X");
    expect(s.panes["topic-X"].openedAt).toBe(stamped as number);
  });

  test("UNDO_CLOSE stamps the restore as a fresh open", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_OPEN_OLD });
    paneReducer(s, {
      type: "CLOSE_PANE",
      payload: { id: "topic-X", groupId: "group:default", groupIndex: 0 },
    });
    const before = Date.now();
    paneReducer(s, { type: "UNDO_CLOSE" });
    expect(s.panes["topic-X"].openedAt as number).toBeGreaterThanOrEqual(before);
  });

  test("openedAt survives the serialize → sanitize → hydrate round-trip", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN });
    const snap = selectLocalSnapshot(s);
    const clean = sanitizeSnapshot(snap);
    expect(clean?.panes?.["topic-X"]?.openedAt).toBe(T_REOPEN);

    const fresh = blank();
    hydrate(fresh, { ...snap });
    expect(fresh.panes["topic-X"].openedAt).toBe(T_REOPEN);
  });

  test("PANE_ID_REMAP carries openedAt across the draft → real promotion", () => {
    const s = blank();
    openPane(s, "draft:1", { openedAt: T_REOPEN });
    paneReducer(s, {
      type: "PANE_ID_REMAP",
      payload: { from: "draft:1", to: "topic-X", updates: {} },
    });
    expect(s.panes["topic-X"].openedAt).toBe(T_REOPEN);
  });
});

describe("mixed-version peers: incoming snapshot stripped of openedAt", () => {
  test("local openedAt survives a wholesale apply from an old-build peer and still beats the stale marker", () => {
    // Local (new build): topic X re-opened after the close.
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_REOPEN });
    // Old-build peer re-PUTs: it lists X open (it hydrated it) but its
    // sanitizer stripped openedAt, and its merged map still carries the
    // stale marker (old code never retracts).
    hydrate(
      s,
      snapshotWith(
        { "topic-X": { id: "topic-X" } }, // no openedAt on the wire
        { tombstones: { "topic-X": T_CLOSE } },
      ),
    );

    // The max-graft must restore the local timestamp so the strip retracts
    // the marker instead of killing the tab (the mixed-version bleed window
    // while some clients still run the pre-fix bundle).
    expect(s.panes["topic-X"]).toBeDefined();
    expect(s.panes["topic-X"].openedAt).toBe(T_REOPEN);
    expect(paneIds(s)).toContain("topic-X");
    expect(s.tombstones["topic-X"]).toBeUndefined();
  });

  test("the graft keeps the NEWEST of the two timestamps", () => {
    const s = blank();
    openPane(s, "topic-X", { openedAt: T_OPEN_OLD });
    hydrate(s, snapshotWith({ "topic-X": { id: "topic-X", openedAt: T_REOPEN } }));
    expect(s.panes["topic-X"].openedAt).toBe(T_REOPEN);
  });
});

describe("end-to-end: the reported bug, two stores through the LWW blob", () => {
  test("desktop reopens a topic; a stale webapp boots, hydrates, PUTs — the tab survives everywhere", () => {
    // ── Desktop: topic X was closed at some point, then deliberately reopened.
    const desktop = blank();
    openPane(desktop, "topic-X", { openedAt: T_OPEN_OLD });
    paneReducer(desktop, {
      type: "CLOSE_PANE",
      payload: { id: "topic-X", groupId: "group:default", groupIndex: 0 },
    });
    const closedAt = desktop.tombstones["topic-X"];
    expect(closedAt).toBeGreaterThan(0);
    openPane(desktop, "topic-X", { openedAt: closedAt + 60_000 }); // reopen later
    expect(desktop.tombstones["topic-X"]).toBeUndefined();

    // Desktop PUTs → this is the server blob the webapp will hydrate.
    const serverBlob = selectLocalSnapshot(desktop);

    // ── Webapp: stale localStorage from BEFORE the reopen — it still holds the
    // marker (it merged the close, never learned of the retraction).
    const webapp = blank();
    webapp.tombstones["topic-X"] = closedAt;

    // Webapp boots and hydrates the server blob (LWW-newer).
    hydrate(webapp, { ...serverBlob }, 1000);
    // The reopened tab must survive the webapp's strip…
    expect(webapp.panes["topic-X"]).toBeDefined();
    expect(paneIds(webapp)).toContain("topic-X");
    expect(webapp.tombstones["topic-X"]).toBeUndefined();

    // …and the webapp's own PUT back must not close it on the desktop.
    const webappPut = selectLocalSnapshot(webapp);
    hydrate(desktop, { ...webappPut }, 1001);
    expect(desktop.panes["topic-X"]).toBeDefined();
    expect(paneIds(desktop)).toContain("topic-X");
  });
});
