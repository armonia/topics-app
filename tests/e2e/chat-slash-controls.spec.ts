import { expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, fetchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installReplayCli } from "./helpers/fake-claude-cli";

hermetic(test);
test.describe.configure({ timeout: 150_000 });

/**
 * A COMMAND THAT HAS A CONTROL IN TOPICS OPENS THAT CONTROL (CMDUI-02).
 *
 * «Nothing reached the engine» is read from the fake CLI's log: it writes
 * down every message it is handed.
 *
 * @covers CMDUI-02
 */

const LOG = join(E2E_HOME, "fake-cli-slash-controls.jsonl");
const received = (): string[] => (existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; text?: string })
    .filter((l) => l.event === "received").map((l) => l.text ?? "")
  : []);

async function send(chatPage: ChatPage, page: Page, text: string) {
  await chatPage.messageInput.click();
  await chatPage.messageInput.fill(text);
  await page.keyboard.press("Escape");
  await chatPage.messageInput.press("Enter");
}

test.describe("commands that open a control", () => {
  let uninstall: (() => void) | null = null;
  let topicId = "";
  const topicName = `slash-controls-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    rmSync(LOG, { force: true });
    uninstall = installReplayCli(LOG);
    topicId = (await createTopic(request, topicName, { provider: "claude-code" })).id;
  });
  test.afterAll(async ({ request }) => {
    uninstall?.();
    if (topicId) await deleteTopic(request, topicId);
  });
  test.beforeEach(async ({ page, request, chatPage }) => {
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  });

  test("/model picked from the menu opens the selector, with the focus inside; nothing reaches the CLI", async ({ page, chatPage }) => {
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/mod");
    await page.getByTestId("slash-menu").locator('[data-cmd="/model"]').click();
    await expect(page.getByTestId("provider-model-picker")).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 });
    await expect.poll(() => page.getByTestId("provider-model-popover").evaluate((el) => el.contains(document.activeElement)), { timeout: 10_000 }).toBe(true);
    expect(received()).toEqual([]);
  });

  test("/permissions opens the autonomy selector with the focus on the current level; /fast puts the focus on its switch", async ({ page, chatPage }) => {
    await send(chatPage, page, "/permissions");
    const panel = page.getByTestId("composer-autonomy-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement)), { timeout: 10_000 }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    await send(chatPage, page, "/fast");
    await expect(page.getByTestId("chat-input-fast-mode")).toBeFocused({ timeout: 10_000 });
    expect(received()).toEqual([]);
  });

  test("/model opus sets the model without opening anything", async ({ page, request, chatPage }) => {
    await send(chatPage, page, "/model opus");
    await expect.poll(async () => ((await fetchTopic(request, topicId)) as unknown as { model?: string | null } | null)?.model ?? null, { timeout: 15_000 }).toBe("opus");
    await expect(page.getByTestId("provider-model-picker")).toHaveAttribute("aria-expanded", "false");
    expect(received()).toEqual([]);
  });

  test("/mcp opens the Strumenti panel beside the «+» without mounting the fleet; /config opens the user menu", async ({ page, chatPage }) => {
    const mounts: string[] = [];
    page.on("request", (r) => { if (/\/api\/mcp\/fleet\/(mount|start|connect)/.test(r.url()) || (r.method() === "POST" && r.url().includes("/api/mcp/fleet"))) mounts.push(r.url()); });
    await page.route("**/api/mcp/fleet**", async (route) => {
      if (route.request().method() !== "GET") { await route.fallback(); return; }
      await route.fulfill({ json: { enabled: true, mounted: false, mounting: false, servers: [] } });
    });
    await send(chatPage, page, "/mcp");
    const tools = page.getByTestId("home-panel-tools");
    await expect(tools).toBeVisible({ timeout: 10_000 });
    const [p, plus] = [await tools.boundingBox(), await page.getByTestId("composer-add-menu").boundingBox()];
    expect(p && plus).toBeTruthy();
    expect(Math.abs(p!.y + p!.height - plus!.y) < 40 || Math.abs(p!.y - (plus!.y + plus!.height)) < 40).toBe(true);
    expect(mounts, "opening the panel mounted the fleet").toEqual([]);
    await page.keyboard.press("Escape");

    await send(chatPage, page, "/config");
    await expect(page.getByTestId("profile-menu")).toBeVisible({ timeout: 10_000 });
    expect(received()).toEqual([]);
  });
});
