import { expect, test } from "@playwright/test";
import { execFileSync } from "child_process";
import { join } from "path";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_DATA_DIR } from "./helpers/test-server";
import { openUserMenuLevel } from "./helpers/user-menu";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * LIVE TERMINALS — every terminal running on the Mac, Topics or not, in one
 * menu at the end of the tabs: listed, screen-readable, writable.
 *
 * The "outside" terminal here is a REAL tmux session, on the socket the
 * test server uses instead of the user's (`TOPICS_TMUX_SOCKET`,
 * testServerEnv). No fakes: proof that writing landed comes from
 * tmux itself, read here rather than from the UI.
 *
 * @covers LIVETERM-01, LIVETERM-02, LIVETERM-03
 */

const SOCK = join(E2E_DATA_DIR, "tmux.sock");
const SESSION = "e2e-live";
const tmux = (...args: string[]) => execFileSync("tmux", ["-S", SOCK, ...args], { encoding: "utf8" });

test.describe.serial("Terminali vivi", () => {
  let chatId: string | null = null;
  let paneId = "";

  test.beforeAll(async ({ request }) => {
    try { tmux("kill-server"); } catch { /* no server: the wanted state */ }
    // Bare `sh`: a predictable prompt, none of the user's rc files.
    tmux("new-session", "-d", "-s", SESSION, "-x", "100", "-y", "20", "env", "PS1=$ ", "sh");
    paneId = tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}").trim();
    const chat = await createTopic(request, `E2E-LiveTerminals ${Date.now()}`);
    chatId = chat.id;
  });

  test.afterAll(async ({ request }) => {
    try { tmux("kill-server"); } catch { /* already off */ }
    if (chatId) await deleteTopic(request, chatId);
  });

  test("LIVETERM-01: la tendina mostra il terminale tmux, il suo schermo, e ci si scrive", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LIVETERM-01" });
    await resetPaneStore(request, [chatId!]);
    await goToApp(page);

    const trigger = page.getByTestId("live-terminals-trigger").first();
    await trigger.click();
    const menu = page.getByTestId("live-terminals-menu");
    await expect(menu).toBeVisible();
    const group = menu.getByTestId("live-terminals-group-tmux");
    const row = group.getByTestId(`live-terminals-row-tmux:${paneId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText(`${SESSION}:0.0`);

    await row.click();
    const peek = page.getByTestId("live-terminals-peek");
    await expect(peek).toBeVisible();
    await expect(peek.getByTestId("live-terminals-screen")).toContainText("$", { timeout: 10_000 });

    const marker = `ciao-${Date.now()}`;
    await peek.getByTestId("live-terminals-input").fill(`echo ${marker}`);
    await peek.getByTestId("live-terminals-input").press("Enter");

    // Really arrived: tmux ran the command (command line + output line).
    await expect.poll(() => tmux("capture-pane", "-p", "-t", paneId).split(marker).length - 1, { timeout: 10_000 }).toBe(2);
    // And the UI reflects it, with nothing reopened.
    await expect(peek.getByTestId("live-terminals-screen")).toContainText(`\n${marker}`, { timeout: 10_000 });
    await expect(peek.getByTestId("live-terminals-input")).toHaveValue("");
  });

  test("LIVETERM-02: l'opzione in Vista toglie e rimette la tendina", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LIVETERM-02" });
    await resetPaneStore(request, [chatId!]);
    await goToApp(page);
    await expect(page.getByTestId("live-terminals-trigger").first()).toBeAttached();

    const level = await openUserMenuLevel(page, "view");
    const toggle = level.getByTestId("topics-menu-live-terminals");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("live-terminals-trigger")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("live-terminals-trigger").first()).toBeAttached();
  });

  test("LIVETERM-04: sul telefono, dove le barre di tab non ci sono, la tendina sta accanto alla campanella", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "LIVETERM-01" });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    try {
      await resetPaneStore(request, [chatId!]);
      await goToApp(page);
      const trigger = page.getByTestId("live-terminals-trigger");
      await expect(trigger).toHaveCount(1);
      await expect(trigger).toBeVisible();
      // Twin of the bell: 44 for fingers.
      const box = await trigger.boundingBox();
      expect(Math.round(box!.height)).toBe(44);
      await trigger.tap();
      await expect(page.getByTestId("live-terminals-menu").getByTestId(`live-terminals-row-tmux:${paneId}`)).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctx.close();
    }
  });

  test("LIVETERM-03: l'API che usano gli agenti elenca, legge e scrive; un id storto non arriva a tmux", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "LIVETERM-03" });
    const list = await (await request.get("/api/live-terminals?fresh=1")).json() as { terminals: Array<{ id: string; source: string; command: string | null }> };
    const t = list.terminals.find((x) => x.id === `tmux:${paneId}`);
    expect(t?.source).toBe("tmux");
    expect(t?.command).toBe("sh");

    const id = encodeURIComponent(`tmux:${paneId}`);
    const marker = `api-${Date.now()}`;
    const sent = await request.post(`/api/live-terminals/${id}/send`, { data: { text: `echo ${marker}` } });
    expect(sent.status()).toBe(200);
    await expect.poll(async () => ((await (await request.get(`/api/live-terminals/${id}/screen`)).json()) as { text: string }).text.split(marker).length - 1, { timeout: 10_000 }).toBe(2);

    const bad = await request.post(`/api/live-terminals/${encodeURIComponent("tmux:-t")}/send`, { data: { text: "x" } });
    expect(bad.status()).toBe(404);
  });
});
