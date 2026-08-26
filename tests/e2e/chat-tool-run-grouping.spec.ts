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
 *
 * @covers CHAT-TOOL-02
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { isEvidenceRun } from "./helpers/evidence";
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
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-02" });
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
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-02" });
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

/**
 * IL ROSSO È PER LA CORSA PERSA, NON PER L'INCIDENTE.
 *
 * Il titolo «N azioni» virava al rosso appena UNA azione falliva: una Read
 * andata male su cinque tingeva la corsa intera, e la riga gridava disastro
 * dove quattro azioni su cinque erano riuscite. Il conto dei fallimenti stava
 * già accanto, sul badge, con il numero. Ora il titolo resta neutro e conta; il
 * rosso pieno arriva solo quando non se n'è salvata nemmeno una.
 *
 * Il rosso non si scrive a mano qui dentro: si LEGGE dal badge «✗ N fallite»
 * del gruppo stesso, che è rosso per costruzione. Così la guardia confronta due
 * colori calcolati dallo stesso schermo, non sopravvive a un cambio di palette
 * per finta, e non può passare perché ha indovinato una costante.
 */
const coloreDi = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).color);

test.describe("Il colore di una corsa di tool", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `tool-red-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    sessionKey = `topic:${topic.id.slice(0, 8)}`;

    // Una corsa = N messaggi assistant con UNA azione ciascuno, che è la forma
    // che l'importer produce davvero (vedi il commento in cima al file).
    const corsa = async (prefisso: string, esiti: Array<"success" | "error">) => {
      for (const [i, status] of esiti.entries()) {
        await seedMessage(request, {
          sessionKey,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: `${prefisso}-${i}`,
              name: "Read",
              args: { path: `/src/${prefisso}-${i}.ts` },
              status,
              ...(status === "error" ? { error: "ENOENT" } : { result: "ok" }),
            },
          ],
        });
      }
    };

    await seedMessage(request, { sessionKey, role: "user", content: "sistema il modulo" });
    // Tre corse, separate da prosa: la prosa spezza la corsa, quindi ogni
    // gruppo è suo e i tre colori stanno sullo stesso schermo, confrontabili.
    await corsa("pulita", ["success", "success", "success"]);
    await seedMessage(request, { sessionKey, role: "assistant", content: "Ora tocco i file." });
    await corsa("parziale", ["success", "error", "success", "success", "success"]);
    await seedMessage(request, { sessionKey, role: "assistant", content: "Riprovo altrove." });
    await corsa("persa", ["error", "error", "error"]);
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("una fallita su cinque lascia il titolo neutro, tre su tre lo fanno rosso", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-02" });
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const gruppi = page.locator('[data-testid="tool-group-row"]');
    await expect(gruppi, "tre corse separate da prosa = tre righe di gruppo").toHaveCount(3, { timeout: 15_000 });
    const [pulita, parziale, persa] = [gruppi.nth(0), gruppi.nth(1), gruppi.nth(2)];

    // La corsa riuscita: nessun badge, e il suo titolo è il NEUTRO di
    // riferimento con cui si misurano gli altri due.
    await expect(pulita.getByTestId("tool-group-title")).toHaveText("3 azioni");
    await expect(pulita.getByTestId("tool-group-errors")).toHaveCount(0);
    const neutro = await coloreDi(pulita.getByTestId("tool-group-title"));

    // 1 su 5: il fallimento si vede, e si vede DOVE va detto. Il badge lo conta,
    // il titolo continua a contare le azioni e non cambia colore.
    await expect(parziale.getByTestId("tool-group-title")).toHaveText("5 azioni");
    await expect(parziale.getByTestId("tool-group-errors")).toContainText("1 fallita");
    const rossoParziale = await coloreDi(parziale.getByTestId("tool-group-errors"));
    const titoloParziale = await coloreDi(parziale.getByTestId("tool-group-title"));
    expect(titoloParziale, "una fallita su cinque non è una corsa fallita").not.toBe(rossoParziale);
    expect(titoloParziale, "resta esattamente il neutro della corsa riuscita").toBe(neutro);

    // 3 su 3: qui il rosso è dovuto, ed è ESATTAMENTE quello del suo badge.
    await expect(persa.getByTestId("tool-group-title")).toHaveText("3 azioni");
    await expect(persa.getByTestId("tool-group-errors")).toContainText("3 fallite");
    const rossoPersa = await coloreDi(persa.getByTestId("tool-group-errors"));
    const titoloPersa = await coloreDi(persa.getByTestId("tool-group-title"));
    expect(titoloPersa, "nessuna azione salvata: la corsa intera è rossa").toBe(rossoPersa);
    expect(titoloPersa, "e non è più il neutro").not.toBe(neutro);

    if (isEvidenceRun()) await scattoDiConsegna(page, gruppi);
  });
});

/**
 * L'anteprima del task: le tre corse a confronto in un ritaglio MISURATO.
 *
 * Il rettangolo si legge dalle righe vere invece di indovinarlo, e la larghezza
 * si allarga finché il rapporto altezza/larghezza sta sotto 0.70: sopra quella
 * soglia la card dell'anteprima taglia il fondo invece di rimpicciolire, e
 * l'ultima corsa (quella rossa, cioè il punto) sparirebbe dal ritaglio.
 */
async function scattoDiConsegna(page: Page, gruppi: Locator): Promise<void> {
  const prima = await gruppi.first().boundingBox();
  const ultima = await gruppi.last().boundingBox();
  if (!prima || !ultima) return;
  const margine = 10;
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.max(0, prima.x - margine);
  const y = Math.max(0, prima.y - margine);
  const height = Math.ceil(ultima.y + ultima.height + margine - y);
  // Stretto: a 268px di larghezza la scala la decide la LARGHEZZA del ritaglio,
  // e ogni pixel di bianco a destra rimpicciolisce le tre righe per niente. 340
  // tiene dentro tutto l'inchiostro (icona, titolo, badge, conteggi) e lascia
  // fuori la colonna dei numeri, che qui è vuota.
  const width = Math.min(viewport.width - x, Math.ceil(Math.max(340, height / 0.68)));
  await page.screenshot({
    path: "test-results/tool-group-colore.png",
    clip: { x, y, width, height },
  });
}
