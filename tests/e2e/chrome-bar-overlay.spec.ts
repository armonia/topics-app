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
let longId = "";
let longName = "";
let cortaId = "";
let cortaNome = "";

test.beforeAll(async ({ request }) => {
  const stamp = Date.now();
  longName = `E2E-Overlay-Lunga-${stamp}`;
  const lunga = await createTopic(request, longName);
  longId = lunga.id;
  for (let i = 0; i < SEMI; i++) {
    await request.post(`${BASE}/api/topics/${longId}/system-message`, {
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
  for (const id of [longId, cortaId]) {
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
    test.info().annotations.push({ type: "spec", description: "CHROME-01" });
    await apri(page, request, longId, longName);
    const b = barra(page);
    await expect(b).toBeVisible({ timeout: 15000 });

    // Fuori dal flusso: senza questo, tutto il resto è la vecchia geometria
    // travestita.
    await expect(b).toHaveCSS("position", "absolute");

    const rBarra = (await b.boundingBox())!;
    const rList = (await contenitore(page).boundingBox())!;

    // Il contenitore della conversazione comincia ALL'ALTEZZA della barra o
    // sopra, non dopo: è la definizione di «ci passa sotto». Con la barra nel
    // flusso qui ci sarebbero 40px di scarto.
    expect(rList.y).toBeLessThanOrEqual(rBarra.y + 1);
  });

  test("OVERLAY-2: su una chat che non scorre, il primo messaggio nasce SOTTO la barra", async ({ page, request }) => {
    await apri(page, request, cortaId, cortaNome);
    const rBarra = (await barra(page).boundingBox())!;
    const bottomBar = rBarra.y + rBarra.height;

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
    expect(Math.min(...cime)).toBeGreaterThanOrEqual(bottomBar - 1);
  });

  test("OVERLAY-3: il varco in cima vale ESATTAMENTE l'altezza della barra", async ({ page, request }) => {
    await apri(page, request, longId, longName);
    // La misura diretta della cosa che si rompe in silenzio. Il varco è il
    // primo figlio dello scroller di Virtuoso (l'Header), e la variabile che lo
    // alimenta deve arrivare fin lì.
    const rBarra = (await barra(page).boundingBox())!;
    // Si misura l'ELEMENTO, non la variabile che dovrebbe alimentarlo: fra le
    // due c'è una regola condizionale (`.chat-under-chrome:first-child`), ed è
    // proprio lì che il varco può andare a zero senza che nessuno se ne accorga.
    // `expect.poll` and not a single read, and not generic patience: the gutter
    // lives on a CSS variable switched on by a CONDITIONAL rule
    // (`.chat-under-chrome:first-child`), so there is an instant — between the
    // scroller mounting and the first style applying — where it is 0. On a Mac
    // that instant is never seen; on a shared runner a bare read lands in it
    // every so often. Measured 2026-08-26 in CI (run 33016943371): "Expected 40,
    // Received 0" on the first attempt and green on the retry, against 16
    // consecutive green runs locally.
    //
    // What the case protects does NOT change: the gutter has to be worth the
    // height of the bar, and if it stays at zero this poll times out and the red
    // arrives all the same. Proved by injecting the defect (`--chat-gutter: 0px`
    // in the rule): the case fails with its own message. What it stops doing is
    // measuring how fast the machine is.
    await expect
      .poll(
        async () => page.getByTestId("chat-top-gutter").first().evaluate((el) => Math.round(el.getBoundingClientRect().height)),
        { timeout: 10_000, message: "the top gutter never reached the height of the bar" },
      )
      .toBe(Math.round(rBarra.height));
  });

  test("OVERLAY-4: scorrendo, i messaggi passano DAVVERO sotto la barra", async ({ page, request }) => {
    await apri(page, request, longId, longName);
    const rBarra = (await barra(page).boundingBox())!;
    const bottomBar = rBarra.y + rBarra.height;

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
      }, bottomBar);
    }, { timeout: 10000, message: "nessun messaggio è finito sotto la barra" }).toBeGreaterThan(0);
  });

  /**
   * WHAT OVERLAY-4 CANNOT SEE: the rects are right and the pixels are cut.
   *
   * The transcript rises under the bar with a NEGATIVE MARGIN, so it leaves its
   * own parent box. Every wrapper between the pane cell and the transcript used
   * to be `overflow: hidden` starting at the bottom of the bar (the cell holds
   * the inset), and a clipped element still reports the rect it would have had:
   * `getBoundingClientRect` knows nothing about clipping. That is why OVERLAY-1
   * and OVERLAY-4 stayed green for weeks over a bar with nothing but flat
   * background under it, and why the defect was only ever found by reading
   * composited pixels (`chrome-bar-worst-case-contrast.spec.ts`, backdrop
   * spread 0.0000 across a whole sweep).
   *
   * This case measures the CAUSE, so the red says which element to open. The
   * pixels are measured by the contrast spec; here the ancestor chain is walked
   * and each wrapper is asked whether it clips vertically. Two clipping
   * mechanisms are checked, because either one alone does it: `overflow-y`
   * anything but `visible`, and paint containment (`contain: paint|content|
   * strict`), which clips without touching `overflow`.
   *
   * THE CELL IS EXCLUDED ON PURPOSE, and it is not a gap in the check: it is
   * the one clip that has to survive. It cuts exactly on the top edge of the
   * pane, so the transcript risen by 40 stops flush instead of spilling into
   * the pane above. Asserted here as well, so "fixing" a future red by opening
   * up the cell fails immediately.
   */
  test("OVERLAY-6: fra cella e trascritto nessun antenato ritaglia in verticale", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-01" });
    await apri(page, request, longId, longName);
    await expect(barra(page)).toBeVisible({ timeout: 15000 });

    const catena = await contenitore(page).evaluate((start) => {
      const clipY = (s: CSSStyleDeclaration) =>
        s.overflowY !== "visible" || /\b(paint|content|strict)\b/.test(s.contain);
      const nome = (el: Element) => {
        const shell = el.getAttribute("data-pane-shell");
        const testId = el.getAttribute("data-testid");
        const cls = String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
        return [el.tagName.toLowerCase(), shell ? `[pane-shell]` : "", testId ? `[${testId}]` : "", cls ? `.${cls}` : ""].join("");
      };
      const fra: { nome: string; overflowY: string; contain: string; clip: boolean }[] = [];
      let cella: { nome: string; clip: boolean } | null = null;
      for (let el = start.parentElement; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (el.hasAttribute("data-pane-shell")) {
          cella = { nome: nome(el), clip: clipY(s) };
          break;
        }
        fra.push({ nome: nome(el), overflowY: s.overflowY, contain: s.contain, clip: clipY(s) });
      }
      return { fra, cella, partenza: nome(start) };
    });

    expect(catena.cella, "nessuna cella `[data-pane-shell]` sopra il trascritto").not.toBeNull();

    // Printed whatever the verdict: the chain is the map of the problem, and a
    // card that has to decide where to put a wrapper should not have to
    // re-derive it from the components.
    console.log(
      `\n[CATENA] ${catena.partenza} → ${catena.fra.map((n) => `${n.nome} (overflow-y:${n.overflowY}${n.clip ? " ✂" : ""})`).join(" → ")} → ${catena.cella?.nome}\n`,
    );

    const offenders = catena.fra.filter((n) => n.clip);
    expect(
      offenders.map((n) => n.nome),
      "un wrapper fra la cella e il trascritto ritaglia in verticale: il trascritto risale sotto la barra e viene tagliato proprio li'. Serve `chrome-passthrough-y` (overflow-x: clip; overflow-y: visible)",
    ).toEqual([]);

    expect(
      catena.cella!.clip,
      "la CELLA della pane ha smesso di ritagliare: senza quel taglio il trascritto risalito esce dal bordo superiore della pane",
    ).toBe(true);
  });

  /**
   * L'ALTRA META' DELL'EFFETTO, e quella che si rompe per prima.
   *
   * OVERLAY-2 misura il varco dove la lista NON scorre. Il caso che si vede
   * usando l'app e' l'opposto: chat lunga, si risale fino in cima, e li' il
   * primo messaggio deve FERMARSI al fondo della barra invece di scivolarci
   * dietro. E' il caso in cui il varco lavora davvero: senza di lui la risalita
   * arriva in cima con il messaggio 1 nascosto per l'altezza della barra, e
   * nessuna quantita' di scroll lo tira fuori, perche' non c'e' piu' niente da
   * scorrere.
   *
   * Si risale con la ROTELLA e non scrivendo `scrollTop`. Due ragioni, e sono
   * state entrambe misurate su questa spec: `chat-scroll-container` e'
   * l'involucro, non lo scroller (Virtuoso si crea il proprio li' dentro),
   * quindi assegnargli `scrollTop` non muove niente; e cercare "il primo
   * antenato scrollabile" trova un elemento che accetta il valore e poi si
   * riancora al fondo, cioe' un test verde su una chat mai risalita. La rotella
   * passa dal vero gestore di scroll, come il dito di chi usa l'app.
   *
   * La condizione di arrivo non e' un numero di pixel ma l'ESISTENZA di
   * `data-index="0"`: e' Virtuoso stesso a dire che il primo messaggio della
   * conversazione e' montato, cioe' che siamo davvero in cima.
   */
  test("OVERLAY-5: risalita fino in cima, il primo messaggio si ferma al fondo della barra", async ({ page, request }) => {
    await apri(page, request, longId, longName);
    const b = barra(page);
    await expect(b).toBeVisible({ timeout: 15000 });
    await page.waitForSelector('[data-testid="virtuoso-item-list"]', { timeout: 15000 });

    const primo = page.locator('[data-testid="virtuoso-item-list"] > [data-index="0"]');
    const area = (await contenitore(page).boundingBox())!;
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    await page.mouse.move(cx, cy);

    // Si risale a strappi finche' il messaggio 1 non e' montato: la chat si
    // apre ancorata in fondo, quindi in cima ci si arriva solo scorrendo.
    // La condizione e' il montaggio, non un tempo: il giro successivo parte
    // appena Virtuoso non ha ancora prodotto `data-index="0"`, e si ferma
    // nell'istante in cui lo produce.
    await expect
      .poll(
        async () => {
          if (await primo.count()) return true;
          await page.mouse.wheel(0, -600);
          return false;
        },
        {
          timeout: 20_000,
          intervals: [50],
          message: "il messaggio 1 non e' mai stato montato: la risalita non ha funzionato",
        },
      )
      .toBe(true);

    // Un altro strappo a vuoto: se la lista si riancorasse al fondo, lo farebbe
    // adesso. Non si aspetta un TEMPO ma la quiete: la cima del primo messaggio
    // deve smettere di muoversi. Un tempo fisso qui e' un tiro a indovinare in
    // due direzioni - troppo corto misura durante l'inerzia dello scroll,
    // troppo lungo si paga a ogni passata anche quando la lista era gia' ferma.
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="virtuoso-item-list"] > [data-index="0"]');
        if (!el) return false;
        const w = window as unknown as { __cimaPrec?: number; __fermoDa?: number };
        const y = Math.round(el.getBoundingClientRect().top);
        if (w.__cimaPrec === y) w.__fermoDa = (w.__fermoDa ?? 0) + 1;
        else { w.__cimaPrec = y; w.__fermoDa = 0; }
        return (w.__fermoDa ?? 0) >= 5;
      },
      undefined,
      { polling: "raf", timeout: 10_000 },
    );

    const rBarra = (await b.boundingBox())!;
    const bottomBar = rBarra.y + rBarra.height;
    const firstTop = (await primo.boundingBox())!.y;

    // Tolleranza di UN pixel: l'arrotondamento del layout, non un margine di
    // comodo. Senza varco lo scarto sarebbe l'altezza intera della barra.
    expect(
      firstTop,
      `la cima del primo messaggio (${firstTop}px) sta sopra il fondo della barra (${bottomBar}px): il testo e' coperto`,
    ).toBeGreaterThanOrEqual(bottomBar - 1);
  });
});
