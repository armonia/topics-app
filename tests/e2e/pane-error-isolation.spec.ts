import { test, expect } from "@playwright/test";
import { createTopic, deleteTopic, seedPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * UNA PANE CHE SI ROMPE NON PORTA GIÙ LE ALTRE.
 *
 * Il guasto. C'era UN SOLO ErrorBoundary, in App.tsx, attorno all'INTERA
 * griglia ("Panel error"). Qualunque errore di render dentro una pane
 * qualsiasi — il caso più comune è un chunk lazy che non esiste più dopo che
 * il bundle è stato ricostruito sotto una finestra aperta — sostituiva tutto
 * il pannello con la schermata di errore. Insieme alla pane rotta sparivano
 * quelle sane: terminali attaccati, chat in streaming, browser. Un pannello
 * secondario che non caricava si portava via la sessione di lavoro.
 *
 * Il taglio. Il boundary sta ora dentro `PaneKeepAlive`, il guscio da cui
 * passa OGNI pane di OGNI layout (GroupLayout ×2, StandaloneChatGroup): un
 * confine di guasto sullo stesso bordo del confine di layout che quel guscio
 * già stabiliva con `contain: layout`.
 *
 * Come si provoca il guasto senza codice di test in produzione: si blocca il
 * chunk della pane Dashboard, che è `lazy()`. È il guasto VERO, non una finta —
 * `import()` rifiuta, React rilancia in render, e il boundary più vicino
 * raccoglie.
 *
 * La prova NON è un conteggio di gusci montati: quanti ne restano lo decide il
 * tetto di residenza, che è un'altra cosa e ha la sua spec. La prova è che
 * dopo il guasto la barra delle tab — che sta dentro la griglia, cioè dentro
 * il vecchio boundary — è ancora lì, e che tornando sulla chat la chat
 * funziona. Prima non c'era nessuna tab su cui tornare.
 *
 * Video acceso: è un comportamento (una pane muore, l'altra continua a
 * funzionare), e uno screenshot non prova un comportamento.
 */
test.use({ video: "on" });

const LAZY_PANE = "__dashboard__";

test.describe("Isolamento dei guasti fra pane", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `pane-isolation-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    // Due tab nello stesso gruppo: la chat del topic e la Dashboard (lazy).
    // Si parte dalla CHAT attiva — una pane resta montata solo se è stata
    // visitata (tetto di residenza, vedi pane-residency-cap.spec.ts), quindi
    // il test deve percorrere la strada dell'utente: guardo la chat, apro il
    // Dashboard, quella si rompe, torno alla chat.
    await seedPaneStore(request, () => ({
      panes: {
        [topicId]: { id: topicId, type: "chat", title: topicName, topicId },
        [LAZY_PANE]: { id: LAZY_PANE, type: "dashboard", title: "Dashboard" },
      },
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: [topicId, LAZY_PANE],
          activePaneId: topicId,
          splitRatio: 1,
          splitAxis: "horizontal",
        },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await request
      .put(`${E2E_BASE}/api/ui-state/panels`, {
        data: { openPanels: [topicId, LAZY_PANE] },
        ignoreHTTPSErrors: true,
      })
      .catch(() => {});
  });

  test("il chunk della Dashboard non carica: la pane mostra l'errore, la chat accanto resta viva", async ({
    page,
    context,
  }) => {
    // Il guasto: il chunk della pane non c'è più. `abort()` fa rifiutare
    // l'`import()` esattamente come un 404 su un bundle ricostruito.
    //
    // `context.route`, NON `page.route`: il service worker intercetta ogni GET
    // di pari origine e la RI-EMETTE dal proprio contesto (`event.respondWith(
    // fetch(...))`, client/public/sw.js), e le fetch del SW non passano da
    // `page.route`. Misurato: il chunk viene chiesto DUE volte — una dalla
    // pagina, una dal worker — e con la sola rotta di pagina la seconda arriva
    // al server, il chunk carica e la pane non si rompe mai. Prima non si
    // vedeva perché il SW non si registrava affatto: `/boot.js` — l'unico posto
    // che lo registra — rispondeva 404 sul percorso web (vedi
    // server/static-assets.ts). Stessa ragione già scritta in
    // tool-call-rendering.spec.ts.
    await context.route("**/assets/DashboardPane-*.js", (route) => route.abort());

    await goToApp(page);

    // Si parte dalla chat, che carica normalmente.
    const input = page.locator('[data-testid="chat-message-input"]');
    await expect(input).toBeVisible({ timeout: 30_000 });

    // Si apre la Dashboard: il suo chunk non arriva, la pane muore in render.
    await page.locator(`[data-testid="pane-tab-${LAZY_PANE}"]`).click();

    // La pane rotta lo dice DENTRO il suo riquadro.
    const brokenShell = page.locator(`[data-pane-shell="${LAZY_PANE}"]`);
    await expect(
      brokenShell.getByRole("button", { name: /ricarica|try again/i }),
    ).toBeVisible({ timeout: 30_000 });

    // L'errore si è fermato al bordo della pane: la barra delle tab — che sta
    // dentro la griglia, cioè DENTRO il vecchio boundary — è ancora lì. Con il
    // boundary solo in App.tsx a questo punto non ci sarebbe più niente da
    // cliccare: tutta l'area sostituita dalla schermata di errore.
    await expect(page.locator('[data-testid="panel-tab-bar"]')).toBeVisible();
    await expect(page.locator(`[data-testid="pane-tab-${topicId}"]`)).toBeVisible();

    // E la prova che conta: si torna alla chat e FUNZIONA. Prima era
    // irraggiungibile — nessuna tab su cui tornare.
    await page.locator(`[data-testid="pane-tab-${topicId}"]`).click();
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.click();
    await input.fill("la pane accanto è morta, io no");
    await expect(input).toHaveValue("la pane accanto è morta, io no");

    // …e la pane rotta non ha lasciato la sua schermata di errore addosso a
    // quella sana: l'errore vive nel riquadro della Dashboard, non nella griglia.
    await expect(
      page.locator(`[data-pane-shell="${topicId}"]`).getByRole("button", { name: /ricarica|try again/i }),
    ).toHaveCount(0);
  });

  test("senza guasti nessuna pane mostra un errore (controprova)", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "PANE-01" });
    await goToApp(page);
    await expect(page.locator('[data-testid="chat-message-input"]')).toBeVisible({
      timeout: 30_000,
    });

    await page.locator(`[data-testid="pane-tab-${LAZY_PANE}"]`).click();
    await expect(page.locator(`[data-pane-shell="${LAZY_PANE}"]`)).toBeVisible({
      timeout: 30_000,
    });

    // Il boundary non deve inventarsi errori quando non ce ne sono: se questa
    // fallisse, l'asserzione dell'altro test non proverebbe niente.
    await expect(
      page.locator("[data-pane-shell]").getByRole("button", { name: /ricarica|try again/i }),
    ).toHaveCount(0);
  });
});
