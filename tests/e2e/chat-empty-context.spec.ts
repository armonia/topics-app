/**
 * La chat vuota dice COME risponderà, e lo dice davvero a schermo.
 *
 * Il lavoro originale (78e4f50a) ha 112 righe di test su `contextBits`, la
 * funzione che compone la riga. Tutte verdi, e nessuna guarda il DOM: la
 * funzione può restituire la stringa giusta mentre il componente non la disegna
 * mai. È la forma esatta che ha lasciato passare il bug della presence
 * (e290c513), dove sette test verdi non arrivavano mai al pixel.
 *
 * C'è una ragione in più per guardare QUI: la riga sta dietro `showStarters`,
 * cioè sparisce sotto i 340px di altezza della pane. È una scelta legittima per
 * i suggerimenti, che sono un di più; molto meno per «questa chat agisce senza
 * chiedere», che è l'unica cosa a schermo capace di distinguere una chat che
 * tocca i file da una che domanda prima. Il secondo caso MISURA quella soglia,
 * non la approva: se domani cambia, cambia perché qualcuno l'ha deciso.
 */
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { goToApp, ensureTopicVisible } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const SHOTS = "test-results/chat-empty";

/**
 * Un topic con scelte ESPLICITE.
 *
 * `contextBits` mostra solo ciò che è stato scelto — un campo assente vuol dire
 * «il default», e stampare «modello: auto, effort: auto» sarebbe rumore. Quindi
 * un topic creato senza opzioni produce una riga VUOTA, e un test che non le
 * imposta verificherebbe il nulla credendo di verificare la riga.
 */
const NOME = `empty-context-${Date.now()}`;

test.describe("la chat vuota dice come risponderà", () => {
  let topicId: string;

  test.beforeAll(async ({ request }) => {
    // `provider` è l'unica delle scelte che la rotta di creazione accetta, ed è
    // sufficiente: la riga si popola da lì e il caso resta vero senza dover
    // scrivere nel DB a mano.
    const t = await createTopic(request, NOME, { provider: "claude" });
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    await deleteTopic(request, topicId).catch(() => { /* già andato */ });
  });

  test("EMPTY-01: le scelte del topic si leggono nel vuoto", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await ensureTopicVisible(page, new RegExp(NOME));
    await page.getByRole("treeitem", { name: new RegExp(NOME) }).first().dblclick();

    await expect(page.getByTestId("chat-empty-state")).toBeVisible({ timeout: 15000 });
    const riga = page.getByTestId("chat-empty-context");
    await expect(riga).toBeVisible({ timeout: 10000 });
    // «via claude»: la scelta fatta, non un default stampato per riempire.
    await expect(riga).toContainText(/claude/i);

    // E IL MODELLO VERO. Il topic non ne impone uno, quindi `topic.model` e'
    // vuoto e la riga taceva - mentre la barra sotto al composer mostrava gia'
    // `claude-opus-5`. Due superfici a un centimetro l'una dall'altra che
    // dicevano due cose diverse sulla stessa chat, e quella muta era proprio
    // quella che si legge PRIMA di scrivere. Qui si verifica che ora
    // concordino: si legge il modello dal `data-model` del picker, cioe' dalla
    // superficie che gia' lo sapeva, invece di scriverne uno atteso a mano.
    const modelloBarra = await page.locator("[data-model]").first().getAttribute("data-model");
    expect(modelloBarra, "la barra deve dichiarare un modello").toBeTruthy();
    await expect(riga, "la riga del vuoto dice lo stesso modello della barra")
      .toContainText(String(modelloBarra).split("[")[0]);
    await page.screenshot({ path: join(SHOTS, "chat-vuota-contesto.png") });
  });

  test("EMPTY-02: sotto i 340px di pane la riga non c'è, sopra sì", async ({ page }) => {
    // Lo stato ATTUALE, dichiarato: la riga condivide la soglia dei
    // suggerimenti. Le due metà servono entrambe — senza la seconda, il caso
    // passerebbe anche se la riga fosse sparita per sempre.
    await page.setViewportSize({ width: 1100, height: 300 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await ensureTopicVisible(page, new RegExp(NOME));
    await page.getByRole("treeitem", { name: new RegExp(NOME) }).first().dblclick();
    await expect(page.getByTestId("chat-empty-context")).toHaveCount(0);

    await page.setViewportSize({ width: 1100, height: 900 });
    await expect(page.getByTestId("chat-empty-context")).toBeVisible({ timeout: 10000 });
  });
});
