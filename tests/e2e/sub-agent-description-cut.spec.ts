import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A sub-agent's description is printed ONCE: in the row when the row shows it
 * whole, in the open card's body when the row clips it. The rule is measured,
 * not guessed from the length: the row checks whether its summary is really
 * cut on screen (scrollWidth > clientWidth) and hands the outcome down.
 *
 * Two fixtures, each read at the widths where the outcome differs:
 *  - 90 characters: whole in the row at 1440 px (no body), cut at 900 px (the
 *    body carries the whole text);
 *  - 45 characters: cut at 390 px, so the body carries it.
 *
 * A rule that forces the body on, or off, fails one of these three cases.
 *
 * @covers CHAT-TOOL-14
 */

const DESCRIPTION_90 = "Controlla ogni file del modulo di pagamento e riporta le differenze trovate, riga per riga";
const DESCRIPTION_45 = "Riassumi il log della build: cosa è fallito e";

test.describe.serial("Descrizione del sotto-agente: il corpo solo se la riga la tronca", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Sub-agent cut " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
    expect(DESCRIPTION_90.length).toBe(90);
    expect(DESCRIPTION_45.length).toBe(45);
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /** One assistant turn that ran a sub-agent with this description. */
  async function seedSubAgent(
    request: APIRequestContext,
    id: string,
    description: string,
    permission = false,
  ) {
    const u = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: `task ${id}`,
      timestamp: new Date(Date.now() - 5000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u.id,
      content: "Fatto.",
      timestamp: new Date(Date.now() - 4000).toISOString(),
      toolCalls: [
        {
          id,
          name: "Task",
          args: { description, subagent_type: "Explore" },
          status: "success",
          detail: { type: "sub_agent", subAgentType: "Explore", description, actions: [], result: "ok" },
          startedAt: Date.now() - 4200,
          endedAt: Date.now() - 4100,
          ...(permission
            ? { permissionRequest: { id: `perm-${id}`, tool: "Task" }, permissionOutcome: { decision: "allow_once" } }
            : {}),
        },
      ],
      latencyMs: 3900,
      usagePromptTokens: 100,
      usageCompletionTokens: 50,
      costCents: 1,
    });
  }

  /** The open card's body for this row: the description the row did not show whole. */
  const bodyOf = (page: Page, id: string) =>
    page.locator(`[data-testid="tool-call-row-${id}"] [data-testid="sub-agent-description"]`);

  test("a 90-character description, whole in the row at 1440 px: no body", async ({ page, request }) => {
    const id = "tc-sub-90-wide";
    await seedSubAgent(request, id, DESCRIPTION_90);
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const row = page.locator(`[data-testid="tool-call-row-${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Controlla ogni file");
    // The row shows it whole, so the card does not print it a second time.
    await expect(bodyOf(page, id)).toHaveCount(0);
  });

  test("the same 90-character description, cut in the row at 900 px: the body carries it whole", async ({ page, request }) => {
    const id = "tc-sub-90-narrow";
    await seedSubAgent(request, id, DESCRIPTION_90);
    await page.setViewportSize({ width: 900, height: 900 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const row = page.locator(`[data-testid="tool-call-row-${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const body = bodyOf(page, id);
    await expect(body).toHaveCount(1);
    await expect(body).toHaveText(DESCRIPTION_90);
    // The clipped summary keeps the full text on the tooltip, as before.
    await expect(row.locator('[title="' + DESCRIPTION_90 + '"]')).toHaveCount(1);
  });

  test("a 45-character description, cut in the row at 390 px: the body carries it whole", async ({ page, request }) => {
    const id = "tc-sub-45-phone";
    await seedSubAgent(request, id, DESCRIPTION_45);
    await page.setViewportSize({ width: 390, height: 844 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const row = page.locator(`[data-testid="tool-call-row-${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const body = bodyOf(page, id);
    await expect(body).toHaveCount(1);
    await expect(body).toHaveText(DESCRIPTION_45);
  });

  test("the row never lays out without the body while the description is cut (ResizeObserver, 900 px)", async ({ page, request }) => {
    const id = "tc-sub-90-observer";
    await seedSubAgent(request, id, DESCRIPTION_90);
    // Record, at every resize callback, whether the body is in the row.
    await page.addInitScript(() => {
      const seen: boolean[] = [];
      (window as unknown as { __subAgentSeen: boolean[] }).__subAgentSeen = seen;
      const Native = window.ResizeObserver;
      window.ResizeObserver = class extends Native {
        constructor(cb: ResizeObserverCallback) {
          super((entries, obs) => {
            const row = document.querySelector('[data-testid="tool-call-row-tc-sub-90-observer"]');
            if (row) seen.push(!!row.querySelector('[data-testid="sub-agent-description"]'));
            cb(entries, obs);
          });
        }
      };
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await expect(bodyOf(page, id)).toHaveCount(1, { timeout: 15_000 });
    const seen = await page.evaluate(() => (window as unknown as { __subAgentSeen: boolean[] }).__subAgentSeen);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  test("a Task with a permission and a cut row carries the whole text in the body (900 px)", async ({ page, request }) => {
    const id = "tc-sub-90-permission";
    await seedSubAgent(request, id, DESCRIPTION_90, true);
    await page.setViewportSize({ width: 900, height: 900 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const body = bodyOf(page, id);
    await expect(body).toHaveCount(1, { timeout: 15_000 });
    await expect(body).toHaveText(DESCRIPTION_90);
  });

  test("resize 1440 -> 900 -> 1440: the body appears and goes away with the cut", async ({ page, request }) => {
    const id = "tc-sub-90-resize";
    await seedSubAgent(request, id, DESCRIPTION_90);
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const row = page.locator(`[data-testid="tool-call-row-${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(bodyOf(page, id)).toHaveCount(0);
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(bodyOf(page, id)).toHaveCount(1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(bodyOf(page, id)).toHaveCount(0);
  });

  test("back from another topic the row keeps its height, and the description stays at a hidden pane", async ({ page, request }) => {
    const id = "tc-sub-90-return";
    await seedSubAgent(request, id, DESCRIPTION_90);
    const other = await createTopic(request, "Sub-agent other " + Date.now());
    await page.setViewportSize({ width: 900, height: 900 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const row = page.locator(`[data-testid="tool-call-row-${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(bodyOf(page, id)).toHaveCount(1);
    const before = (await row.boundingBox())?.height ?? -1;
    await openTopic(page, new RegExp(other.name));
    await openTopic(page, new RegExp(topicName));
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(bodyOf(page, id)).toHaveCount(1);
    const after = (await row.boundingBox())?.height ?? -2;
    expect(after).toBe(before);
    await deleteTopic(request, other.id);
  });
});
