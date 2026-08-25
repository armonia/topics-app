/**
 * LA CARD DI UNA SHELL IN BACKGROUND NON È UN RICORDO.
 *
 * `Bash(run_in_background: true)` non è un tool che finisce: è un processo che
 * resta. La card però mostrava lo scatto del momento in cui il tool ha
 * risposto — «Command running in background with ID: bash_1» — e da lì non si
 * muoveva più: il server sapeva che la shell era ancora viva, quanto output
 * aveva prodotto e con che codice era uscita, e la chat continuava a dire la
 * frase di partenza.
 *
 * Questo è un comportamento nel TEMPO, quindi non c'è asserzione statica che lo
 * dimostri: la spec semina la card, muove il registro vero
 * (`POST /api/test/background-shell`, che chiama le stesse funzioni di un turno
 * dell'agente) e pretende che la card cambi da sola, senza ricaricare la
 * pagina, tre volte: output nuovo, altro output, e infine il codice d'uscita.
 *
 * Il video è la prova: `recordVideo` è acceso sul progetto e il clip mostra la
 * coda che cresce sotto il pallino verde e il pallino che si spegne.
 */
import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const SHELL_ID = "bash_live_1";

test.describe("Shell in background: la card cresce dal vivo", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  /** Muove il registro come lo muoverebbe un turno vero. */
  async function shell(request: import("@playwright/test").APIRequestContext, body: Record<string, unknown>) {
    const res = await request.post(`${E2E_BASE}/api/test/background-shell`, {
      data: { sessionKey, shellId: SHELL_ID, ...body },
      ignoreHTTPSErrors: true,
    });
    if (!res.ok()) throw new Error(`registro non mosso: ${res.status()} ${await res.text()}`);
  }

  test.beforeAll(async ({ request }) => {
    topicName = `shell-live-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    sessionKey = `topic:${topic.id.slice(0, 8)}`;

    await seedMessage(request, { sessionKey, role: "user", content: "avvia il server e tienilo su" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "tc-bg-shell",
        name: "Bash",
        args: { command: "bun run dev:server", run_in_background: true },
        status: "success",
        // Esattamente la prosa del CLI: è da lì che la card ricava l'id.
        result: `Command running in background with ID: ${SHELL_ID}`,
      }],
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("output nuovo e codice d'uscita arrivano nella card senza ricaricare", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BGSHELL-03" });

    // La shell è viva PRIMA che la chat si apra: è il caso normale — il turno
    // che l'ha avviata è finito da un pezzo e la card viene riaperta dopo.
    await shell(request, { command: "bun run dev:server", topicId, output: "in ascolto su :3333" });

    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const riga = page.locator('[data-testid="tool-call-row-tc-bg-shell"]');
    await expect(riga).toBeVisible({ timeout: 15_000 });
    await riga.click();

    // Il pallino vivo: la card ha trovato la sua shell nel registro.
    const stato = page.locator('[data-testid="shell-live-status"]').first();
    await expect(stato).toHaveAttribute("data-status", "running", { timeout: 10_000 });

    const coda = page.locator('[data-testid="shell-live-output"]').first();
    await expect(coda).toContainText("in ascolto su :3333", { timeout: 10_000 });

    // ── Il punto della spec: da qui in poi NESSUNA azione sulla pagina. ──
    await shell(request, { output: "compilato in 240ms" });
    await expect(coda).toContainText("compilato in 240ms", { timeout: 10_000 });
    // La riga di prima non è stata sostituita: la coda si accumula.
    await expect(coda).toContainText("in ascolto su :3333");

    await shell(request, { output: "richiesta GET /api/topics 200" });
    await expect(coda).toContainText("GET /api/topics 200", { timeout: 10_000 });

    // E quando muore, la card lo dice — invece di restare «in corso» per sempre.
    await shell(request, { output: "arresto", status: "failed", exitCode: 1 });
    await expect(stato).toHaveAttribute("data-status", "ended", { timeout: 10_000 });
    await expect(page.locator('[data-testid="shell-live"]').first()).toContainText("uscita 1");
  });
});
