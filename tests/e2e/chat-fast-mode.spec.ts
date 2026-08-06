import { expect, type Route } from "@playwright/test";
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

  test("toggle is positioned between Plan and Context ring, flips on click", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "FAST-MODE-01" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    const fastBtn = page.getByTestId("chat-input-fast-mode");
    await expect(fastBtn).toBeVisible();

    // Ordine: graffetta → Fast (⚡) → anello del contesto. Il vecchio
    // interruttore «Plan» stava fra i primi due ed è sparito: il piano è un
    // LIVELLO di autonomia (il controllo `composer-autonomy`, più a destra),
    // non un flag di prompt accanto alla graffetta.
    const attachBtn = page.getByRole("button", { name: /Attach file/i });
    const ringBtn = page.getByTestId("chat-input-context-ring");
    await expect(attachBtn).toBeVisible();
    await expect(ringBtn).toBeVisible();
    await expect(page.getByRole("button", { name: /toggle plan mode/i })).toHaveCount(0);
    const positions = await Promise.all(
      [attachBtn, fastBtn, ringBtn].map(async (loc) => {
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
});
