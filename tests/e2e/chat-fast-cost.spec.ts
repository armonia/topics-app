/**
 * chat-fast-cost.spec.ts — il numero sotto il ⚡.
 *
 * Il badge dice quanto costerebbe premere Fast Mode, sul listino VERO
 * (`shared/model-pricing.ts`, la stessa tabella con cui il server tariffa i
 * turni). Tre cose da inchiodare, e sono le tre in cui un badge del genere
 * mente facilmente:
 *  - FASTCOST-01 il numero è il rapporto vero fra i due modelli, e il tooltip
 *    dice QUALI sono (un «0,2×» solo non si può verificare a occhio);
 *  - FASTCOST-02 con un modello FISSATO il Fast non cambia niente — è il ramo
 *    di `server/routes/chat.ts` («fast mapping skipped») — quindi il badge dice
 *    1× invece di promettere un risparmio che non arriverà;
 *  - FASTCOST-03 quando il rapporto non è calcolabile il badge SPARISCE, e il
 *    bottone resta un bottone (si accende e si spegne lo stesso).
 *
 * Lo snapshot dei provider è moccato su ENTRAMBI i canali (GET + frame WS):
 * lo store è last-write-wins, quindi il frame vero che arriva dopo l'HTTP
 * ribalterebbe il mock. Stessa ragione — e stessa forma — di
 * `helpers/openclaw.ts`.
 */
import { test } from "./fixtures/chat.fixture";
import { expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

interface FakeEntry {
  name: string;
  defaultModel?: string;
  fastModel?: string | null;
}

function snapshotOf(entries: FakeEntry[], defaultProvider: string) {
  return {
    providers: entries.map((e) => ({
      name: e.name,
      label: e.name,
      status: "ready",
      isDefault: e.name === defaultProvider,
      models: [] as unknown[],
      requirements: [] as unknown[],
      defaultModel: e.defaultModel,
      fastModel: e.fastModel,
      fetchedAt: "2026-01-01T00:00:00Z",
    })),
    defaultProvider,
    generatedAt: "2026-01-01T00:00:00Z",
  };
}

/** Moccalo su tutti e due i canali, o il frame vero vince sull'HTTP. */
async function mockProviders(page: Page, entries: FakeEntry[], defaultProvider: string) {
  const snapshot = snapshotOf(entries, defaultProvider);
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

test.describe.serial("Fast Mode — quanto costa premerlo", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Fast Cost E2E " + Date.now();
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    // Il ⚡ è per-composer: con altre pane aperte il testid risolve a più
    // elementi. Una sola topic in scena.
    await resetPaneStore(request, [topicId]);
    await request.patch(`/api/topics/${topicId}`, { data: { provider: null, model: null } });
  });

  async function openComposer(page: Page) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await page.getByRole("textbox", { name: /Message input/ }).waitFor({ state: "visible", timeout: 15_000 });
    return page.getByTestId("chat-input-fast-mode");
  }

  test("FASTCOST-01: il badge è il rapporto VERO fra i due listini", async ({ page }) => {
    // opus-5 = 5$/25$ per 1M · haiku-4-5 = 1$/5$ → un quinto.
    await mockProviders(page, [
      { name: "claude-code", defaultModel: "claude-opus-5", fastModel: "claude-haiku-4-5" },
    ], "claude-code");
    const fastBtn = await openComposer(page);

    const badge = page.getByTestId("fast-mode-cost");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    // Virgola o punto secondo la lingua dell'interfaccia: il valore è lo stesso.
    await expect(badge).toHaveText(/^0[.,]2×$/);

    // E il tooltip dice QUALI modelli: senza, «0,2×» è un numero da indovinare.
    const title = await fastBtn.getAttribute("title");
    expect(title).toContain("claude-haiku-4-5");
    expect(title).toContain("claude-opus-5");

    // Il badge non è un bersaglio tattile: è dentro il bottone, non un secondo
    // bottone da 12px sopra il primo.
    await expect(badge).toHaveCSS("pointer-events", "none");
    // E il bottone resta alto 32 come i fratelli della riga.
    const box = await fastBtn.boundingBox();
    expect(Math.round(box!.height)).toBe(32);
  });

  test("FASTCOST-02: con un modello FISSATO il Fast non cambia niente → 1×", async ({ page, request }) => {
    // È il ramo di server/routes/chat.ts: un modello esplicito vince sul Fast,
    // che viene saltato. Un badge che qui dicesse «0,2×» sarebbe una bugia.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: "claude-code", model: "claude-opus-5" },
    });
    await mockProviders(page, [
      { name: "claude-code", defaultModel: "claude-opus-5", fastModel: "claude-haiku-4-5" },
    ], "claude-code");
    const fastBtn = await openComposer(page);

    const badge = page.getByTestId("fast-mode-cost");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1×");
    expect(await fastBtn.getAttribute("title")).toContain("non cambia niente");
  });

  test("FASTCOST-03: senza rapporto calcolabile il badge sparisce, il bottone no", async ({ page }) => {
    // openclaw delega al gateway: nessun fast model, quindi nessun numero.
    await mockProviders(page, [{ name: "openclaw", defaultModel: "gateway", fastModel: null }], "openclaw");
    const fastBtn = await openComposer(page);

    await expect(fastBtn).toBeVisible();
    await expect(page.getByTestId("fast-mode-cost")).toHaveCount(0);

    // Il bottone continua a fare il suo mestiere: un badge assente non deve
    // trasformarlo in un pulsante morto.
    await expect(fastBtn).toHaveAttribute("aria-pressed", "false");
    await fastBtn.click();
    await expect(fastBtn).toHaveAttribute("aria-pressed", "true");
    await fastBtn.click();
    await expect(fastBtn).toHaveAttribute("aria-pressed", "false");
  });
});
