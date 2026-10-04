/**
 * ONE "SEEN" PER PANE, whatever brought the pane in front.
 *
 * The report (01/10): notifications still disagree. A pane whose tab is blue
 * keeps its blue when you click INSIDE it; clicking its TAB clears it. The tab
 * click carried a private clear for the terminal mark, the terminal body
 * cleared its own mark as soon as it was merely VISIBLE (focused or not), and a
 * chat already in front whose turn ended was never seen again.
 *
 * The rule proved here: a pane is seen when it is THE focused pane of the
 * window (tab click, click inside, keyboard, sidebar row: any input), with the
 * window awake, for the seen dwell. That one event goes through the seen door
 * and clears the subject on every surface at once: tab, sidebar row, the inbox
 * (whose number is the Dock's). A mark on a pane that is visible in a split
 * but not focused stays. A subject that is in front of the person when its
 * epoch is born is born seen: never lit, never counted.
 *
 * Since notifications-redesign (tasks.md 5.5) every mark is the server's: the
 * chats finish REAL turns on the chat route (a fake CLI answers), the Claude
 * Code terminal is driven by the hooks route (the POSTs the CLI makes), the
 * permission is the bridge's own route. Nothing is injected. What is faked is
 * the boundary a headless browser cannot have: the window being in front of
 * the person or behind another app (`hasFocus()`), the OS banner, the Badging
 * API (recorded).
 *
 * No sleep: "a dwell has passed" is read off a witness, a lit subject in front
 * that the dwell switches off, or off the seen door's own request.
 *
 * @covers SEEN-ANY-FOCUS-01
 * @covers SEEN-ANY-FOCUS-02
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { splitViaContextMenu } from "./helpers/layout";
import { createTopic, deleteTerminalSession, deleteTopic, resetPaneStore, seedPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { seedMessage } from "./helpers/seed-messages";
import {
  createClaudeTerminal, postHook, recordAttentionFrames, runChatTurn, sessionKeyOf, setAwake, stubBannersAndWindow,
  type AttentionFrames, type ClaudeTerminal,
} from "./helpers/attention";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { terminalSubject, topicSubject } from "../../shared/attention";

hermetic(test);
test.use({ video: "on" });

const BASE = E2E_BASE;

/** The Badging API records every number the Dock is given. */
async function recordDock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __dock: number[] };
    w.__dock = [];
    const nav = navigator as unknown as { setAppBadge: (n?: number) => Promise<void>; clearAppBadge: () => Promise<void> };
    nav.setAppBadge = (n?: number) => { w.__dock.push(n ?? 0); return Promise.resolve(); };
    nav.clearAppBadge = () => { w.__dock.push(0); return Promise.resolve(); };
  });
}

const dockHistory = (page: Page) => page.evaluate(() => (window as unknown as { __dock: number[] }).__dock.slice());

interface FocusFrames {
  /** Waits until the app's socket told the server this subject is in front, with this wake. */
  reported: (subject: string, awake: boolean) => Promise<void>;
}

/**
 * The `focus` frames the page sends on the app's socket (`/ws`, not a
 * terminal's `/ws/...`): what the server knows is in front of the person. A
 * turn that ends before the server knows is not born seen, so the specs wait
 * for this before ending one.
 */
function recordFocusFrames(page: Page): FocusFrames {
  const sent: Array<{ subject: string | null; awake: boolean }> = [];
  page.on("websocket", (ws) => {
    if (!/\/ws(\?|$)/.test(ws.url())) return;
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string" || !payload.includes('"focus"')) return;
      try {
        const msg = JSON.parse(payload) as { type?: string; subject?: string | null; awake?: boolean };
        if (msg.type === "focus") sent.push({ subject: msg.subject ?? null, awake: msg.awake !== false });
      } catch { /* not a frame of ours */ }
    });
  });
  return {
    reported: async (subject, awake) => {
      await expect
        .poll(() => { const last = sent.at(-1); return last ? `${last.subject}|${last.awake}` : null; }, { timeout: 15_000, message: `the window never told the server ${subject} is in front (awake: ${awake})` })
        .toBe(`${subject}|${awake}`);
    },
  };
}

