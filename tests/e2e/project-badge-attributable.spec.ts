/**
 * Il numero su una tab «Progetto» deve avere un PROPRIETARIO che si possa trovare.
 *
 * Il caso vero, misurato il 03/08. Il progetto «Guido AI» mostrava `1` e nessuna
 * tab dentro rivendicava quel numero. Il conteggio era giusto — una chat ferma su
 * `awaiting-user` — ma non era ATTRIBUIBILE, e per una ragione che nessuna delle
 * due parti sbagliava da sola:
 *
 *   · il badge di un progetto è un ROLLUP dei figli, e i figli possono benissimo
 *     essere fuori vista (accordion chiuso, altro gruppo, nessuna tab aperta);
 *   · una tab SELEZIONATA non porta badge — è la spec, fissata da TAB-BADGE-07:
 *     non ha senso segnalare a qualcuno ciò che sta già guardando.
 *
 * Quel progetto aveva UNA sola pane interna, quindi quella chat era per
 * costruzione sempre la tab attiva. Due regole giuste, e insieme un numero
 * orfano: il progetto diceva «1», il figlio che lo produceva diceva niente.
 *
 * La soppressione non si tocca (romperebbe TAB-BADGE-07, che difende una cosa
 * giusta). Quello che mancava era il modo di RISALIRE dal numero al suo autore,
 * ed è ciò che questo file difende: il badge del progetto nomina i figli che
 * stanno suonando, sul badge stesso e nel nome accessibile della tab.
 *
 * L'invariante è più larga del caso singolo — «un numero mostrato deve essere
 * spiegabile» — ed è per questo che vive in un test e non in un commento: le due
 * metà (rollup puro in `signals.ts`, soppressione nel JSX di `PaneTabBar`) non si
 * incontrano mai in uno unit test.
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
const PROJECT_PATH = `/tmp/e2e-badge-attribuibile-${Date.now()}`;
const PROJECT_PANE_ID = `project:${encodeURIComponent(PROJECT_PATH)}`;

test.describe("Il badge di un progetto dice DI CHI è", () => {
  let chatId: string;
  let chatName: string;
  let chatSessionKey: string;

  /** Il sessionKey che il SERVER ha assegnato: non si indovina dalla convenzione,
   *  o un cambio di formato produce un test verde-vuoto invece di un rosso. */
  async function sessionKeyOf(
    request: import("@playwright/test").APIRequestContext,
    topicId: string,
  ): Promise<string> {
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const body = (await res.json()) as { topics?: Record<string, { id: string; sessionKey?: string }> };
    const found = body.topics?.[topicId];
    if (!found?.sessionKey) {
      throw new Error(`la topic ${topicId} non ha sessionKey: il seed della fase non può funzionare`);
    }
    return found.sessionKey;
  }

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-badge-attribuibile" }));
    chatName = `Lavori aperti da fare ${Date.now()}`;
    const chat = await createTopic(request, chatName, { projectPath: PROJECT_PATH });
    chatId = chat.id;
    chatSessionKey = await sessionKeyOf(request, chatId);
  });

  test.afterAll(async ({ request }) => {
    if (chatId) await deleteTopic(request, chatId).catch(() => {});
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
    await seedProjectPane(request, PROJECT_PATH);
    // UNA sola pane interna: è la forma esatta del caso reale, e la ragione per
    // cui quella chat è sempre la tab attiva del progetto.
    await seedProjectInnerChats(request, PROJECT_PATH, [chatId]);
  });

  test("il numero del progetto nomina il figlio che lo produce, anche quando il figlio non lo mostra", async ({ page }) => {
    const ws = await interceptWebSocket(page);
    await goToApp(page);

    const tabProgetto = page.locator(`[role="tab"][data-pane-id="${PROJECT_PANE_ID}"]`);
    await expect(tabProgetto).toBeVisible({ timeout: 20000 });

    // Il turno della chat dentro il progetto finisce e resta parcheggiato.
    ws.send({
      type: "session:state",
      sessionKey: chatSessionKey,
      state: { phase: "awaiting-user", rev: 1, claudeSessionId: chatSessionKey },
    });

    // Il progetto porta il numero.
    const badge = tabProgetto.locator("span[title]").filter({ hasText: /^\d+$/ }).first();
    await expect(badge).toBeVisible({ timeout: 15000 });
    await expect(badge).toHaveText("1");

    // ...e il numero si spiega: dice quanti e CHI.
    const spiegazione = await badge.getAttribute("title");
    expect(spiegazione, "il badge del progetto deve portare la sua spiegazione").toBeTruthy();
    expect(spiegazione).toContain("1 da guardare");
    expect(spiegazione).toContain(chatName);

    // Lo stesso vale per chi non vede il tooltip: il nome accessibile della tab
    // porta lo stesso contenuto. Il colore non parla, e un tooltip nemmeno.
    const ariaProject = await tabProgetto.getAttribute("aria-label");
    expect(ariaProject).toContain(chatName);
  });

  test("il figlio, che è la tab attiva, resta senza badge — e il progetto resta spiegabile", async ({ page }) => {
    // È la metà che rende il caso possibile, e va difesa insieme all'altra: se
    // un domani qualcuno «risolvesse» il numero orfano togliendo la soppressione,
    // TAB-BADGE-07 diventerebbe rosso e questo test resterebbe verde. Asserirle
    // vicine rende la coppia visibile a chi tocca l'una o l'altra.
    const ws = await interceptWebSocket(page);
    await goToApp(page);

    const tabProgetto = page.locator(`[role="tab"][data-pane-id="${PROJECT_PANE_ID}"]`);
    await expect(tabProgetto).toBeVisible({ timeout: 20000 });
    await tabProgetto.click();

    // Dentro un progetto la pane di una chat ha id `chat:<topicId>`
    // (`createPaneId`), non l'uuid nudo: al primo livello e' l'uuid, qui no.
    const tabChat = page.locator(`[role="tab"][data-pane-id="chat:${chatId}"]`);
    await expect(tabChat).toBeVisible({ timeout: 15000 });
    // Con una sola pane interna, quella chat È la tab attiva del progetto.
    await expect(tabChat).toHaveAttribute("data-active", "true", { timeout: 10000 });

    ws.send({
      type: "session:state",
      sessionKey: chatSessionKey,
      state: { phase: "awaiting-user", rev: 1, claudeSessionId: chatSessionKey },
    });

    // Il progetto conta.
    await expect(tabProgetto).toHaveAttribute("data-attention", /done|input/, { timeout: 15000 });
    // Il figlio selezionato non mostra numeri: è la spec (TAB-BADGE-07).
    const badgeChat = tabChat.locator("span.rounded-full").filter({ hasText: /^\d+$/ });
    await expect(badgeChat).toHaveCount(0);

    // E proprio per questo il numero del progetto deve restare risalibile.
    const badgeProject = tabProgetto.locator("span[title]").filter({ hasText: /^\d+$/ }).first();
    await expect(badgeProject).toBeVisible({ timeout: 10000 });
    expect(await badgeProject.getAttribute("title")).toContain(chatName);
  });
});
