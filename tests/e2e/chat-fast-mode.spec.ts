import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// openspec change: chat-fast-mode
//
// Verifies the composer's Fast Mode toggle (⚡), positioned between Plan mode
// and the Context ring in the left tool cluster. We assert:
//   1. The toggle is rendered with data-testid="chat-input-fast-mode".
//   2. Clicking it flips `aria-pressed` and the amber visual.
//   3. The next /api/chat POST carries `fastMode: true` in its body.
//   4. PUT /api/topics/:id fires with `{ fastMode: true }` so the toggle
//      survives refresh + cross-window.
//   5. Fast and Plan are not mutually exclusive — both can be ON at once.
//
// Video output lands in test-results/artifacts/chat-fast-mode-*.

/**
 * Che cosa la CLI dichiara sulla fast mode — deciso QUI, non ereditato.
 *
 * Il ⚡ esiste solo se lo snapshot dei provider NON porta un `reason`
 * (`client/src/lib/fastMode.ts`: un comando che non si può usare non occupa una
 * riga). E quel campo è stato del PROCESSO server, non del database: lo scrive
 * `observeFastMode` alla prima riga che una `claude` vera stampa, e ci resta
 * finché il server non muore. Basta un `POST /api/chat` in una spec qualunque
 * — anche uno che finisce in «Not logged in», misurato — perché da lì in avanti
 * lo snapshot dica `sdk_opt_in_required` e il bottone sparisca per tutti i file
 * che seguono su quel server. `POST /api/test/reset` non lo tocca: ripristina
 * il DB, e questo in DB non c'è.
 *
 * È esattamente com'è andata: verde da solo, rosso nello shard 2 dopo le spec
 * della chat che una sessione vera la lanciano. Il bottone non era rotto — la
 * sua PREMESSA era implicita. Quindi ogni test di questo file la dichiara, sui
 * due canali insieme: lo store è last-write-wins e il frame WS, che arriva dopo
 * la GET, ribalterebbe il mock.
 */
async function dichiaraFastMode(
  page: Page,
  fastMode: { state: string; reason: string | null; costMultiplier: number },
): Promise<void> {
  const snapshot = {
    providers: [{
      name: "claude-code",
      label: "Claude Code",
      status: "ready",
      isDefault: true,
      models: [] as unknown[],
      requirements: [] as unknown[],
      fastMode,
      fetchedAt: "2026-08-07T00:00:00Z",
    }],
    defaultProvider: "claude-code",
    generatedAt: "2026-08-07T00:00:00Z",
  };
  await page.route("**/api/providers/snapshot", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((msg) => {
      const text = typeof msg === "string" ? msg : "";
      if (text.includes('"providers:snapshot"')) {
        ws.send(JSON.stringify({ type: "providers:snapshot", snapshot }));
        return;
      }
      ws.send(msg);
    });
    ws.onMessage((msg) => server.send(msg));
  });
}

/** La fast mode è servibile: nessun motivo la blocca. */
const FAST_SERVIBILE = { state: "off", reason: null, costMultiplier: 2 } as const;

