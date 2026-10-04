/**
 * THE ONE MODEL SELECTOR, ON THE CHAT SURFACES (tasks 1.9, 1.10).
 *
 * The catalog is a fixture handed in through the snapshot route and the WS
 * push (`providers:snapshot`): the catalogs measured on 2026-10-02 plus two
 * more companies, so four sections exist. No provider is called, no model is
 * asked anything: the only writes are the topic's own PATCHes.
 *
 * Screenshots and the video of the main flow are written for the maintainer
 * when `MSEL_SHOTS_DIR` is set (openspec/changes/archive/2026-10-04-model-selector/screenshots).
 *
 * @covers MSEL-01 MSEL-02 MSEL-03 MSEL-07 MSEL-08 MSEL-10
 */
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import type { ProvidersSnapshot, ProviderSnapshotEntry } from "../../shared/types";

hermetic(test);

const at = new Date().toISOString();
const CLAUDE_CODE_IDS = [
  "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]", "claude-haiku-4-5",
  "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]", "claude-haiku-3-5",
];
const OLDER = new Set(["claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]", "claude-haiku-3-5"]);
const CODEX = [
  ["gpt-6.1-sol", "GPT-6.1-Sol", "current"], ["gpt-6-astra", "GPT-6-Astra", "current"], ["gpt-6-sol", "GPT-6-Sol", "current"],
  ["gpt-6-luna", "GPT-6-Luna", "current"], ["gpt-5.6-sol", "GPT-5.6-Sol", "older"], ["gpt-5.6-terra", "GPT-5.6-Terra", "older"],
  ["gpt-5.6-luna", "GPT-5.6-Luna", "older"], ["gpt-5.5", "GPT-5.5", "older"],
] as const;
const row = (name: string, label: string, models: string[], extra: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry =>
  ({ name, label, status: "ready", isDefault: false, models, capabilities: ["coding-tasks"], requirements: [], fetchedAt: at, ...extra });

const SNAPSHOT: ProvidersSnapshot = {
  generatedAt: at,
  defaultProvider: "claude-code",
  providers: [
    row("claude-code", "Claude Code", CLAUDE_CODE_IDS, {
      isDefault: true,
      modelInfo: Object.fromEntries(CLAUDE_CODE_IDS.map((id) => [id, { generation: OLDER.has(id) ? "older" : "current" }])),
    }),
    row("codex", "Codex", CODEX.map(([id]) => id), {
      modelContextWindows: Object.fromEntries(CODEX.map(([id]) => [id, 272000])),
      modelInfo: Object.fromEntries(CODEX.map(([id, label, generation]) => [id, {
        label, generation, ...(id === "gpt-5.5" ? { retiresAt: "2026-10-14T19:00:00Z" } : {}),
      }])),
    }),
    row("gemini", "Gemini", ["gemini-3-pro", "gemini-3-flash"], { capabilities: ["streaming"] }),
    row("openclaw", "OpenClaw", ["llama-4-scout", "qwen-3-coder"], { capabilities: ["streaming"] }),
    row("topics", "Topics", ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"]),
  ],
};

async function mockSnapshot(page: Page) {
  await page.route("**/api/providers/snapshot", (route) => route.fulfill({ json: SNAPSHOT }));
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(typeof message === "string" && message.includes('"providers:snapshot"')
      ? JSON.stringify({ type: "providers:snapshot", snapshot: SNAPSHOT }) : message));
    socket.onMessage((message) => server.send(message));
  });
}

const shotsDir = process.env.MSEL_SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `impl-${name}.png`) });
}

let topicId = "";
let topicName = "";

test.beforeAll(async ({ request }) => {
  topicName = `Model selector ${Date.now()}`;
  topicId = (await createTopic(request, topicName)).id;
});
test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId);
});

