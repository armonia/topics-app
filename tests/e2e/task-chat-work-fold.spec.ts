/**
 * LA CHAT DI UN TASK SI LEGGE PER DECIDERE.
 *
 * Chi apre la sessione di un task non la legge come una conversazione: la legge
 * per approvare. Le parole dell'agente, le sue domande e le consegne sono la
 * decisione; le dieci azioni che le hanno prodotte sono la prova, ed erano il
 * grosso della pagina.
 *
 * Questa spec semina la forma vera del transcript (un messaggio per azione,
 * senza prosa, come la scrive l'importer) dentro una sessione LEGATA a un task,
 * e pretende tre cose: la corsa chiusa dietro una riga di riepilogo, la prosa e
 * la domanda sempre in chiaro, e le stesse righe di prima al primo clic.
 *
 * Il quarto caso e' quello che protegge tutto il resto: la stessa semina in una
 * chat NON di task non deve cambiare di una virgola.
 *
 * @covers CHAT-TOOL-06
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath } from "../../shared/board";

hermetic(test);

const SHOTS = "test-results/task-work-fold";
const STAMP = Date.now();
const PROJECT_PATH = `/tmp/e2e-workfold-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);

type Req = import("@playwright/test").APIRequestContext;

/** La domanda che ferma il turno: e' la cosa che NON deve finire ripiegata. */
const DOMANDA = {
  question: "DOMANDA-ALL-UMANO: lando su main?",
  header: "Scelta",
  options: [{ label: "Landa su main" }, { label: "Aspetta" }],
};

const ACTIONS = [
  { name: "Read", args: { file_path: "/repo/src/a.ts" } },
  { name: "Read", args: { file_path: "/repo/src/b.ts" } },
  { name: "Grep", args: { pattern: "partitionTurn" } },
  { name: "Edit", args: { file_path: "/repo/src/a.ts" } },
  { name: "Edit", args: { file_path: "/repo/src/b.ts" } },
  { name: "Bash", args: { command: "bun run typecheck" } },
  { name: "Read", args: { file_path: "/repo/src/c.ts" } },
  { name: "Write", args: { file_path: "/repo/src/d.ts" } },
  { name: "Bash", args: { command: "bun test" } },
  { name: "Read", args: { file_path: "/repo/src/e.ts" } },
];

/** La sessione dell'agente, seminata come la scrive il transcript vero. */
async function seedSession(request: Req, sessionKey: string, prefix: string) {
  await seedMessage(request, { sessionKey, role: "user", content: "sistema il modulo" });
  for (const [i, a] of ACTIONS.entries()) {
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `${prefix}-${i}`,
        name: a.name,
        args: a.args,
        status: "success",
        result: "ok",
        startedAt: 1_700_000_000_000 + i * 1000,
        endedAt: 1_700_000_000_000 + i * 1000 + 800,
      }],
    });
  }
  await seedMessage(request, { sessionKey, role: "assistant", content: "PROSA-DELL-AGENTE: il modulo e' sistemato." });
  await seedMessage(request, {
    sessionKey,
    role: "assistant",
    content: "",
    toolCalls: [{
      id: `${prefix}-ask`,
      name: "mcp__topics__ask_user_question",
      args: { questions: [DOMANDA] },
      status: "waiting_for_input",
      userInputSchema: { kind: "questions", questions: [{ ...DOMANDA, multiSelect: false }] },
    }],
  });
}

