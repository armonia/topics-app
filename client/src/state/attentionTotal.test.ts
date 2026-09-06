/**
 * `chromeAttentionTotal`: the ONE number the OS chrome paints (dock badge, tray
 * glyph, PWA badge). The contract worth pinning is not the arithmetic, it is the
 * PARITY: for the same state, the chrome total equals the sum of the badges the
 * sidebar shows for the same subjects, and the expectation is computed from the
 * very per-row helpers the sidebar calls (`topicAttentionCount`,
 * `terminalAttentionCount`, the `extraCounts` map, `trayBoardAttention`), never
 * from a number typed by hand. If one surface changes its criterion and the other
 * does not, this file goes red.
 *
 * @covers CHROME-COUNT-01
 */
import { describe, test, expect } from "bun:test";
import { chromeAttentionTotal, paneAttentionTotal } from "./attentionTotal";
import { topicAttentionCount, terminalAttentionCount } from "./signals";
import { buildSidebarItems } from "../lib/buildSidebarItems";
import { utilityPanelId } from "./pane/adapters/utilityPanelId";
import { trayBoardAttention, trayBoardGroups, type TrayTaskInput } from "../../../shared/tray-board";
import type { Topic, TerminalSessionInfo } from "../types";

const unread = (counts: Record<string, number>): Record<string, { unreadCount: number }> =>
  Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, { unreadCount: n }]));

// Minimal Topic: only the fields the rollup and the sidebar builder read.
const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: id, ...over } as Topic);

// A claude-code terminal with every field the sidebar builder touches.
const term = (id: string): TerminalSessionInfo =>
  ({
    id,
    name: `Claude ${id}`,
    createdAt: new Date(0).toISOString(),
    cwd: "/work/standalone",
    command: "claude",
    clients: 1,
    type: "claude-code",
  }) as TerminalSessionInfo;

const card = (id: string, status: string): TrayTaskInput => ({ id, text: `task ${id}`, status, projectId: "p" });

const DASHBOARD = utilityPanelId("dashboard");
const SCHEDULE = utilityPanelId("cron");

/** One realistic state: chats in every attention shape, two finished terminals,
 *  one badged utility pane, a board with cards in every visible column. */
function fixture() {
  const topics = {
    a: topic("a"),                                   // unread only
    b: topic("b"),                                   // Claude needs-you only
    c: topic("c"),                                   // both (max, never the sum)
    quiet: topic("quiet"),                           // nothing pending
    gone: topic("gone", { archived: true }),         // archived WITH unread
  };
  const unreadData = unread({ a: 3, c: 2, gone: 7 });
  const claudeAttentionTopics = new Set(["b", "c"]);
  const terminalFinishedIds = new Set(["s1", "s2"]);
  const terminalSessions = [term("s1"), term("s2"), term("idle")];
  const paneCounts = new Map<string, number>([[DASHBOARD, 2]]);
  const boardGroups = trayBoardGroups([
    card("r1", "review"), card("r2", "review"),
    card("w1", "in_progress"), card("t1", "todo"), card("d1", "done"), card("b1", "backlog"),
  ]);
  return { topics, unreadData, claudeAttentionTopics, terminalFinishedIds, terminalSessions, paneCounts, boardGroups };
}

function chromeOf(f: ReturnType<typeof fixture>, over: Partial<Parameters<typeof chromeAttentionTotal>[0]> = {}): number {
  return chromeAttentionTotal({
    topics: f.topics,
    unread: f.unreadData,
    claudeAttentionTopics: f.claudeAttentionTopics,
    terminalFinishedIds: f.terminalFinishedIds,
    boardGroups: f.boardGroups,
    paneCounts: f.paneCounts,
    ...over,
  });
}

/** The sidebar as the user sees it for that state: every subject's tab open,
 *  archived hidden unless asked. Returns the sum of the LEAF rows' badges.
 *  No workspace projects, so no project rollup row can double-count a child. */
function sidebarBadgeSum(f: ReturnType<typeof fixture>, showArchived = false): number {
  const items = buildSidebarItems({
    topics: f.topics,
    unreadData: f.unreadData as never,
    showArchived,
    terminalSessions: f.terminalSessions,
    openPanels: [...f.terminalSessions.map((t) => `terminal:${t.id}`), DASHBOARD],
    claudeAttentionTopics: f.claudeAttentionTopics,
    terminalFinishedIds: f.terminalFinishedIds,
    extraCounts: f.paneCounts,
  });
  expect(items.some((i) => i.type === "project")).toBe(false);
  return items.reduce((n, i) => n + i.notificationCount, 0);
}

