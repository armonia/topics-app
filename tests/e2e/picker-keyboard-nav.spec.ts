import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";

/**
 * Slice 6 verification — picker keyboard nav.
 *
 * The picker must be navigable with the keyboard alone:
 *   ↓/↑ move the highlight, Enter selects, Esc closes.
 * The highlight is exposed via the `data-active="true"` attribute on the
 * focused model row.
 */
test.describe.serial("Provider/Model picker keyboard navigation", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Picker KB " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    // Reset to a clean state — no override.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: null, model: null },
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Idem provider-picker.spec.ts: il picker è per-pane, quindi le pane lasciate
  // aperte dai file precedenti rendono ambiguo `getByTestId`. Reset al solo
  // topic di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("ArrowDown/Enter selects the second row", async ({ page, request }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();

    // Need at least 2 enabled model rows to test ArrowDown selection.
    const popover = page.locator('[data-popover="provider-model-picker"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    const enabledRows = popover.locator('button:not([disabled])[data-row-index]');
    const enabledCount = await enabledRows.count();
    if (enabledCount < 2) {
      test.skip(true, `Need ≥ 2 ready models in env; got ${enabledCount}`);
    }

    // First row gets highlighted on open.
    const firstActive = page.locator('[data-popover="provider-model-picker"] [data-active="true"]');
    await firstActive.waitFor({ state: "visible", timeout: 5_000 });
    const firstActiveModel = (await firstActive.textContent())?.trim() ?? "";

    // Pressing ArrowDown should move the highlight to the second model.
    await page.keyboard.press("ArrowDown");
    const secondActive = page.locator('[data-popover="provider-model-picker"] [data-active="true"]');
    await expect(secondActive).toBeVisible();
    const secondActiveModel = (await secondActive.textContent())?.trim() ?? "";
    expect(secondActiveModel).not.toBe("");
    expect(secondActiveModel).not.toBe(firstActiveModel);

    // Enter selects the highlighted row → picker closes and topic is patched.
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-popover="provider-model-picker"]')).toHaveCount(0, { timeout: 5_000 });

    // The picker button now reflects the model the keyboard chose.
    await expect(picker).toContainText(secondActiveModel, { timeout: 5_000 });

    // Server-side persistence — the topic record carries the same model.
    const all = await request.get("/api/topics");
    const data = await all.json();
    expect(data.topics[topicId].model).toBe(secondActiveModel);
  });

  test("Escape closes the popover without changing the topic", async ({ page, request }) => {
    // Reset.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: null, model: null },
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();

    await expect(page.locator('[data-popover="provider-model-picker"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-popover="provider-model-picker"]')).toHaveCount(0, { timeout: 5_000 });

    // Topic untouched — the server response omits the field when it's null.
    const all = await request.get("/api/topics");
    const data = await all.json();
    expect(data.topics[topicId].model ?? null).toBeNull();
  });

  test("CHAT-EFFORT-01: effort-tier badge visible in group row and collapsed button", async ({ page, request }) => {
    // Clean override so the collapsed button reflects the effective provider.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: null, model: null },
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();
    const popover = page.locator('[data-popover="provider-model-picker"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });

    // The isolated test server has no effort env overrides, so claude-code
    // resolves to the default tier "xhigh". If claude-code isn't ready in
    // this env there is no group row to assert on — skip like the nav test.
    const claudeBadge = popover.getByTestId("effort-tier-claude-code");
    if ((await claudeBadge.count()) === 0) {
      test.skip(true, "claude-code not ready in this env — no tier row to assert");
    }
    await expect(claudeBadge).toHaveText("xhigh");
    // The badge must coexist with (not replace) the Default pill on the row.
    await expect(popover.getByText("Default", { exact: true })).toBeVisible();

    // Collapsed button: claude-code is the only ready provider in the test
    // env, so the effective selection lands there and the badge shows too.
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0, { timeout: 5_000 });
    await expect(picker.getByTestId("effort-tier-badge")).toHaveText("xhigh");
  });
});
