import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import {
  PERMISSION_ALLOW_ALWAYS_LABEL,
  PERMISSION_ALLOW_ONCE_LABEL,
  PERMISSION_DENY_LABEL,
  permissionSchemaFor,
} from "../../shared/permission-decision";

hermetic(test);

const BASE = E2E_BASE;

/**
 * «Uno strumento che la modalità di permessi non copre non muore in silenzio:
 *  chiede, e la risposta della persona arriva davvero alla CLI.»
 *
 * Il guasto, il 7 agosto: 515 topic su 518 giravano in `--permission-mode
 * acceptEdits`, che in headless CHIEDE prima di eseguire ogni tool MCP e ogni
 * scrittura fuori dalla cwd. Topics non aveva un canale per rispondere, quindi
 * ogni richiesta diventava un no muto — con un messaggio che invitava a
 * concedere un permesso che nessuno poteva chiedere.
 *
 * Il canale è `--permission-prompt-tool mcp__topics__approval_prompt`: la CLI
 * chiama il bridge, il bridge blocca su `POST /api/sessions/:key/permission`, e
 * il pannello in chat sblocca il rendez-vous di `server/lib/permission-bridge.ts`.
 *
 * Questo e2e esercita il rendez-vous VERO: registra la gamba come farebbe il
 * bridge, poi guida il pannello vero nell'UI. È un COMPORTAMENTO — video acceso,
 * il .webm è la prova. Le parti pure hanno i loro unit test
 * (permission-bridge, tool-grants, permission-decision, approval-prompt).
 */
test.use({ video: "on" });

const TOOL = "mcp__gateway__kiwi__search-flight";
const TOOL_INPUT = { flyFrom: "NAP", flyTo: "RAK" };

