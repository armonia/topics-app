import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL, PLAN_APPROVAL_QUESTION } from "../../shared/plan-decision";

hermetic(test);

/**
 * Il turno che PROPONE e non può consegnare.
 *
 * Registrato sul wire con la CLI 2.1.223: in `--permission-mode plan` — dove
 * gira un topic con autonomia «ask» — vengono esposti 29 tool e `ExitPlanMode`
 * NON è tra questi. Il modello non può agire e non può chiedere l'approvazione:
 * scrive il piano in `~/.claude/plans/<slug>.md` e si ferma. A schermo restava
 * il cartello «il turno si è chiuso senza produrre niente» sopra una colonna di
 * azioni riuscite, e il piano non si vedeva.
 *
 * Se la CLI non ha più il tool per chiedere, la domanda la pone Topics — con lo
 * STESSO pannello di ogni altra domanda.
 */
test.describe.serial("Approvazione del piano", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  const PLAN = "# Piano\n\n1. **Primo passo** — leggere i file\n2. **Secondo passo** — scrivere il codice";

  test.beforeAll(async ({ request }) => {
    topicName = "Piano " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
    // Il topic è in «ask»: è la modalità che finisce in plan mode.
    await request.patch(`${E2E_BASE}/api/topics/${topicId}`, { data: { autonomyLevel: "ask" } });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function seedPlan(request: import("@playwright/test").APIRequestContext, toolCallId: string) {
    const u = await seedMessage(request, {
      sessionKey, role: "user", content: "aiutami a fare una cosa",
      timestamp: new Date(Date.now() - 5000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey, role: "assistant", parentId: u.id, content: "",
      timestamp: new Date(Date.now() - 4000).toISOString(),
      toolCalls: [
        {
          id: toolCallId,
          name: "Write",
          args: { file_path: "/Users/x/.claude/plans/una-cosa-cozy-wilkes.md", content: PLAN },
          status: "waiting_for_input",
          startedAt: Date.now() - 4000,
          userInputSchema: {
            kind: "questions",
            questions: [{
              question: PLAN_APPROVAL_QUESTION,
              header: "Piano",
              options: [
                { label: PLAN_APPROVE_LABEL, description: "La chat passa ad auto-apply e il piano viene eseguito.", recommended: true },
                { label: PLAN_REJECT_LABEL, description: "Il piano viene scartato." },
              ],
              multiSelect: false,
            }],
          },
        },
      ],
    });
  }

  test("il piano si vede, e la domanda è il pannello di sempre", async ({ page, request }) => {
    const toolCallId = "toolu_plan_vista";
    await seedPlan(request, toolCallId);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    // Il piano NON è una scrittura anonima: è un piano, col suo testo.
    const row = page.locator(`[data-testid="tool-call-row-${toolCallId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('[data-testid="tool-call-name"]')).toHaveText("Plan");
    await expect(row).toContainText("Primo passo");
    // …e non nomina il file, che è un dettaglio di trasporto.
    await expect(row).not.toContainText("cozy-wilkes");

    // La domanda usa il pannello standard, con le due scelte.
    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible();
    await expect(form).toContainText(PLAN_APPROVE_LABEL);
    await expect(form).toContainText(PLAN_REJECT_LABEL);
    // Approvare è consigliato ma non preselezionato: la scelta resta un gesto.
    await expect(form.getByTestId("ask-recommended")).toHaveCount(1);
    await expect(form.locator('input[type="radio"]:checked')).toHaveCount(0);
    // E il cartello del turno a vuoto non c'è: qui qualcosa è stato prodotto.
    await expect(page.locator('[data-testid="chat-message"]', { hasText: "senza produrre niente" })).toHaveCount(0);

    await row.screenshot({ path: "test-results/plan-approval-panel.png" });
  });

  test("approvare alza l'autonomia, o il turno ripartirebbe nella stessa trappola", async ({ page, request }) => {
    const toolCallId = "toolu_plan_approva";
    await seedPlan(request, toolCallId);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });

    // `GET /api/topics/:id` non esiste, e `topics` è una MAPPA per id.
    const autonomia = async () => {
      const all = await (await request.get(`${E2E_BASE}/api/topics`)).json();
      return all?.topics?.[topicId]?.autonomyLevel;
    };

    // Prima: la chat è in «ask», cioè in plan mode.
    expect(await autonomia()).toBe("ask");

    await form.getByText(PLAN_APPROVE_LABEL, { exact: false }).first().click();
    const submit = form.locator('button[type="submit"]');
    if (await submit.count()) await submit.first().click();

    // Dopo: auto-apply. Senza questo passaggio il turno che esegue ripartirebbe
    // in plan mode — cioè di nuovo bloccato, e l'approvazione non varrebbe niente.
    await expect.poll(autonomia, { timeout: 10_000 }).toBe("auto-apply");
  });
});