const inboxCount = (page: Page) => page.getByTestId("inbox-count");
const inboxNumber = async (page: Page): Promise<number> =>
  (await inboxCount(page).count()) ? Number(await inboxCount(page).getAttribute("data-notification-count")) : 0;

/**
 * The inbox shows what the server says is lit, no more and no less. The specs
 * name which subjects are lit; this proves the number agrees. Not a count
 * relative to a baseline: a hookless Claude Code terminal closes a turn of its
 * own when its PTY goes quiet after the CLI's first output (T2,
 * `server/attention/terminal-turns.ts`), at a moment no spec chooses.
 */
async function expectInboxIsServer(page: Page, frames: AttentionFrames, message: string): Promise<void> {
  await expect
    .poll(async () => {
      const shown = await inboxNumber(page);
      const lit = [...frames.rows().values()].filter((r) => r.lit).map((r) => r.subject);
      return shown === lit.length ? "agree" : `inbox ${shown}, server lit ${JSON.stringify(lit)}`;
    }, { timeout: 15_000, message })
    .toBe("agree");
}

const tab = (page: Page, paneId: string) => page.locator(`[role="tab"][data-pane-id="${paneId}"]`);
const chatRow = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const terminalRow = (page: Page, sid: string) => page.locator(`[data-terminal-row="${sid}"]`);
const badgeOf = (surface: Locator) => surface.locator("[data-notification-count]");

/** One whole turn of the Claude Code terminal, as its hooks post it. */
async function terminalTurn(request: APIRequestContext, term: ClaudeTerminal, prompt: string): Promise<void> {
  await postHook(request, "UserPromptSubmit", { session_id: term.claudeSessionId, cwd: term.cwd, prompt });
  await postHook(request, "Stop", { session_id: term.claudeSessionId, cwd: term.cwd });
}

/** Polls the last row the server sent for a subject until it is lit, or not. */
async function expectLit(frames: AttentionFrames, subject: string, lit: boolean, message: string): Promise<void> {
  await expect.poll(() => frames.rows().get(subject)?.lit ?? null, { timeout: 15_000, message }).toBe(lit);
}

/** Click inside the pane's BODY (not its tab): the middle of its split card,
 *  below the tab bar. */
