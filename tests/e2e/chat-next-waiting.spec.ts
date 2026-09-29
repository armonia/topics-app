/**
 * ⌘J: THE NEXT CHAT WAITING FOR YOU, and the same step from the phone's door.
 *
 * Three chats, seeded with no fake inside the app:
 *   - A parked on a permission: a `session:state` frame with the
 *     `awaiting-approval` phase, injected on the intercepted socket;
 *   - B parked on an in-app question: a turn in flight
 *     (`POST /api/test/streams/partial`) whose last row carries
 *     `mcp__topics__ask_user_question` in `waiting_for_input`, which
 *     `GET /api/topics/streaming` reports as `waiting`;
 *   - C with a turn in flight and no question: working, never a target.
 *
 * B and C are seeded BEFORE the page loads, so the first snapshot the client
 * asks for already tells them apart (a seed after the load would race the
 * snapshot that `stream:start` schedules 400 ms later).
 *
 * The expected order is read from the «Attende te» section of the state view,
 * not written here: the queue is defined as that sequence (CHAT-WAIT-03), and
 * this is the only place both can be compared on the same screen.
 *
 * Behaviour, so a video: the `.webm` of the three presses is the proof.
 */
import { mkdirSync, realpathSync } from "fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpDir, cleanupFileProject, removeTmpDir, seedFileProject } from "./helpers/file-project";
import { projectRowSelector } from "./fixtures/file-explorer.fixture";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { TerminalPage } from "./fixtures/terminal.fixture";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
  openShellViaSidebar,
} from "./helpers/terminal-workspace";

hermetic(test);
test.use({ video: "on" });