describe("chromeAttentionTotal", () => {
  test("is the sum of non-archived topics + finished terminals + pane badges + board cards in review", () => {
    const f = fixture();
    // a=3, b=1, c=max(2,1)=2, quiet=0, gone=archived(0); s1+s2=2; dashboard=2; review=2.
    expect(chromeOf(f)).toBe(3 + 1 + 2 + 0 + 0 + 2 + 2 + 2);
  });

  test("an archived topic with unread contributes ZERO", () => {
    const f = fixture();
    const withoutGone = { ...f.topics };
    delete (withoutGone as Record<string, Topic>).gone;
    expect(chromeOf(f)).toBe(chromeOf(f, { topics: withoutGone }));
    // And on its own it is a cleared badge, however large its unread.
    expect(chromeAttentionTotal({
      topics: { gone: topic("gone", { archived: true }) },
      unread: unread({ gone: 7 }),
      claudeAttentionTopics: new Set(["gone"]),
      terminalFinishedIds: new Set(),
      boardGroups: [],
      paneCounts: new Map(),
    })).toBe(0);
  });

  test("PARITY: equals the sum of the badges the sidebar rows show for the same subjects", () => {
    const f = fixture();
    // Expectation from the per-row helpers, the ones every sidebar row calls.
    const perRow =
      Object.values(f.topics).filter((t) => !t.archived)
        .reduce((n, t) => n + topicAttentionCount(t.id, f.unreadData, f.claudeAttentionTopics), 0)
      + f.terminalSessions.reduce((n, t) => n + terminalAttentionCount(t.id, f.terminalFinishedIds), 0)
      + paneAttentionTotal(f.paneCounts);
    // The board share comes from the shared tray helper, the same one the glyph
    // uses. The sidebar "Board" row is NOT part of this sum on purpose: it shows
    // open work (every card not done), a different quantity by design.
    const board = trayBoardAttention(f.boardGroups);
    expect(chromeOf(f)).toBe(perRow + board);
    // And the real builder agrees: the rows it emits sum to the same number.
    expect(sidebarBadgeSum(f)).toBe(perRow);
    expect(chromeOf(f) - board).toBe(sidebarBadgeSum(f));
  });

  test("PARITY holds with 'show archived' on: the archived row is listed and carries badge 0", () => {
    const f = fixture();
    const items = buildSidebarItems({
      topics: f.topics,
      unreadData: f.unreadData as never,
      showArchived: true,
      terminalSessions: f.terminalSessions,
      openPanels: [...f.terminalSessions.map((t) => `terminal:${t.id}`), DASHBOARD],
      claudeAttentionTopics: f.claudeAttentionTopics,
      terminalFinishedIds: f.terminalFinishedIds,
      extraCounts: f.paneCounts,
    });
    const archivedRow = items.find((i) => i.id === "gone");
    expect(archivedRow?.archived).toBe(true);
    // Unread 7 on the server, 0 on the row: nothing could ever switch it off.
    expect(archivedRow?.notificationCount).toBe(0);
    // And a NON-archived row keeps its badge untouched by the rule.
    expect(items.find((i) => i.id === "a")?.notificationCount).toBe(topicAttentionCount("a", f.unreadData, f.claudeAttentionTopics));
    expect(chromeOf(f) - trayBoardAttention(f.boardGroups)).toBe(sidebarBadgeSum(f, true));
  });

  test("reading a topic drops exactly that topic's share and nothing else", () => {
    const f = fixture();
    const before = chromeOf(f);
    const afterUnread = { ...f.unreadData, a: { unreadCount: 0 } };
    const after = chromeOf(f, { unread: afterUnread });
    const share = topicAttentionCount("a", f.unreadData, f.claudeAttentionTopics)
      - topicAttentionCount("a", afterUnread, f.claudeAttentionTopics);
    expect(share).toBeGreaterThan(0);
    expect(before - after).toBe(share);
    // A topic that is ALSO waiting on Claude keeps its needs-you unit when read:
    // unread clears on reading, attention clears when the session moves on.
    const cRead = { ...f.unreadData, c: { unreadCount: 0 } };
    expect(before - chromeOf(f, { unread: cRead })).toBe(
      topicAttentionCount("c", f.unreadData, f.claudeAttentionTopics) - topicAttentionCount("c", cRead, f.claudeAttentionTopics),
    );
  });

  test("window-local pane badges (the notifyPane map) count once per unit, like their utility rows", () => {
    const f = fixture();
    const panes = new Map<string, number>([[DASHBOARD, 2], [SCHEDULE, 1]]);
    expect(chromeOf(f, { paneCounts: panes }) - chromeOf(f, { paneCounts: new Map() })).toBe(3);
    expect(paneAttentionTotal(panes)).toBe(3);
    expect(paneAttentionTotal(new Map())).toBe(0);
  });

  test("empty input is 0, the cleared badge", () => {
    expect(chromeAttentionTotal({
      topics: {},
      unread: {},
      claudeAttentionTopics: new Set(),
      terminalFinishedIds: new Set(),
      boardGroups: [],
      paneCounts: new Map(),
    })).toBe(0);
  });
});
