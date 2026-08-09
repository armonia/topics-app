/**
 * LA BARRA DELLE TAB È UN VETRO SOPRA LA CONVERSAZIONE — misurato, non guardato.
 *
 * Il cambio (Attilio, 08/08: «rimuovere la linea sotto la tab bar, togliendo
 * anche l'eventuale sfondo, in modo da creare un effetto overlay; così la chat
 * va proprio sotto la tab bar») ha tre parti, e ognuna può rompersi da sola:
 *
 *  1. la barra esce dal flusso e si sovrappone alla pane (`.pane-chrome-bar`);
 *  2. la conversazione COMINCIA sotto di lei — cioè il suo contenitore parte in
 *     cima alla card, non sotto la barra;
 *  3. a riposo però non c'è niente di nascosto: il varco in cima alla lista
 *     (l'`Header` di Virtuoso) vale esattamente l'altezza della barra.
 *
 * Il punto 3 è quello che si perde per primo, e in silenzio: basta che
 * `--chrome-bar-h` smetta di arrivare — una card che dimentica
 * `CHROME_BAR_H_VAR`, un rebuild che non rigenera la classe arbitraria — perché
 * il varco vada a zero e il primo messaggio nasca coperto. Non lancia niente,
 * non colora niente di rosso: si vede solo aprendo una chat e leggendo una riga
 * tagliata a metà. Quindi si misura qui.
 *
 * L'ultimo test è la prova dell'effetto vero e proprio: scorrendo, un messaggio
 * deve finire SOTTO la barra. Se un giorno la barra tornasse un ripiano nel
 * flusso, quel test diventa rosso mentre gli altri tre resterebbero verdi —
 * perché con la barra nel flusso «niente di nascosto» è vero per costruzione.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/** Quanti messaggi bastano perché la lista scorra davvero in un viewport da 800. */
const SEMI = 24;

const barra = (page: Page) => page.locator(".pane-chrome-bar").first();
const contenitore = (page: Page) => page.getByTestId("chat-scroll-container").first();

/**
 * DUE conversazioni, e la differenza NON è cosmetica.
 *
 * «A riposo non c'è niente di nascosto» è vero solo dove la lista NON scorre.
 * Una chat lunga si apre ancorata in fondo, quindi i messaggi in cima stanno
 * sotto la barra — e ci stanno per progetto, è l'effetto stesso. Misurare il
 * varco lì significherebbe misurare lo scroll. Il varco si vede sulla chat
 * CORTA: contenuto più basso del viewport, nessuno scorrimento possibile, e
 * allora la posizione del primo messaggio dipende SOLO dall'Header.
 *
 * (È il primo rosso di questa spec, e va scritto: il test lungo diceva
 * «nascosto» di una cosa che era semplicemente scorsa.)
 */
let lungaId = "";
let lungaNome = "";
let cortaId = "";
let cortaNome = "";

test.beforeAll(async ({ request }) => {
  const stamp = Date.now();
  lungaNome = `E2E-Overlay-Lunga-${stamp}`;
  const lunga = await createTopic(request, lungaNome);
  lungaId = lunga.id;
  for (let i = 0; i < SEMI; i++) {
    await request.post(`${BASE}/api/topics/${lungaId}/system-message`, {
      data: { content: `Riga di semina numero ${i} — serve solo a far scorrere la lista.` },
    });
  }

  cortaNome = `E2E-Overlay-Corta-${stamp}`;
  const corta = await createTopic(request, cortaNome);
  cortaId = corta.id;
  await request.post(`${BASE}/api/topics/${cortaId}/system-message`, {
    data: { content: "Una riga sola: questa chat non deve scorrere." },
  });
});

test.afterAll(async ({ request }) => {
  for (const id of [lungaId, cortaId]) {
    if (id) await deleteTopic(request, id).catch(() => {});
  }
});

async function apri(page: Page, request: APIRequestContext, id: string, nome: string) {
  await resetPaneStore(request, [id]);
  await goToApp(page);
  await openTopic(page, nome);
  await expect(contenitore(page)).toBeVisible({ timeout: 15000 });
}