test.describe.serial("Pannello di permesso", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `permission-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    // Le regole sono globali: una lasciata dietro renderebbe verde il test
    // successivo senza che nessuno abbia premuto niente.
    await request.delete(`${BASE}/api/tool-grants/${encodeURIComponent(TOOL)}`, { ignoreHTTPSErrors: true });
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
    await request.delete(`${BASE}/api/tool-grants/${encodeURIComponent(TOOL)}`, { ignoreHTTPSErrors: true });
  });

  /**
   * Semina il turno fermo sulla riga dello strumento, con il pannello del
   * permesso già persistito: è ESATTAMENTE ciò che la rotta scrive alla prima
   * gamba, e ciò che si rilegge dopo un reload.
   */
  async function seedPermission(
    request: import("@playwright/test").APIRequestContext,
    toolCallId: string,
  ) {
    const schema = permissionSchemaFor({ toolName: TOOL, input: TOOL_INPUT });
    await seedMessage(request, { sessionKey, role: "user", content: "cerca un volo" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "Cerco i voli:",
      toolCalls: [
        {
          id: toolCallId,
          name: TOOL,
          args: TOOL_INPUT,
          status: "waiting_for_input",
          startedAt: Date.now() - 3_000,
          userInputSchema: schema,
        },
      ],
    });
  }

  /** Polla come il bridge: gambe corte, si torna dentro finché non si decide. */
  function registerBridgePermission(
    request: import("@playwright/test").APIRequestContext,
    toolUseId: string,
    legMs = 800,
  ): Promise<{ decision?: string; cancelled?: boolean; legs: number }> {
    return (async () => {
      for (let legs = 1; legs <= 200; legs++) {
        const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
          data: { toolName: TOOL, input: TOOL_INPUT, toolUseId, legMs },
          ignoreHTTPSErrors: true,
          timeout: 60_000,
        });
        const body = (await r.json()) as { decision?: string; cancelled?: boolean; pending?: boolean };
        if (!body.pending) return { ...body, legs };
      }
      throw new Error("il bridge ha pollato 200 volte senza decisione");
    })();
  }

  test("il pannello dice che è un PERMESSO, mostra con quali argomenti, e non offre testo libero", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_perm_shape";
    await seedPermission(request, toolCallId);
    const bridge = registerBridgePermission(request, toolCallId);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });

    // Chi lo legge di sfuggita deve capire che sta decidendo COSA l'agente può
    // fare, non quale strada preferisce.
    await expect(form.getByText("L'agente chiede un permesso")).toBeVisible();
    await expect(form.getByText("L'agente attende la tua risposta")).toHaveCount(0);

    // Le tre decisioni, e nessuna consigliata: è l'unica domanda dell'app in cui
    // un consiglio deciderebbe al posto di chi deve decidere.
    await expect(form.getByText(PERMISSION_ALLOW_ONCE_LABEL, { exact: true })).toBeVisible();
    await expect(form.getByText(PERMISSION_ALLOW_ALWAYS_LABEL, { exact: true })).toBeVisible();
    await expect(form.getByText(PERMISSION_DENY_LABEL, { exact: true })).toBeVisible();
    await expect(form.locator('[data-testid="ask-recommended"]')).toHaveCount(0);

    // Un permesso concesso senza vedere cosa farà è un pulsante, non un permesso.
    const detail = form.locator('[data-testid="ask-question-detail"]');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("NAP");

    // Niente «Altro»: qui il testo libero il server lo legge come NEGA, quindi
    // la casella prometterebbe una risposta e ne darebbe un'altra.
    await expect(form.getByText("Altro")).toHaveCount(0);
    await expect(form.locator('[data-testid="ask-other-input-0"]')).toHaveCount(0);

    await page.waitForTimeout(1500);
    await form.locator(`input[type="radio"][value="${PERMISSION_ALLOW_ONCE_LABEL}"]`).check();
    await form.locator('[data-testid="ask-submit"]').click();

    // La decisione arriva al bridge, che è ciò che sblocca la CLI.
    const out = await bridge;
    expect(out.decision).toBe("allow");
    // Ed è passata da più di una gamba di poll: il difetto da cui questo giro
    // ci difende è una gamba che scade sotto una persona che sta leggendo.
    expect(out.legs).toBeGreaterThan(1);
  });

  test("«Consenti sempre» scrive la regola, e la volta dopo NESSUNO viene disturbato", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_perm_always";
    await seedPermission(request, toolCallId);
    const bridge = registerBridgePermission(request, toolCallId);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await form.locator(`input[type="radio"][value="${PERMISSION_ALLOW_ALWAYS_LABEL}"]`).check();
    await form.locator('[data-testid="ask-submit"]').click();

    expect((await bridge).decision).toBe("allow_always");

    // La regola è scritta dove Topics comanda — non nel `.claude/settings.local.json`
    // gitignorato da cui, fino a ieri, dipendeva se una chat avesse o no i suoi
    // strumenti a seconda della cartella in cui era nata.
    const grants = await (await request.get(`${BASE}/api/tool-grants`, { ignoreHTTPSErrors: true })).json() as {
      grants: { pattern: string }[];
    };
    expect(grants.grants.map((g) => g.pattern)).toContain(TOOL);

    // E la prova che serve davvero: la RICHIESTA SUCCESSIVA non apre nessun
    // pannello. Senza questo, «sempre» vorrebbe dire «di nuovo».
    const second = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
      data: { toolName: TOOL, input: TOOL_INPUT, toolUseId: "toolu_perm_always_2", legMs: 800 },
      ignoreHTTPSErrors: true,
    });
    expect((await second.json()).decision).toBe("allow");
  });

  test("«Nega» torna alla CLI come un no, non come un silenzio", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_perm_deny";
    await seedPermission(request, toolCallId);
    const bridge = registerBridgePermission(request, toolCallId);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await form.locator(`input[type="radio"][value="${PERMISSION_DENY_LABEL}"]`).check();
    await form.locator('[data-testid="ask-submit"]').click();

    expect((await bridge).decision).toBe("deny");

    // Un no non scrive nessuna regola: «no una volta» non è «no per sempre».
    const grants = await (await request.get(`${BASE}/api/tool-grants`, { ignoreHTTPSErrors: true })).json() as {
      grants: { pattern: string }[];
    };
    expect(grants.grants.map((g) => g.pattern)).not.toContain(TOOL);
  });

  test("un «sempre» si ritrova e si ritira dalle Impostazioni", async ({ page, chatPage, request }) => {
    // Senza questa scheda, «Consenti sempre» sarebbe una decisione permanente
    // presa di corsa dentro una chat e visibile in nessun posto: una porta che
    // si apre e basta.
    await request.post(`${BASE}/api/tool-grants`, { data: { pattern: TOOL }, ignoreHTTPSErrors: true });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    await page.keyboard.press("Meta+Comma");
    const settings = page.locator('[data-testid="settings-panel"]');
    await expect(settings).toBeVisible({ timeout: 5_000 });
    await settings.getByText("Permessi", { exact: true }).click();

    const row = settings.locator(`[data-testid="tool-grant-${TOOL}"]`);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(800);
    await settings.locator(`[data-testid="tool-grant-revoke-${TOOL}"]`).click();
    await expect(row).toHaveCount(0, { timeout: 5_000 });

    // E la revoca MORDE: la richiesta successiva torna a chiedere invece di
    // passare da sé.
    const after = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
      data: { toolName: TOOL, input: TOOL_INPUT, toolUseId: "toolu_after_revoke", legMs: 300 },
      ignoreHTTPSErrors: true,
    });
    const body = await after.json();
    expect(body.decision).toBeUndefined();
    expect(body.pending).toBe(true);
  });

  test("le mani di Topics non chiedono mai il permesso di essere sé stesse", async ({ request }) => {
    // Il 7 agosto una richiesta è arrivata su `mcp__topics__ask_user_question`:
    // per mostrare un pannello serviva il permesso di mostrare un pannello.
    const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
      data: { toolName: "mcp__topics__ask_user_question", input: {}, toolUseId: "toolu_selfask", legMs: 500 },
      ignoreHTTPSErrors: true,
    });
    expect((await r.json()).decision).toBe("allow");
  });
});
