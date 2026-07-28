import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * PIANO §1b.1 + §1b.2 — l'effort si cambia in UN posto solo, ed è uno slider.
 *
 * 1b.1: viveva in due superfici — il popover del modello e il
 *       SessionConfigPopover — con due grafiche e due idee di "default".
 *       Nel picker resta il badge, di sola lettura.
 * 1b.2: cinque pill non dicono che `max` viene dopo `xhigh`. La scala è
 *       ordinata: si guida con uno slider.
 */
test.describe.serial("Effort — una sola superficie, uno slider", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Effort UI " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await patchTopic(request, topicId, { effort: null });
    await resetPaneStore(request, [topicId]);
  });

  test("il picker del modello non offre più i bottoni dell'effort", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();
    const popover = page.locator('[data-popover="provider-model-picker"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });

    // Nessuno dei cinque bottoni di prima, e nessuna label "Effort" dentro il
    // popover del modello: quel pannello parla di provider e modelli.
    for (const tier of ["low", "medium", "high", "xhigh", "max"]) {
      await expect(popover.getByTestId(`effort-opt-${tier}`)).toHaveCount(0);
    }
    await expect(popover.getByRole("group", { name: "Reasoning effort tier" })).toHaveCount(0);
  });

  test("lo slider nel pannello di sessione scrive l'override sulla topic", async ({ page, request }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    await page.getByTestId("chat-session-config").click();
    const panel = page.getByTestId("chat-session-config-panel");
    await panel.waitFor({ state: "visible", timeout: 5_000 });

    const slider = panel.getByTestId("session-effort-slider");
    await expect(slider).toBeVisible();
    // Nessun override ancora: il pollice sta sul default, non su un valore
    // scelto dall'umano.
    await expect(slider).not.toHaveAttribute("data-effort-overridden", "true");

    // `low` è il primo tier della scala: qualunque sia il default del provider
    // in questo ambiente, portarcisi sopra è un override esplicito.
    await slider.fill("0");
    await expect(slider).toHaveAttribute("data-effort-tier", "low");
    await expect(slider).toHaveAttribute("data-effort-overridden", "true");

    // …e finisce sul server, non solo nel DOM.
    await expect
      .poll(async () => {
        const res = await request.get(`/api/topics/${topicId}`);
        return res.ok() ? ((await res.json()) as { effort?: string | null }).effort : undefined;
      }, { timeout: 10_000 })
      .toBe("low");
  });
});
