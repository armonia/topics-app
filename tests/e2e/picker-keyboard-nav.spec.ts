import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Slice 6 verification — picker keyboard nav.
 *
 * The picker must be navigable with the keyboard alone:
 *   ↓/↑ move the highlight, Enter selects, Esc closes.
 * The highlight is exposed via the `data-active="true"` attribute on the
 * focused model row.
 *
 * @covers CHAT-DEF-03
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

    // Il fuoco deve RESTARE nel popover. Era qui il guasto vero dietro la fama di
    // "flaky" di questo test: la pane, quando diventa attiva, dava il fuoco al
    // composer 50 ms dopo — e se lo riprendeva da sotto al campo di ricerca appena
    // autofocussato (misurato: input a 25 ms, textarea a 29 ms). Le frecce
    // finivano nella textarea e la navigazione da tastiera non funzionava.
    // Asserirlo qui fa fallire la causa, non il sintomo.
    await expect(popover.locator("input")).toBeFocused();

    // First row gets highlighted on open.
    const firstActive = page.locator('[data-popover="provider-model-picker"] [data-active="true"]');
    await firstActive.waitFor({ state: "visible", timeout: 5_000 });
    // L'identita' del modello si legge da `data-model`, non dal testo della riga.
    // Prima si confrontava il testo della riga col testo del bottone, e reggeva
    // solo perche' i due COINCIDEVANO per caso: il bottone mostra un'etichetta
    // per gli occhi (la modalita' `[1m]` staccata in un badge), la riga l'id
    // grezzo della CLI. Al primo cambio di come si SCRIVE il modello il test
    // diventava rosso senza che nulla si fosse rotto.
    const firstActiveModel = await firstActive.getAttribute("data-model");

    // Pressing ArrowDown should move the highlight to the second model.
    await page.keyboard.press("ArrowDown");
    const secondActive = page.locator('[data-popover="provider-model-picker"] [data-active="true"]');
    await expect(secondActive).toBeVisible();
    const secondActiveModel = await secondActive.getAttribute("data-model");
    expect(secondActiveModel).toBeTruthy();
    expect(secondActiveModel).not.toBe(firstActiveModel);

    // Enter selects the highlighted row → picker closes and topic is patched.
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-popover="provider-model-picker"]')).toHaveCount(0, { timeout: 5_000 });

    // The picker button now reflects the model the keyboard chose.
    await expect(picker).toHaveAttribute("data-model", secondActiveModel!, { timeout: 5_000 });

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

  test("CHAT-EFFORT-01: il tier del provider si legge sul controllo dell'effort, non nel picker", async ({ page, request }) => {
    // Questo test guardava il contrario: il tier del provider stampato DENTRO il
    // picker del modello, sulla riga del gruppo e sul bottone chiuso. Era l'unico
    // posto dove si vedeva, mentre a cambiarlo era un altro controllo che non lo
    // mostrava. Ora l'effort — default del provider oppure override della chat —
    // sta sul trigger che lo governa, e il picker parla solo di modelli.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: null, model: null, effort: null },
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();
    const popover = page.locator('[data-popover="provider-model-picker"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });

    // Se claude-code non è pronto in questo ambiente non c'è niente da asserire
    // — si salta, come fa il test di navigazione.
    if ((await popover.getByText("Claude Code", { exact: true }).count()) === 0) {
      test.skip(true, "claude-code non pronto in questo ambiente");
    }
    // Niente effort nel picker: né sulla riga del gruppo…
    await expect(popover.getByTestId("effort-tier-claude-code")).toHaveCount(0);
    // …ma la pill "Default" sulla stessa riga resta: diceva un'altra cosa (quale
    // provider è il default) e non se n'è andata insieme al badge.
    await expect(popover.getByText("Default", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0, { timeout: 5_000 });
    // …né sul bottone chiuso.
    await expect(picker.getByTestId("effort-tier-badge")).toHaveCount(0);

    // Il valore non è sparito: è sul trigger dell'effort, marcato come default
    // del provider perché questa chat non ha scelto niente.
    //
    // L'attesa NON è la costante "xhigh". `resolveClaudeEffort` risolve
    // `TOPICS_CLAUDE_EFFORT` → `CLAUDE_EFFORT` → "xhigh", e il server di prova
    // eredita l'ambiente di CHI LANCIA la suite: da una shell che esporta
    // `CLAUDE_EFFORT=high` — quella di un agente dentro Topics, per dirne una —
    // il default del provider È "high", e il codice sta funzionando. Il test
    // cadeva su questo il 04/08 (`Expected "xhigh", Received "high"`), anche da
    // solo: asseriva un ambiente invece del comportamento.
    //
    // Quello che il test vuole davvero sapere è che il badge mostri il DEFAULT
    // DEL PROVIDER, qualunque sia, e che lo dichiari come tale. Quindi si
    // ricalcola la stessa catena.
    const defaultAtteso = (process.env.TOPICS_CLAUDE_EFFORT || process.env.CLAUDE_EFFORT || "xhigh")
      .trim()
      .toLowerCase();
    const badge = page.getByTestId("chat-session-config").getByTestId("session-effort-badge");
    await expect(badge).toHaveText(defaultAtteso, { timeout: 5_000 });
    await expect(badge).toHaveAttribute("data-effort-source", "default");
  });
});
