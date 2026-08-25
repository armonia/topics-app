/**
 * «Qualcuno sta scrivendo» non deve muovere la chat.
 *
 * La segnalazione era: «mentre digito sulle chat di Topics, si illumina e flasha
 * la chat». Il lampeggio era un LAYOUT SHIFT — l'indicatore era un blocco nel
 * flusso che montava e smontava, e siccome si spegne 2 s dopo l'ultimo frame,
 * scrivendo in due produceva un su-e-giù continuo. Il fix è stato consegnato
 * dichiarando che nessun test lo guardava: questa spec chiude quel buco, e lo fa
 * MISURANDO le scatole prima e dopo invece di guardare uno screenshot.
 *
 * Copre anche il secondo difetto dello stesso punto — il proprio eco accendeva
 * l'indicatore — iniettando un frame col `clientId` di un ALTRO client e poi uno
 * col proprio: il primo deve accenderlo, il secondo no.
 *
 * @covers PERF-01
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Indicatore «sta scrivendo»", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `typing-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    // Un trascritto vero serve: a topic vuota la chat rende lo stato di
    // benvenuto e `chat-message-list` (il Virtuoso) non esiste proprio — non e'
    // un dettaglio del test, e' il ramo che si vuole misurare. Il difetto
    // segnalato («flasha mentre scrivo») si vede su una chat CON messaggi:
    // spostare il composer accorcia il trascritto e Virtuoso ri-scorre.
    for (const content of ["Ciao.", "Ecco la risposta.", "Un'altra riga."]) {
      await request.post(`/api/topics/${topicId}/system-message`, { data: { content } });
    }
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("appare e sparisce senza spostare un pixel del composer", async ({ page, chatPage }) => {
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const list = page.getByTestId("chat-message-list").first();
    await expect(list).toBeVisible({ timeout: 10_000 });

    const indicator = page.getByTestId("others-typing-indicator");
    await expect(indicator).toHaveCount(0);

    const before = await chatPage.messageInput.boundingBox();
    const listBefore = await list.boundingBox();
    if (!before || !listBefore) throw new Error("composer non misurabile");

    // `clientId` diverso dal proprio: è un ALTRO che scrive.
    ws.send({ type: "typing", topicId, clientId: "someone-else", text: "" });
    await expect(indicator).toBeVisible({ timeout: 5_000 });

    const during = await chatPage.messageInput.boundingBox();
    const listDuring = await list.boundingBox();
    if (!during || !listDuring) throw new Error("composer non misurabile");
    // Zero, non «poco»: l'indicatore vive in un contenitore alto 0 e ci si ancora
    // sopra in assoluto, quindi non ha modo di spingere niente.
    expect(during.y).toBeCloseTo(before.y, 1);
    expect(during.height).toBeCloseTo(before.height, 1);
    expect(listDuring.height).toBeCloseTo(listBefore.height, 1);

    // …e alla scomparsa (2 s dopo l'ultimo frame) nemmeno.
    await expect(indicator).toHaveCount(0, { timeout: 10_000 });
    const after = await chatPage.messageInput.boundingBox();
    const listAfter = await list.boundingBox();
    if (!after || !listAfter) throw new Error("composer non misurabile");
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(listAfter.height).toBeCloseTo(listBefore.height, 1);
  });

  test("il proprio eco NON accende l'indicatore", async ({ page, chatPage }) => {
    // Il server esclude già la socket mittente, ma non copre lo stesso utente con
    // la topic aperta due volte: lì ognuno vedeva «qualcuno sta scrivendo» mentre
    // a scrivere era lui. Il frame porta `clientId` proprio per questo.
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // L'id di QUESTA socket è quello che il server ha annunciato nel `welcome`:
    // si legge DAL FILO invece di inventarlo o di esporlo su `window` apposta per
    // il test. Se un giorno il welcome smettesse di portarlo, qui si vedrebbe
    // subito — ed è esattamente il caso che ha prodotto il difetto.
    const welcome = ws.getByType("welcome").at(-1);
    expect(welcome, "nessun frame welcome sul filo").toBeTruthy();
    const ownId = JSON.parse(welcome!.data).clientId as string | undefined;
    expect(ownId, "il welcome non porta clientId").toBeTruthy();

    ws.send({ type: "typing", topicId, clientId: ownId!, text: "ciao" });
    // Nessuna attesa arbitraria: si manda subito dopo un frame ALTRUI e si
    // pretende che l'indicatore compaia. Se comparisse per il proprio, sarebbe
    // già visibile prima — e questa asserzione non distinguerebbe i due casi. Per
    // questo si controlla PRIMA che sia assente, con un timeout corto ma reale.
    await expect(page.getByTestId("others-typing-indicator")).toHaveCount(0);
    ws.send({ type: "typing", topicId, clientId: "someone-else", text: "ciao" });
    await expect(page.getByTestId("others-typing-indicator")).toBeVisible({ timeout: 5_000 });
  });
});