async function clickInside(page: Page, paneId: string): Promise<void> {
  const card = page.locator("[data-split-card]").filter({ has: tab(page, paneId) });
  const box = await card.boundingBox();
  if (!box) throw new Error(`no split card holds the pane ${paneId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  // The click moved the focus: the pane is now the one in front.
  await expect(tab(page, paneId), `a click inside ${paneId} did not focus it`).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
}

const TOOL = "mcp__gateway__kiwi__search-flight";
const TOOL_INPUT = { flyFrom: "NAP", flyTo: "RAK" };

/** The bridge's legs, as the CLI's permission tool makes them, until somebody decides. */
function askPermission(request: APIRequestContext, sessionKey: string, toolUseId: string): Promise<{ decision?: string; cancelled?: boolean }> {
  return (async () => {
    for (let legs = 0; legs < 120; legs++) {
      const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
        data: { toolName: TOOL, input: TOOL_INPUT, toolUseId, legMs: 1000 }, timeout: 30_000,
      });
      const body = (await r.json()) as { decision?: string; cancelled?: boolean; pending?: boolean };
      if (!body.pending) return body;
    }
    throw new Error("nobody decided the permission");
  })();
}

test.describe("Seen on any focus: one event clears a pane's marks everywhere", () => {
  // One worker for the file: the fake CLI is one entry on disk, installed once.
  test.describe.configure({ mode: "default", timeout: 120_000 });
  let removeCli: (() => void) | null = null;
  test.beforeAll(() => { removeCli = installSlowTurnCli(); });
  test.afterAll(() => { removeCli?.(); removeCli = null; });

  let focusChat: { id: string; name: string };
  let doneChat: { id: string; name: string };
  let term: ClaudeTerminal & { name: string };
  let termPane: string;

  test.beforeEach(async ({ request }) => {
    const stamp = Date.now();
    focusChat = await createTopic(request, `Seen-Focus-${stamp}`, { provider: "claude-code" });
    doneChat = await createTopic(request, `Seen-Done-${stamp}`, { provider: "claude-code" });
    const name = `Seen-Term-${stamp}`;
    term = { ...(await createClaudeTerminal(request, name)), name };
    termPane = `terminal:${term.id}`;
  });

  test.afterEach(async ({ request }) => {
    for (const t of [focusChat, doneChat]) if (t) await deleteTopic(request, t.id).catch(() => {});
    if (term) await deleteTerminalSession(request, term.id);
  });

  /** Three cells side by side, the focus on the first: the chat and the
   *  terminal are VISIBLE and not focused. */
  async function threeCells(page: Page, focus: FocusFrames): Promise<void> {
    await resetPaneStore(page.request, [focusChat.id, doneChat.id, termPane]);
    await goToApp(page);
    await expect(tab(page, termPane)).toBeVisible({ timeout: 20_000 });
    await splitViaContextMenu(page, "Dividi a destra", 1);
    await splitViaContextMenu(page, "Dividi a destra", 1);
    await expect(page.locator("[data-split-card]")).toHaveCount(3, { timeout: 10_000 });
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true");
    await expect(tab(page, doneChat.id)).toBeVisible();
    await expect(tab(page, termPane)).toBeVisible();
    await expect(chatRow(page, doneChat.name)).toBeVisible({ timeout: 15_000 });
    await expect(terminalRow(page, term.id)).toBeVisible({ timeout: 15_000 });
    await focus.reported(topicSubject(focusChat.id), true);
  }

  test("SEEN-ANY-FOCUS-01: a visible but unfocused pane keeps its mark; a click inside it clears tab, row and inbox", async ({ page, request }) => {
    await stubBannersAndWindow(page, { awake: true });
    const frames = recordAttentionFrames(page);
    const focus = recordFocusFrames(page);
    await threeCells(page, focus);

    // Three turns end while the window is behind another app: none is born seen.
    await setAwake(page, false);
    await focus.reported(topicSubject(focusChat.id), false);
    await runChatTurn(request, doneChat.id, "done over there");
    await terminalTurn(request, term, "finish over there");
    await runChatTurn(request, focusChat.id, "done in front");
    await expectLit(frames, topicSubject(focusChat.id), true, "the chat in front of a window behind another app is not lit");
    await expect(tab(page, doneChat.id), "the finished chat's tab is not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name)).toHaveAttribute("data-attention", "done");
    await expect(tab(page, termPane), "the finished terminal's tab is not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(terminalRow(page, term.id)).toHaveAttribute("data-attention", "done");
    await expectLit(frames, topicSubject(doneChat.id), true, "the finished chat is not lit");
    await expectLit(frames, terminalSubject(term.id), true, "the finished terminal is not lit");
    await expectInboxIsServer(page, frames, "the inbox does not count the three finished panes");

    // Back in front of the person. The witness: the focused chat is seen once
    // a dwell has passed, so by then the dwell had every chance to clear the
    // two visible panes too.
    await setAwake(page, true);
    await expectLit(frames, topicSubject(focusChat.id), false, "the witness: the focused chat was never seen");
    await expect(tab(page, focusChat.id)).not.toHaveAttribute("data-attention-fill", /.+/, { timeout: 10_000 });
    await expectInboxIsServer(page, frames, "the inbox still counts the focused chat");

    // Visible is not seen: both marks are still on every surface.
    await expect(tab(page, doneChat.id), "a visible, unfocused chat lost its mark").toHaveAttribute("data-attention", "done");
    await expect(chatRow(page, doneChat.name)).toHaveAttribute("data-attention", "done");
    await expect(tab(page, termPane), "a visible, unfocused terminal lost its mark").toHaveAttribute("data-attention", "done");
    await expect(terminalRow(page, term.id)).toHaveAttribute("data-attention", "done");

    // A click INSIDE the chat, not on its tab: the chat's marks go everywhere.
    await clickInside(page, doneChat.id);
    await expect(tab(page, doneChat.id), "a click inside the chat left its tab marked").not.toHaveAttribute("data-attention", /.+/, { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name), "a click inside the chat left its row marked").not.toHaveAttribute("data-attention", /.+/);
    await expectInboxIsServer(page, frames, "the inbox still counts the seen chat");
    // The terminal was not looked at: it keeps its mark.
    await expect(tab(page, termPane)).toHaveAttribute("data-attention", "done");
    await expect(terminalRow(page, term.id)).toHaveAttribute("data-attention", "done");

    // A click INSIDE the terminal: its marks go everywhere too.
    await clickInside(page, termPane);
    await expect(terminalRow(page, term.id), "a click inside the terminal left its row marked").not.toHaveAttribute("data-attention", /.+/, { timeout: 10_000 });
    await expectInboxIsServer(page, frames, "the inbox still counts the seen terminal");
    // Leave it: the tab of a pane you no longer look at shows what is left.
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true");
    await expect(tab(page, termPane), "a click inside the terminal left its tab marked").not.toHaveAttribute("data-attention", /.+/);
    await expect(badgeOf(tab(page, termPane))).toHaveCount(0);
  });

  test("SEEN-ANY-FOCUS-02: a pane already focused when its turn ends is never left marked, on any surface", async ({ page, request }) => {
    await stubBannersAndWindow(page, { awake: true });
    const frames = recordAttentionFrames(page);
    const focus = recordFocusFrames(page);
    await threeCells(page, focus);

    // The chat finishes while unfocused: blue on its tab and its row.
    await runChatTurn(request, doneChat.id, "first");
    await expect(tab(page, doneChat.id)).toHaveAttribute("data-attention-fill", "done", { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name)).toHaveAttribute("data-attention-fill", "done");
    // Focused from inside: seen after the dwell, on both surfaces.
    await clickInside(page, doneChat.id);
    await expect(tab(page, doneChat.id)).not.toHaveAttribute("data-attention-fill", /.+/, { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name)).not.toHaveAttribute("data-attention-fill", /.+/);

    // Still in front of the person, the chat ends a NEW turn: born seen.
    await focus.reported(topicSubject(doneChat.id), true);
    const turnsBefore = frames.rows().get(topicSubject(doneChat.id))?.lastTurnAt ?? null;
    await runChatTurn(request, doneChat.id, "second");
    await expect
      .poll(() => frames.rows().get(topicSubject(doneChat.id))?.lastTurnAt ?? null, { timeout: 15_000, message: "the second turn never closed" })
      .not.toBe(turnsBefore);
    await expectLit(frames, topicSubject(doneChat.id), false, "the focused chat's new turn lit it");
    await expect(tab(page, doneChat.id), "the focused chat's tab stays blue").not.toHaveAttribute("data-attention-fill", /.+/);
    await expect(chatRow(page, doneChat.name), "the focused chat's row stays blue").not.toHaveAttribute("data-attention-fill", /.+/);

    // The terminal, focused from inside, finishes a turn in front of you.
    await clickInside(page, termPane);
    await focus.reported(terminalSubject(term.id), true);
    await terminalTurn(request, term, "finish in front");
    // The sentinel: a chat that is NOT in front finishes after it.
    await runChatTurn(request, focusChat.id, "sentinel");
    await expect(tab(page, focusChat.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expectLit(frames, terminalSubject(term.id), false, "the focused terminal's turn lit it");
    await expect(terminalRow(page, term.id), "the focused terminal's row kept a mark").not.toHaveAttribute("data-attention", /.+/);
    await expectInboxIsServer(page, frames, "the inbox counts the terminal you are looking at");
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true");
    await expect(tab(page, termPane), "the focused terminal's tab kept a mark").not.toHaveAttribute("data-attention", /.+/);
  });

  test("SEEN-ANY-FOCUS-01b: a finished terminal goes from the inbox when its tab or its sidebar row focuses it", async ({ page, request }) => {
    await stubBannersAndWindow(page, { awake: true });
    const frames = recordAttentionFrames(page);
    const focus = recordFocusFrames(page);
    await threeCells(page, focus);

    // Its turn ends while another cell is focused: one more in the inbox.
    await terminalTurn(request, term, "first");
    await expectLit(frames, terminalSubject(term.id), true, "the terminal's turn did not light it");
    await expectInboxIsServer(page, frames, "the terminal is not in the inbox");
    // The TAB focuses it: the seen clears it.
    await tab(page, termPane).click();
    await expect(tab(page, termPane)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expectInboxIsServer(page, frames, "the tab click left the terminal in the inbox");
    await expectLit(frames, terminalSubject(term.id), false, "the tab click did not see the terminal");

    // Away from it, a new turn of the same terminal (already seen once).
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await focus.reported(topicSubject(focusChat.id), true);
    await terminalTurn(request, term, "second");
    await expectInboxIsServer(page, frames, "the second turn is not in the inbox");
    // The sidebar ROW focuses it: the same event clears it.
    await terminalRow(page, term.id).click();
    await expect(tab(page, termPane)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expectInboxIsServer(page, frames, "the row click left the terminal in the inbox");
  });

  /** One group seeded with `paneIds`, nothing clicked: `focusedPanelId` stays
   *  null (a new device, a fresh PWA, the state after a drop) and the group
   *  draws its first tab as the focused one. */
  async function noFocusYet(page: Page, paneIds: string[]): Promise<void> {
    await resetPaneStore(page.request, paneIds);
    await goToApp(page);
    await expect(tab(page, paneIds[0]), "the first tab is not the active one").toHaveAttribute("data-active", "true", { timeout: 20_000 });
    await expect(tab(page, paneIds[0]), "the active tab is not drawn as focused").toHaveAttribute("data-focused", "true");
    await expect(tab(page, paneIds[1])).toBeVisible();
  }

  test("SEEN-ANY-FOCUS-02b: with no pane focused yet, the terminal its group draws in front finishes a turn and is left with no mark", async ({ page, request }) => {
    await stubBannersAndWindow(page, { awake: true });
    const frames = recordAttentionFrames(page);
    const focus = recordFocusFrames(page);
    await noFocusYet(page, [termPane, doneChat.id]);
    await expect(terminalRow(page, term.id)).toBeVisible({ timeout: 15_000 });
    await focus.reported(terminalSubject(term.id), true);

    // The terminal drawn in front finishes; then the sentinel, the chat in the
    // tab behind it, ends a turn.
    await terminalTurn(request, term, "finish in front");
    await runChatTurn(request, doneChat.id, "sentinel");
    await expect(tab(page, doneChat.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expectLit(frames, terminalSubject(term.id), false, "the terminal drawn in front was lit");
    await expect(terminalRow(page, term.id), "the terminal drawn in front kept a row mark").not.toHaveAttribute("data-attention", /.+/);
    await expectInboxIsServer(page, frames, "the inbox counts the terminal drawn in front");
    await tab(page, doneChat.id).click();
    await expect(tab(page, doneChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect(tab(page, termPane), "the terminal drawn in front kept a tab mark").not.toHaveAttribute("data-attention", /.+/);
  });

  test("SEEN-ANY-FOCUS-02c: with no pane focused yet, the chat its group draws in front ends a turn and is left with no mark", async ({ page, request }) => {
    await stubBannersAndWindow(page, { awake: true });
    const frames = recordAttentionFrames(page);
    const focus = recordFocusFrames(page);
    await noFocusYet(page, [focusChat.id, doneChat.id]);
    await expect(chatRow(page, focusChat.name)).toBeVisible({ timeout: 15_000 });
    await focus.reported(topicSubject(focusChat.id), true);

    await runChatTurn(request, focusChat.id, "front");
    await runChatTurn(request, doneChat.id, "sentinel");
    await expect(tab(page, doneChat.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expectLit(frames, topicSubject(focusChat.id), false, "the chat drawn in front was lit");
    await expect(tab(page, focusChat.id), "the chat drawn in front kept its done mark").not.toHaveAttribute("data-attention", /.+/);
    await expect(chatRow(page, focusChat.name), "the row of the chat drawn in front kept its done mark").not.toHaveAttribute("data-attention", /.+/);
    await expectInboxIsServer(page, frames, "the inbox counts the chat drawn in front");
  });

  test("SEEN-ANY-FOCUS-02d: the board's coordinator, open in its drawer, is the subject in front: the window tells the server, and leaving the board takes it back", async ({ page, request }) => {
    // The coordinator is Codex-only and the test server has no Codex
    // (`codex_unavailable`), so no turn of it can end here. What the client
    // owns is proved instead: with the board in front and the drawer open, the
    // window names the coordinator as the subject in front, awake, and an
    // epoch born there is born seen on the server (`server/attention/store.ts`
    // `inFrontOfThePerson`, unit-proved in `server/attention/born-seen.test.ts`).
    await stubBannersAndWindow(page, { awake: true });
    const focus = recordFocusFrames(page);
    const board = "__board__";
    await resetPaneStore(request, [focusChat.id, board]);
    await goToApp(page);
    await tab(page, board).click();
    await expect(tab(page, board)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("board-open-orchestrator").click();
    const drawer = page.getByTestId("board-orchestrator-drawer");
    await expect(drawer.getByTestId("chat-panel")).toBeVisible({ timeout: 15_000 });
    const res = await request.get(`${BASE}/api/topics`);
    const all = ((await res.json()) as { topics: Record<string, { id: string; isGlobalOrchestrator?: boolean }> }).topics;
    const coordinator = Object.values(all).find((t) => t.isGlobalOrchestrator);
    expect(coordinator, "no coordinator topic").toBeTruthy();
    await focus.reported(topicSubject(coordinator!.id), true);
    // Behind another app, the coordinator is still in front of the window but not of the person.
    await setAwake(page, false);
    await focus.reported(topicSubject(coordinator!.id), false);
    await setAwake(page, true);
    await focus.reported(topicSubject(coordinator!.id), true);
    // Another tab in front: the coordinator is no longer the subject in front.
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await focus.reported(topicSubject(focusChat.id), true);
  });

  test("SEEN-ANY-FOCUS-01c: a permission wait on the focused chat stays amber on its tab, its row and its group card after it is seen", async ({ page, request }) => {
    await stubBannersAndWindow(page, { awake: true });
    const frames = recordAttentionFrames(page);
    const focus = recordFocusFrames(page);
    const subject = topicSubject(focusChat.id);
    const sessionKey = await sessionKeyOf(request, focusChat.id);
    const toolCallId = `toolu_seen_perm_${Date.now()}`;
    await request.delete(`${BASE}/api/tool-grants/${encodeURIComponent(TOOL)}`);
    await request.patch(`${BASE}/api/topics/${focusChat.id}`, { data: { autonomyLevel: "auto-apply" } });
    // The turn as the route paints it: the tool on the row, waiting on the person.
    const tc = {
      id: toolCallId, name: TOOL, args: TOOL_INPUT, status: "awaiting_permission" as const, startedAt: Date.now(),
      permissionRequest: { toolName: TOOL, input: TOOL_INPUT, requestedAt: Date.now() },
    };
    await seedMessage(request, { sessionKey, role: "user", content: "find a flight" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "Searching:", toolCalls: [tc], blocks: [{ kind: "text", text: "Searching:" }, { kind: "tool", toolCall: tc }] });
    // A second group, so the group cards are drawn.
    const SPACE_ID = "space:seen-any-focus";
    await Promise.all([focusChat.id, doneChat.id].map((id) => unarchiveTopic(request, id)));
    await seedPaneStore(request, () => {
      const openedAt = Date.now();
      const pane = (id: string, spaceId?: string) => ({ id, type: "chat", title: "", topicId: id, openedAt, ...(spaceId ? { spaceId } : {}) });
      return {
        panes: { [focusChat.id]: pane(focusChat.id), [doneChat.id]: pane(doneChat.id, SPACE_ID) },
        groups: { "group:default": { id: "group:default", paneIds: [focusChat.id, doneChat.id], splitRatio: 1, splitAxis: "horizontal" } },
        projects: {}, groupOrder: ["group:default"], closedStack: [],
        spaces: { [SPACE_ID]: { id: SPACE_ID, name: "Seen Group", order: 1, updatedAt: openedAt } },
      };
    });
    await goToApp(page);
    const mainCard = page.locator(`[role="tab"][data-space-id="space:default"]`);
    await expect(mainCard).toBeVisible({ timeout: 20_000 });
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await focus.reported(subject, true);

    // The permission is asked while the person looks at the chat: born seen,
    // and a look does not answer it. Every surface still asks for it.
    const decided = askPermission(request, sessionKey, toolCallId);
    await expect.poll(() => frames.rows().get(subject)?.reason ?? null, { timeout: 15_000, message: "the permission is not needs-you(permission)" }).toBe("permission");
    await expect
      .poll(() => { const r = frames.rows().get(subject); return r ? r.seenEpoch >= r.epoch : false; }, { timeout: 15_000, message: "the permission in front was never seen" })
      .toBe(true);
    await expectLit(frames, subject, true, "a seen permission stopped asking");
    await expect(mainCard, "the group card dropped the permission wait").toHaveAttribute("data-attention", "needs-you", { timeout: 10_000 });
    await expect(tab(page, focusChat.id), "the focused chat's tab dropped the amber of a pending permission").toHaveAttribute("data-attention-fill", "needs-you");
    await expect(chatRow(page, focusChat.name), "the focused chat's row dropped the amber of a pending permission").toHaveAttribute("data-attention-fill", "needs-you");

    // The answer switches it off.
    const panel = page.locator(`[data-testid="tool-permission-${toolCallId}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.locator(`[data-testid="tool-permission-allow-${toolCallId}"]`).click();
    expect((await decided).decision).toBe("allow");
    await expectLit(frames, subject, false, "the answer did not switch the wait off");
  });

  test("SEEN-ANY-FOCUS-01d: the focused chat that finished while the window was behind is seen in the inbox and on the Dock once the window comes back", async ({ page, request }) => {
    await stubBannersAndWindow(page, { awake: true });
    await recordDock(page);
    const frames = recordAttentionFrames(page);
    const focus = recordFocusFrames(page);
    await resetPaneStore(request, [focusChat.id, doneChat.id]);
    await goToApp(page);
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await focus.reported(topicSubject(focusChat.id), true);

    // The window goes behind; the chat in front ends a turn.
    await setAwake(page, false);
    await focus.reported(topicSubject(focusChat.id), false);
    await runChatTurn(request, focusChat.id, "a reply while away");
    await expectLit(frames, topicSubject(focusChat.id), true, "the chat that finished behind another app is not lit");
    await expectInboxIsServer(page, frames, "nothing counted while the window was behind");

    // Back, looking at the same chat for a dwell.
    await setAwake(page, true);
    await expectLit(frames, topicSubject(focusChat.id), false, "back in front of the chat, it was never seen");
    await expectInboxIsServer(page, frames, "back in front of the chat, the inbox still counts it");
    await expect
      .poll(async () => ((await dockHistory(page)).at(-1) ?? 0) === (await inboxNumber(page)), { timeout: 10_000, message: "back in front of the chat, the Dock still counts it" })
      .toBe(true);
    // Leave it: nothing is left on its row or its tab.
    await tab(page, doneChat.id).click();
    await expect(tab(page, doneChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect(chatRow(page, focusChat.name), "the chat seen on return kept a row mark").not.toHaveAttribute("data-attention", /.+/);
    await expect(badgeOf(chatRow(page, focusChat.name)), "the chat seen on return kept a row badge").toHaveCount(0);
    await expect(badgeOf(tab(page, focusChat.id)), "the chat seen on return kept a tab badge").toHaveCount(0);
  });
});