async function openChat(page: Page, request: Parameters<typeof resetPaneStore>[0]) {
  await request.patch(`/api/topics/${topicId}`, { data: { provider: "claude-code", model: null, topicsRouting: null } });
  await resetPaneStore(request, [topicId]);
  await mockSnapshot(page);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(topicName));
  const picker = page.getByTestId("provider-model-picker");
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  return picker;
}

const panel = (page: Page) => page.getByTestId("model-selector-panel");
const modelRow = (page: Page, model: string) => panel(page).locator(`[data-testid="model-row"][data-model="${model}"]`);

test.describe("desktop, 1280 × 900", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Opus and GPT in one view, the search, the keyboard and the band", async ({ page, request }) => {
    const picker = await openChat(page, request);
    await picker.click();
    // MSEL-02: no intermediate level, every company side by side.
    await expect(panel(page)).toHaveAttribute("data-layout", "columns");
    await expect(modelRow(page, "claude-opus-5-5")).toBeVisible();
    await expect(modelRow(page, "gpt-6.1-sol")).toBeVisible();
    // MSEL-03: the search has the focus on desktop.
    const search = page.getByTestId("model-selector-search");
    await expect(search).toBeFocused();
    await search.fill("gpt");
    await expect(panel(page).getByTestId("model-section-openai")).toBeVisible();
    await expect(panel(page).getByTestId("model-section-anthropic")).toHaveCount(0);
    await search.fill("");
    await shot(page, "desktop-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "desktop-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape");
    // MSEL-08: Esc gives the focus back to the trigger.
    await expect(picker).toBeFocused();

    // ⌘⇧M from the composer opens; the arrows cross from Opus to GPT; Enter picks.
    await page.locator('[role="main"] textarea').first().click();
    await page.keyboard.press("ControlOrMeta+Shift+M");
    await expect(panel(page)).toBeVisible();
    await expect(search).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("model-row-automatic")).toBeFocused();
    // ↓ only, from Automatic to Opus and on to GPT-6.1-Sol across the sections.
    // The path is recorded, so a red says where the focus went instead.
    const path: string[] = [];
    const walkTo = async (model: string) => {
      const target = modelRow(page, model);
      for (let i = 0; i < 24 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press("ArrowDown");
        path.push(await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el ? `${el.dataset.testid ?? el.tagName}:${el.dataset.model ?? el.dataset.provider ?? ""}` : "none";
        }));
      }
      await expect(target, `focus path: ${path.join(" > ")}`).toBeFocused();
    };
    await walkTo("claude-opus-5-5");
    expect(path, "Opus is the first row after Automatic").toHaveLength(1);
    await walkTo("gpt-6.1-sol");
    const target = modelRow(page, "gpt-6.1-sol");
    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveCount(0);
    await expect(picker).toHaveAttribute("data-model", "gpt-6.1-sol");
    await expect(picker).toBeFocused();
    // MSEL-07: GPT goes direct, said in the band; the chip has no route mark.
    await expect(picker.getByTestId("model-route-mark")).toHaveCount(0);
    await picker.click();
    const band = page.getByTestId("model-selector-routing");
    await expect(band).toHaveAttribute("data-route", "direct");
    await expect(band).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("model-selector-routing-line")).toContainText("Codex");
    await expect(band).toBeEnabled();
    // Back to Opus: through Topics, and the chip shows the mark.
    // On the label: the middle of a narrow row is the 1M switch, a sibling.
    await modelRow(page, "claude-opus-5-5").click({ position: { x: 12, y: 10 } });
    await expect(picker.getByTestId("model-route-mark")).toBeVisible();
    await picker.click();
    await expect(band).toHaveAttribute("data-route", "topics");
    await page.keyboard.press("Escape");
  });

  // Revision 2026-10-04 §3.4: no catch-all; OpenClaw's llama and qwen are
  // Meta and Qwen, stacked in the fourth column after the three fixed ones.
  test("five companies in a 900px window: inside the viewport, columns scroll under fixed headings", async ({ page, request }) => {
    const picker = await openChat(page, request);
    await picker.click();
    const box = await panel(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    await expect(panel(page).getByTestId("model-section-other")).toHaveCount(0);
    for (const maker of ["anthropic", "openai", "google", "meta", "qwen"]) {
      const section = panel(page).getByTestId(`model-section-${maker}`);
      await expect(section).toHaveAttribute("data-maker", maker);
      await expect(section.getByTestId("model-section-heading")).toBeInViewport();
      await expect(section.getByTestId("model-row").first()).toBeInViewport();
    }
    // Open every fold: the Anthropic column grows past its height and scrolls by itself.
    for (const older of await panel(page).getByTestId("model-section-older").all()) await older.click();
    const anthropic = panel(page).getByTestId("model-section-anthropic");
    const column = panel(page).getByTestId("model-column").first();
    const scroll = await column.evaluate((el) => ({ overflowY: getComputedStyle(el).overflowY }));
    expect(["auto", "scroll"]).toContain(scroll.overflowY);
    const heading = anthropic.getByTestId("model-section-heading");
    await expect(heading).toHaveCSS("position", "sticky");
    // The band and the search do not move when a column scrolls.
    const searchBefore = await page.getByTestId("model-selector-search").boundingBox();
    await column.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await page.getByTestId("model-selector-search").boundingBox()).toEqual(searchBefore);
    await expect(heading).toBeInViewport();
    await page.keyboard.press("Escape");
  });

  test("/model op proposes the models of the current engine only, with the selector's labels", async ({ page, request }) => {
    await openChat(page, request);
    const field = page.locator('[role="main"] textarea').first();
    await field.click();
    await field.fill("/model op");
    const menu = page.locator('[role="main"] [role="listbox"]').filter({ hasText: "/model claude-opus-5-5" });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Opus 5.5");
    await expect(menu).toContainText("Opus 4.8");
    await expect(menu).not.toContainText("gpt-");
    await field.fill("");
  });

  test("the chat settings choose provider and model with the full variant", async ({ page, request }) => {
    await openChat(page, request);
    const tab = page.locator('[role="main"]').getByText(new RegExp(topicName)).first();
    await tab.dispatchEvent("contextmenu");
    await page.locator("button").filter({ hasText: /^(Impostazioni della chat|Chat settings)$/ }).click();
    const trigger = page.getByTestId("topic-settings-model");
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(panel(page)).toHaveAttribute("data-variant", "full");
    // MSEL-08: Escape inside the selector closes the selector only, and the
    // focus goes back to its trigger in the dialog that is still open.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(panel(page)).toHaveAttribute("data-scope", "chat");
    await modelRow(page, "gpt-6.1-sol").click();
    await expect(trigger).toContainText("GPT-6.1-Sol");
    await expect(page.getByRole("dialog").locator("select")).toHaveCount(0);
  });
});

test.describe("phone, 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a sheet from the bottom, 44px rows, no focus in the search, the line readable", async ({ page, request }) => {
    const picker = await openChat(page, request);
    await picker.click();
    await expect(panel(page)).toHaveAttribute("data-layout", "list");
    const sheet = page.getByTestId("provider-model-popover");
    const box = await sheet.boundingBox();
    expect(Math.round(box!.width)).toBe(390);
    expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(840);
    await expect(page.getByTestId("model-selector-search")).not.toBeFocused();
    await expect(page.getByTestId("model-selector-routing-line")).toBeInViewport();
    const height = await modelRow(page, "claude-opus-5-5").evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
    await shot(page, "phone-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "phone-dark");
    // Scrolling the list keeps the heading of the company in sight.
    const sections = panel(page).getByTestId("model-selector-sections");
    await sections.evaluate((el) => { el.scrollTop = 240; });
    await expect(panel(page).getByTestId("model-section-anthropic").getByTestId("model-section-heading")).toHaveCSS("position", "sticky");
  });
});
