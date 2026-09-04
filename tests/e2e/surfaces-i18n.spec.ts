/**
 * surfaces-i18n.spec.ts - the three surfaces where the language selector used
 * to do nothing, read in the language the person chose.
 *
 * WHY THIS EXISTS AND WHY THE OTHER SPECS DO NOT COVER IT. Every other spec in
 * this suite runs in Italian (`playwright.config.ts` pins `locale: "it-IT"`),
 * so an Italian string hard-coded into a component does not make anything fall
 * over: it stays Italian in an English app, and the person who finds out is a
 * user. `scripts/check-ui-language.ts` reads the SOURCE and can say that a
 * literal is not going through i18n; only a run in English can say that the
 * key actually resolves and reaches the screen.
 *
 * The three chosen are not a sample. They are the ones where reading the wrong
 * language costs something:
 *  - the PERMISSION panel decides whether an agent may touch files;
 *  - the browser pane CONTEXT MENU is nine entries that were Italian even with
 *    the interface in English;
 *  - the DESTRUCTIVE DIALOGS shipped an English "Cancel" next to an Italian
 *    "Sposta nel cestino", which is the mixed language showing up exactly
 *    where somebody is about to lose something.
 *
 * The last one is checked with the locale in ITALIAN, deliberately: its defect
 * was English leaking into the Italian UI, which is the mirror image of the
 * other two.
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { PERMISSION_LABEL_KEY } from "../../shared/permission-decision";
import EN from "../../client/src/lib/i18n-en";
import IT from "../../client/src/lib/i18n-it";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const TOOL = "mcp__gateway__kiwi__search-flight";
const TOOL_INPUT = { flyFrom: "NAP", flyTo: "RAK" };

/**
 * The language lives in TWO stores and both have to be written: localStorage
 * paints the first frame, `ui_state` hydrates right after. Writing one only
 * shows the right language and then watching it flip back.
 */
async function useLanguage(page: Page, language: "it" | "en"): Promise<void> {
  await page.request.put(`${API}/ui-state/settings`, { data: { language } });
  await page.addInitScript((lang: string) => {
    const KEY = "app-settings";
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>; } catch { /* empty */ }
    localStorage.setItem(KEY, JSON.stringify({ ...cur, language: lang }));
  }, language);
}

test.describe.serial("le superfici seguono la lingua scelta", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `i18n-surfaces-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    // The language is a USER preference shared by the whole suite through
    // `ui_state`: left in English it would turn every Italian spec that runs
    // after this one red.
    await request.put(`${API}/ui-state/settings`, { data: { language: "auto" } });
  });

  test("I18N-SURF-01: in inglese il pannello dei permessi dice Allow, non Consenti", async ({ page, chatPage, request }) => {

    test.info().annotations.push({ type: "spec", description: "I18N-04" });
    const toolCallId = "toolu_i18n_allow";
    const tc = {
      id: toolCallId,
      name: TOOL,
      args: TOOL_INPUT,
      status: "awaiting_permission" as const,
      startedAt: Date.now() - 3_000,
      permissionRequest: { toolName: TOOL, input: TOOL_INPUT, requestedAt: Date.now() - 3_000 },
    };
    await seedMessage(request, { sessionKey, role: "user", content: "cerca un volo" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "Cerco i voli:", toolCalls: [tc] });

    await useLanguage(page, "en");
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const panel = page.locator(`[data-testid="tool-permission-${toolCallId}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // The words come from the catalogue, so the assertion reads the catalogue:
    // asserting the literal "Allow" here would pass on a panel that hard-codes
    // English, which is the state this whole change came out of.
    for (const key of Object.values(PERMISSION_LABEL_KEY)) {
      const english = (EN as Record<string, string>)[key]!;
      await expect(panel.getByRole("button", { name: english, exact: true })).toBeVisible();
    }
    await expect(panel.getByText(EN["permission.asks"]!)).toBeVisible();
    // And the Italian is GONE, not merely joined: a panel showing both would
    // pass every assertion above.
    await expect(panel.getByText(IT["permission.decision.allow.label"]!, { exact: true })).toHaveCount(0);
  });

  test("I18N-SURF-02: in italiano un dialogo distruttivo non dice Cancel ne Discard", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "I18N-04" });
    // The dialog reached here is the unsaved-changes one on the topic settings
    // modal: it is the cheapest REAL `ConfirmDialog` in the app, and it is the
    // one that exercises the defect at its root, because it omits
    // `cancelLabel` and therefore takes the DEFAULT the component ships. That
    // default was the hard-coded English "Cancel", which is how an English
    // word ended up under an Italian question about losing work.
    await useLanguage(page, "it");
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const tab = page.getByRole("tab", { name: new RegExp(topicName) }).first();
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await tab.dispatchEvent("contextmenu");
    const settings = page.locator("button").filter({ hasText: /^Impostazioni$/ });
    await expect(settings).toBeVisible({ timeout: 5_000 });
    await settings.click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    // Dirty it, so closing has something to lose and the confirmation fires.
    const prompt = page.getByLabel("System prompt");
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    await prompt.fill(`sporco ${Date.now()}`);
    await page.keyboard.press("Escape");

    const confirmDialog = page.getByRole("dialog").filter({ hasText: IT["topic.unsaved.title"]! });
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    const words = (await confirmDialog.innerText()).toLowerCase();
    expect(words, "un dialogo distruttivo in italiano non dice Cancel").not.toContain("cancel");
    expect(words, "ne Discard").not.toContain("discard");
    expect(words, "ne Confirm").not.toContain("confirm");
    // And the Italian words ARE there: absence of English is not presence of
    // Italian, and an empty dialog would pass all three lines above.
    await expect(confirmDialog.getByRole("button", { name: IT["common.cancel"]!, exact: true })).toBeVisible();
    await expect(confirmDialog.getByRole("button", { name: IT["topic.unsaved.confirm"]!, exact: true })).toBeVisible();
  });
});
