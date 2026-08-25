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

    test.info().annotations.push({ type: "spec", description: "PERM-05" });
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

    // Il piano si legge per come è SCRITTO: un titolo e due passi, non un
    // blocco monospazio. Era un <pre>, cioè la forma che si scorre senza
    // leggere — e questo è l'unico testo della chat su cui si decide.
    const corpo = row.locator('[data-testid="plan-card-body"]');
    await expect(corpo).toBeVisible();
    await expect(corpo.locator("h1")).toHaveText("Piano");
    await expect(corpo.locator("ol > li")).toHaveCount(2);
    await expect(corpo.locator("li strong").first()).toHaveText("Primo passo");
    await expect(corpo.locator("pre")).toHaveCount(0);

    // La domanda usa il pannello standard, con le due scelte.
    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible();
    await expect(form).toContainText(PLAN_APPROVE_LABEL);
    await expect(form).toContainText(PLAN_REJECT_LABEL);
    // Approvare è consigliato ma non preselezionato: la scelta resta un gesto.
    await expect(form.getByTestId("ask-recommended")).toHaveCount(1);
    await expect(form.locator('input[type="radio"]:checked')).toHaveCount(0);
    // Su un piano NON c'è «Altro»: la risposta la confrontiamo noi con due
    // etichette esatte, quindi qualunque prosa varrebbe rifiuto e il testo
    // scritto sparirebbe senza che nessuno lo legga.
    await expect(form.getByTestId("ask-other-input-0")).toHaveCount(0);
    await expect(form).not.toContainText("Scrivi la tua risposta");
    // E il cartello del turno a vuoto non c'è: qui qualcosa è stato prodotto.
    await expect(page.locator('[data-testid="chat-message"]', { hasText: "senza produrre niente" })).toHaveCount(0);

    // …e soprattutto la scelta sta SOPRA IL COMPOSER, dove finisce l'occhio di
    // chi sta per scrivere: dentro la trascrizione la trovi solo se stai già
    // guardando quel punto.
    const bar = page.locator('[data-testid="plan-approval-bar"]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("aspetta la tua approvazione");
    await expect(bar.getByTestId("plan-approve")).toBeVisible();
    await expect(bar.getByTestId("plan-reject")).toBeVisible();
    // Sta davvero sopra l'input, non in mezzo ai messaggi.
    const barBox = (await bar.boundingBox())!;
    const inputBox = (await page.getByTestId("chat-message-input").boundingBox())!;
    expect(barBox.y).toBeLessThan(inputBox.y);
    expect(inputBox.y - (barBox.y + barBox.height)).toBeLessThan(80);

    await row.screenshot({ path: "test-results/plan-approval-panel.png" });
    await bar.screenshot({ path: "test-results/plan-approval-bar.png" });
  });

  test("approvare alza l'autonomia, o il turno ripartirebbe nella stessa trappola", async ({ page, request }) => {
    const toolCallId = "toolu_plan_approva";
    await seedPlan(request, toolCallId);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    await expect(page.locator('[data-testid="plan-approval-bar"]')).toBeVisible({ timeout: 15_000 });

    // `GET /api/topics/:id` non esiste, e `topics` è una MAPPA per id.
    const autonomia = async () => {
      const all = await (await request.get(`${E2E_BASE}/api/topics`)).json();
      return all?.topics?.[topicId]?.autonomyLevel;
    };

    // Prima: la chat è in «ask», cioè in plan mode.
    expect(await autonomia()).toBe("ask");

    // Si approva dalla barra sopra il composer.
    await page.getByTestId("plan-approve").click();

    // Dopo: auto-apply. Senza questo passaggio il turno che esegue ripartirebbe
    // in plan mode — cioè di nuovo bloccato, e l'approvazione non varrebbe niente.
    await expect.poll(autonomia, { timeout: 10_000 }).toBe("auto-apply");
  });

  /**
   * Il piano scritto SOLO in prosa.
   *
   * Il modello, in plan mode, non sempre scrive il file: il contesto gli chiede
   * un formato preciso («## Plan» + passi numerati, `planModeContent()`) e a
   * volte risponde e basta. Lì di riga di tool non ce n'è nessuna a cui
   * appendere la domanda — e fino a ieri la decisione non esisteva proprio: la
   * vecchia vista di prosa viveva solo nel ramo di render legacy, che per i
   * messaggi con timeline `blocks` — cioè tutti quelli nuovi — non passa mai.
   */
  test("un piano scritto solo in prosa ha lo stesso cancello", async ({ page, request }) => {
    // Topic SUO. I test qui sopra approvano, e approvare manda un messaggio:
    // riusando la stessa chat l'ultimo messaggio non sarebbe più il piano, e il
    // cancello — che guarda l'ultimo — direbbe giustamente di no.
    const nome = "Piano prosa " + Date.now();
    const t = await createTopic(request, nome);
    const chiave = `topic:${t.id.slice(0, 8)}`;
    await request.patch(`${E2E_BASE}/api/topics/${t.id}`, { data: { autonomyLevel: "ask" } });
    const u = await seedMessage(request, {
      sessionKey: chiave, role: "user", content: "aiutami a fare un'altra cosa",
      timestamp: new Date(Date.now() - 5000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey: chiave, role: "assistant", parentId: u.id,
      content: "## Plan\n\n1. **Primo passo** — leggere i file\n2. **Secondo passo** — scrivere il codice\n\n## Summary\nBreve riassunto.",
      timestamp: new Date(Date.now() - 4000).toISOString(),
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(nome));

    const bar = page.locator('[data-testid="plan-approval-bar"]');
    await expect(bar).toBeVisible({ timeout: 15_000 });

    const autonomia = async () => {
      const all = await (await request.get(`${E2E_BASE}/api/topics`)).json();
      return all?.topics?.[t.id]?.autonomyLevel;
    };
    expect(await autonomia()).toBe("ask");

    // Approvare fa la STESSA cosa del piano-blocco: alza l'autonomia. Se qui
    // divergesse, il turno che esegue ripartirebbe in plan mode.
    await bar.getByTestId("plan-approve").click();
    await expect.poll(autonomia, { timeout: 10_000 }).toBe("auto-apply");
    // …e la barra sparisce: la palla non è più tua.
    await expect(bar).toBeHidden({ timeout: 10_000 });

    await deleteTopic(request, t.id);
  });
});