test.describe.serial("Chat — Fast Mode toggle", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Fast Mode E2E " + Date.now();
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) {
      await deleteTopic(request, topicId);
    }
  });

  // Il toggle ⚡ è per-composer: con le pane dei file precedenti ancora aperte,
  // `data-testid="chat-input-fast-mode"` risolve a più elementi. Reset dello
  // store condiviso al solo topic seminato qui.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("toggle sits between the + menu and the context ring, flips on click", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "FAST-MODE-01" });
    await dichiaraFastMode(page, FAST_SERVIBILE);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    const fastBtn = page.getByTestId("chat-input-fast-mode");
    await expect(fastBtn).toBeVisible();

    // Ordine sulla riga: «+» → Fast (⚡) → anello del contesto. La graffetta
    // stava qui in mezzo ed è finita DENTRO il «+», con il microfono; il
    // vecchio interruttore «Plan» è sparito prima ancora — il piano è un
    // LIVELLO di autonomia (`composer-autonomy`, in coda alla riga), non un
    // flag di prompt.
    const addMenu = page.getByTestId("composer-add-menu");
    const ringBtn = page.getByTestId("chat-input-context-ring");
    await expect(addMenu).toBeVisible();
    await expect(ringBtn).toBeVisible();
    await expect(page.getByRole("button", { name: /toggle plan mode/i })).toHaveCount(0);
    // La graffetta non è più un bottone della riga: è una voce del «+».
    await expect(page.getByRole("button", { name: /Attach file/i })).toHaveCount(0);
    const positions = await Promise.all(
      [addMenu, fastBtn, ringBtn].map(async (loc) => {
        const box = await loc.boundingBox();
        return box?.x ?? -1;
      }),
    );
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);

    // Initial state: OFF
    await expect(fastBtn).toHaveAttribute("aria-pressed", "false");

    // Flip ON
    await fastBtn.click();
    await expect(fastBtn).toHaveAttribute("aria-pressed", "true");

    // Visual hint: amber color class is applied. We check for the bg token.
    const cls = await fastBtn.getAttribute("class");
    expect(cls).toContain("bg-amber-500/10");

    // Flip OFF
    await fastBtn.click();
    await expect(fastBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("sending a message with Fast ON includes fastMode:true in /api/chat body", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "FAST-MODE-02" });
    await dichiaraFastMode(page, FAST_SERVIBILE);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Capture POST /api/chat body via route interception (must register
    // BEFORE the click). We respond with a minimal SSE so the chat panel
    // doesn't hang.
    const captured: { fastMode?: boolean; planMode?: boolean } = {};
    await page.route(/\/api\/chat$/, async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      try {
        const body = route.request().postDataJSON();
        captured.fastMode = body?.fastMode;
        captured.planMode = body?.planMode;
      } catch {}
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body:
          'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n' +
          "data: [DONE]\n\n",
      });
    });

    // Toggle Fast ON
    const fastBtn = page.getByTestId("chat-input-fast-mode");
    await fastBtn.click();
    await expect(fastBtn).toHaveAttribute("aria-pressed", "true");

    // Send a message
    await textarea.fill("ciao veloce");
    await textarea.press("Enter");

    // Wait for the request to land
    await expect.poll(() => captured.fastMode, { timeout: 10_000 }).toBe(true);
    expect(captured.planMode).toBeFalsy();
  });

  test("Fast + piano convivono, ma il piano viaggia sull'autonomia", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "FAST-MODE-03" });
    // Prima questo test premeva DUE bottoni e si aspettava due flag nello
    // stesso corpo. Il secondo bottone era il «Plan Mode»: un flag per-turno,
    // tenuto in localStorage, che iniettava una richiesta nel prompt e che
    // nessuno faceva rispettare — mentre a quattro bottoni di distanza il
    // livello di autonomia passava `--permission-mode plan` alla CLI. Il flag
    // non parte più dal client: il piano lo accende il livello, server-side
    // (`planModeFor`, provato in server/lib/autonomy-mode.test.ts).
    await dichiaraFastMode(page, FAST_SERVIBILE);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    const captured: { fastMode?: boolean; planMode?: boolean } = {};
    await page.route(/\/api\/chat$/, async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      try {
        const body = route.request().postDataJSON();
        captured.fastMode = body?.fastMode;
        captured.planMode = body?.planMode;
      } catch {}
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body:
          'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n' +
          "data: [DONE]\n\n",
      });
    });

    // Il piano si sceglie QUI, e da nessun'altra parte nel composer.
    const autonomy = page.getByTestId("composer-autonomy");
    await autonomy.click();
    await page.getByTestId("composer-autonomy-ask").click();
    await expect(autonomy).toHaveAttribute("data-level", "ask");

    // Fast ON (potrebbe già esserlo dal test precedente: è una pagina nuova).
    const fastBtn = page.getByTestId("chat-input-fast-mode");
    if ((await fastBtn.getAttribute("aria-pressed")) !== "true") {
      await fastBtn.click();
    }

    await textarea.fill("piano + veloce");
    await textarea.press("Enter");

    await expect.poll(() => captured.fastMode, { timeout: 10_000 }).toBe(true);
    // Il client NON manda più `planMode`: se ricomparisse, vorrebbe dire che è
    // tornata la seconda leva.
    expect(captured.planMode).toBeUndefined();
  });

  test("FAST-MODE-04: quando la CLI dice che non si può, il bottone NON c'è", async ({ page }) => {
    // Il caso vero di oggi: le chat girano `claude --print --input-format
    // stream-json`, cioè la via Agent SDK, e la CLI risponde
    // `fast_mode_disabled_reason: "sdk_opt_in_required"`. Prima, con lo stesso
    // clic, il server scambiava il modello con haiku: il toggle faceva una cosa
    // DIVERSA da quella che prometteva, in silenzio.
    await dichiaraFastMode(page, { state: "off", reason: "sdk_opt_in_required", costMultiplier: 2 });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await page.getByRole("textbox", { name: /Message input/ }).waitFor({ state: "visible", timeout: 15_000 });

    const fastBtn = page.getByTestId("chat-input-fast-mode");
    // Non c'è proprio: un comando che non si può usare non occupa una riga.
    await expect(fastBtn).toHaveCount(0);
    // E gli altri controlli della riga restano al loro posto.
    await expect(page.getByTestId("chat-input-context-ring")).toBeVisible();
  });

  test("FAST-MODE-05: quando si può, sotto il ⚡ c'è quanto costa", async ({ page }) => {
    // 2× = 10$/50$ della fast mode contro i 5$/25$ di Opus standard, listino
    // che la CLI scrive nei suoi stessi documenti. «Più veloce» da solo non è
    // un'informazione finché non dici quanto costa.
    await dichiaraFastMode(page, FAST_SERVIBILE);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await page.getByRole("textbox", { name: /Message input/ }).waitFor({ state: "visible", timeout: 15_000 });

    const fastBtn = page.getByTestId("chat-input-fast-mode");
    await expect(fastBtn).toBeVisible();
    await expect(fastBtn).toBeEnabled();
    const badge = page.getByTestId("fast-mode-cost");
    await expect(badge).toHaveText("2×");
    // Il numero sta anche nel tooltip: il badge da solo non dice DI COSA è il doppio.
    expect(await fastBtn.getAttribute("title")).toContain("2×");
    // Il badge non è un bersaglio tattile a sé, e il bottone resta alto 32.
    await expect(badge).toHaveCSS("pointer-events", "none");
    expect(Math.round((await fastBtn.boundingBox())!.height)).toBe(32);
  });
});
