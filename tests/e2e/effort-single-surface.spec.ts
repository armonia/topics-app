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
    // Anche provider/model: il file è `serial`, e il test sul badge 1M lascia una
    // scelta di modello sulla topic. Ripulire in coda al test non basta — se
    // quello fallisce a metà, l'avanzo avvelenerebbe i successivi.
    await patchTopic(request, topicId, { effort: null, provider: null, model: null });
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

    // …e finisce sul server, non solo nel DOM. Non esiste una GET per la
    // singola topic (solo la PATCH): la verità sta nell'elenco.
    await expect
      .poll(async () => {
        const res = await request.get(`/api/topics`);
        if (!res.ok()) return undefined;
        const data = (await res.json()) as { topics?: Record<string, { effort?: string | null }> };
        return data.topics?.[topicId]?.effort;
      }, { timeout: 10_000 })
      .toBe("low");
  });

  test("l'effort si VEDE sul controllo che lo cambia", async ({ page }) => {
    // Il difetto segnalato: «un tasto per l'effort che cambia la label dall'altra
    // select». L'override finiva scritto nel bottone del MODELLO — che apre la
    // lista dei modelli — mentre a cambiarlo era il pannello di sessione, che non
    // ne portava traccia. Ora il valore sta sul trigger che lo governa.
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const trigger = page.getByTestId("chat-session-config");
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    // Senza override non c'è niente da mostrare: il badge dice "questa chat ha
    // una scelta sua", non "esiste un effort".
    await expect(trigger.getByTestId("session-effort-badge")).toHaveCount(0);

    await trigger.click();
    const slider = page.getByTestId("chat-session-config-panel").getByTestId("session-effort-slider");
    await slider.fill("0");
    await page.keyboard.press("Escape");

    await expect(trigger.getByTestId("session-effort-badge")).toHaveText("low", { timeout: 5_000 });
  });

  test("cambiare effort non sposta di un pixel la barra del composer", async ({ page }) => {
    // Il layout shift segnalato. Le sigle dei tier hanno lunghezze diverse (LOW 3,
    // MEDIUM 6, XHIGH 5): a larghezza libera ogni cambio allargava o stringeva il
    // bottone e trascinava con sé quello che gli sta intorno. Qui si MISURA, non
    // si guarda: stessa scatola prima e dopo.
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const trigger = page.getByTestId("chat-session-config");
    const picker = page.getByTestId("provider-model-picker");
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    await picker.waitFor({ state: "visible", timeout: 10_000 });

    await trigger.click();
    const slider = page.getByTestId("chat-session-config-panel").getByTestId("session-effort-slider");
    await slider.fill("0");
    await expect(slider).toHaveAttribute("data-effort-tier", "low");
    await page.keyboard.press("Escape");
    await expect(trigger.getByTestId("session-effort-badge")).toHaveText("low", { timeout: 5_000 });

    const boxLow = await trigger.boundingBox();
    const pickerLow = await picker.boundingBox();
    if (!boxLow || !pickerLow) throw new Error("composer non misurabile");

    // `medium` è la sigla più lunga della scala: se una larghezza fissa non ci
    // fosse, il salto si vedrebbe proprio qui.
    await trigger.click();
    await slider.fill("1");
    await expect(slider).toHaveAttribute("data-effort-tier", "medium");
    await page.keyboard.press("Escape");
    await expect(trigger.getByTestId("session-effort-badge")).toHaveText("medium", { timeout: 5_000 });

    const boxMedium = await trigger.boundingBox();
    const pickerMedium = await picker.boundingBox();
    if (!boxMedium || !pickerMedium) throw new Error("composer non misurabile");

    expect(boxMedium.width).toBeCloseTo(boxLow.width, 1);
    expect(boxMedium.x).toBeCloseTo(boxLow.x, 1);
    // Il picker sta a SINISTRA del trigger: se il badge del tier del provider
    // sparisse quando arriva un override, si stringerebbe lui e il trigger
    // scivolerebbe — lo stesso shift, dall'altro lato.
    expect(pickerMedium.width).toBeCloseTo(pickerLow.width, 1);
  });

  test("una finestra da 1M si legge in un badge, non in un suffisso tagliato", async ({ page, request }) => {
    // `claude-opus-5[1m]` finiva dentro uno span `truncate` accanto al nome: su
    // una pane stretta veniva tagliato via proprio il suffisso, cioè l'unica cosa
    // che distingue 200k da 1M. Ora la modalità è un badge a sé.
    await patchTopic(request, topicId, { provider: "claude-code", model: "claude-opus-5[1m]" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    // L'identità resta l'id ESATTO della CLI, suffisso compreso: è quello che
    // viene mandato al provider, e non deve essere ricostruito dall'etichetta.
    await expect(picker).toHaveAttribute("data-model", "claude-opus-5[1m]", { timeout: 10_000 });
    await expect(picker.getByTestId("model-longcontext-badge")).toHaveText("1M");
    // …e il nome accanto non porta più le parentesi.
    await expect(picker).not.toContainText("[1m]");
  });
});
