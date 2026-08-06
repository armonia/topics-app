/**
 * UNA CORSA DI TOOL È UNA RIGA SOLA — nel transcript com'è fatto DAVVERO.
 *
 * Il raggruppamento (`toolGrouping`) era cablato e provato, e non scattava mai:
 * lavora dentro UN messaggio, mentre Claude Code emette un messaggio assistant
 * per ogni blocco. Misurato sul DB vivo: 85 messaggi su 117 sono «una tool
 * call, testo vuoto». Il raggruppatore riceveva sempre un array di lunghezza
 * uno, i test unitari restavano verdi, e a schermo si vedevano N righe sciolte
 * ognuna col vestito completo di un messaggio.
 *
 * Questa spec semina esattamente quella forma — un messaggio per azione, senza
 * prosa — e pretende UNA riga di gruppo. È il caso che i test puri non possono
 * vedere, perché il difetto non era nella funzione: era in ciò che le arrivava.
 */
import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Corse di tool nel transcript", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `tool-run-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    // Stessa derivazione delle altre spec che seminano messaggi.
    sessionKey = `topic:${topic.id.slice(0, 8)}`;

    await seedMessage(request, { sessionKey, role: "user", content: "sistema il modulo" });
    // SEI azioni, SEI messaggi, nessuna prosa: la forma che l'importer produce.
    const azioni = [
      { name: "Read", args: { path: "/src/a.ts" } },
      { name: "Read", args: { path: "/src/b.ts" } },
      { name: "Edit", args: { path: "/src/a.ts" } },
      { name: "Bash", args: { command: "bun test" } },
      { name: "Read", args: { path: "/src/c.ts" } },
      { name: "Edit", args: { path: "/src/b.ts" } },
    ];
    for (const [i, a] of azioni.entries()) {
      await seedMessage(request, {
        sessionKey,
        role: "assistant",
        content: "",
        toolCalls: [{ id: `run-${i}`, name: a.name, args: a.args, status: "success", result: "ok" }],
      });
    }
    await seedMessage(request, { sessionKey, role: "assistant", content: "Fatto." });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("sei azioni in sei messaggi collassano in UNA riga di gruppo", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const gruppo = page.locator('[data-testid="tool-group-row"]');
    await expect(gruppo, "la corsa deve produrre una riga di gruppo").toHaveCount(1, { timeout: 15_000 });
    await expect(gruppo.locator('[data-testid="tool-group-summary"]')).toContainText("6 azioni");
    // I conteggi per tool: è la sintesi che rende la riga leggibile.
    await expect(gruppo.locator('[data-testid="tool-group-summary"]')).toContainText("Read ×3");

    // Chiusa, le righe per-azione NON sono a schermo: è tutto il punto.
    await expect(page.locator('[data-testid="tool-call-row-run-0"]')).toHaveCount(0);

    // …e aprendola ci sono tutte e sei.
    await gruppo.locator('[data-testid="tool-group-summary"]').click();
    for (let i = 0; i < 6; i++) {
      await expect(page.locator(`[data-testid="tool-call-row-run-${i}"]`)).toBeVisible();
    }
  });

  test("la corsa è UN item: sei azioni non portano sei bolle di messaggio", async ({ page }) => {
    // Il vuoto fra le righe non veniva dai margini della riga di tool: veniva
    // dal fatto che ogni azione era un MESSAGGIO, e ogni messaggio si porta
    // dietro bolla, margini e la riga dell'orario. Fusa la corsa, il vestito si
    // paga una volta.
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator(`[aria-label="Messages for ${topicName}"]`);
    await expect(scroller).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="tool-group-row"]')).toHaveCount(1, { timeout: 15_000 });

    // utente + corsa (una sola) + risposta finale = 3 bolle, non 8.
    const bolle = page.locator(`[aria-label="Messages for ${topicName}"] [data-testid="chat-message"]`);
    await expect(bolle).toHaveCount(3);
  });
});
