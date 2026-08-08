import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { PERMISSION_LABELS } from "../../shared/permission-decision";

hermetic(test);

const BASE = E2E_BASE;

/**
 * «Uno strumento che la modalità di permessi non copre non muore in silenzio:
 *  chiede, e la decisione della persona arriva davvero alla CLI.»
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
 * Un permesso ha uno STATO SUO (`awaiting_permission`) e non è una domanda
 * travestita: tre esiti esatti, una `PermissionDecision` sul filo, nessuna
 * prosa da interpretare. Il primo taglio riusava il pannello delle domande e
 * costava tre eccezioni là dentro — vedi la nota in `shared/types.ts`.
 *
 * È un COMPORTAMENTO: video acceso, il .webm è la prova. Le parti pure hanno i
 * loro unit test (permission-bridge, tool-grants, permission-decision,
 * approval-prompt, human-hold).
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
   * Semina il turno com'è quando la rotta ha già dipinto: riga in
   * `awaiting_permission` con la richiesta tipizzata, nei blocchi E in
   * `tool_calls` — cioè quello che si rilegge dopo un reload.
   */
  async function seedPermission(
    request: import("@playwright/test").APIRequestContext,
    toolCallId: string,
  ) {
    const tc = {
      id: toolCallId,
      name: TOOL,
      args: TOOL_INPUT,
      status: "awaiting_permission" as const,
      startedAt: Date.now() - 3_000,
      permissionRequest: { toolName: TOOL, input: TOOL_INPUT, requestedAt: Date.now() - 3_000 },
    };
    await seedMessage(request, { sessionKey, role: "user", content: "cerca un volo" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "Cerco i voli:",
      toolCalls: [tc],
      blocks: [{ kind: "text", text: "Cerco i voli:" }, { kind: "tool", toolCall: tc }],
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

  async function openChat(page: import("@playwright/test").Page, chatPage: { messageInput: import("@playwright/test").Locator }) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  test("è un pannello di PERMESSO: dice cosa, con quali argomenti, e si decide in un click", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_perm_shape";
    await seedPermission(request, toolCallId);
    const bridge = registerBridgePermission(request, toolCallId);

    await openChat(page, chatPage);
    const panel = page.locator(`[data-testid="tool-permission-${toolCallId}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // Chi lo legge di sfuggita deve capire che sta decidendo COSA l'agente può
    // fare, non quale strada preferisce.
    await expect(panel.getByText("L'agente chiede un permesso")).toBeVisible();
    await expect(panel.getByText(TOOL)).toBeVisible();

    // Un permesso concesso senza vedere cosa farà è un pulsante, non un permesso.
    await expect(panel.locator('[data-testid="tool-permission-detail"]')).toContainText("NAP");

    // Tre esiti, e NIENTE testo libero: non è una domanda, non c'è un «Altro»
    // che prometta una risposta e ne dia un'altra.
    for (const label of Object.values(PERMISSION_LABELS)) {
      // `exact`: senza, «Consenti» pesca anche «Consenti sempre».
      await expect(panel.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(panel.getByText("Altro")).toHaveCount(0);
    await expect(panel.locator("textarea")).toHaveCount(0);

    await page.waitForTimeout(1500);
    // UN click, non «scegli poi invia»: su tre esiti esatti il secondo gesto non
    // aggiunge una scelta, aggiunge un modo di lasciare il pannello a metà.
    await panel.locator(`[data-testid="tool-permission-allow-${toolCallId}"]`).click();

    const out = await bridge;
    expect(out.decision).toBe("allow");
    // Ed è passata da più di una gamba di poll: il difetto da cui questo giro ci
    // difende è una gamba che scade sotto una persona che sta leggendo.
    expect(out.legs).toBeGreaterThan(1);

    // Decisa, la riga si RICHIUDE — la palla non è più tua — ma la traccia
    // resta: riaprendola si legge chi ha detto cosa, come per una domanda a cui
    // hai già risposto.
    await expect(page.locator(`[data-testid="tool-permission-${toolCallId}"]`)).toHaveCount(0, { timeout: 10_000 });
    await page.locator(`[data-testid="tool-call-row-${toolCallId}"]`).click();
    await expect(page.locator(`[data-testid="tool-permission-outcome-${toolCallId}"]`)).toBeVisible({ timeout: 10_000 });
  });

  /**
   * IL DIFETTO CHE QUESTO TEST ESISTE PER FERMARE (7 agosto, primo permesso vero).
   *
   * Gli altri seminano il pannello già persistito: provano che il pannello
   * FUNZIONA, non che il server sappia dipingerlo. E il server non lo sapeva:
   * scriveva lo stato in `tool_calls` e lasciava `blocks` a `running` — ma
   * quando un messaggio ha blocchi, chi disegna legge QUELLI. A schermo: tre
   * chiamate che giravano da tre minuti, il piede che diceva «in attesa della
   * tua risposta», e nessun pannello.
   */
  test("il pannello lo dipinge il SERVER, e sopravvive a un caricamento da zero", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_perm_painted";
    const running = { id: toolCallId, name: TOOL, args: TOOL_INPUT, status: "running" as const, startedAt: Date.now() - 3_000 };
    await seedMessage(request, { sessionKey, role: "user", content: "cerca un volo" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "Cerco i voli:",
      toolCalls: [running],
      blocks: [{ kind: "text", text: "Cerco i voli:" }, { kind: "tool", toolCall: running }],
    });

    // Niente è stato seminato: se il pannello compare, l'ha scritto la rotta.
    const bridge = registerBridgePermission(request, toolCallId);
    await expect
      .poll(async () => {
        const r = await request.get(`${BASE}/api/topics/${topicId}/messages`, { ignoreHTTPSErrors: true });
        const body = (await r.json()) as { messages?: { blocks?: { kind: string; toolCall?: { id: string; status?: string; permissionRequest?: unknown } }[] }[] };
        const last = body.messages?.[body.messages.length - 1];
        const tool = last?.blocks?.find((b) => b.kind === "tool" && b.toolCall?.id === toolCallId);
        return tool?.toolCall?.status === "awaiting_permission" && !!tool?.toolCall?.permissionRequest;
      }, { timeout: 15_000, message: "la rotta deve dipingere NEI BLOCCHI, non solo in tool_calls" })
      .toBe(true);

    // E adesso la prova che conta: una pagina caricata da zero lo vede.
    await openChat(page, chatPage);
    const panel = page.locator(`[data-testid="tool-permission-${toolCallId}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await panel.locator(`[data-testid="tool-permission-allow-${toolCallId}"]`).click();
    expect((await bridge).decision).toBe("allow");
  });

  test("«Consenti sempre» scrive la regola, e la volta dopo NESSUNO viene disturbato", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_perm_always";
    await seedPermission(request, toolCallId);
    const bridge = registerBridgePermission(request, toolCallId);

    await openChat(page, chatPage);
    const panel = page.locator(`[data-testid="tool-permission-${toolCallId}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await panel.locator(`[data-testid="tool-permission-allow_always-${toolCallId}"]`).click();

    expect((await bridge).decision).toBe("allow_always");

    // La regola è scritta dove Topics comanda — non nel `.claude/settings.local.json`
    // gitignorato da cui, fino a ieri, dipendeva se una chat avesse o no i suoi
    // strumenti a seconda della cartella in cui era nata.
    const grants = (await (await request.get(`${BASE}/api/tool-grants`, { ignoreHTTPSErrors: true })).json()) as {
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

    await openChat(page, chatPage);
    const panel = page.locator(`[data-testid="tool-permission-${toolCallId}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await panel.locator(`[data-testid="tool-permission-deny-${toolCallId}"]`).click();

    expect((await bridge).decision).toBe("deny");

    // Un no non scrive nessuna regola: «no una volta» non è «no per sempre».
    const grants = (await (await request.get(`${BASE}/api/tool-grants`, { ignoreHTTPSErrors: true })).json()) as {
      grants: { pattern: string }[];
    };
    expect(grants.grants.map((g) => g.pattern)).not.toContain(TOOL);
  });

  test("un «sempre» si ritrova e si ritira dalle Impostazioni", async ({ page, chatPage, request }) => {
    // Senza questa scheda, «Consenti sempre» sarebbe una decisione permanente
    // presa di corsa dentro una chat e visibile in nessun posto.
    await request.post(`${BASE}/api/tool-grants`, { data: { pattern: TOOL }, ignoreHTTPSErrors: true });
    await openChat(page, chatPage);

    await page.keyboard.press("Meta+Comma");
    const settings = page.locator('[data-testid="settings-panel"]');
    await expect(settings).toBeVisible({ timeout: 5_000 });
    // I consensi non hanno più una voce di nav propria: stanno in fondo alla
    // scheda «AI Providers». Un pannello che di default è vuoto non merita un
    // posto fisso in navigazione — ma deve restare raggiungibile, ed è
    // esattamente ciò che questo test difende.
    await settings.getByRole("button", { name: "AI Providers" }).click();

    const row = settings.locator(`[data-testid="tool-grant-${TOOL}"]`);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(800);
    await settings.locator(`[data-testid="tool-grant-revoke-${TOOL}"]`).click();
    await expect(row).toHaveCount(0, { timeout: 5_000 });

    // E la revoca MORDE: la richiesta successiva torna a chiedere.
    const after = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
      data: { toolName: TOOL, input: TOOL_INPUT, toolUseId: "toolu_after_revoke", legMs: 300 },
      ignoreHTTPSErrors: true,
    });
    const body = await after.json();
    expect(body.decision).toBeUndefined();
    expect(body.pending).toBe(true);
  });

  test("una decisione che non riconosciamo è un 400 — non un sì per inerzia, non un no muto", async ({ request }) => {
    const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission-response`, {
      data: { toolCallId: "toolu_qualsiasi", decision: "ok" },
      ignoreHTTPSErrors: true,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("invalid_decision");
  });

  test("un click su un pannello che non ha più nessuno sotto lo DICE, invece di sparire", async ({ request }) => {
    // Il fantasma: turno morto, server riavviato, richiesta scaduta. Accettare
    // il click farebbe credere di aver risposto a qualcosa.
    const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission-response`, {
      data: { toolCallId: "toolu_mai_aperto", decision: "allow" },
      ignoreHTTPSErrors: true,
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).code).toBe("permission_not_pending");
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