/** Lega il task al topic dell'agente come fa il dispatcher. */
async function bindTopic(request: Req, taskId: string, topicId: string) {
  const res = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/bind-topic`, {
    data: { topicId, dispatchState: "working" },
  });
  expect(res.ok()).toBe(true);
}

async function openChat(page: Page, name: string) {
  await goToApp(page);
  await openTopic(page, new RegExp(name));
}

test.describe("Il lavoro dell'agente in una chat di task", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.describe.configure({ timeout: 120_000 });

  let taskTopicId = "";
  let plainTopicId = "";
  let taskTopicName = "";
  let plainTopicName = "";
  let taskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(SHOTS, { recursive: true });
    // La cartella del progetto: senza, la board del task non ha un posto a cui
    // appartenere e la scheda non compare fra le colonne.
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-workfold" }));
    taskTopicName = `work-fold-task-${STAMP}`;
    plainTopicName = `work-fold-plain-${STAMP}`;
    const taskTopic = await createTopic(request, taskTopicName);
    const plainTopic = await createTopic(request, plainTopicName);
    taskTopicId = taskTopic.id;
    plainTopicId = plainTopic.id;

    await seedSession(request, `topic:${taskTopicId.slice(0, 8)}`, "wf");
    await seedSession(request, `topic:${plainTopicId.slice(0, 8)}`, "pf");

    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: `Rifinitura conversazione ${STAMP}` },
    });
    expect(res.ok()).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
    await bindTopic(request, taskId, taskTopicId);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    for (const id of [plainTopicId, taskTopicId]) if (id) await deleteTopic(request, id);
  });

  // Una pane per volta: con due chat aperte insieme la riga della scheda
  // dell'una si vedrebbe mentre si guarda l'altra, ed e' esattamente cio' che
  // il secondo caso deve poter negare.

  test("dieci azioni stanno dietro UNA riga chiusa, e la prosa e la domanda restano in chiaro", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-06" });
    await resetPaneStore(request, [taskTopicId]);
    await openChat(page, taskTopicName);
    // La riga di ritorno alla scheda dice che questa chat e' la sessione di un
    // task: senza, il ripiegamento non deve nemmeno accendersi.
    await expect(page.getByTestId("chat-task-card-strip")).toBeVisible({ timeout: 20_000 });

    const fold = page.getByTestId("task-work-accordion");
    await expect(fold, "la corsa deve produrre un accordion solo").toHaveCount(1, { timeout: 15_000 });
    await expect(fold).toHaveAttribute("data-open", "false");
    // Il riepilogo vale la piega: quante azioni, cosa e' stato fatto, quanto e'
    // durato, quanti file sono stati scritti.
    await expect(fold).toHaveAttribute("data-actions", "10");
    const summary = fold.getByTestId("task-work-summary");
    await expect(summary).toContainText("10");
    await expect(summary).toContainText("Read");
    await expect(fold.getByTestId("task-work-duration")).toBeVisible();
    // Tre file SCRITTI (a.ts, b.ts, d.ts): i letti non sono file toccati.
    await expect(fold.getByTestId("task-work-files")).toContainText("3");
    await didascalia(page, "Dieci azioni dietro una riga sola");
    await beat(page);

    // Chiuso: nessuna delle dieci righe per-azione e' a schermo. La riga della
    // DOMANDA (`wf-ask`) e' fuori dal conto apposta: non si piega mai.
    for (let i = 0; i < ACTIONS.length; i++) {
      await expect(page.getByTestId(`tool-call-row-wf-${i}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("tool-call-row-wf-ask")).toBeVisible();

    // Le parole restano: la prosa e la domanda non si piegano mai. Nel
    // transcript, non nella sidebar (che dell'ultimo messaggio fa l'anteprima).
    const transcript = page.getByTestId("virtuoso-item-list");
    await expect(transcript.getByText("PROSA-DELL-AGENTE", { exact: false })).toBeVisible();
    // La domanda con il suo pannello di risposta, aperto e cliccabile.
    await expect(page.getByTestId("tool-input-form-wf-ask")).toContainText("DOMANDA-ALL-UMANO");

    await page.screenshot({ path: join(SHOTS, "chiuso.png") });
    await didascalia(page, "La prosa e la domanda restano in chiaro");
    await beat(page);

    // Al clic torna tutto, righe per-azione comprese.
    await didascalia(page, "Un clic, e il lavoro torna tutto");
    await summary.click();
    await expect(fold).toHaveAttribute("data-open", "true");
    const gruppo = fold.getByTestId("tool-group-summary");
    if (await gruppo.count()) await gruppo.first().click();
    for (let i = 0; i < ACTIONS.length; i++) {
      await expect(page.getByTestId(`tool-call-row-wf-${i}`)).toBeVisible();
    }
    await page.screenshot({ path: join(SHOTS, "aperto.png") });
    await beat(page, 1600);
  });

  test("anche la SCHEDA del task ripiega il lavoro: e' dove si decide", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-06" });
    await resetPaneStore(request, [taskTopicId]);
    await goToApp(page);
    // La board globale: la scheda vive su un progetto di /tmp, non su una
    // finestra di progetto aperta.
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    // Dentro la board: lo stesso testo vive anche sulla riga di ritorno della
    // chat, che qui sta dietro e non e' cliccabile.
    const card = page.getByTestId("kanban-board").getByText(`Rifinitura conversazione ${STAMP}`).first();
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15_000 });

    const fold = page.getByTestId("task-detail-drawer").getByTestId("task-work-accordion");
    await expect(fold.first()).toBeVisible({ timeout: 20_000 });
    await expect(fold.first()).toHaveAttribute("data-open", "false");
    await page.screenshot({ path: join(SHOTS, "scheda.png") });
  });

  test("una chat qualunque non cambia: nessun accordion, le azioni si vedono come prima", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-06" });
    await resetPaneStore(request, [plainTopicId]);
    await openChat(page, plainTopicName);
    await expect(page.getByTestId("chat-task-card-strip")).toHaveCount(0);
    // La riga di gruppo dei tool (CHAT-TOOL-02) e' il comportamento storico e
    // resta: quello che non c'e' e' il ripiegamento per turno.
    await expect(page.getByTestId("tool-group-row").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-work-accordion")).toHaveCount(0);
    await expect(page.getByTestId("virtuoso-item-list").getByText("PROSA-DELL-AGENTE", { exact: false })).toBeVisible();
  });
});