interface Seeded { id: string; name: string; sessionKey: string }

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey?: string }> };
  const key = body.topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey: the seed cannot reach it`);
  return key;
}

async function mk(request: APIRequestContext, label: string): Promise<Seeded> {
  const name = `next-waiting-${label}-${Date.now()}`;
  const t = await createTopic(request, name);
  return { id: t.id, name, sessionKey: await sessionKeyOf(request, t.id) };
}

/** A turn in flight; with `ask`, its last row is a question waiting for you. */
async function turnInFlight(request: APIRequestContext, s: Seeded, ask: boolean): Promise<void> {
  expect((await request.post(`${E2E_BASE}/api/test/streams/partial`, { data: { sessionKey: s.sessionKey } })).ok()).toBe(true);
  if (!ask) return;
  const question = "Quale ramo tengo?";
  const options = [{ label: "main", description: "" }, { label: "feat", description: "" }];
  await seedMessage(request, {
    sessionKey: s.sessionKey,
    role: "assistant",
    content: "Mi serve una scelta:",
    toolCalls: [{
      id: `ask-${Date.now()}`,
      name: "mcp__topics__ask_user_question",
      args: { questions: [{ question, header: "Ramo", options }] },
      status: "waiting_for_input",
      startedAt: Date.now() - 2_000,
      userInputSchema: { kind: "questions", questions: [{ question, header: "Ramo", options, multiSelect: false }] },
    }],
  });
}

/** The state view, seeded in storage like `tab-state-view.spec.ts`: the
 *  toggle lives in a sidebar popover, and driving it would test the menu. */
async function stateView(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      const raw = window.localStorage.getItem("topics-sidebar-state");
      const prev = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem("topics-sidebar-state", JSON.stringify({ ...prev, viewMode: "state" }));
    } catch { /* no storage: the assertions below say so */ }
  });
}

function permission(ws: Awaited<ReturnType<typeof interceptWebSocket>>, s: Seeded): void {
  ws.send({ type: "session:state", sessionKey: s.sessionKey, state: { phase: "awaiting-approval", rev: 1, claudeSessionId: s.sessionKey } });
}

/** The ids of the «Attende te» rows, top to bottom. */
async function awaitingOrder(page: Page, seeded: Seeded[]): Promise<string[]> {
  const names = await page.locator('[data-testid="sidebar-state-section-awaiting"] [data-row-name="chat"]').allTextContents();
  return names.map((n) => seeded.find((s) => s.name === n.trim())?.id ?? `unknown:${n}`);
}

const activeTab = (page: Page) => page.locator('[role="tab"][data-active="true"]');

/** Moves `paneId` to a new group through the tab menu, as a user does, and
 *  returns that group's id (`spaces-switcher.spec.ts`, same gesture). */
async function moveToNewGroup(page: Page, paneId: string): Promise<string> {
  await page.locator(`[role="tab"][data-pane-id="${paneId}"]`).click({ button: "right" });
  await page.getByText("Sposta nel gruppo", { exact: true }).click();
  await page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" }).click();
  const row = page.getByTestId("space-row").filter({ hasText: "Gruppo 2" });
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  const id = await row.getAttribute("data-space-id");
  if (!id) throw new Error("the new group's row carries no data-space-id");
  return id;
}
const focusedRow = (page: Page) => page.locator('[role="treeitem"][aria-selected="true"]');

test.describe("⌘J, on the desktop", () => {
  test("two chats waiting and one working: ⌘J walks the waiting ones and wraps", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "a");
    const b = await mk(request, "b");
    const c = await mk(request, "c");
    try {
      await turnInFlight(request, b, true);
      await turnInFlight(request, c, false);
      await resetPaneStore(request, [a.id, b.id, c.id]);
      await stateView(page);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(page.locator(`[role="tab"][data-pane-id="${c.id}"]`)).toBeVisible({ timeout: 15_000 });
      permission(ws, a);

      const awaiting = page.locator('[data-testid="sidebar-state-section-awaiting"]');
      await expect(awaiting.locator('[data-row-name="chat"]')).toHaveCount(2, { timeout: 20_000 });
      await expect(awaiting).toContainText(a.name);
      await expect(awaiting).toContainText(b.name);
      await expect(page.locator('[data-testid="sidebar-state-section-working"]')).toContainText(c.name);
      const order = await awaitingOrder(page, [a, b, c]);

      await page.locator(`[role="tab"][data-pane-id="${c.id}"]`).click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", c.id);

      for (const expected of [order[0], order[1], order[0]]) {
        await page.keyboard.press("Meta+j");
        await expect(activeTab(page)).toHaveAttribute("data-pane-id", expected!);
        await expect(activeTab(page)).not.toHaveAttribute("data-pane-id", c.id);
      }
    } finally {
      for (const s of [a, b, c]) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  test("in the app, no other chat waiting: a notice, and the focus stays", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "only");
    try {
      await resetPaneStore(request, [a.id]);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      const tab = page.locator(`[role="tab"][data-pane-id="${a.id}"]`);
      await expect(tab).toBeVisible({ timeout: 15_000 });
      permission(ws, a);
      await expect(tab).toHaveAttribute("data-attention", "input", { timeout: 15_000 });
      await tab.click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);

      await page.keyboard.press("Meta+j");
      await expect(page.getByTestId("toast").filter({ hasText: "Nessun'altra chat ti aspetta" })).toBeVisible();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);
    } finally {
      await deleteTopic(request, a.id).catch(() => {});
    }
  });
});

test.describe("the «In attesa» door, on the phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const door = (page: Page) => page.locator('[data-testid="mobile-chrome-bar"] [data-testid="mobile-chrome-waiting"]');

  test("the door counts the two waiting and takes you to them, never to the working one", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-04" });
    const a = await mk(request, "a");
    const b = await mk(request, "b");
    const c = await mk(request, "c");
    try {
      await turnInFlight(request, b, true);
      await turnInFlight(request, c, false);
      await resetPaneStore(request, [a.id, b.id, c.id]);
      await stateView(page);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(door(page)).toBeVisible({ timeout: 15_000 });
      permission(ws, a);

      await expect(door(page).locator("[data-notification-count]")).toHaveAttribute("data-notification-count", "2", { timeout: 20_000 });
      // The badge is only drawn: the number has to be in the door's name too.
      await expect(door(page)).toHaveAccessibleName("In attesa, 2");
      const queue = await awaitingOrder(page, [a, b, c]);
      expect([...queue].sort()).toEqual([a.id, b.id].sort());

      // Start from the working chat, as on the desktop.
      await page.locator(`[role="treeitem"][aria-label="${c.name}"]`).tap();
      await expect(focusedRow(page)).toHaveAttribute("aria-label", c.name);

      for (const expected of [queue[0], queue[1]]) {
        await door(page).tap();
        const name = [a, b].find((s) => s.id === expected)!.name;
        await expect(focusedRow(page)).toHaveAttribute("aria-label", name);
        await expect(focusedRow(page)).not.toHaveAttribute("aria-label", c.name);
      }
    } finally {
      for (const s of [a, b, c]) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  test("at zero the door is off and nothing moves when the number comes", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-04" });
    const a = await mk(request, "a");
    const b = await mk(request, "b");
    try {
      await resetPaneStore(request, [a.id, b.id]);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(door(page)).toBeVisible({ timeout: 15_000 });
      await expect(door(page)).toBeDisabled();
      await expect(door(page), "zero is said, not left out").toHaveAccessibleName("In attesa, 0");

      const widths = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="mobile-chrome-bar"] button')).map((el) => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.width)];
        }),
      );
      const atZero = await widths();
      expect(atZero.length).toBe(5);

      permission(ws, a);
      permission(ws, b);
      await expect(door(page).locator("[data-notification-count]")).toHaveAttribute("data-notification-count", "2", { timeout: 15_000 });
      await expect(door(page)).toBeEnabled();
      await expect(door(page)).toHaveAccessibleName("In attesa, 2");
      expect(await widths()).toEqual(atZero);
    } finally {
      for (const s of [a, b]) await deleteTopic(request, s.id).catch(() => {});
    }
  });
});

test.describe("Ctrl+J, the Windows way in", () => {
  // `isMod` is `metaKey || ctrlKey`, so Ctrl+J is the chord on Windows. On a
  // Mac runner Control+J is byte for byte what Windows sends (`ctrlKey` true,
  // `metaKey` false), so the Windows path is reproducible here.
  test.describe.configure({ timeout: 75_000 });

  test("Ctrl+J steps from the chat composer, a text field included", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "ctrl-target");
    const c = await mk(request, "ctrl-composer");
    try {
      await resetPaneStore(request, [a.id, c.id]);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      const tabA = page.locator(`[role="tab"][data-pane-id="${a.id}"]`);
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      permission(ws, a);
      await expect(tabA).toHaveAttribute("data-attention", "input", { timeout: 15_000 });

      await page.locator(`[role="tab"][data-pane-id="${c.id}"]`).click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", c.id);
      const composer = page.getByRole("textbox", { name: /Campo del messaggio/ }).first();
      await composer.click();
      await expect(composer).toBeFocused();

      await page.keyboard.press("Control+j");
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);
    } finally {
      for (const s of [a, c]) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  test("in a terminal Ctrl+J is the terminal's newline, and Meta+J still steps", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const terminalPage = new TerminalPage(page);
    const seeded = await seedTerminalTopic(request, "next-waiting-ctrl");
    const a = await mk(request, "term-target");
    try {
      await resetTerminalWorkspace(request, seeded.topicId);
      await resetPaneStore(request, [seeded.topicId, a.id]);
      const ws = await interceptWebSocket(page);
      await gotoTerminalProject(page, seeded.topicName);
      // The permission goes in BEFORE the shell: the terminal opens a socket of
      // its own that the same route also matches, and `send` talks to the last.
      const tabA = page.locator(`[role="tab"][data-pane-id="${a.id}"]`);
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      permission(ws, a);
      await expect(tabA).toHaveAttribute("data-attention", "input", { timeout: 15_000 });
      await openShellViaSidebar(page, terminalPage);

      await terminalPage.focus();
      // The project window and its inner terminal tab are both `data-active`,
      // so the check reads A's own tab rather than «the» active one.
      await expect(tabA, "the terminal has the focus, not the waiting chat").toHaveAttribute("data-active", "false");

      // Typed without Enter, then sent with Ctrl+J: the arithmetic only turns
      // into `42` if the shell received the newline, so the output is the
      // proof that the terminal got the key, and the happens-after that makes
      // the negative check below mean something.
      const marker = `ctrlj${Date.now()}`;
      await page.keyboard.type(`echo $((6*7))${marker}`);
      await page.keyboard.press("Control+j");
      await terminalPage.waitForOutput(`42${marker}`);
      await expect(tabA, "Ctrl+J stayed with the terminal: no step").toHaveAttribute("data-active", "false");

      // Cmd is absolute: the same key with Meta steps from the terminal too.
      await terminalPage.focus();
      await page.keyboard.press("Meta+j");
      await expect(tabA).toHaveAttribute("data-active", "true");
    } finally {
      await deleteTopic(request, a.id).catch(() => {});
      await cleanupTerminalTopic(request, seeded.topicId);
    }
  });

  // The other half of the concession: a CodeMirror editor owns its key combos
  // too (`isRawKeySurfaceFocused`, `.cm-editor`). The terminal test above does
  // not reach that branch, so without this one it could go and stay green.
  test("in a code editor Ctrl+J stays with the editor, and Meta+J still steps", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const project = await seedFileProject(request, `next-waiting-editor-${Date.now()}`);
    const a = await mk(request, "editor-target");
    try {
      // The project row is drawn while its pane is open, so the pane is seeded
      // next to A's tab (`seedProjectPane` appends).
      await resetPaneStore(request, [a.id]);
      await resetProjectPanes(request, project.tmpDir);
      await seedProjectPane(request, project.tmpDir);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      const tabA = page.locator(`[role="tab"][data-pane-id="${a.id}"]`);
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      permission(ws, a);
      await expect(tabA).toHaveAttribute("data-attention", "input", { timeout: 15_000 });

      const projects = page.getByRole("button", { name: /sezione Progetti/ });
      if ((await projects.count()) > 0 && (await projects.getAttribute("aria-expanded")) === "false") await projects.click();
      await page.locator(projectRowSelector(project.tmpDir)).first().click();
      const tree = page.locator('[data-testid="file-tree"]').first();
      await expect(tree).toBeVisible({ timeout: 15_000 });
      const indexTs = tree.getByRole("treeitem", { name: /index\.ts/ });
      if (!(await indexTs.isVisible())) await tree.locator('[role="treeitem"]', { hasText: /^src$/ }).click();
      await indexTs.click();
      const content = page.locator(".cm-editor .cm-content").first();
      await expect(content).toContainText("hello", { timeout: 15_000 });
      await content.click();
      await expect(tabA, "the editor has the focus, not the waiting chat").toHaveAttribute("data-active", "false");

      // Ctrl+J, then a marker typed after it: the marker lands in the editor
      // only if the focus never left it, and it is the happens-after that makes
      // the negative check below mean something.
      const marker = `ctrlj${Date.now()}`;
      await page.keyboard.press("Control+j");
      await page.keyboard.type(marker);
      await expect(content).toContainText(marker);
      await expect(tabA, "Ctrl+J stayed with the editor: no step").toHaveAttribute("data-active", "false");

      await page.keyboard.press("Meta+j");
      await expect(tabA).toHaveAttribute("data-active", "true");
    } finally {
      await deleteTopic(request, a.id).catch(() => {});
      await cleanupFileProject(request, project);
    }
  });
});

test.describe("⌘J in a group window (`?space=`)", () => {
  test.describe.configure({ timeout: 75_000 });

  test("⌘J goes where a click on the row goes: into the other group, and the window follows", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "grp-a");
    const b = await mk(request, "grp-b");
    try {
      await resetPaneStore(request, [a.id, b.id]);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(page.locator(`[role="tab"][data-pane-id="${b.id}"]`)).toBeVisible({ timeout: 15_000 });
      const spaceId = await moveToNewGroup(page, a.id);

      // The group window: the whole app, pinned to A's group by its query.
      await page.goto(`/?space=${encodeURIComponent(spaceId)}`);
      const tabA = page.locator(`[role="tab"][data-pane-id="${a.id}"]`);
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`[role="tab"][data-pane-id="${b.id}"]`), "B lives in the other group").toHaveCount(0);

      permission(ws, a);
      permission(ws, b);
      await expect(tabA).toHaveAttribute("data-attention", "input", { timeout: 15_000 });
      // B has no tab here, so its sidebar row is the only place that says it waits.
      await expect(page.locator(`[role="treeitem"][aria-label="${b.name}"]`)).toHaveAttribute("data-attention", "input", { timeout: 15_000 });

      await tabA.click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);

      // Two targets and the focus on one: the step is the other, whatever the order.
      await page.keyboard.press("Meta+j");
      await expect(activeTab(page), "B is opened AND visible, not opened in a hidden group").toHaveAttribute("data-pane-id", b.id);
      await expect(page.getByTestId("space-row-active")).toContainText("Principale");
      await expect.poll(() => new URL(page.url()).searchParams.get("space"), { message: "the query follows, or the next hydrate undoes the step" }).toBe("space:default");

      await page.keyboard.press("Meta+j");
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);
      await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2");
    } finally {
      for (const s of [a, b]) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  // A PINNED target is drawn in the tile block above every group, in no card:
  // the lookup through the cards found no group for it, so ⌘J (and the tile's
  // own click) opened B inside the hidden default group and the active tab
  // stayed A. Its group now comes from the pane map, as for any row.
  test("⌘J to a pinned chat whose tab lives in the other group takes the window there, and so does its tile", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "pin-a");
    const b = await mk(request, "pin-b");
    const pins = (pinnedItems: string[]) =>
      request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
        data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems, pinnedLayout: [] },
      });
    try {
      await resetPaneStore(request, [a.id, b.id]);
      expect((await pins([b.id])).ok()).toBe(true);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(page.locator(`[role="tab"][data-pane-id="${b.id}"]`)).toBeVisible({ timeout: 15_000 });
      const spaceId = await moveToNewGroup(page, a.id);

      await page.goto(`/?space=${encodeURIComponent(spaceId)}`);
      const tabA = page.locator(`[role="tab"][data-pane-id="${a.id}"]`);
      await expect(tabA).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`[role="tab"][data-pane-id="${b.id}"]`), "B lives in the other group").toHaveCount(0);
      const tileB = page.getByTestId("sidebar-pinned-section").getByTestId("pinned-tile").and(page.getByRole("treeitem", { name: b.name }));
      await expect(tileB, "B is pinned: its tile is its only place in this sidebar").toBeVisible({ timeout: 15_000 });

      permission(ws, a);
      permission(ws, b);
      await expect(tabA).toHaveAttribute("data-attention", "input", { timeout: 15_000 });
      await tabA.click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);

      // Two targets and the focus on one: the step is the pinned B.
      await page.keyboard.press("Meta+j");
      await expect(activeTab(page), "B is opened AND visible, not opened in a hidden group").toHaveAttribute("data-pane-id", b.id);
      await expect(page.getByTestId("space-row-active")).toContainText("Principale");

      await page.keyboard.press("Meta+j");
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);
      await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2");

      // The tile's click is the row's click: same detour.
      await tileB.click();
      await expect(activeTab(page), "the pinned tile opened B in a group you cannot see").toHaveAttribute("data-pane-id", b.id);
      await expect(page.getByTestId("space-row-active")).toContainText("Principale");
    } finally {
      await pins([]).catch(() => {});
      for (const s of [a, b]) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  // Every pinned tile kind, not only chats and terminals: a project tile and a
  // browser tile opened their pane inside the hidden group, and nothing moved.
  test("a pinned project tile and a pinned browser tile whose tab lives in the other group take the window there", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "tile-a");
    const dir = canonicalTmpDir("e2e-next-waiting-tile");
    mkdirSync(dir, { recursive: true });
    const projectPath = realpathSync(dir);
    const projectKey = `project:${projectPath}`;
    const projectPane = `project:${encodeURIComponent(projectPath)}`;
    const browserPane = `browser:e2e-next-waiting-${Date.now()}`;
    const pins = (pinnedItems: string[]) =>
      request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
        data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems, pinnedLayout: [] },
      });
    try {
      await resetPaneStore(request, [a.id, projectPane, browserPane]);
      expect((await pins([projectKey, browserPane])).ok()).toBe(true);
      await goToApp(page);
      await expect(page.locator(`[role="tab"][data-pane-id="${a.id}"]`)).toBeVisible({ timeout: 15_000 });
      const spaceId = await moveToNewGroup(page, a.id);
      const groupWindow = async () => {
        await page.goto(`/?space=${encodeURIComponent(spaceId)}`);
        await expect(page.locator(`[role="tab"][data-pane-id="${a.id}"]`)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2");
      };
      const tile = (key: string) => page.getByTestId("sidebar-pinned-section").locator(`[data-pinned-tile="${key}"]`);

      await groupWindow();
      await expect(page.locator(`[role="tab"][data-pane-id="${projectPane}"]`), "the project lives in the other group").toHaveCount(0);
      await tile(projectKey).click();
      await expect(page.getByTestId("space-row-active"), "the project tile took the window to its group").toContainText("Principale");
      await expect(page.locator(`[role="tab"][data-pane-id="${projectPane}"]`)).toHaveAttribute("data-active", "true");

      await groupWindow();
      await expect(page.locator(`[role="tab"][data-pane-id="${browserPane}"]`), "the browser lives in the other group").toHaveCount(0);
      await tile(browserPane).click();
      await expect(page.getByTestId("space-row-active"), "the browser tile took the window to its group").toContainText("Principale");
      await expect(page.locator(`[role="tab"][data-pane-id="${browserPane}"]`)).toHaveAttribute("data-active", "true");
    } finally {
      await pins([]).catch(() => {});
      await deleteTopic(request, a.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });
});

test.describe("⌘J in the normal window, with groups", () => {
  test.describe.configure({ timeout: 75_000 });

  // Without `?space=` the window is not pinned to a group: the step switches
  // the grid to the target's group, and the query stays out of it.
  test("⌘J into the other group switches the grid there, and back", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "norm-a");
    const b = await mk(request, "norm-b");
    try {
      await resetPaneStore(request, [a.id, b.id]);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      const tabB = page.locator(`[role="tab"][data-pane-id="${b.id}"]`);
      await expect(tabB).toBeVisible({ timeout: 15_000 });
      await moveToNewGroup(page, a.id);
      await expect(page.getByTestId("space-row-active"), "the move leaves the window where it was").toContainText("Principale");
      await expect(page.locator(`[role="tab"][data-pane-id="${a.id}"]`), "A lives in the other group").toHaveCount(0);

      permission(ws, a);
      permission(ws, b);
      await expect(tabB).toHaveAttribute("data-attention", "input", { timeout: 15_000 });
      await expect(page.locator(`[role="treeitem"][aria-label="${a.name}"]`)).toHaveAttribute("data-attention", "input", { timeout: 15_000 });
      await tabB.click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", b.id);

      await page.keyboard.press("Meta+j");
      await expect(activeTab(page), "A is opened AND visible").toHaveAttribute("data-pane-id", a.id);
      await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2");
      expect(new URL(page.url()).searchParams.get("space"), "a normal window stays a normal window").toBeNull();

      await page.keyboard.press("Meta+j");
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", b.id);
      await expect(page.getByTestId("space-row-active")).toContainText("Principale");
    } finally {
      for (const s of [a, b]) await deleteTopic(request, s.id).catch(() => {});
    }
  });
});
