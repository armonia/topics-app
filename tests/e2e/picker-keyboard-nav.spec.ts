import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import type { ProvidersSnapshot } from "../../shared/types";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Slice 6 verification: picker keyboard nav.
 *
 * The picker must be navigable with the keyboard alone. Since the shared
 * execution-first selector (task 05807e8e, MP-TASK-07) it has two levels:
 * the first lists Automatic and the execution engines, Enter on an engine
 * replaces the panel with that engine's models, and Enter on a model selects
 * it. ↓/↑ move the real DOM focus between rows (the roving focus of the shared
 * `Menu`), so the highlight is `document.activeElement`, not an attribute.
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
    test.info().annotations.push({ type: "spec", description: "CHAT-DEF-03" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();

    const popover = page.getByTestId("provider-model-popover");
    await popover.waitFor({ state: "visible", timeout: 5_000 });

    // Focus has to STAY in the popover. This was the real fault behind this
    // test's "flaky" reputation: when the pane became active it gave the focus
    // to the composer 50 ms later, taking it back from the picker's freshly
    // focused search field of the time (measured: field at 25 ms, textarea at
    // 29 ms). The arrows then landed in the textarea and keyboard navigation
    // did nothing. The shared `Menu` focuses its panel once it is placed, so
    // the panel is what must hold the focus here. Asserting it fails the
    // cause, not the symptom.
    await expect(popover).toBeFocused();

    // First level: the first ArrowDown lands on the first row (Automatic).
    // Had the composer stolen the focus, the key would have gone there.
    await page.keyboard.press("ArrowDown");
    await expect(popover.locator("[data-ai-selector-auto]")).toBeFocused();

    // Walk down to the engine the isolated test server makes ready (its
    // `claude` stub, scripts/start-test-server.sh). The list also shows the
    // unavailable engines, in the server's order, so the number of steps is
    // read from the rendered rows instead of being hard-coded.
    const runtime = popover.locator('button[data-provider="claude-code"]');
    await expect(runtime).toBeVisible();
    const runtimeIndex = await popover
      .locator("button:not([disabled])")
      .evaluateAll((rows) => rows.findIndex((row) => row.getAttribute("data-provider") === "claude-code"));
    for (let step = 0; step < runtimeIndex; step++) await page.keyboard.press("ArrowDown");
    await expect(runtime).toBeFocused();

    // Enter opens the engine: the panel is replaced and the focus moves to the
    // back row of the new level, so the arrows keep working after the swap.
    await page.keyboard.press("Enter");
    await expect(popover.getByTestId("ai-selector-back")).toBeFocused();

    // Need at least 2 enabled model rows to test ArrowDown selection.
    const enabledRows = popover.locator("button:not([disabled])[data-model]");
    const enabledCount = await enabledRows.count();
    if (enabledCount < 2) {
      test.skip(true, `Need ≥ 2 ready claude-code models in env; got ${enabledCount}`);
    }

    // The model identity is read from `data-model`, never from the row text:
    // the button shows a label meant for the eyes (the `[1m]` mode split into
    // a badge) while the row carries the raw CLI id.
    const firstModel = await enabledRows.nth(0).getAttribute("data-model");

    // Back row, then first model, then second model.
    await page.keyboard.press("ArrowDown");
    await expect(enabledRows.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const secondRow = enabledRows.nth(1);
    await expect(secondRow).toBeFocused();
    const secondActiveModel = await secondRow.getAttribute("data-model");
    expect(secondActiveModel).toBeTruthy();
    expect(secondActiveModel).not.toBe(firstModel);

    // Enter selects the focused row: picker closes and topic is patched.
    await page.keyboard.press("Enter");
    await expect(popover).toHaveCount(0, { timeout: 5_000 });

    // The picker button now reflects the model the keyboard chose.
    await expect(picker).toHaveAttribute("data-model", secondActiveModel!, { timeout: 5_000 });

    // Server-side persistence: the topic record carries the same engine and model.
    const all = await request.get("/api/topics");
    const data = await all.json();
    expect(data.topics[topicId].provider).toBe("claude-code");
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

    const popover = page.getByTestId("provider-model-popover");
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0, { timeout: 5_000 });

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
    const popover = page.getByTestId("provider-model-popover");
    await popover.waitFor({ state: "visible", timeout: 5_000 });

    // With claude-code not ready there is nothing to assert, so the test skips
    // like the navigation one. Readiness is read from the snapshot the picker
    // renders: since the execution-first selector (task 05807e8e) the popover
    // lists unavailable engines too, so a visible "Claude Code" row no longer
    // means the engine is ready.
    const snapshot = (await (await request.get("/api/providers/snapshot")).json()) as ProvidersSnapshot;
    const claudeCode = snapshot.providers.find((entry) => entry.name === "claude-code");
    if (claudeCode?.status !== "ready") {
      test.skip(true, "claude-code not ready in this environment");
    }
    // Niente effort nel picker: né sulla riga del gruppo…
    await expect(popover.getByTestId("effort-tier-claude-code")).toHaveCount(0);
    // ...but the picker still says which provider is the default: that was a
    // different fact and it did not leave together with the tier badge. Task
    // 05807e8e moved it from a "Default" pill on the provider group to the hint
    // of the Automatic row, which is where the shared selector keeps it.
    await expect(popover.locator("[data-ai-selector-auto]")).toHaveAttribute(
      "title",
      `Default: ${claudeCode?.label ?? "claude-code"}`,
    );

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
    const expectedDefault = (process.env.TOPICS_CLAUDE_EFFORT || process.env.CLAUDE_EFFORT || "xhigh")
      .trim()
      .toLowerCase();
    const badge = page.getByTestId("chat-session-config").getByTestId("session-effort-badge");
    await expect(badge).toHaveText(expectedDefault, { timeout: 5_000 });
    await expect(badge).toHaveAttribute("data-effort-source", "default");
  });
});
