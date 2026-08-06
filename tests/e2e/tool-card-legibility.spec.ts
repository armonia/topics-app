import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * Che cosa si LEGGE dentro la card di un tool.
 *
 * Tre difetti di resa, tutti sullo stesso schermo:
 *
 *  1. la `Skill` riscriveva nel corpo il nome già stampato nell'intestazione, e
 *     sotto ci metteva «Launching skill: X» — l'unica cosa che la CLI
 *     restituisce, e che non dice niente di nuovo. Il contenuto vero (le
 *     istruzioni caricate) finiva invece nella PROSA della risposta;
 *  2. i risultati arrivati come array di blocchi venivano serializzati: nella
 *     card si leggeva `[{"type":"text","text":"…"}]` invece del testo. Sul DB di
 *     questa macchina: 4.735 risultati su 32.492;
 *  3. i messaggi già salvati con la forma (2) devono tornare leggibili senza
 *     riscrivere il DB.
 */
test.describe.serial("Leggibilità delle card dei tool", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  const SKILL_BODY =
    "Fai un riassunto in massimo 2 righe di tutte le modifiche fatte in questa sessione di chat.\nSii conciso: elenca i cambiamenti separati da punto e virgola.";
  const MCP_TEXT = "Task #12 — in review\nassegnato a: nessuno";
  /** La forma in cui i risultati MCP sono finiti nel DB fino a oggi. */
  const MCP_RAW = JSON.stringify([{ type: "text", text: MCP_TEXT }]);

  test.beforeAll(async ({ request }) => {
    topicName = "Tool Cards " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("la Skill mostra le ISTRUZIONI, non il proprio nome due volte", async ({ page, request }) => {
    const u = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "/recap",
      timestamp: new Date(Date.now() - 5000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u.id,
      content: "Corretto il ritaglio delle finestre; ridotta la latenza a 22 ms.",
      timestamp: new Date(Date.now() - 4000).toISOString(),
      toolCalls: [
        // Come arriva ADESSO: il corpo della skill è il risultato del tool.
        {
          id: "tc-skill-new",
          name: "Skill",
          args: { skill: "recap" },
          status: "success",
          result: SKILL_BODY,
          startedAt: Date.now() - 4200,
          endedAt: Date.now() - 4100,
        },
        // Un messaggio VECCHIO: la CLI aveva restituito solo il segnaposto.
        {
          id: "tc-skill-old",
          name: "Skill",
          args: { skill: "caveman" },
          status: "success",
          result: "Launching skill: caveman",
          startedAt: Date.now() - 4400,
          endedAt: Date.now() - 4300,
        },
      ],
      latencyMs: 3900,
      usagePromptTokens: 432,
      usageCompletionTokens: 354,
      costCents: 2,
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const fresh = page.locator('[data-testid="tool-call-row-tc-skill-new"]');
    await expect(fresh).toBeVisible({ timeout: 15_000 });

    // L'intestazione nomina la skill come la si invoca.
    await expect(fresh.locator('[data-testid="tool-call-name"]')).toHaveText("Skill");
    await expect(fresh).toContainText("/recap");

    // La prosa della risposta NON contiene il corpo della skill: era il difetto
    // di partenza, il prompt del comando incollato prima della risposta.
    const assistant = page.locator('[data-testid="message-content-assistant"]').last();
    await expect(assistant).not.toContainText("Fai un riassunto in massimo 2 righe");

    // Aperta, la card porta le istruzioni caricate — una volta sola.
    await fresh.locator("button").first().click();
    const body = fresh.locator('[data-testid="tool-call-result"]');
    await expect(body).toBeVisible();
    await expect(body).toContainText("Fai un riassunto in massimo 2 righe");
    await expect(fresh).toContainText("Istruzioni caricate");
    // `/recap` compare UNA volta sola in tutta la riga: nell'intestazione.
    const occurrences = ((await fresh.innerText()).match(/\/recap/g) ?? []).length;
    expect(occurrences).toBe(1);

    // Il messaggio vecchio: niente segnaposto, la card resta muta.
    const old = page.locator('[data-testid="tool-call-row-tc-skill-old"]');
    await old.locator("button").first().click();
    await expect(old).not.toContainText("Launching skill");

    await fresh.screenshot({ path: "test-results/skill-card-instructions.png" });
  });

  test("un risultato salvato come array di blocchi torna leggibile", async ({ page, request }) => {
    const u = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "che stato ha il task 12?",
      timestamp: new Date(Date.now() - 3000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u.id,
      content: "È in review.",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      toolCalls: [
        {
          id: "tc-mcp-json",
          name: "mcp__topics__get_task",
          args: { taskId: "12" },
          status: "success",
          result: MCP_RAW,
          startedAt: Date.now() - 2200,
          endedAt: Date.now() - 2100,
        },
      ],
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const row = page.locator('[data-testid="tool-call-row-tc-mcp-json"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator("button").first().click();

    const body = row.locator('[data-testid="tool-call-result"]');
    await expect(body).toBeVisible();
    await expect(body).toContainText("Task #12 — in review");
    // Nessuna traccia dell'involucro JSON.
    await expect(body).not.toContainText('"type"');
    await expect(body).not.toContainText("[{");

    await row.screenshot({ path: "test-results/mcp-card-unwrapped.png" });
  });
});
