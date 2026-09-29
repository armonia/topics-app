/**
 * `chromeAttentionTotal`: the ONE number the OS chrome paints (dock badge, tray
 * glyph, PWA badge). The contract worth pinning is not the arithmetic, it is the
 * PARITY: for the same state, the chrome total equals the number of sidebar rows
 * that carry a badge (SUBJECTS, not the messages inside them), and the
 * expectation is computed from the very per-row helpers the sidebar calls
 * (`topicAttentionCount`, `terminalAttentionCount`, the `extraCounts` map,
 * `trayBoardAttention`), never from a number typed by hand. If one surface
 * changes its criterion and the other does not, this file goes red.
 *
 * @covers CHROME-COUNT-01, NOTIF-ONE-02
 */
import { describe, test, expect } from "bun:test";
import { chromeAttentionSubjects, chromeAttentionTotal, paneAttentionTotal, waitingSubjects } from "./attentionTotal";
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
 *  archived hidden unless asked. Returns how many LEAF rows carry a badge.
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
  return items.filter((i) => i.notificationCount > 0).length;
}

describe("chromeAttentionTotal", () => {
  test("counts SUBJECTS: non-archived chats + finished terminals + badged panes + board cards in review", () => {
    const f = fixture();
    // a (3 messages) = 1, b = 1, c (2 messages + needs-you) = 1, quiet = 0,
    // gone = archived (0); s1 + s2 = 2; dashboard (badge 2) = 1; review = 2.
    expect(chromeOf(f)).toBe(1 + 1 + 1 + 0 + 0 + 2 + 1 + 2);
  });

  test("a chat with many unread messages is ONE, not the message sum", () => {
    // The measured case of 2026-09-29: 132 messages on 6 chats painted 133.
    const topics = { a: topic("a"), b: topic("b") };
    const input = {
      topics,
      unread: unread({ a: 39, b: 1 }),
      claudeAttentionTopics: new Set<string>(),
      terminalFinishedIds: new Set<string>(),
      boardGroups: [],
      paneCounts: new Map<string, number>(),
    };
    expect(chromeAttentionTotal(input)).toBe(2);
    // Reading the big one drops the number by ONE, like the panel's list.
    expect(chromeAttentionTotal({ ...input, unread: unread({ a: 0, b: 1 }) })).toBe(1);
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

  test("PARITY: equals the number of sidebar rows that show a badge for the same subjects", () => {
    const f = fixture();
    // Expectation from the per-row helpers, the ones every sidebar row calls:
    // a row counts once when its helper says it is waiting.
    const perRow =
      Object.values(f.topics).filter((t) => !t.archived)
        .filter((t) => topicAttentionCount(t.id, f.unreadData, f.claudeAttentionTopics) > 0).length
      + f.terminalSessions.filter((t) => terminalAttentionCount(t.id, f.terminalFinishedIds) > 0).length
      + paneAttentionTotal(f.paneCounts);
    // The board share comes from the shared tray helper, the same one the glyph
    // uses. The sidebar "Board" row is NOT part of this count on purpose: it shows
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

  test("reading a topic drops exactly that topic's ONE and nothing else", () => {
    const f = fixture();
    const before = chromeOf(f);
    const afterUnread = { ...f.unreadData, a: { unreadCount: 0 } };
    expect(topicAttentionCount("a", f.unreadData, f.claudeAttentionTopics)).toBeGreaterThan(1);
    expect(before - chromeOf(f, { unread: afterUnread })).toBe(1);
    // A topic that is ALSO waiting on Claude stays a subject when read: unread
    // clears on reading, attention clears when the session moves on.
    const cRead = { ...f.unreadData, c: { unreadCount: 0 } };
    expect(chromeOf(f, { unread: cRead })).toBe(before);
  });

  test("window-local pane badges (the notifyPane map) count once per badged pane, like their utility rows", () => {
    const f = fixture();
    const panes = new Map<string, number>([[DASHBOARD, 2], [SCHEDULE, 1]]);
    expect(chromeOf(f, { paneCounts: panes }) - chromeOf(f, { paneCounts: new Map() })).toBe(2);
    expect(paneAttentionTotal(panes)).toBe(2);
    expect(paneAttentionTotal(new Map([[DASHBOARD, 0]]))).toBe(0);
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

/**
 * The bell and the dock count THE SAME subjects (NOTIF-ONE-02): the one number
 * is the union of what is asking for something and what has an unseen
 * notification, and the panel lists under "Waiting for you" every counted
 * subject that its history does not already show with an unseen dot.
 */
describe("the one number unions the live signals with the unseen notifications", () => {
  const none = {
    topics: {} as Record<string, Topic>,
    unread: {},
    claudeAttentionTopics: new Set<string>(),
    terminalFinishedIds: new Set<string>(),
    boardGroups: [] as ReturnType<typeof trayBoardGroups>,
    paneCounts: new Map<string, number>(),
  };

  test("a card in review with NO notification row counts 1, and the panel lists it", () => {
    // The verifier's ATK-4: the dock at 1 over a panel saying "No notifications".
    const input = { ...none, boardGroups: trayBoardGroups([card("r1", "review")]) };
    expect(chromeAttentionTotal(input)).toBe(1);
    const waiting = waitingSubjects(chromeAttentionSubjects(input), new Set());
    expect(waiting.map((w) => [w.kind, w.id, w.key])).toEqual([["card", "r1", "task:r1"]]);
  });

  test("a chat waiting for you with every row already seen counts 1, and the panel lists it", () => {
    const input = { ...none, topics: { w: topic("w") }, claudeAttentionTopics: new Set(["w"]) };
    expect(chromeAttentionTotal(input)).toBe(1);
    expect(waitingSubjects(chromeAttentionSubjects(input), new Set()).map((w) => w.key)).toEqual(["topic:w"]);
  });

  test("a chat with unread AND an unseen notification is ONE, shown by the history and not twice", () => {
    const keys = new Set(["topic:a"]);
    const input = { ...none, topics: { a: topic("a") }, unread: unread({ a: 4 }), unseenNotificationKeys: keys };
    expect(chromeAttentionTotal(input)).toBe(1);
    expect(waitingSubjects(chromeAttentionSubjects(input), keys)).toEqual([]);
  });

  test("a card in review with its own unseen review row is ONE", () => {
    const keys = new Set(["task:r1"]);
    const input = { ...none, boardGroups: trayBoardGroups([card("r1", "review")]), unseenNotificationKeys: keys };
    expect(chromeAttentionTotal(input)).toBe(1);
  });

  test("an unseen notification of a subject that asks nothing still counts: the bell and the dock say 1", () => {
    // A row with no target (keyed by its id), and a chat notification whose
    // chat has no unread left: both are in the panel with a dot.
    const keys = new Set(["row-uuid-1", "topic:read"]);
    const input = { ...none, topics: { read: topic("read") }, unseenNotificationKeys: keys };
    expect(chromeAttentionTotal(input)).toBe(2);
    expect(waitingSubjects(chromeAttentionSubjects(input), keys)).toEqual([]);
  });

  test("a chat that finished (its 'done' mark) counts 1 like a finished terminal, and the panel lists it", () => {
    const input = { ...none, topics: { f: topic("f") }, chatFinishedTopics: new Set(["f"]) };
    expect(chromeAttentionTotal(input)).toBe(1);
    const waiting = waitingSubjects(chromeAttentionSubjects(input), new Set());
    expect(waiting.map((w) => [w.kind, w.id, w.key])).toEqual([["chat", "f", "topic:f"]]);
    // The terminal twin, for the same shape.
    const term = { ...none, terminalFinishedIds: new Set(["s1"]) };
    expect(chromeAttentionTotal(term)).toBe(1);
  });

  test("a finished chat that is also unread, or has an unseen row, is still ONE", () => {
    const keys = new Set(["topic:f"]);
    const input = {
      ...none, topics: { f: topic("f") }, unread: unread({ f: 5 }), chatFinishedTopics: new Set(["f"]), unseenNotificationKeys: keys,
    };
    expect(chromeAttentionTotal(input)).toBe(1);
  });

  test("a finished mark on an archived or unknown chat counts nothing: no row could clear it", () => {
    const input = { ...none, topics: { gone: topic("gone", { archived: true }) }, chatFinishedTopics: new Set(["gone", "deleted"]) };
    expect(chromeAttentionTotal(input)).toBe(0);
  });

  test("a review group cut to its first rows still counts every card", () => {
    const cards = Array.from({ length: 7 }, (_, i) => card(`r${i}`, "review"));
    const cut = trayBoardGroups(cards, { rowsPerGroup: 2 });
    expect(chromeAttentionTotal({ ...none, boardGroups: cut })).toBe(7);
    // The anonymous rest is counted but not listed: it has nowhere to go.
    expect(waitingSubjects(chromeAttentionSubjects({ ...none, boardGroups: cut }), new Set())).toHaveLength(2);
  });
});
