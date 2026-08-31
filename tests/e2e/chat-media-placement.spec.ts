import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * Dove finisce un'immagine, e cosa NON si deve leggere.
 *
 * Segnalato guardando una chat vera: «perche' alla fine della chat allega
 * screenshot? al massimo dovrebbero essere in mezzo quando vuole farli vedere...
 * anche l'url che poi scrive MEDIA:/Users/…/.topics/media/armonia-masonry.png».
 * Due cose in una frase, e solo la seconda era un difetto.
 *
 * IL DIFETTO: la pulizia dei marcatori girava su `content`, ma un messaggio con
 * la timeline si dipinge dai `blocks`, e il testo del blocco arrivava a schermo
 * intatto. Sulla riga vera: due marcatori in coda al blocco 57 di 58, stampati
 * come prosa sotto la risposta.
 *
 * L'ALTRA META' era il progetto. Quelle immagini non le allega nessuno: il
 * server le TROVA, con una scansione di `~/.topics/media` per `mtime`, e le
 * appende a fine turno (`updateLastMessageWithMedia`). Quindi «mettile dove
 * l'agente voleva» non era implementabile: l'agente non l'aveva mai detto.
 *
 * La regola adesso e' una sola, senza casi particolari: il marcatore si disegna
 * DOVE STA SCRITTO. Quello appeso dal server e' in fondo all'ultimo blocco e
 * quindi esce in fondo, come prima; quello che un agente scrive a meta' del
 * discorso esce a meta'. E' il test di ENTRAMBI i versi.
 *
 * @covers CHAT-MEDIA-01
 */
test.describe.serial("Un'immagine sta dove e' dichiarata", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  const A = "/Users/zorahrel/.topics/media/e2e-media-a.png";
  const B = "/Users/zorahrel/.topics/media/e2e-media-b.png";

  test.beforeAll(async ({ request }) => {
    topicName = "Chat Media " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * L'ORDINE A SCHERMO, in una parola per elemento: «testo» o «media».
   *
   * Scende nell'albero e si ferma al primo dei due che incontra, cosi' legge la
   * SEQUENZA e non il conteggio — ed e' la sequenza la prova: con la galleria in
   * coda uscirebbe testo,testo,testo,media,media anche quando i marcatori erano
   * scritti in mezzo.
   */
  const letturaOrdine = (el: Element): string[] => {
    const out: string[] = [];
    const visita = (n: Element) => {
      const id = n.getAttribute("data-testid") || "";
      if (id.startsWith("media-")) { out.push("media"); return; }
      if (n.classList.contains("prose")) { out.push("testo"); return; }
      for (const c of Array.from(n.children)) visita(c);
    };
    visita(el);
    return out;
  };

  /** Il testo che l'utente LEGGE davvero nella bolla dell'assistente. */
  const prosa = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="message-content-assistant"]').last().innerText();

  test("il marcatore appeso dal server non si legge come prosa, e resta in coda", async ({ page, request }) => {
    const coda = `Fatto, ecco le due viste.\nMEDIA:${A}\nMEDIA:${B}`;
    await seedMessage(request, { sessionKey, role: "user", content: "fammi vedere" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: coda,
      blocks: [{ kind: "text", text: coda }],
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const bolla = page.locator('[data-testid="message-content-assistant"]').last();
    await expect(bolla).toBeVisible({ timeout: 10000 });

    // 1) IL MARCATORE NON SI LEGGE. E' la segnalazione, alla lettera.
    const testo = await prosa(page);
    expect(testo, `il marcatore e' finito a schermo:\n${testo}`).not.toContain("MEDIA:");
    expect(testo).not.toContain(".topics/media");
    // La prosa vera invece c'e' ancora: non e' stato tagliato il messaggio.
    expect(testo).toContain("Fatto, ecco le due viste.");

    // 2) E RESTA IN CODA: appesa dal server, quindi in fondo. Non e' un
    //    ripiego, e' la stessa regola — sta dove e' scritta, e li' e' in fondo.
    // SI GUARDA LO SLOT DEL MEDIA, non il pixel: il file di questo test non
    // esiste su disco, quindi `MediaImage` finisce nel suo ramo d'errore
    // (`media-image-error`). E' comunque l'elemento giusto — il posto che
    // l'immagine occupa — e misurarlo non dipende dal caricamento di una
    // risorsa, che in un test e' rumore.
    const ordine = await bolla.evaluate(letturaOrdine);
    expect(ordine.filter((x) => x === "media").length).toBe(2);
    expect(ordine.indexOf("testo")).toBeLessThan(ordine.indexOf("media"));
  });

  test("scritto a META' del discorso, esce a META'", async ({ page, request }) => {
    const inMezzo = `Prima era cosi':\nMEDIA:${A}\ne dopo la cura cosi':\nMEDIA:${B}\nLa differenza e' il velo.`;
    await seedMessage(request, { sessionKey, role: "user", content: "e adesso?" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: inMezzo,
      blocks: [{ kind: "text", text: inMezzo }],
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const bolla = page.locator('[data-testid="message-content-assistant"]').last();
    await expect(bolla).toBeVisible({ timeout: 10000 });

    const testo = await prosa(page);
    expect(testo).not.toContain("MEDIA:");

    // L'ORDINE E' LA PROVA: testo, immagine, testo, immagine, testo. Con la
    // galleria in coda uscirebbe testo, testo, testo, immagine, immagine —
    // ed e' esattamente cio' che faceva prima.
    const ordine = await bolla.evaluate(letturaOrdine);
    expect(ordine, `ordine letto: ${ordine.join(" → ")}`).toEqual(["testo", "media", "testo", "media", "testo"]);
  });
});
