import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installReplayCli } from "./helpers/fake-claude-cli";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 120_000 });

/**
 * /usage AND /cost OPEN "PROVIDERS AND KEYS" BESIDE THE MODEL SELECTOR, WITH THE
 * WEEK UNDER THE FIVE HOURS (CMDUI-05).
 *
 * The reading goes through `POST /api/test/plan-usage`, the same function the
 * provider calls on a `rate_limit_event`. The plan label comes from the
 * snapshot as a machine signed in to Claude Max 20x sends it (the same seam
 * as `settings-homes.spec.ts`).
 *
 * @covers CMDUI-05
 */

const LOG = join(E2E_HOME, "fake-cli-plan-meter.jsonl");
const received = (): string[] => (existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; text?: string })
    .filter((l) => l.event === "received").map((l) => l.text ?? "")
  : []);

type Snapshot = { providers: Array<Record<string, unknown> & { name: string }>; defaultProvider: string | null };
function withClaudePlan(snapshot: Snapshot): Snapshot {
  const subscription = { type: "max", tier: "default_claude_max_20x" };
  const claudeRow = (name: string, label: string) => ({
    isDefault: false, models: ["claude-sonnet-4-5"], requirements: [], fetchedAt: new Date().toISOString(),
    ...snapshot.providers.find((p) => p.name === name),
    name, label, status: "ready", subscription,
  });
  const others = snapshot.providers.filter((p) => p.name !== "claude-code" && p.name !== "topics");
  return { ...snapshot, providers: [claudeRow("topics", "Topics"), claudeRow("claude-code", "Claude Code"), ...others] };
}
async function claudeMaxMachine(page: Page) {
  await page.route("**/api/providers/snapshot", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withClaudePlan(await response.json() as Snapshot) });
  });
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string" && message.includes('"providers:snapshot"')) {
        const frame = JSON.parse(message) as { snapshot?: Snapshot };
        if (frame.snapshot) frame.snapshot = withClaudePlan(frame.snapshot);
        socket.send(JSON.stringify(frame));
      } else socket.send(message);
    });
    socket.onMessage((message) => server.send(message));
  });
}

async function send(chatPage: ChatPage, page: Page, text: string) {
  await chatPage.messageInput.click();
  await chatPage.messageInput.fill(text);
  await page.keyboard.press("Escape");
  await chatPage.messageInput.press("Enter");
}

test.describe("the plan meter", () => {
  let uninstall: (() => void) | null = null;
  let topicId = "";
  const topicName = `plan-meter-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    rmSync(LOG, { force: true });
    uninstall = installReplayCli(LOG);
    topicId = (await createTopic(request, topicName, { provider: "claude-code" })).id;
  });
  test.afterAll(async ({ request }) => {
    uninstall?.();
    await request.post("/api/test/plan-usage", { data: { clear: true } });
    if (topicId) await deleteTopic(request, topicId);
  });

  test("with a reading: /usage opens the panel beside the selector, two bars with day and hour, the week amber; the selector's line adds the week; /cost opens the same, and the CLI hears nothing", async ({ page, request, chatPage }) => {
    await claudeMaxMachine(page);
    const fiveReset = Date.now() + 2 * 3_600_000;
    const weekReset = Date.now() + 3 * 86_400_000;
    await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 38, resetsAtMs: fiveReset }, sevenDay: { utilization: 78, resetsAtMs: weekReset } } });
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    await send(chatPage, page, "/usage");
    const panel = page.getByTestId("home-panel-providers");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const [p, chip] = [await panel.boundingBox(), await page.getByTestId("provider-model-picker").boundingBox()];
    expect(Math.abs(p!.y + p!.height - chip!.y) < 40 || Math.abs(p!.y - (chip!.y + chip!.height)) < 40).toBe(true);
    await expect(panel.getByTestId("providers-claude-usage")).toContainText("38%", { timeout: 15_000 });
    const week = panel.getByTestId("providers-claude-week");
    await expect(week).toContainText("Settimana al 78%");
    const when = await page.evaluate((ms) => new Date(ms).toLocaleString("it-IT", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }), weekReset);
    await expect(week).toContainText(when);
    await expect(week).toHaveAttribute("data-warn", "true");
    await expect(panel.getByTestId("providers-claude-week-bar")).toHaveAttribute("aria-valuenow", "78");
    await page.keyboard.press("Escape");

    await page.getByTestId("provider-model-picker").click();
    // Revision 2026-10-04 §4.5: one short warning on the Anthropic heading, the
    // window over PLAN_USAGE_WARN_AT; the full reading is in the providers panel.
    await expect(page.getByTestId("provider-model-popover").getByTestId("model-section-anthropic").getByTestId("model-plan-warning")).toHaveText("sett. 78%", { timeout: 15_000 });
    await page.keyboard.press("Escape");

    await send(chatPage, page, "/cost");
    await expect(page.getByTestId("home-panel-providers")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    expect(received()).toEqual([]);
  });

  test("without a reading the panel says it arrives with the first Claude Code turn", async ({ page, request, chatPage }) => {
    await request.post("/api/test/plan-usage", { data: { clear: true } });
    await claudeMaxMachine(page);
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await send(chatPage, page, "/usage");
    const panel = page.getByTestId("home-panel-providers");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByTestId("providers-claude-usage-none")).toHaveText("Nessuna lettura ancora: arriva col primo turno di Claude Code", { timeout: 15_000 });
  });
});
