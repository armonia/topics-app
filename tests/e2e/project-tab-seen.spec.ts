/**
 * La tab «Progetto» si spegne quando hai guardato ciò che segnalava — e RESTA
 * spenta.
 *
 * Il bug. Una fase Claude come `awaiting-user` non si spegne da sola: resta lì
 * fino al turno dopo. Per una chat il fill blu lo spegne il "visto"
 * (SEEN_DWELL_MS davanti con la finestra sveglia); il rollup del PROGETTO invece
 * leggeva gli insiemi awaiting GREZZI, quindi continuava a segnalare un figlio
 * già letto. L'unica cosa che lo nascondeva era il gate «questa tab è attiva
 * adesso» — transitorio: bastava passare a un'altra tab e il progetto tornava blu
 * per una chat appena letta, per sempre.
 *
 * L'appiglio è `data-attention`, non le classi Tailwind (che non sono un
 * contratto: rinominarne una farebbe passare a verde-vuoto un locator morto). Per
 * una pane 'project' l'attributo è l'AGGREGATO di ciò che resta da guardare —
 * per questo qui la sua sparizione è la prova del fix.
 *
 * Il video serve: la differenza è un fondo blu che respira e poi smette, e uno
 * screenshot statico non prova un comportamento.
 *
 * @covers PROJECT-TABS-03
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  seedProjectInnerChats,
} from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);
test.use({ video: "on" });

const BASE = E2E_BASE;
// Una directory VERA: le pane interne di un progetto ci fanno cd dentro, e un
// path inesistente le fa uscire subito.
const PROJECT_PATH = `/tmp/e2e-progetto-visto-${Date.now()}`;
const PROJECT_PANE_ID = `project:${encodeURIComponent(PROJECT_PATH)}`;

test.describe("Tab «Progetto»: si spegne quando l'hai guardata", () => {
  let chatId: string;
  let chatSessionKey: string;
  let elsewhereId: string;

  /** Il sessionKey che il SERVER ha assegnato: non si indovina dalla convenzione,
   *  o un cambio di formato produce un test verde-vuoto invece di un rosso. */
  async function sessionKeyOf(
    request: import("@playwright/test").APIRequestContext,
    topicId: string,
  ): Promise<string> {
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const body = await res.json();
    const map: Record<string, { id: string; sessionKey?: string }> = body.topics ?? {};
    const found = map[topicId];
    if (!found?.sessionKey) {
      throw new Error(`la topic ${topicId} non ha sessionKey: il seed della fase non può funzionare`);
    }
    return found.sessionKey;
  }

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-progetto-visto" }));
    const stamp = Date.now();
    const chat = await createTopic(request, `visto-dentro-${stamp}`, { projectPath: PROJECT_PATH });
    chatId = chat.id;
    chatSessionKey = await sessionKeyOf(request, chatId);
    // Una seconda tab FUORI dal progetto: serve a dimostrare che il fill non
    // torna quando sposti il fuoco altrove (il vecchio gate lo faceva tornare).
    const altrove = await createTopic(request, `visto-altrove-${stamp}`);
    elsewhereId = altrove.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [chatId, elsewhereId]) {
      if (id) await deleteTopic(request, id).catch(() => {});
    }
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ request }) => {
    // Superficie ermetica: prima si azzera, POI si semina il pane del progetto
    // (seedProjectPane appende allo store appena riscritto).
    await resetPaneStore(request, [elsewhereId]);
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
    await seedProjectPane(request, PROJECT_PATH);
    // La chat del progetto è una tab APERTA dentro il progetto: è ciò che l'utente
    // si trova davanti aprendolo, quindi è ciò che può guardare.
    await seedProjectInnerChats(request, PROJECT_PATH, [chatId]);
  });

  test("un turno finito dentro il progetto accende la tab, guardarlo la spegne per sempre", async ({ page }) => {
    // L'intercetto va installato PRIMA del goto, o la connessione iniziale sfugge.
    const ws = await interceptWebSocket(page);
    await goToApp(page);

    const tabProgetto = page.locator(`[role="tab"][data-pane-id="${PROJECT_PANE_ID}"]`);
    await expect(tabProgetto).toBeVisible({ timeout: 20000 });
    // Si parte puliti: nessun tier addosso al progetto.
    await expect(tabProgetto).not.toHaveAttribute("data-attention", /input|done/);

    // Il turno della chat DENTRO il progetto finisce.
    ws.send({
      type: "session:state",
      sessionKey: chatSessionKey,
      state: { phase: "awaiting-user", rev: 1, claudeSessionId: chatSessionKey },
    });

    // Il progetto lo dice: "qui dentro c'è qualcosa che ti aspetta".
    await expect(tabProgetto).toHaveAttribute("data-attention", "done", { timeout: 15000 });

    // L'utente apre il progetto e resta sulla chat oltre la soglia del "visto"
    // (SEEN_DWELL_MS = 1200 ms). Il fill deve cadere DA SÉ, senza altri click.
    await tabProgetto.click();
    await expect(tabProgetto).not.toHaveAttribute("data-attention", /input|done/, { timeout: 15000 });

    // E qui il bug: sposta il fuoco altrove. Prima tornava blu — il gate era
    // «la tab è attiva adesso», non «l'ho letta».
    const tabElsewhere = page.locator(`[role="tab"][data-pane-id]`).filter({ hasText: /visto-altrove/ }).first();
    await expect(tabElsewhere).toBeVisible({ timeout: 10000 });
    await tabElsewhere.click();

    // Resta spenta. La fase è ancora `awaiting-user` — è il "visto" a reggere,
    // non l'assenza dello stato.
    await expect(tabProgetto).not.toHaveAttribute("data-attention", /input|done/);
    await page.waitForTimeout(2000);
    await expect(tabProgetto).not.toHaveAttribute("data-attention", /input|done/);

    // Un turno NUOVO deve riaccenderla: spegnersi per sempre sarebbe l'altro bug.
    // Il "visto" cade sul FRONTE DI SALITA (`resetSeenOnNewAttention`), quindi
    // servono DUE aggiornamenti distinti dello store: la sessione deve prima
    // USCIRE dagli awaiting e poi rientrarci. I due frame vanno separati — non è
    // un'attesa di comodo: un turno che parte e finisce nello stesso tick non è
    // un turno, e mandati insieme React li unisce in un solo effetto dove il
    // fronte non esiste.
    ws.send({
      type: "session:state",
      sessionKey: chatSessionKey,
      state: { phase: "running", rev: 2, claudeSessionId: chatSessionKey },
    });
    await page.waitForTimeout(1000);
    ws.send({
      type: "session:state",
      sessionKey: chatSessionKey,
      state: { phase: "awaiting-approval", rev: 3, claudeSessionId: chatSessionKey },
    });
    await expect(tabProgetto).toHaveAttribute("data-attention", "input", { timeout: 15000 });
  });

  /**
   * Il caso che si misura sul campo, non un caso di scuola: sulla macchina di
   * sviluppo dei 22 figli che tenevano accesi i progetti, 21 erano chat CHIUSE
   * ferme su `awaiting-user` — alcune di settimane prima. Una chat chiusa non ha
   * riga in sidebar né tab: nessuna soglia può marcarla vista, quindi non c'è
   * NESSUN posto dove andare a spegnere il progetto. Il "visto" non basta: questi
   * figli non devono proprio contare.
   */
  test("una chat CHIUSA parcheggiata in attesa non accende il progetto", async ({ page, request }) => {
    const stamp = Date.now();
    const chiusa = await createTopic(request, `visto-chiusa-${stamp}`, { projectPath: PROJECT_PATH });
    const closedKey = await sessionKeyOf(request, chiusa.id);
    // Archiviare è una DELETE con `{archived:true}` (soft delete), non una PATCH:
    // il PATCH del campo passa senza errore e non archivia niente — un test che
    // lo usasse verificherebbe una chat APERTA credendola chiusa.
    const chiuso = await request.delete(`${BASE}/api/topics/${chiusa.id}`, {
      data: { archived: true },
      ignoreHTTPSErrors: true,
    });
    expect(chiuso.ok(), "la chat di prova dev'essere davvero archiviata").toBeTruthy();
    const dopo = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const mappa = ((await dopo.json()) as { topics: Record<string, { archived?: boolean }> }).topics;
    expect(mappa[chiusa.id]?.archived, "il server deve riportarla archiviata").toBe(true);
    try {
      const ws = await interceptWebSocket(page);
      await goToApp(page);

      const tabProgetto = page.locator(`[role="tab"][data-pane-id="${PROJECT_PANE_ID}"]`);
      await expect(tabProgetto).toBeVisible({ timeout: 20000 });

      // Il turno della chat CHIUSA finisce. Non deve dire niente al progetto.
      ws.send({
        type: "session:state",
        sessionKey: closedKey,
        state: { phase: "awaiting-user", rev: 1, claudeSessionId: closedKey },
      });
      await page.waitForTimeout(2000);
      await expect(tabProgetto).not.toHaveAttribute("data-attention", /input|done/);

      // Controprova sullo STESSO canale: la chat APERTA dello stesso progetto
      // accende. Senza, un verde qui direbbe solo «non è arrivato niente».
      ws.send({
        type: "session:state",
        sessionKey: chatSessionKey,
        state: { phase: "awaiting-user", rev: 1, claudeSessionId: chatSessionKey },
      });
      await expect(tabProgetto).toHaveAttribute("data-attention", "done", { timeout: 15000 });
    } finally {
      await deleteTopic(request, chiusa.id).catch(() => {});
    }
  });
});