test.describe("La riga di chrome sta SOPRA la pane, non prima di lei", () => {
  test("OVERLAY-1: la barra è fuori dal flusso e la conversazione le comincia sotto", async ({ page, request }) => {
    await apri(page, request, lungaId, lungaNome);
    const b = barra(page);
    await expect(b).toBeVisible({ timeout: 15000 });

    // Fuori dal flusso: senza questo, tutto il resto è la vecchia geometria
    // travestita.
    await expect(b).toHaveCSS("position", "absolute");

    const rBarra = (await b.boundingBox())!;
    const rLista = (await contenitore(page).boundingBox())!;

    // Il contenitore della conversazione comincia ALL'ALTEZZA della barra o
    // sopra, non dopo: è la definizione di «ci passa sotto». Con la barra nel
    // flusso qui ci sarebbero 40px di scarto.
    expect(rLista.y).toBeLessThanOrEqual(rBarra.y + 1);
  });

  test("OVERLAY-2: su una chat che non scorre, il primo messaggio nasce SOTTO la barra", async ({ page, request }) => {
    await apri(page, request, cortaId, cortaNome);
    const rBarra = (await barra(page).boundingBox())!;
    const fondoBarra = rBarra.y + rBarra.height;

    // Precondizione esplicita: se questa chat scorresse, il test misurerebbe
    // lo scroll invece del varco e passerebbe (o fallirebbe) per il motivo
    // sbagliato.
    const scorre = await contenitore(page).evaluate((el) => el.scrollHeight > el.clientHeight + 4);
    expect(scorre, "la chat corta è diventata scrollabile: la semina non è più corta").toBe(false);

    const cime = await page.evaluate(() => {
      const lista = document.querySelector('[data-testid="virtuoso-item-list"]');
      if (!lista) return [];
      return Array.from(lista.children).map((el) => el.getBoundingClientRect().top);
    });
    expect(cime.length, "nessun messaggio montato").toBeGreaterThan(0);

    // Tolleranza di UN pixel, e non di più: è l'arrotondamento del layout, non
    // un margine di comodo. Senza varco lo scarto sarebbe di decine di pixel.
    expect(Math.min(...cime)).toBeGreaterThanOrEqual(fondoBarra - 1);
  });

  test("OVERLAY-3: il varco in cima vale ESATTAMENTE l'altezza della barra", async ({ page, request }) => {
    await apri(page, request, lungaId, lungaNome);
    // La misura diretta della cosa che si rompe in silenzio. Il varco è il
    // primo figlio dello scroller di Virtuoso (l'Header), e la variabile che lo
    // alimenta deve arrivare fin lì.
    const rBarra = (await barra(page).boundingBox())!;
    // Si misura l'ELEMENTO, non la variabile che dovrebbe alimentarlo: fra le
    // due c'è una regola condizionale (`.chat-under-chrome:first-child`), ed è
    // proprio lì che il varco può andare a zero senza che nessuno se ne accorga.
    const rVarco = await page.getByTestId("chat-top-gutter").first().evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(rVarco).toBeCloseTo(rBarra.height, 0);
  });

  test("OVERLAY-4: scorrendo, i messaggi passano DAVVERO sotto la barra", async ({ page, request }) => {
    await apri(page, request, lungaId, lungaNome);
    const rBarra = (await barra(page).boundingBox())!;
    const fondoBarra = rBarra.y + rBarra.height;

    // Si scorre verso l'alto di mezzo schermo: qualunque messaggio che prima
    // stava appena sotto la barra deve ora trovarsi in parte dietro di lei.
    await contenitore(page).evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 300); });

    await expect.poll(async () => {
      return page.evaluate((soglia) => {
        const lista = document.querySelector('[data-testid="virtuoso-item-list"]');
        if (!lista) return 0;
        // Quanti messaggi hanno la loro cima sopra il fondo della barra, pur
        // essendo ancora dentro il viewport: sono quelli che le stanno sotto.
        return Array.from(lista.children).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top < soglia && r.bottom > 0;
        }).length;
      }, fondoBarra);
    }, { timeout: 10000, message: "nessun messaggio è finito sotto la barra" }).toBeGreaterThan(0);
  });
});
