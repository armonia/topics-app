/**
 * @covers PINTILE-01 @covers PINTILE-02 @covers PINTILE-03
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

/**
 * Le TESSERE dei Fissati.
 *
 * Quello che si difende qui è ciò che si vede: le tessere stanno affiancate e
 * non impilate, nessuna intestazione le annuncia in nessun modo di vista, il
 * click apre una fascia SOTTO la riga giusta (non in fondo alla sezione), il
 * drag cambia riga e la disposizione sopravvive a un ricarico.
 *
 * La geometria si misura con `boundingBox()` invece di fidarsi delle classi:
 * «affiancate» è un fatto di pixel, e una classe Tailwind che smette di essere
 * emessa non lo cambierebbe nel test ma lo cambierebbe sullo schermo.
 */

hermetic(test);

const created: string[] = [];

/** Fissa una lista di id scrivendo direttamente lo stato sidebar: il percorso
 *  dal menu contestuale è già coperto da `sidebar.spec.ts` (PIN-1/PIN-2), e
 *  qui interessa la GRIGLIA, non come ci si è arrivati. */
async function setPins(page: Page, ids: string[], layout?: string[][]): Promise<void> {
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: {
      viewMode: "timeline",
      showArchived: false,
      expandedNodes: [],
      pinnedItems: ids,
      // Senza disposizione esplicita si finisce su UNA riga sola: `reconcile`
      // accoda i fissati che il layout non conosce all'ultima riga finché c'è
      // posto (`PINNED_ROW_MAX`, 6). Chi vuole due righe le chiede.
      //
      // Le larghezze qui sono una formalità: `reconcilePinnedLayout` le
      // PAREGGIA in lettura, di proposito — non esiste un gesto per
      // ridimensionare una tessera, quindi una riga sbilanciata è rumore. La
      // sola leva sulla larghezza è QUANTE ne stanno in riga.
      pinnedLayout: (layout ?? []).map(keys => ({
        keys,
        widths: keys.map(() => 1 / keys.length),
      })),
    },
  });
}

async function gotoSidebar(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

/** Crea una cartella con dentro una `favicon.png` vera, cosi' il progetto ha
 *  un'icona e la tessera prende il ramo «icona reale».
 *
 *  Scritta dal processo di TEST, non da un endpoint: il server di prova gira
 *  sulla stessa macchina e legge lo stesso disco, quindi un endpoint apposta
 *  sarebbe superficie in produzione che esiste solo per i test. Un PNG 1×1
 *  basta — il server serve il file, non lo giudica. */
function mkdirWithIcon(dir: string): void {
  const PNG_1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/favicon.png`, Buffer.from(PNG_1x1, "base64"));
}

const section = (page: Page): Locator => page.getByTestId("sidebar-pinned-section");
const tiles = (page: Page): Locator => section(page).getByTestId("pinned-tile");

/** La TESSERA con questo nome accessibile. Ristretta ai `pinned-tile` di
 *  proposito: una fascia aperta contiene le RIGHE delle tab del progetto, che
 *  sono anch'esse `treeitem` con quel nome — cercare per solo ruolo pescherebbe
 *  la riga dentro la fascia invece del quadrato. */
function tileNamed(page: Page, name: string): Locator {
  return section(page).getByTestId("pinned-tile").and(page.getByRole("treeitem", { name }));
}

/** Il rettangolo di una tessera, per nome accessibile. */
async function boxOf(page: Page, name: string) {
  const box = await tileNamed(page, name).boundingBox();
  expect(box, `la tessera "${name}" deve avere un rettangolo`).not.toBeNull();
  return box!;
}

test.describe("Sidebar — tessere fissate", () => {
  test("TILE-ALLINEA: una sola colonna per gli accordion, e niente spazio prima", async ({ page, request }) => {
    // Measured in the DOM on the real rows: a project's chevron sat in a 20px
    // box around a 14px glyph (ink 11px from the row's edge), a chat with
    // children in a 16px box around a 12px glyph (at 10), a pinned tile in a
    // 12px one (at 8). THREE columns for the same control, in a list where the
    // rows sit one on top of the other.
    //
    // And where there is NO accordion its empty place must not stay behind:
    // "in the normal ones there must be no useless space before the accordion"
    // (card a035f945). That was 12px of slot plus 8 of gap in front of nothing,
    // on every tile that does not open, which is most of them.
    //
    // Why a test and not a look: the defect is GEOMETRY, and a VLM or a
    // distracted eye lose it. Three pixels are not seen, they are measured.
    const a = await createTopic(request, `E2E-Allinea-A-${Date.now()}`);
    const b = await createTopic(request, `E2E-Allinea-B-${Date.now()}`);
    // A PROJECT with an open chat: it is the only tile that really opens
    // (`renderExpanded` answers only for those with tabs), so it is the only
    // way to measure a REAL chevron among the pinned ones.
    const projectDir = `/tmp/e2e-allinea-proj-${Date.now()}`;
    const childTopic = await createTopic(request, `E2E-Allinea-P-${Date.now()}`, { projectPath: projectDir });
    // A SECOND project, deliberately NOT pinned: the tree only lists what is
    // not in the pinned block, so pinning the only project would leave no row
    // with an accordion to compare the tile against.
    const treeDir = `/tmp/e2e-allinea-albero-${Date.now()}`;
    const treeChildTopic = await createTopic(request, `E2E-Allinea-T-${Date.now()}`, { projectPath: treeDir });
    created.push(a.id, b.id, childTopic.id, treeChildTopic.id);
    const chiaveProj = `project:${projectDir}`;
    // Each on its OWN row: row form, that is, the "normal" alignment.
    await setPins(page, [a.id, b.id, chiaveProj, childTopic.id], [[a.id], [b.id], [chiaveProj], [childTopic.id]]);
    await gotoSidebar(page);

    // SETTLED, not immediate. The accordion chevron carries `transition-transform
    // duration-150`, and its bounding box is the box of a ROTATING square: 12px
    // at rest, up to 16.97 crossing 45 degrees. Sampled frame by frame it walks
    // 16.12 -> 12.00 while its ink slides 5.94 -> 8.00, which is precisely the
    // tile's column. Measuring on the first frame therefore reported a 1.7px
    // gap that nobody can see and that is gone two frames later - a moving
    // target read once. Every geometry here is taken when two consecutive
    // frames agree on it.
    const settled = async <T>(take: () => Promise<T>): Promise<T> => {
      let before = JSON.stringify(await take());
      for (let i = 0; i < 40; i++) {
        await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
        const ora = await take();
        if (JSON.stringify(ora) === before) return ora;
        before = JSON.stringify(ora);
      }
      throw new Error(`la geometria non si ferma: ultimo valore ${before}`);
    };

    const misura = async (nome: string) => {
      const tile = tileNamed(page, nome);
      await expect(tile).toBeVisible({ timeout: 10000 });
      return settled(() => tile.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const testo = el.querySelector('[data-testid="pinned-tile-name"]');
        const slot = el.querySelector('[data-testid="pinned-chevron-slot"]');
        const glyph = el.querySelector('[data-testid="pinned-expand-hint"]');
        return {
          testo: testo ? +(testo.getBoundingClientRect().left - r.left).toFixed(1) : null,
          slot: slot ? +slot.getBoundingClientRect().width.toFixed(1) : null,
          // The chevron's INK, not its box: that is what one sees, and that
          // is what sat in three different columns.
          glyph: glyph ? +(glyph.getBoundingClientRect().left - r.left).toFixed(1) : null,
        };
      }));
    };

    const xa = await misura(a.name);
    const xb = await misura(b.name);
    expect(xa.testo, "la prima tessera deve avere un testo misurabile").not.toBeNull();
    expect(xb.testo).not.toBeNull();
    expect(Math.abs(xa.testo! - xb.testo!), "due tessere della stessa forma partono dalla stessa colonna").toBeLessThanOrEqual(0.5);

    // NO DEAD SPACE: a tile that does not open has no slot at all. Falsified
    // by reserving the slot again (as it was before): these two lines go red.
    expect(xa.slot, "una chat non si apre: nessuno slot da riservare").toBeNull();
    expect(xb.slot).toBeNull();

    // THE ACCORDION COLUMN, on the two surfaces that have one: the pinned
    // tile of a project and the project row in the tree.
    const tessera = await misura(projectDir.split("/").pop()!);
    expect(tessera.glyph, "la tessera di un progetto con tab si apre, e mostra il chevron").not.toBeNull();

    const riga = await settled(() => page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[aria-expanded][aria-label^="Expand"], [aria-expanded][aria-label^="Collapse"]');
      if (!button) return null;
      const card = button.parentElement!;
      const glyph = button.querySelector("svg");
      if (!glyph) return null;
      return +(glyph.getBoundingClientRect().left - card.getBoundingClientRect().left).toFixed(1);
    }));
    expect(riga, "serve almeno una riga con accordion nell'albero").not.toBeNull();
    expect(
      Math.abs(riga! - tessera.glyph!),
      `il chevron della riga parte a ${riga}px dal bordo, quello della tessera a ${tessera.glyph}: stesso comando, due colonne`,
    ).toBeLessThanOrEqual(0.5);
  });


  test("TILE-CENTRO: il trigger non sposta cio' che e' centrato", async ({ page, request }) => {
    // Segnalato: «quelle pinnate, icona o testo, devono essere ben centrate e
    // il trigger non dovrebbe partecipare al peso per farlo centrato. Magari
    // potremmo replicare il peso del trigger sulla destra, cosi' da mantenere
    // spaziature, ingombri e allineamenti corretti».
    //
    // In forma STRETTA la tessera centra il suo contenuto. Ma nel flusso, di
    // fianco al contenuto, ci sono anche lo slot del chevron a sinistra e lo
    // slot del «+» a destra: ognuno che pesi in modo diverso dall'altro sposta
    // il centro di meta' della propria larghezza. Il difetto non si vede su una
    // tessera sola, si vede in COLONNA — tessere con e senza «+» mettono
    // l'icona in due x diverse, e la fila sembra storta senza saper dire dove.
    //
    // Si misura il CENTRO del contenuto contro il CENTRO della tessera: e' la
    // sola formulazione che non dipende da quanti ornamenti ci sono attorno.
    const a = await createTopic(request, `E2E-Centro-A-${Date.now()}`);
    const b = await createTopic(request, `E2E-Centro-B-${Date.now()}`);
    created.push(a.id, b.id);
    // UN PROGETTO SENZA FAVICON: il caso che contiene il difetto.
    //
    // Le chat un glifo ce l'hanno sempre (`TYPE_ICONS`), quindi tre chat
    // misuravano solo tessere con qualcosa dentro il contenitore dell'icona.
    // `project` NON e' in quella mappa: una cartella senza favicon rende il
    // contenitore VUOTO, largo zero ma con il suo `gap` ancora nel flusso -
    // ed e' li' che il 17/08 il nome stava a 16px da sinistra contro 8 a
    // destra. Verificato: senza questa riga il sabotaggio resta verde.
    const senzaIcona = `/tmp/e2e-centro-nudo-${Date.now()}`;
    fs.mkdirSync(senzaIcona, { recursive: true });
    // Tre su UNA riga: e' cosi' che la tessera diventa stretta abbastanza da
    // passare in forma quadrata, che e' la forma in cui il centraggio esiste.
    const chiaveNuda = `project:${senzaIcona}`;
    await setPins(page, [a.id, b.id, chiaveNuda], [[a.id, b.id, chiaveNuda]]);
    await gotoSidebar(page);

    // L'INCHIOSTRO, non le scatole. Misurare i box dei figli non distingue il
    // centrato dal non centrato: il nome e' `flex-1`, quindi la sua SCATOLA
    // riempie la riga in tutti e due i casi e lascia sempre la stessa aria ai
    // lati. Cio' che si sposta e' il TESTO dentro quella scatola, ed e' quello
    // che si vede. Si prende con un `Range`, che da' il rettangolo dei glifi
    // davvero disegnati. Verificato togliendo il centraggio: la misura sui box
    // restava verde, questa diventa rossa.
    // ANCHE UNA TESSERA SENZA GLIFO. Le chat un'icona ce l'hanno sempre
    // (`TYPE_ICONS`), quindi tre chat non coprono il caso in cui il
    // contenitore dell'icona resta nel flusso VUOTO: largo zero, ma il `gap`
    // della riga pesa lo stesso, e il nome finisce fuori centro di meta' gap.
    // Misurato il 17/08 sulla sidebar vera: 16px a sinistra contro 8 a destra
    // su una tessera di progetto senza favicon, mentre le tre chat di questo
    // caso restavano a zero. Un caso che non contiene il difetto non lo
    // ferma, ed e' il modo in cui questo test e' stato verde mentre lo
    // schermo era storto.
    const senzaGlifo = await tiles(page).evaluateAll((els) =>
      els.filter((el) => !el.querySelector('img, svg:not([data-testid="pinned-expand-hint"])'))
         .map((el) => el.getAttribute("aria-label") ?? "?"),
    );
    // Non si asserisce che ce ne sia una (dipende da cosa e' fissato): si
    // asserisce che se c'e', e' misurata come le altre - il ciclo sotto le
    // prende tutte.
    if (senzaGlifo.length) console.log(`[TILE-CENTRO] tessere senza glifo misurate: ${senzaGlifo.join(", ")}`);

    const scarti = await tiles(page).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const pezzi: Array<{ left: number; right: number }> = [];
        // Il testo vero, RITAGLIATO dalla scatola che lo contiene: il nome e'
        // `truncate`, quindi il rettangolo del Range e' quello del testo
        // intero, anche la parte che l'ellissi nasconde. Senza il ritaglio si
        // misurerebbe inchiostro che nessuno vede.
        const nodi = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = nodi.nextNode(); n; n = nodi.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const rg = document.createRange();
          rg.selectNodeContents(n);
          const b = rg.getBoundingClientRect();
          const clip = (n.parentElement as HTMLElement).getBoundingClientRect();
          const left = Math.max(b.left, clip.left);
          const right = Math.min(b.right, clip.right);
          if (right > left) pezzi.push({ left, right } as DOMRect);
        }
        // Le icone: hanno una dimensione propria, la loro scatola E' inchiostro.
        // Il chevron no, sta fuori dal flusso per scelta.
        for (const g of el.querySelectorAll('img, svg:not([data-testid="pinned-expand-hint"])')) {
          const b = g.getBoundingClientRect();
          if (b.width > 0) pezzi.push(b);
        }
        if (!pezzi.length) return null;
        const sinistra = Math.min(...pezzi.map((b) => b.left)) - r.left;
        const destra = r.right - Math.max(...pezzi.map((b) => b.right));
        return {
          nome: el.getAttribute("aria-label") ?? "?",
          larghezza: +r.width.toFixed(1),
          sinistra: +sinistra.toFixed(2),
          destra: +destra.toFixed(2),
          // Positivo = l'inchiostro pende a destra.
          scarto: +((sinistra - destra) / 2).toFixed(2),
        };
      }).filter(Boolean),
    );

    // Solo le tessere davvero STRETTE: sopra la soglia della container query
    // la tessera e' una riga e parte da sinistra, che e' voluto.
    type Scarto = { nome: string; larghezza: number; sinistra: number; destra: number; scarto: number };
    const strette = (scarti as Scarto[]).filter((s) => s.larghezza < 104);
    expect(strette.length, `nessuna tessera stretta da misurare: ${JSON.stringify(scarti)}`).toBeGreaterThan(0);
    for (const s of strette) {
      // Il numero OSSERVATO anche quando passa: un verde muto dice solo «non e'
      // peggiorato», e non permette di rispondere a «di quanto era fuori?».
      console.log(`[TILE-CENTRO] ${s.nome} larga ${s.larghezza}: sx ${s.sinistra} · dx ${s.destra} · fuori centro ${s.scarto}px`);
      expect(
        Math.abs(s.scarto),
        `"${s.nome}" (larga ${s.larghezza}) ha ${s.sinistra}px a sinistra e ${s.destra}px a destra: il contenuto e' fuori centro di ${s.scarto}px`,
      ).toBeLessThanOrEqual(0.5);
    }
  });

  test("TILE-CENTRO-b: il centraggio non dipende dal FONT ne' dalla DENSITA'", async ({ page, request }) => {
    // IL CONFINE CHE HA FATTO CADERE TILE-32 IN CI.
    //
    // Il centraggio si misura in frazioni di pixel, e quelle cambiano con la
    // faccia montata: in locale la San Francisco di sistema, sul runner Linux
    // un'altra. Un verde sul portatile non dice niente su cosa succede la'.
    //
    // La prova non e' «passa anche altrove» (i font del runner non li ho), ma
    // «il centraggio non DIPENDE dal font»: `justify-center` divide lo spazio
    // che avanza, e quanto ne avanza dipende dalla larghezza del contenuto,
    // non dalle metriche verticali del carattere. Quello che poteva romperlo
    // era un figlio VUOTO nel flusso, ed e' il difetto corretto oggi.
    // QUATTRO su una riga: sui 244px della colonna due fanno ~118 (forma
    // RIGA, che parte da sinistra e non si centra), quattro fanno ~56, cioe'
    // sotto la soglia dei 104 in cui il centraggio esiste. Con due il caso
    // misurava zero tessere e si fermava - che e' come deve fare, ma non
    // provava niente.
    const a = await createTopic(request, `E2E-Font-A-${Date.now()}`);
    const b2 = await createTopic(request, `E2E-Font-B-${Date.now()}`);
    const c2 = await createTopic(request, `E2E-Font-C-${Date.now()}`);
    created.push(a.id, b2.id, c2.id);
    const nudo = `/tmp/e2e-font-nudo-${Date.now()}`;
    fs.mkdirSync(nudo, { recursive: true });
    const chiave = `project:${nudo}`;
    await setPins(page, [a.id, b2.id, c2.id, chiave], [[a.id, b2.id, c2.id, chiave]]);
    await gotoSidebar(page);

    const misura = async () => tiles(page).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        if (r.width >= 104) return null;
        const pezzi: Array<{ left: number; right: number }> = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.textContent?.trim()) continue;
          // Il CONTEGGIO non e' inchiostro da centrare: sotto i 72px
          // `pinned-tile-count` lo mette `position: absolute` nell'angolo in
          // alto a destra, cioe' CSS lo toglie dal flusso apposta — ed e'
          // sempre il flusso che questo caso misura (il chevron e' escluso
          // qui sotto per la stessa ragione, e il commento di `PinnedTile.tsx`
          // lo dice: «chevron e conteggio ne escono»).
          //
          // Contandolo, una notifica arrivata per conto suo su una delle topic
          // appena create appiccicava un pezzo di inchiostro al bordo destro e
          // il centraggio risultava fuori di ~13px: il rosso accusava il font,
          // che non c'entrava niente — bastava il retry, dove il badge non
          // c'era, per tornare a 0px. `data-notification-count` e' l'appiglio
          // che il badge espone apposta, e non parla nessuna lingua.
          if ((n.parentElement as HTMLElement | null)?.closest("[data-notification-count]")) continue;
          const rg = document.createRange(); rg.selectNodeContents(n);
          const b = rg.getBoundingClientRect();
          const clip = (n.parentElement as HTMLElement).getBoundingClientRect();
          const L = Math.max(b.left, clip.left), R = Math.min(b.right, clip.right);
          if (R > L) pezzi.push({ left: L, right: R });
        }
        for (const g of el.querySelectorAll('img, svg:not([data-testid="pinned-expand-hint"])')) {
          const b = g.getBoundingClientRect();
          if (b.width > 0) pezzi.push({ left: b.left, right: b.right });
        }
        if (!pezzi.length) return null;
        const sx = Math.min(...pezzi.map((x) => x.left)) - r.left;
        const dx = r.right - Math.max(...pezzi.map((x) => x.right));
        return { nome: el.getAttribute("aria-label") ?? "?", scarto: +((sx - dx) / 2).toFixed(2) };
      }).filter(Boolean),
    );

    for (const [family, che] of [
      ["Georgia, serif", "serif"],
      ['"Courier New", monospace', "monospazio"],
      ['"Times New Roman", serif', "x-height bassa"],
    ] as const) {
      await page.addStyleTag({ content: `:root, body, * { font-family: ${family} !important; }` });
      const m = (await misura()) as Array<{ nome: string; scarto: number }>;
      expect(m.length, "servono tessere strette da misurare").toBeGreaterThan(0);
      const peggio = Math.max(...m.map((x) => Math.abs(x.scarto)));
      // eslint-disable-next-line no-console
      console.log(`[TILE-CENTRO-b] ${che.padEnd(14)} ${m.length} tessere, peggiore ${peggio}px`);
      expect(peggio, `con ${family} il centraggio salta: dipende dal font, e in CI la faccia e' un'altra`).toBeLessThanOrEqual(0.5);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-1: le tessere stanno affiancate, e nessuna intestazione le annuncia", async ({ page, request }) => {
    const names = ["E2E-Tile-A", "E2E-Tile-B", "E2E-Tile-C"].map(n => `${n}-${Date.now()}`);
    const ids: string[] = [];
    for (const n of names) {
      const t = await createTopic(request, n);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids);
    await gotoSidebar(page);

    await expect(tiles(page)).toHaveCount(3, { timeout: 15000 });

    // Affiancate: stesso `top`, `left` crescenti. Se tornassero righe piene,
    // i `top` sarebbero diversi e i `left` uguali — cioè l'esatto contrario.
    const boxes = await Promise.all(names.map(n => boxOf(page, n)));
    expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0);
    expect(boxes[1].y).toBeCloseTo(boxes[2].y, 0);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);

    // Tre tessere costano meno di tre righe: l'altezza del blocco è quella di
    // UNA fila, non della loro somma.
    const sectionBox = (await section(page).boundingBox())!;
    expect(sectionBox.height).toBeLessThan(boxes[0].height * 2);

    // Nessuna etichetta, in NESSUNO dei modi di vista rimasti (il modo "per
    // tipo" è stato rimosso il 06/08). Il modo si imposta dal
    // lato server invece di cercare il bottone che lo cicla: qui si verifica
    // l'assenza dell'intestazione, e un click che non trova il suo bersaglio
    // renderebbe questo controllo un test che non può fallire.
    for (const viewMode of ["timeline", "state"] as const) {
      await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
        data: { viewMode, showArchived: false, expandedNodes: [], pinnedItems: ids, pinnedLayout: [] },
      });
      await gotoSidebar(page);
      await expect(tiles(page), `modo ${viewMode}`).toHaveCount(3, { timeout: 15000 });
      await expect(
        page.getByText(/^\s*(Fissati|Pinned)\s*$/),
        `nessuna intestazione nel modo ${viewMode}`,
      ).toHaveCount(0);
    }
  });

  test("TILE-2: il click apre una fascia SOTTO la riga della tessera, non in fondo", async ({ page, request }) => {
    // Due righe: il progetto sta sulla PRIMA, e la fascia deve infilarsi fra le
    // due — se comparisse in coda alla sezione questo test lo vede.
    //
    // La chat del progetto è fissata anch'essa, e non per comodità: una chat
    // senza tab aperta e senza notifiche non entra fra i figli del progetto
    // (`buildSidebarItems` la salta), e senza figli non c'è niente da espandere.
    // Il pin è l'escape documentato che la tiene in lista — e la stessa chat
    // resta anche una tessera sua, che è la semantica «preferiti del Finder»
    // già scelta per i figli fissati.
    const projectPath = "/tmp/e2e-tile-project";
    const chatName = `E2E-TileProjChat-${Date.now()}`;
    const chat = await createTopic(request, chatName, { projectPath });
    created.push(chat.id);

    const projectKey = `project:${projectPath}`;
    await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [projectKey, chat.id],
        pinnedLayout: [
          { keys: [projectKey], widths: [1] },
          { keys: [chat.id], widths: [1] },
        ],
      },
    });
    await gotoSidebar(page);

    const projectTile = tileNamed(page, "e2e-tile-project");
    await expect(projectTile).toBeVisible({ timeout: 15000 });

    const rowTop = (await projectTile.boundingBox())!;
    const loneBefore = await boxOf(page, chatName);
    expect(rowTop.y).toBeLessThan(loneBefore.y); // due righe, il progetto sopra

    await projectTile.click();

    const band = section(page).getByTestId("pinned-expansion");
    await expect(band).toHaveCount(1, { timeout: 10000 });
    const bandBox = (await band.boundingBox())!;
    const loneAfter = await boxOf(page, chatName);

    // La fascia sta FRA la riga del progetto e la riga sotto.
    expect(bandBox.y).toBeGreaterThan(rowTop.y);
    expect(bandBox.y).toBeLessThan(loneAfter.y);
    // E porta la chat del progetto.
    await expect(band.getByText(new RegExp(chatName))).toBeVisible({ timeout: 10000 });
  });

  test("TILE-3: la disposizione a due righe sopravvive al ricarico", async ({ page, request }) => {
    const a = await createTopic(request, `E2E-TileRowA-${Date.now()}`);
    const b = await createTopic(request, `E2E-TileRowB-${Date.now()}`);
    created.push(a.id, b.id);

    await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [a.id, b.id],
        pinnedLayout: [{ keys: [a.id], widths: [1] }, { keys: [b.id], widths: [1] }],
      },
    });
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });

    const first = await tiles(page).nth(0).boundingBox();
    const second = await tiles(page).nth(1).boundingBox();
    // Due righe: `top` diversi. È la disposizione salvata, non il wrap naturale.
    expect(second!.y).toBeGreaterThan(first!.y + first!.height / 2);

    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    const firstAfter = await tiles(page).nth(0).boundingBox();
    const secondAfter = await tiles(page).nth(1).boundingBox();
    expect(secondAfter!.y).toBeGreaterThan(firstAfter!.y + firstAfter!.height / 2);
  });

  test("TILE-4: togliere il pin toglie la tessera, e le altre restano dove sono", async ({ page, request }) => {
    const a = await createTopic(request, `E2E-TileDropA-${Date.now()}`);
    const b = await createTopic(request, `E2E-TileDropB-${Date.now()}`);
    created.push(a.id, b.id);

    await setPins(page, [a.id, b.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });

    await setPins(page, [b.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });
    await expect(tiles(page)).toHaveAttribute("aria-label", /E2E-TileDropB/);
  });

  test("TILE-5: uno stato salvato senza disposizione non rompe niente", async ({ page, request }) => {
    // È il caso di ogni client che aggiorna: i pin ci sono, il campo del layout
    // no. Le tessere devono uscire nell'ordine di pin, senza errori.
    const a = await createTopic(request, `E2E-TileLegacyA-${Date.now()}`);
    const b = await createTopic(request, `E2E-TileLegacyB-${Date.now()}`);
    created.push(a.id, b.id);

    await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [a.id, b.id] },
    });

    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    await gotoSidebar(page);

    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    expect(errors, "nessun errore di pagina").toEqual([]);
  });
  test("TILE-6: la tessera porta ancora la chiave che apre il pane nella griglia", async ({ page, request }) => {
    // È il rischio numero uno di questa change. La tessera scrive DUE tipi sullo
    // stesso dataTransfer: `PINNED_TILE` per il riordino dentro la griglia dei
    // fissati, e `PANEL_ID` per la griglia dei pane, che è il drag «apri qui»
    // che esisteva prima. Se il secondo si perdesse, quel gesto morirebbe senza
    // che niente lo dica — nessun errore, solo un drag che non fa nulla.
    const t = await createTopic(request, `E2E-TileToGrid-${Date.now()}`);
    created.push(t.id);
    await setPins(page, [t.id]);
    await gotoSidebar(page);
    await expect(tiles(page).first()).toBeVisible({ timeout: 15000 });

    // Si legge dal `dataTransfer` vero prodotto dal `dragstart` della tessera,
    // non dal sorgente: un `setData` rimosso passerebbe qualunque lettura del
    // codice, non questa.
    const types = await page.evaluate(() => {
      const el = document.querySelector("[data-pinned-tile]") as HTMLElement | null;
      if (!el) return [];
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      const seen = Array.from(dt.types);
      el.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      return seen;
    });
    expect(types).toContain("application/x-pinned-tile");
    expect(types).toContain("application/x-panel-id");
  });

  test("TILE-7: la tessera di un progetto porta l'id della PANE, non quello della riga", async ({ page, request }) => {
    // Le due chiavi servono a due cose diverse: `PINNED_TILE` e' la chiave della
    // RIGA (il layout), `PANEL_ID` quella della PANE — e per un progetto sono
    // due stringhe (path grezzo vs codificato). Chi riceve `PANEL_ID` apre o
    // sposta una pane: con l'id della riga il drop cadrebbe su una pane che non
    // esiste, senza un errore.
    // Path SUO: `/tmp/e2e-tile-project` è già di TILE-2, e `hermetic` riparte
    // dalla baseline una volta per FILE, non per test — condividerlo significa
    // ereditare le pane e i gruppi che gli altri hanno lasciato aperti.
    const projectPath = "/tmp/e2e-tile-paneid";
    const chat = await createTopic(request, `E2E-TilePaneId-${Date.now()}`, { projectPath });
    created.push(chat.id);
    await setPins(page, [`project:${projectPath}`]);
    await gotoSidebar(page);
    await expect(tiles(page).first()).toBeVisible({ timeout: 15000 });

    const payload = await page.evaluate(() => {
      const el = document.querySelector("[data-pinned-tile]") as HTMLElement | null;
      if (!el) return null;
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      const out = {
        row: dt.getData("application/x-pinned-tile"),
        pane: dt.getData("application/x-panel-id"),
      };
      el.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      return out;
    });
    expect(payload).not.toBeNull();
    expect(payload!.row).toBe(`project:${projectPath}`);
    expect(payload!.pane).toBe(`project:${encodeURIComponent(projectPath)}`);
    expect(payload!.pane).toContain("%2F");
    expect(payload!.pane).not.toBe(payload!.row);
  });

  test("TILE-8: lasciare una tessera CHIUSA su un gruppo la porta dentro quel gruppo", async ({ page, request }) => {
    // Il caso che falliva in silenzio. `movePaneToSpace` sposta una pane
    // ESISTENTE: una tessera fissata con la tab chiusa non ha pane — cioè lo
    // stato normale di un fissato da quando chiuderlo è permesso — quindi il
    // drop non aveva niente da spostare e non faceva nulla, senza un errore.
    const dentro = await createTopic(request, `E2E-TileInGroup-${Date.now()}`);
    const altra = await createTopic(request, `E2E-TileGroupSeed-${Date.now()}`);
    created.push(dentro.id, altra.id);

    // `altra` aperta serve solo a far NASCERE un gruppo: un gruppo si crea
    // portandoci una tab, non da un comando a vuoto.
    await page.request.put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: [altra.id] } });
    await setPins(page, [dentro.id]);
    await gotoSidebar(page);
    await expect(page.locator(`[data-pane-id="${altra.id}"]`).first()).toBeVisible({ timeout: 15000 });

    await page.locator(`[data-pane-id="${altra.id}"]`).first().click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    await page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" }).click();
    await expect(page.getByTestId("sidebar-groups")).toBeVisible({ timeout: 10000 });

    const tile = tiles(page).first();
    await expect(tile).toBeVisible({ timeout: 10000 });

    // Il gruppo BERSAGLIO è quello appena nato, non il predefinito: le card
    // sono due, e colpire la prima che capita proverebbe la cosa sbagliata.
    const targetSpaceId = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll('[data-testid="space-card"], [data-testid="space-card-active"]'),
      ) as HTMLElement[];
      const target = cards
        .map(c => c.getAttribute("data-space-id") ?? "")
        .find(id => id.startsWith("space:") && id !== "space:default");
      return target ?? null;
    });
    expect(targetSpaceId, "dev'esserci un gruppo diverso dal predefinito").not.toBeNull();

    // Drop sintetico: gli stessi eventi che manda il browser, con il
    // dataTransfer prodotto dalla tessera. Playwright non guida un drag HTML5
    // nativo in modo affidabile, e qui interessa il CONTRATTO, non il gesto.
    await page.evaluate((spaceId) => {
      const el = document.querySelector("[data-pinned-tile]") as HTMLElement | null;
      const card = document.querySelector(`[data-space-id="${spaceId}"]`) as HTMLElement | null;
      if (!el || !card) throw new Error("tessera o card mancante");
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      card.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      card.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
    }, targetSpaceId);

    // La cosa fissata è ora una pane VIVA, e vive in QUEL gruppo.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${E2E_BASE}/api/ui-state/pane-store-v2`);
          const env = await res.json();
          const store = env?.value ?? env;
          const pane = store?.panes?.[dentro.id];
          if (!pane) return "nessuna pane";
          return pane.spaceId ?? "gruppo predefinito";
        },
        { timeout: 15000 },
      )
      .toBe(targetSpaceId);
  });

  test("TILE-9: lasciare una tab sui fissati la fissa", async ({ page, request }) => {
    // Il gesto inverso di trascinarla via. Senza, l'unica strada per fissare era
    // il menu contestuale — che dentro una card di gruppo non tutte le righe
    // hanno, quindi da lì una cosa non si poteva proprio fissare.
    const t = await createTopic(request, `E2E-TileAdopt-${Date.now()}`);
    const gia = await createTopic(request, `E2E-TileAdoptSeed-${Date.now()}`);
    created.push(t.id, gia.id);

    // Un fissato serve solo a far esistere la griglia su cui lasciar cadere.
    await page.request.put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: [t.id] } });
    await setPins(page, [gia.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${t.id}"]`).first()).toBeVisible({ timeout: 10000 });

    await page.evaluate((paneId) => {
      const tab = document.querySelector(`[data-pane-id="${paneId}"]`) as HTMLElement | null;
      const grid = document.querySelector('[data-testid="sidebar-pinned-section"]') as HTMLElement | null;
      if (!tab || !grid) throw new Error("tab o griglia mancante");
      const dt = new DataTransfer();
      tab.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      grid.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      grid.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      tab.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
    }, t.id);

    await expect(tiles(page)).toHaveCount(2, { timeout: 10000 });
    await expect(
      section(page).getByTestId("pinned-tile").and(page.getByRole("treeitem", { name: new RegExp("E2E-TileAdopt-") })),
    ).toBeVisible({ timeout: 10000 });

    // E il pin è arrivato al server, non solo allo schermo.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedItems ?? []).includes(t.id);
      }, { timeout: 15000 })
      .toBe(true);
  });

  test("TILE-10: riordinare dentro una riga mostra l'anteprima, non solo il risultato", async ({ page, request }) => {
    // Il caso più comune — spostare due tessere vicine — non mostrava niente:
    // l'anteprima scattava solo quando la riga GUADAGNAVA una cella, e dentro
    // la stessa riga il conteggio non cambia. Si trascinava alla cieca.
    const ids: string[] = [];
    for (const n of ["E2E-Ord-A", "E2E-Ord-B", "E2E-Ord-C"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(3, { timeout: 15000 });

    const ordine = () => tiles(page).evaluateAll(els =>
      els.map(e => e.getAttribute("data-pinned-tile") ?? ""),
    );
    expect(await ordine()).toEqual(ids);

    // Un GESTO solo, in una evaluate sola: dragstart → dragover → drop → dragend
    // sullo stesso `DataTransfer`. Separarli in piu' evaluate significherebbe
    // fabbricarne uno nuovo per il drop — senza i tipi che il dragstart ci ha
    // messo — e il drop verrebbe ignorato, che e' un difetto del test travestito
    // da difetto del prodotto.
    const [durante, dopo] = await page.evaluate(async (key) => {
      const due = (r: HTMLElement) =>
        Array.from(r.querySelectorAll("[data-pinned-tile]")).map(e => e.getAttribute("data-pinned-tile") ?? "");
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const row = tile.parentElement!.parentElement as HTMLElement;
      const box = (row.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      const punto = { clientX: box.left + 2, clientY: box.top + 5 };
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      row.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      await attendi();
      const mentreTrascini = due(row);

      row.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return [mentreTrascini, due(row)];
    }, ids[2]);

    // L'anteprima e' gia' l'ordine finale…
    expect(durante, "l'anteprima deve mostrare l'ordine finale").toEqual([ids[2], ids[0], ids[1]]);
    // …e rilasciando resta esattamente cio' che si vedeva.
    expect(dopo, "il drop deve confermare l'anteprima").toEqual([ids[2], ids[0], ids[1]]);

    // E la disposizione e' arrivata al server, non solo allo schermo.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedLayout ?? []).flatMap((r: { keys: string[] }) => r.keys);
      }, { timeout: 15000 })
      .toEqual([ids[2], ids[0], ids[1]]);
  });
});

/**
 * Il drop che arriva da FUORI, e la Board generale.
 *
 * Sono lo stesso pezzo visto da due lati: la board si fissa perché la sua riga è
 * trascinabile e i Fissati sanno accogliere una pane qualunque — non perché sia
 * stato scritto un percorso apposta per lei.
 */
test.describe("Sidebar — fissare da fuori, e la Board", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-11: trascinare un progetto sui Fissati mostra dove finisce, e ci finisce", async ({ page, request }) => {
    // Il difetto: sul drag esterno si accendeva solo il riquadro dell'intera
    // sezione — «cade qui dentro», non DOVE. E il drop accodava comunque, perché
    // fissare e disporre sono due scritture che riconciliano l'una sull'altra e
    // la cella della cosa appena fissata veniva scartata.
    const projectPath = "/tmp/e2e-tile-dropin";
    const projChat = await createTopic(request, `E2E-DropIn-Proj-${Date.now()}`, { projectPath });
    const solo = await createTopic(request, `E2E-DropIn-Pinned-${Date.now()}`);
    created.push(projChat.id, solo.id);

    await setPins(page, [solo.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    // La sorgente è la RIGA VERA del progetto nell'albero: il payload lo produce
    // il suo `dragstart`, non il test. Un `setData` rimosso fallisce qui.
    const projectRow = page.locator('[draggable="true"]').filter({ hasText: "e2e-tile-dropin" }).first();
    await expect(projectRow).toBeVisible({ timeout: 15000 });

    const esito = await projectRow.evaluate(async (src) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const section = document.querySelector('[data-testid="sidebar-pinned-section"]') as HTMLElement;
      const row = (section.querySelector("[data-pinned-tile]") as HTMLElement).parentElement!.parentElement as HTMLElement;
      const box = (row.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      // A sinistra della metà della prima tessera ⇒ posizione 0.
      const punto = { clientX: box.left + 2, clientY: box.top + 5 };
      const dt = new DataTransfer();

      src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      const tipi = Array.from(dt.types);
      row.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      await attendi();
      const anteprima = row.querySelector('[data-testid="pinned-drop-preview"]');
      const durante = {
        // Non un rettangolo colorato: la TESSERA vera, con il nome della cosa
        // che sta per atterrare.
        anteprimaReale: !!anteprima,
        nome: anteprima?.querySelector("[data-pinned-tile]")?.getAttribute("aria-label") ?? null,
        celle: row.children.length,
        // Niente azzurro: né il fantasma tratteggiato di prima, né il riquadro
        // sull'intera sezione. L'anteprima è la cosa, e basta.
        fantasmaVuoto: !!row.querySelector('[data-testid="pinned-drop-ghost"]'),
        sezioneAccesa: section.className.includes("ring-primary"),
      };

      row.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return { tipi, durante };
    });

    expect(esito.tipi, "la riga del progetto deve portare la chiave della PANE").toContain("application/x-panel-id");
    expect(esito.durante.anteprimaReale, "l'anteprima deve essere la tessera vera").toBe(true);
    expect(esito.durante.nome, "e deve portare il nome della cosa trascinata").toBe("e2e-tile-dropin");
    expect(esito.durante.celle, "la riga deve mostrarsi con una cella in più").toBe(2);
    expect(esito.durante.fantasmaVuoto, "niente rettangolo di ripiego quando la cosa si sa nominare").toBe(false);
    expect(esito.durante.sezioneAccesa, "niente riquadro azzurro sulla sezione").toBe(false);

    // Fissato E in prima posizione: quella scelta col cursore, non in coda.
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedLayout ?? []).flatMap((r: { keys: string[] }) => r.keys);
      }, { timeout: 15000 })
      .toEqual([`project:${projectPath}`, solo.id]);
  });

  test("TILE-12: la riga della Board e il filo divisore stanno sulla stessa colonna delle altre", async ({ page, request }) => {
    // La board era l'UNICA riga a filo dei bordi (px-3, niente card) e il filo
    // l'unico elemento rientrato di 12px: due colonne diverse nello stesso
    // elenco, che è esattamente ciò che si vedeva come «padding incoerente».
    const solo = await createTopic(request, `E2E-Pad-Pinned-${Date.now()}`);
    const altra = await createTopic(request, `E2E-Pad-Row-${Date.now()}`);
    created.push(solo.id, altra.id);
    await setPins(page, [solo.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    // La board compare quando la sua tab è aperta, anche a zero task.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
    const boardRow = page.getByTestId("sidebar-board-generale");
    await expect(boardRow).toBeVisible({ timeout: 15000 });

    const sidebar = page.locator('[aria-label="Topics sidebar"]');
    const bordo = (await sidebar.boundingBox())!.x;
    const sinistra = async (l: Locator) => Math.round((await l.boundingBox())!.x - bordo);

    const tessera = await sinistra(tiles(page).first());
    const board = await sinistra(boardRow);
    const filo = await sinistra(page.getByTestId("pinned-divider").first());

    // Un'unica colonna: ROW_INSET = 6px, la stessa per la card di ogni riga.
    expect(board, "la riga della board deve rientrare come una card").toBe(tessera);
    expect(filo, "il filo deve rientrare come le tessere sopra e le righe sotto").toBe(tessera);
  });

  test("TILE-13: la Board si fissa, diventa tessera e mostra i task PER STATO", async ({ page, request }) => {
    const stamp = Date.now();
    const inReview = await request.post(`${E2E_BASE}/api/boards/_none/tasks`, {
      data: { text: `E2E-Board-Review-${stamp}`, status: "review" },
    });
    expect(inReview.ok(), "il task in review deve nascere").toBe(true);
    const daFare = await request.post(`${E2E_BASE}/api/boards/_none/tasks`, {
      data: { text: `E2E-Board-Backlog-${stamp}`, status: "backlog" },
    });
    expect(daFare.ok()).toBe(true);
    const ids = [(await inReview.json()).id as string, (await daFare.json()).id as string];

    try {
      await setPins(page, []);
      await gotoSidebar(page);
      const boardRow = page.getByTestId("sidebar-board-generale");
      await expect(boardRow, "con task attivi la riga c'è anche a tab chiusa").toBeVisible({ timeout: 15000 });

      // Il menu della riga: una voce sola, e dice il verso GIUSTO.
      await boardRow.click({ button: "right" });
      const voce = page.getByTestId("pin-toggle-item");
      await expect(voce).toHaveText(/Aggiungi ai Fissati/, { timeout: 5000 });
      await voce.click();

      // Fissata è una TESSERA, e la riga sparisce: mai la stessa cosa in due posti.
      const tessera = tileNamed(page, "Board");
      await expect(tessera).toBeVisible({ timeout: 15000 });
      await expect(boardRow).toHaveCount(0);

      // Fissata, la tessera NON apre una fascia: il riassunto sta sulla riga e
      // la lista dei titoli sta nella board. Cliccarla porta alla board.
      await expect(tessera).toHaveAttribute("aria-expanded", "false");

      // E si torna indietro dalla stessa voce, col verso opposto.
      await tessera.click({ button: "right" });
      await expect(page.getByTestId("pin-toggle-item")).toHaveText(/Rimuovi dai Fissati/, { timeout: 5000 });
      await page.getByTestId("pin-toggle-item").click();
      await expect(page.getByTestId("sidebar-board-generale")).toBeVisible({ timeout: 15000 });
    } finally {
      for (const id of ids) {
        await request.delete(`${E2E_BASE}/api/boards/_none/tasks/${id}`).catch(() => {});
      }
    }
  });
});

test.describe("Sidebar — il ritmo verticale del blocco fissati", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-14: board, righe di tessere e separatore stanno a UNA sola distanza", async ({ page, request }) => {
    // Erano tre numeri diversi per tre spazi che l'occhio legge in fila: 1px
    // fra la riga della board e le tessere (il solo `my-px` della card), 0px
    // fra due righe di tessere — si TOCCAVANO — e 10px prima del filo.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = await createTopic(request, `E2E-Ritmo-${i}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    // Due righe da tre, chieste esplicitamente, più qualcosa sotto il filo
    // perché il filo si disegni.
    const sotto = await createTopic(request, `E2E-Ritmo-Sotto-${Date.now()}`);
    created.push(sotto.id);

    await setPins(page, ids, [ids.slice(0, 3), ids.slice(3)]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(6, { timeout: 15000 });

    // La board compare quando la sua tab è aperta, anche a zero task.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
    await expect(page.getByTestId("sidebar-board-generale")).toBeVisible({ timeout: 15000 });

    const righe = page.getByTestId("pinned-row");
    await expect(righe).toHaveCount(2, { timeout: 15000 });

    const box = async (l: Locator) => {
      const b = await l.boundingBox();
      expect(b).not.toBeNull();
      return b!;
    };
    const board = await box(page.getByTestId("sidebar-board-generale"));
    const riga0 = await box(righe.nth(0));
    const riga1 = await box(righe.nth(1));
    const filo = await box(page.getByTestId("pinned-divider").first());

    const spazi = {
      boardTessere: Math.round(riga0.y - (board.y + board.height)),
      fraRighe: Math.round(riga1.y - (riga0.y + riga0.height)),
      tessereFilo: Math.round(filo.y - (riga1.y + riga1.height)),
    };

    // Un solo passo, lo stesso che separa due tessere della stessa riga.
    expect(spazi).toEqual({ boardTessere: 6, fraRighe: 6, tessereFilo: 6 });
  });

  test("TILE-15: la riga della board dice quanti task e in quale colonna, senza aprire niente", async ({ page, request }) => {
    // Prima era un accordion: un gesto per sapere una cosa che sta in tre
    // numeri, e quella cosa — «quanti in review, quanti stanno girando» — e'
    // esattamente cio' che si vuole senza aprire niente. E il badge col totale
    // non distingueva se ad aspettare fossi tu o un agente.
    const stamp = Date.now();
    const creati: string[] = [];
    for (const [text, status] of [
      [`E2E-Conta-Review-${stamp}`, "review"],
      [`E2E-Conta-Corso-A-${stamp}`, "in_progress"],
      [`E2E-Conta-Corso-B-${stamp}`, "in_progress"],
    ]) {
      const res = await request.post(`${E2E_BASE}/api/boards/_none/tasks`, { data: { text, status } });
      expect(res.ok()).toBe(true);
      creati.push((await res.json()).id as string);
    }

    try {
      await setPins(page, []);
      await gotoSidebar(page);
      const riga = page.getByTestId("sidebar-board-generale");
      await expect(riga).toBeVisible({ timeout: 15000 });

      // Niente da aprire: nessun chevron, nessuna fascia.
      await expect(page.getByTestId("sidebar-board-chevron")).toHaveCount(0);
      await expect(page.getByTestId("board-state-band")).toHaveCount(0);

      // I conteggi stanno sulla riga, e sono quelli veri.
      await expect(riga.getByTestId("board-count-review")).toHaveText(/1/, { timeout: 15000 });
      await expect(riga.getByTestId("board-count-in_progress")).toHaveText(/2/);
      // Una colonna vuota non disegna un numero: uno zero non e' informazione.
      await expect(riga.getByTestId("board-count-todo")).toHaveCount(0);

      // «Generale» non si legge piu' da nessuna parte: la board di progetto sta
      // in un altro menu, quindi non c'era niente da cui distinguerla.
      await expect(riga).toHaveText(/Board/);
      await expect(riga).not.toHaveText(/generale/i);

      // E il glifo non e' piu' verde: nella sidebar il colore dice uno STATO.
      const colore = await riga.locator("svg").first().evaluate(el => getComputedStyle(el).color);
      expect(colore, "il glifo della board deve essere neutro").not.toMatch(/52,\s*211,\s*153/); // emerald-400
    } finally {
      for (const id of creati) await request.delete(`${E2E_BASE}/api/boards/_none/tasks/${id}`).catch(() => {});
    }
  });
});

test.describe("Sidebar — la tessera dice cosa fa", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-16: il segno di apertura sta accanto al titolo, e a zero tab non c'è", async ({ page, request }) => {
    // La cartella non diceva niente che il nome non dicesse già — un progetto si
    // chiama come la sua cartella — e occupava lo spazio dell'unica cosa che il
    // nome NON dice: che quella tessera si apre.
    const projectPath = "/tmp/e2e-tile-affordance";
    const chat = await createTopic(request, `E2E-Afford-${Date.now()}`, { projectPath });
    // NON un prefisso dell'altro: `getByRole(name)` fa match per
    // SOTTOSTRINGA, e "…-affordance" pescherebbe anche "…-affordance-vuoto".
    const vuoto = "/tmp/e2e-tile-senza-tab";
    const chatVuoto = await createTopic(request, `E2E-AffordVuoto-${Date.now()}`, { projectPath: vuoto });
    created.push(chat.id, chatVuoto.id);

    // Il primo progetto ha un figlio VISIBILE (la sua chat è fissata anche lei);
    // il secondo no, e la sua tab è chiusa.
    await setPins(page, [`project:${projectPath}`, chat.id, `project:${vuoto}`]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(3, { timeout: 15000 });

    const progetto = tileNamed(page, "e2e-tile-affordance");
    const segno = progetto.getByTestId("pinned-expand-hint");
    await expect(segno).toHaveCount(1, { timeout: 15000 });

    // Niente cartella: al progetto resta il solo segno di apertura.
    await expect(progetto.locator("svg")).toHaveCount(1);

    const box = async (l: Locator) => {
      const b = await l.boundingBox();
      expect(b).not.toBeNull();
      return b!;
    };
    const tessera = await box(progetto);
    // Il testo, non il contenitore: da quando il chevron gli sta a fianco, il
    // wrapper contiene ENTRAMBI e parte dal chevron — misurarlo direbbe che il
    // segno non precede niente.
    const testo = await box(progetto.getByTestId("pinned-tile-name"));
    const scarto = Math.abs((testo.y + testo.height / 2) - (tessera.y + tessera.height / 2));
    expect(scarto, "il titolo deve stare al centro verticale della tessera").toBeLessThanOrEqual(1);

    // Il segno sta ACCANTO a ciò che identifica, sulla stessa riga: davanti al
    // nome (o all'icona, quando c'è) come nell'albero sta davanti alla cartella.
    const marker = await box(segno);
    expect(marker.x + marker.width, "il segno precede il titolo").toBeLessThanOrEqual(testo.x + 1);
    const centri = Math.abs((marker.y + marker.height / 2) - (testo.y + testo.height / 2));
    expect(centri, "e gli sta a fianco, non sopra o sotto").toBeLessThanOrEqual(1);

    // Tailwind v4 scrive `rotate: 180deg`, non `transform: matrix(...)`: sono
    // proprietà separate, e leggere `transform` qui torna sempre "none" — cioè
    // un'asserzione che non può fallire.
    const giro = () => segno.evaluate(el => getComputedStyle(el).rotate);
    expect(await giro(), "a riposo punta a destra, come ogni chevron delle righe").toBe("none");

    await progetto.click();
    await expect(page.getByTestId("pinned-expansion")).toBeVisible({ timeout: 15000 });
    // 90°, non 180: è lo STESSO chevron delle righe (progetti, gruppi,
    // sotto-agenti), quindi ruota come loro.
    await expect.poll(giro, { timeout: 5000 }).toBe("90deg");

    // A ZERO TAB non c'è niente da aprire: niente segno e nessuna fascia vuota.
    // Una riga che dice «non c'è niente» è una riga in più per dire un vuoto.
    const senzaTab = tileNamed(page, "e2e-tile-senza-tab");
    await expect(senzaTab.getByTestId("pinned-expand-hint")).toHaveCount(0);
  });
});

test.describe("Sidebar — creare una tab da una tessera", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-17: il «+» della riga c'è anche sulla tessera di un progetto, e solo lì", async ({ page, request }) => {
    // Fissato un progetto, la sua riga nell'albero poteva non esserci più (una
    // tessera vive anche a tab chiuse): senza il «+» qui, creare una tab DENTRO
    // quel progetto non aveva più nessuna strada.
    const projectPath = "/tmp/e2e-tile-plus";
    const chat = await createTopic(request, `E2E-Plus-${Date.now()}`, { projectPath });
    const solo = await createTopic(request, `E2E-Plus-Solo-${Date.now()}`);
    created.push(chat.id, solo.id);

    await setPins(page, [`project:${projectPath}`, solo.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });

    const cella = page.getByTestId("sidebar-pinned-section")
      .locator("div.group\\/cell")
      .filter({ has: page.getByRole("treeitem", { name: "e2e-tile-plus" }) });
    const piu = cella.getByTestId("pane-add-menu-trigger");

    // C'è, ma solo al passaggio del mouse: a riposo la tessera resta pulita.
    await expect(piu).toHaveCount(1, { timeout: 15000 });
    await expect(piu).toBeHidden();
    await cella.hover();
    await expect(piu).toBeVisible();

    // È il menu VERO, non un bottone che somiglia: apre le stesse voci.
    await piu.click();
    await expect(page.getByTestId("pane-add-menu")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");

    // Una chat fissata non contiene niente: nessun «+» da offrire.
    const cellaChat = page.getByTestId("sidebar-pinned-section")
      .locator("div.group\\/cell")
      .filter({ has: page.getByRole("treeitem", { name: solo.name }) });
    await cellaChat.hover();
    await expect(cellaChat.getByTestId("pane-add-menu-trigger")).toHaveCount(0);
  });
});

test.describe("Sidebar — l'anteprima del drop e' la cosa, alle misure giuste", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-18: spostare una tessera su un'ALTRA riga mostra la tessera, non un rettangolo", async ({ page, request }) => {
    // Il caso che mostrava il ripiego grigio: `incoming` era popolato solo per i
    // drag da FUORI, quindi il movimento piu' comune dopo il riordino — portare
    // una tessera su un'altra riga della stessa griglia — annunciava una cella
    // vuota al posto della cosa che stava per atterrare.
    const ids: string[] = [];
    for (const n of ["E2E-Prev-A", "E2E-Prev-B", "E2E-Prev-C"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    // Due righe: [A, B] e [C]. Trasciniamo C sulla prima.
    await setPins(page, ids, [[ids[0], ids[1]], [ids[2]]]);
    await gotoSidebar(page);
    await expect(page.getByTestId("pinned-row")).toHaveCount(2, { timeout: 15000 });

    const esito = await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const righe = Array.from(document.querySelectorAll('[data-testid="pinned-row"]')) as HTMLElement[];
      const target = righe[0];
      const box = (target.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent("dragover", {
        dataTransfer: dt, bubbles: true, cancelable: true,
        clientX: box.left + 2, clientY: box.top + 5,
      }));
      await attendi();
      const anteprima = target.querySelector('[data-testid="pinned-drop-preview"]');
      const out = {
        reale: !!anteprima,
        nome: anteprima?.querySelector("[data-pinned-tile]")?.getAttribute("aria-label") ?? null,
        ripiego: !!target.querySelector('[data-testid="pinned-drop-ghost"]'),
      };
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return out;
    }, ids[2]);

    expect(esito.reale, "l'anteprima deve essere la tessera vera").toBe(true);
    expect(esito.ripiego, "niente rettangolo di ripiego: la cosa si sa nominare").toBe(false);
    expect(esito.nome).toContain("E2E-Prev-C");
  });

  test("TILE-19: l'anteprima di una riga NUOVA sta alle stesse distanze delle righe vere", async ({ page, request }) => {
    // Diventando riga, quello spazio deve avere il respiro di una riga: senza,
    // la tessera in arrivo toccava quelle gia' in griglia mentre tutte le altre
    // stanno a 6px — un'anteprima che mostra una spaziatura che il risultato non
    // avra'.
    //
    // La tessera che si trascina DIVIDE la sua riga con un'altra: una che ha
    // gia' una riga tutta sua non ha niente da guadagnare nello spazio sopra o
    // sotto quella riga, e infatti li' la zona non si apre nemmeno (TILE-19b).
    const ids: string[] = [];
    for (const n of ["E2E-Gap-A", "E2E-Gap-B", "E2E-Gap-C"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids, [[ids[0], ids[1]], [ids[2]]]);
    await gotoSidebar(page);
    await expect(page.getByTestId("pinned-row")).toHaveCount(2, { timeout: 15000 });

    const misure = await page.evaluate(async (key) => {
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const zone = Array.from(document.querySelectorAll('[data-testid="pinned-new-row-zone"]')) as HTMLElement[];
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      // La zona FRA le due righe.
      zone[1].dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));

      // La zona si apre con una transizione da 100ms: misurare al secondo
      // frame coglie il padding a 0,1px e fa fallire il test su un numero che
      // sullo schermo non esiste mai. Si aspetta che si fermi, non un tempo
      // fisso — cosi' un domani a 200ms il test regge lo stesso.
      const stabile = async () => {
        let prec = "";
        for (let i = 0; i < 60; i++) {
          await new Promise(r => requestAnimationFrame(() => r(null)));
          const ora = getComputedStyle(zone[1]).paddingTop;
          if (ora === prec && ora !== "0px") return;
          prec = ora;
        }
      };
      await stabile();

      const anteprima = zone[1].querySelector('[data-testid="pinned-drop-preview"]') as HTMLElement | null;
      // La TESSERA della riga sopra, non il contenitore: la riga porta il suo
      // rientro come padding (bordo a 0, tessere a 6), la zona come margine
      // (bordo a 6) — confrontare i due contenitori direbbe 6 di scarto che
      // sullo schermo non c'e'.
      const tessellaSopra = document.querySelectorAll('[data-pinned-tile]')[0] as HTMLElement;
      const rigaSopra = document.querySelectorAll('[data-testid="pinned-row"]')[0] as HTMLElement;
      const out = anteprima
        ? {
            trovata: true,
            sopra: Math.round(anteprima.getBoundingClientRect().top - rigaSopra.getBoundingClientRect().bottom),
            sinistra: Math.round(anteprima.getBoundingClientRect().left - tessellaSopra.getBoundingClientRect().left),
          }
        : { trovata: false, sopra: -1, sinistra: -1 };
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      return out;
    }, ids[1]);

    expect(misure.trovata, "la riga nuova deve mostrare la tessera").toBe(true);
    // Lo stesso passo del blocco: 6px, come fra due righe vere.
    expect(misure.sopra, "il respiro sopra e' quello di sempre").toBe(6);
    // E la stessa colonna: le tessere di una riga cominciano dove cominciano
    // quelle di ogni altra riga.
    expect(misure.sinistra, "e comincia sulla stessa colonna").toBe(0);
  });

  test("TILE-19b: chi ha gia' una riga tutta sua non trova bersagli sopra e sotto", async ({ page, request }) => {
    // Il difetto riferito: «sto occupando una riga intera e mi da' la
    // possibilita' di spostarla in una riga sotto, ma non ha senso perche' gia'
    // sta occupando una riga». Il modello lo sapeva gia' — `insertPinnedRow`
    // restituiva il layout invariato — ma la zona si apriva lo stesso, si
    // accendeva e ci disegnava dentro l'anteprima: un bersaglio che prometteva
    // uno spostamento e poi non faceva niente.
    //
    // Non basta ignorare il drop: senza `preventDefault` la zona non e' proprio
    // un bersaglio, quindi il cursore stesso dice «qui no».
    const ids: string[] = [];
    for (const n of ["E2E-Solo-A", "E2E-Solo-B", "E2E-Solo-X"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    // X e' l'unica della sua riga: sopra di lei e sotto di lei non c'e' niente
    // da guadagnare. La riga [A, B] invece e' un bersaglio vero.
    await setPins(page, ids, [[ids[0], ids[1]], [ids[2]]]);
    await gotoSidebar(page);
    await expect(page.getByTestId("pinned-row")).toHaveCount(2, { timeout: 15000 });

    const esito = await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const zone = () => Array.from(document.querySelectorAll('[data-testid="pinned-new-row-zone"]')) as HTMLElement[];
      const righe = Array.from(document.querySelectorAll('[data-testid="pinned-row"]')) as HTMLElement[];
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const dt = new DataTransfer();
      // `dispatchEvent` torna false quando qualcuno ha chiamato
      // `preventDefault`: e' letteralmente la domanda «questo e' un bersaglio?».
      const bersaglio = (el: HTMLElement, punto?: { clientX: number; clientY: number }) =>
        !el.dispatchEvent(new DragEvent("dragover", {
          dataTransfer: dt, bubbles: true, cancelable: true, ...(punto ?? {}),
        }));

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      await attendi();

      const z = zone();
      const dichiarato = z.map(e => e.getAttribute("data-drop-allowed"));

      // Lo spazio FRA le due righe (indice 1) e quello in fondo (indice 2)
      // sono i due che circondano la riga di X.
      const accettaSopraSe = bersaglio(z[1]);
      await attendi();
      const apertaSopraSe = {
        padding: getComputedStyle(zone()[1]).paddingTop,
        anteprima: !!zone()[1].querySelector('[data-testid="pinned-drop-preview"]'),
        fantasma: !!zone()[1].querySelector('[data-testid="pinned-drop-ghost"]'),
      };
      const accettaSotto = bersaglio(zone()[2]);
      // La riga di X: riordinare dentro una riga dove X e' l'unica non muove niente.
      const accettaPropriaRiga = bersaglio(righe[1]);

      // …mentre i bersagli VERI restano tali: la riga [A, B] e lo spazio sopra
      // di lei, che porterebbe X davvero da un'altra parte.
      const accettaAltraRiga = bersaglio(righe[0]);
      const accettaSopraTutto = bersaglio(zone()[0]);
      await attendi();
      const apertaSopraTutto = !!zone()[0].querySelector('[data-testid="pinned-drop-preview"]');

      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return {
        dichiarato, accettaSopraSe, apertaSopraSe, accettaSotto, accettaPropriaRiga,
        accettaAltraRiga, accettaSopraTutto, apertaSopraTutto,
      };
    }, ids[2]);

    // Lo dice il DOM, prima ancora del cursore: gli spazi attorno alla riga di
    // X non sono bersagli.
    expect(esito.dichiarato, "solo lo spazio che porta X altrove e' un bersaglio")
      .toEqual(["si", "no", "no"]);
    expect(esito.accettaSopraSe, "lo spazio sopra la propria riga non e' un bersaglio").toBe(false);
    expect(esito.accettaSotto, "ne' quello sotto").toBe(false);
    expect(esito.accettaPropriaRiga, "ne' la propria riga, dove X e' sola").toBe(false);
    // E non si apre: niente respiro, niente anteprima, niente tratteggio.
    expect(esito.apertaSopraSe.padding, "la zona non deve aprirsi").toBe("0px");
    expect(esito.apertaSopraSe.anteprima, "niente anteprima di uno spostamento che non avviene").toBe(false);
    expect(esito.apertaSopraSe.fantasma, "niente tratteggio").toBe(false);

    // Il resto della griglia continua a rispondere: la regola toglie i bersagli
    // finti, non i veri.
    expect(esito.accettaAltraRiga, "la riga [A, B] resta un bersaglio").toBe(true);
    expect(esito.accettaSopraTutto, "e lo spazio in cima porta X davvero altrove").toBe(true);
    expect(esito.apertaSopraTutto, "che infatti si apre e mostra la tessera").toBe(true);
  });

  test("TILE-19c: lasciata in uno spazio fra due righe, la tessera ne apre una nuova", async ({ page, request }) => {
    // L'altra meta' di TILE-19b: chi divide la riga con qualcun altro una riga
    // nuova la guadagna davvero, e il drop la crea. Senza questo, «togliere i
    // bersagli finti» potrebbe voler dire «averli tolti tutti» e nessuno se ne
    // accorgerebbe.
    const ids: string[] = [];
    for (const n of ["E2E-NewRow-A", "E2E-NewRow-B", "E2E-NewRow-C"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids, [[ids[0], ids[1], ids[2]]]);
    await gotoSidebar(page);
    await expect(page.getByTestId("pinned-row")).toHaveCount(1, { timeout: 15000 });

    await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const zona = document.querySelectorAll('[data-testid="pinned-new-row-zone"]')[0] as HTMLElement;
      const dt = new DataTransfer();
      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      zona.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      await attendi();
      zona.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
    }, ids[2]);

    await expect(page.getByTestId("pinned-row")).toHaveCount(2, { timeout: 15000 });
    // C da sola in cima, A e B rimaste insieme sotto.
    const disposizione = () =>
      page.getByTestId("pinned-row").evaluateAll(righe =>
        righe.map(r => Array.from(r.querySelectorAll("[data-pinned-cell]"))
          .map(c => (c as HTMLElement).dataset.pinnedCell ?? "")),
      );
    await expect.poll(disposizione, { timeout: 15000 }).toEqual([[ids[2]], [ids[0], ids[1]]]);

    // E la disposizione e' arrivata al server, non solo allo schermo.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedLayout ?? []).map((r: { keys: string[] }) => r.keys);
      }, { timeout: 15000 })
      .toEqual([[ids[2]], [ids[0], ids[1]]]);
  });

  test("TILE-18b: la riga di PARTENZA mostra che la tessera se ne sta andando", async ({ page, request }) => {
    // L'anteprima raccontava mezzo movimento: la riga d'arrivo si stringeva per
    // fare posto, quella di partenza restava larga com'era — e a drop fatto
    // scattava. Le due righe devono raccontare lo STESSO gesto.
    const ids: string[] = [];
    for (const n of ["E2E-Exit-A", "E2E-Exit-B", "E2E-Exit-C"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    // [A, B] e [C]: trasciniamo A sulla seconda riga.
    await setPins(page, ids, [[ids[0], ids[1]], [ids[2]]]);
    await gotoSidebar(page);
    await expect(page.getByTestId("pinned-row")).toHaveCount(2, { timeout: 15000 });

    const durante = await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const celle = (r: HTMLElement) =>
        Array.from(r.querySelectorAll("[data-pinned-cell]")).map(e => (e as HTMLElement).dataset.pinnedCell ?? "");
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const righe = Array.from(document.querySelectorAll('[data-testid="pinned-row"]')) as HTMLElement[];
      const box = (righe[1].querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      const punto = { clientX: box.left + 2, clientY: box.top + 5 };
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      righe[1].dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      await attendi();
      const anteprima = righe[1].querySelector('[data-testid="pinned-drop-preview"]');
      const out = {
        partenza: celle(righe[0]),
        arrivo: righe[1].children.length,
        nome: anteprima?.querySelector("[data-pinned-tile]")?.getAttribute("aria-label") ?? null,
      };

      righe[1].dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return out;
    }, ids[0]);

    // La riga di partenza mostra gia' di aver perso A: resta B, a tutta larghezza.
    expect(durante.partenza, "la riga di partenza deve mostrare la tessera in uscita").toEqual([ids[1]]);
    // E quella d'arrivo mostra la cella in piu', con il nome giusto dentro.
    expect(durante.arrivo, "la riga d'arrivo deve mostrare una cella in piu'").toBe(2);
    expect(durante.nome).toContain("E2E-Exit-A");

    // Il drop conferma quello che si vedeva.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedLayout ?? []).map((r: { keys: string[] }) => r.keys);
      }, { timeout: 15000 })
      .toEqual([[ids[1]], [ids[0], ids[2]]]);
  });

  test("TILE-10b: verso DESTRA l'anteprima e il risultato dicono la stessa cosa", async ({ page, request }) => {
    // Le due formule del riordino erano gemelle e vivevano in due posti — una
    // nella resa, una implicita nel `pluck`+`splice` del modello — e
    // divergevano su ogni spostamento verso destra: vedevi [B, A, C] mentre
    // tenevi premuto e ti restava [B, C, A]. TILE-10 sposta verso SINISTRA, cioe'
    // proprio il verso in cui le due formule coincidono.
    const ids: string[] = [];
    for (const n of ["E2E-Right-A", "E2E-Right-B", "E2E-Right-C"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids, [[ids[0], ids[1], ids[2]]]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(3, { timeout: 15000 });

    const [durante, dopo] = await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const celle = (r: HTMLElement) =>
        Array.from(r.querySelectorAll("[data-pinned-cell]")).map(e => (e as HTMLElement).dataset.pinnedCell ?? "");
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const row = tile.closest('[data-testid="pinned-row"]') as HTMLElement;
      // Oltre la meta' della SECONDA tessera ⇒ posizione 2: A scavalca B.
      const b = (row.querySelectorAll("[data-pinned-cell]")[1] as HTMLElement).getBoundingClientRect();
      const punto = { clientX: b.left + b.width * 0.75, clientY: b.top + 5 };
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      row.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      await attendi();
      const mentre = celle(row);

      row.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return [mentre, celle(row)];
    }, ids[0]);

    expect(durante, "l'anteprima non deve scavalcare di uno").toEqual([ids[1], ids[0], ids[2]]);
    expect(dopo, "e il drop deve confermarla").toEqual([ids[1], ids[0], ids[2]]);
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedLayout ?? []).flatMap((r: { keys: string[] }) => r.keys);
      }, { timeout: 15000 })
      .toEqual([ids[1], ids[0], ids[2]]);
  });
});

/**
 * Il riordino si VEDE muovere.
 *
 * Le celle non hanno una posizione da animare — stanno in un flex e il loro
 * posto lo decide l'ordine dei nodi — quindi non c'e' nessuna proprieta' CSS da
 * interpolare e le tessere si scambiavano di posto in un fotogramma. Qui si
 * difende il movimento con i numeri che lo compongono: fotogrammi con una
 * traslazione applicata, posizioni intermedie distinte, e zero traslazione alla
 * fine (un FLIP che non torna a zero lascia la cella storta per sempre).
 */
test.describe("Sidebar — il riordino si vede muovere", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  /** Semina tre tessere su una riga e restituisce i loro id. */
  async function treSuUnaRiga(page: Page, request: Parameters<typeof createTopic>[0], tag: string) {
    const ids: string[] = [];
    for (const n of ["A", "B", "C"]) {
      const t = await createTopic(request, `E2E-${tag}-${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids, [[ids[0], ids[1], ids[2]]]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(3, { timeout: 15000 });
    return ids;
  }

  /**
   * Trascina l'ultima tessera in testa e campiona la PRIMA cella a ogni
   * fotogramma: quella che deve farsi da parte. Torna la traslazione applicata e
   * la posizione sullo schermo, che e' cio' che l'occhio vede — piu' l'ordine
   * raggiunto, perche' «non si e' animato» e «non e' successo niente» sono due
   * esiti diversi e vanno distinti.
   */
  async function campiona(page: Page, mossa: string, spiata: string) {
    return page.evaluate(async ([key, spia]) => {
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const row = tile.closest('[data-testid="pinned-row"]') as HTMLElement;
      const box = (row.querySelector("[data-pinned-cell]") as HTMLElement).getBoundingClientRect();
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      row.dispatchEvent(new DragEvent("dragover", {
        dataTransfer: dt, bubbles: true, cancelable: true,
        clientX: box.left + 2, clientY: box.top + 5,
      }));

      // 30 fotogrammi erano la scommessa «mezzo secondo basta»: bastano a
      // vedere la corsa, ma l'ULTIMO campione veniva poi asserito uguale a
      // "none" — cioe' si dava per scontato che la FLIP fosse anche finita
      // entro quel conteggio. Sotto carico non lo e': il rosso misurato diceva
      // `matrix(1, 0, 0, 1, 0, -2.92651)`, una traslazione ancora viva, e
      // accusava «traslazione residua» di un'animazione che stava solo
      // arrivando tardi. Ora i 30 fotogrammi restano il minimo che raccoglie
      // le prove del movimento, e dopo si continua FINCHE' la traslazione non
      // si spegne davvero, con un tetto perche' un campionamento senza fine
      // appenderebbe il test invece di farlo fallire.
      const MINIMO = 30, TETTO = 240;
      const frames: Array<{ t: string; x: number }> = [];
      for (let i = 0; i < TETTO; i++) {
        await new Promise(r => requestAnimationFrame(() => r(null)));
        const el = document.querySelector(`[data-pinned-cell="${spia}"]`) as HTMLElement | null;
        if (!el) break;
        const t = getComputedStyle(el).transform;
        frames.push({ t, x: Math.round(el.getBoundingClientRect().x) });
        if (i + 1 >= MINIMO && t === "none") break;
      }
      const ordine = Array.from(row.querySelectorAll("[data-pinned-cell]"))
        .map(e => (e as HTMLElement).dataset.pinnedCell ?? "");
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      return { frames, ordine };
    }, [mossa, spiata] as const);
  }

  test("TILE-28: riordinando dentro la riga le celle attraversano lo spazio", async ({ page, request }) => {
    // La config della suite chiede `reducedMotion: "reduce"` a TUTTI i contesti, e
    // `useCellFlip` in quel caso salta l'animazione apposta. Questo test misura
    // proprio l'animazione, quindi deve chiedere il movimento per se stesso: senza,
    // `animati.length` e' zero per costruzione e il rosso non dice niente sul
    // codice. Il fratello TILE-28b copre il ramo opposto.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const ids = await treSuUnaRiga(page, request, "Flip");
    // C va in testa: A scivola di un posto a destra, e deve vedersi scivolare.
    const { frames, ordine } = await campiona(page, ids[2], ids[0]);

    expect(ordine, "il riordino deve essere avvenuto").toEqual([ids[2], ids[0], ids[1]]);

    const animati = frames.filter(f => f.t !== "none");
    expect(animati.length, "la cella deve passare per fotogrammi traslati").toBeGreaterThanOrEqual(2);

    // Non basta che una traslazione ci sia: deve CAMBIARE. Una `transform` fissa
    // sarebbe un salto travestito.
    const posizioni = new Set(frames.map(f => f.x));
    expect(posizioni.size, "e attraversare posizioni intermedie distinte").toBeGreaterThanOrEqual(3);

    // E finire a zero: un FLIP che non si spegne lascia la cella storta, e ogni
    // riordino successivo parte da un errore accumulato.
    expect(frames[frames.length - 1].t, "a fine corsa nessuna traslazione residua").toBe("none");
  });

  test("TILE-28b: chi ha chiesto meno movimento non lo riceve", async ({ page, request }) => {
    // `prefers-reduced-motion` non e' un dettaglio di gusto: e' una richiesta di
    // accessibilita'. Le misure pero' si aggiornano lo stesso — altrimenti al
    // primo cambio di preferenza si animerebbe un salto accumulato da tutti i
    // riordini precedenti — quindi qui si verifica che il RISULTATO arrivi
    // comunque, solo senza corsa.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ids = await treSuUnaRiga(page, request, "NoFlip");
    const { frames, ordine } = await campiona(page, ids[2], ids[0]);

    // Il riordino c'e' stato lo stesso…
    expect(ordine, "il riordino deve avvenire comunque").toEqual([ids[2], ids[0], ids[1]]);
    // …ma nessuna cella ha attraversato lo spazio: ci e' arrivata e basta.
    expect(frames.every(f => f.t === "none"), "nessun fotogramma traslato").toBe(true);
    const posizioni = [...new Set(frames.map(f => f.x))];
    expect(posizioni.length, "un salto, non una corsa").toBeLessThanOrEqual(2);
  });
});

/**
 * QUANDO una tessera è accesa, e con quale cornice.
 *
 * «Accesa» vuol dire selezionata: la superficie della famiglia più una cornice
 * sottile attorno. Due modi di sbagliarlo, tutti e due riferiti:
 *
 *  — restare accese per sempre. La fascia di un progetto esiste solo finché quel
 *    progetto ha tab aperte; l'insieme delle tessere aperte invece è un insieme
 *    di INTENZIONI, e nessuno lo puliva. Chiusa l'ultima tab, la tessera restava
 *    accesa sopra una fascia vuota, e cliccarla non la spegneva.
 *  — accendersi in modo DIVERSO. La cornice esisteva solo dove c'era un colore
 *    da proiettare, quindi una tessera senza icona e senza tinta si accendeva
 *    senza bordo: «senza colore» deve voler dire un colore diverso, non una
 *    forma diversa.
 */
test.describe("Sidebar — quando una tessera è accesa", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  /** L'opacità della cornice: è LEI che dice «accesa», e si legge in numeri. */
  const cornice = (t: Locator) => t.getByTestId("pinned-tile-rim");
  const opacita = (l: Locator) => l.evaluate(el => getComputedStyle(el).opacity);

  /**
   * Un progetto SENZA favicon, con una tab dentro — il caso senza colore.
   *
   * La tinta di una tessera viene dall'icona per i progetti e dal tipo per
   * tutto il resto: una chat ce l'ha sempre (il colore del suo tipo), un
   * progetto senza icona no. È quindi qui, e solo qui, che si vede come si
   * accende una tessera che non ha un colore da proiettare.
   *
   * La chat è fissata anche lei: è ciò che la rende un FIGLIO visibile del
   * progetto, e senza un figlio la fascia non esiste e la tessera non si apre.
   *
   * Con `conVicino` si fissa anche una chat ESTRANEA al progetto: serve solo a
   * portare via il fuoco, per guardare l'accensione che NON viene dal fuoco.
   */
  async function progettoSenzaColore(
    page: Page,
    request: Parameters<typeof createTopic>[0],
    dir: string,
    opts?: { conVicino?: boolean },
  ) {
    const projectPath = `/tmp/${dir}`;
    const chat = await createTopic(request, `E2E-Rim-${Date.now()}`, { projectPath });
    created.push(chat.id);
    const fissati = [`project:${projectPath}`, chat.id];
    let vicino: { id: string } | null = null;
    if (opts?.conVicino) {
      vicino = await createTopic(request, `E2E-Rim-Vicino-${Date.now()}`);
      created.push(vicino.id);
      fissati.push(vicino.id);
    }
    await setPins(page, fissati);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(fissati.length, { timeout: 15000 });
    return { chat, vicino, tessera: tileNamed(page, dir) };
  }

  test("TILE-29: senza colore la cornice c'è lo stesso, con la stessa forma", async ({ page, request }) => {
    const { tessera } = await progettoSenzaColore(page, request, "e2e-tessera-neutra");
    const rim = cornice(tessera);

    // La cornice esiste PRIMA di accendersi: è sempre nel DOM, cambia solo
    // l'opacità. Renderla condizionale la faceva apparire e sparire, e una cosa
    // che appare non può dissolversi.
    await expect(rim, "la cornice esiste anche a riposo").toHaveCount(1);
    // Senza icona non c'è niente da proiettare: è esattamente il caso che prima
    // restava senza bordo mentre tutte le altre ne prendevano uno.
    await expect(rim).toHaveAttribute("data-rim", "neutro");
    await expect.poll(() => opacita(rim), { timeout: 5000 }).toBe("0");

    // Aperta ⇒ accesa. E la cornice si vede.
    await tessera.click();
    await expect(page.getByTestId("pinned-expansion")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => opacita(rim), { timeout: 10000 }).toBe("1");

    // Stessa GEOMETRIA delle altre: copre tutta la tessera, non un pezzo, e ha
    // il suo stesso raggio. Il neutro cambia il colore, non la forma.
    const [t, r] = await Promise.all([tessera.boundingBox(), rim.boundingBox()]);
    expect(t).not.toBeNull();
    expect(r).not.toBeNull();
    expect(Math.abs(r!.x - t!.x), "la cornice segue il bordo sinistro").toBeLessThanOrEqual(1);
    expect(Math.abs(r!.y - t!.y), "e quello superiore").toBeLessThanOrEqual(1);
    expect(Math.abs(r!.width - t!.width), "ed è larga quanto la tessera").toBeLessThanOrEqual(1);
    expect(Math.abs(r!.height - t!.height), "e alta quanto la tessera").toBeLessThanOrEqual(1);
    const forma = await rim.evaluate(el => {
      const s = getComputedStyle(el);
      return { raggio: s.borderRadius, transizione: s.transitionProperty };
    });
    expect(forma.raggio, "lo stesso raggio della tessera").toBe("8px");
    expect(forma.transizione, "e si dissolve, non compare").toContain("opacity");
  });

  test("TILE-30: chiusa l'ultima tab, la tessera del progetto si spegne", async ({ page, request }) => {
    // Il difetto riferito: «a volte mi restano illuminati i pinnati». Si arriva
    // qui in due mosse — apri la fascia di un progetto, poi chiudi la sua ultima
    // tab — e prima la tessera restava accesa su una fascia che non c'era più,
    // senza nessun gesto che potesse spegnerla.
    const { chat, vicino, tessera } = await progettoSenzaColore(page, request, "e2e-tessera-spenta", { conVicino: true });
    const rim = cornice(tessera);
    await expect(tessera.getByTestId("pinned-expand-hint"), "con una tab c'è da aprire").toHaveCount(1);

    await tessera.click();
    await expect(page.getByTestId("pinned-expansion")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => opacita(rim), { timeout: 10000 }).toBe("1");

    // IL FUOCO SE NE VA ALTROVE, E LA CORNICE PIENA VA CON LUI.
    //
    // Qui prima si asseriva "1", perche' `lit` valeva `focused || expanded`:
    // spostando il fuoco su un'altra tessera la prima restava col bordo pieno
    // — due tessere accese identiche e un solo fuoco. E' il difetto riferito
    // «cambio fuoco fra le pin e a volte resta illuminato il bordo»: il «a
    // volte» erano le tessere che si APRONO, cioe' i progetti con tab, perche'
    // `expanded` e' un insieme che nessuno restringeva quando il fuoco si
    // muoveva. La cornice piena ora dice una cosa sola — sei qui.
    //
    // Aperta-ma-non-a-fuoco resta comunque qualcosa da dire, e lo dice un
    // GRADINO piu' in basso (`opacity-40`): stessa cornice, smorzata. Si
    // asserisce che sia FRA i due estremi invece del numero esatto — quel che
    // conta e' che non sia ne' spenta ne' accesa come la tessera a fuoco.
    await page.locator(`[data-pinned-tile="${vicino!.id}"]`).click();
    const grado = async () => {
      const v = Number(await opacita(rim));
      return v === 0 ? "spenta" : v === 1 ? "piena" : "smorzata";
    };
    await expect.poll(grado, { timeout: 10000 }).toBe("smorzata");
    // La cornice si dissolve in 200ms, e a meta' dissolvenza QUALUNQUE valore
    // sarebbe «smorzato»: si guarda di nuovo a transizione finita, o questo
    // test passerebbe anche su una cornice che si sta semplicemente spegnendo.
    await page.waitForTimeout(400);
    expect(await grado(), "aperta ma non a fuoco: smorzata, non spenta").toBe("smorzata");

    // Ora la fascia si svuota. La chat sta lì perché è FISSATA (una chat a tab
    // chiusa resta figlia del suo progetto solo per quello): riportarla nella
    // lista la toglie dai figli, e il progetto resta senza niente da aprire —
    // esattamente lo stato che lasciava la tessera accesa nel vuoto.
    await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const lista = document.querySelector(".sidebar-scroll") as HTMLElement;
      const dt = new DataTransfer();
      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      lista.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      await attendi();
      lista.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
    }, chat.id);

    // La fascia sparisce — e con lei l'accensione. Prima restava questa.
    await expect(page.getByTestId("pinned-expansion")).toHaveCount(0, { timeout: 15000 });
    await expect(tessera.getByTestId("pinned-expand-hint"), "e niente più segno di apertura").toHaveCount(0);
    await expect.poll(() => opacita(rim), { timeout: 10000 }).toBe("0");

    // E il click torna a essere un click: porta sul progetto — quindi la
    // tessera si riaccende, ma per il FUOCO — e non riapre l'intenzione rimasta
    // appesa da prima. Se l'insieme non venisse ripulito, tornerebbe una fascia.
    await tessera.click();
    await expect(page.getByTestId("pinned-expansion"), "nessuna fascia risorta").toHaveCount(0);
  });
});

test.describe("Sidebar — le distanze attorno al «+»", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-20: il «+» sta dal bordo quanto ogni altro comando, e respira quanto la sua riga", async ({ page, request }) => {
    // QUI SI ASSERIVA CHE I TRE SPAZI COINCIDONO (sopra, a destra, sotto), e
    // l'identita' che li produceva era «altezza della tessera = trigger + 2 ×
    // rientro». Reggeva, ed era una regola che NESSUN'ALTRA superficie
    // dell'app segue: una riga della colonna e' alta 34 con un comando da 28 a
    // 8px dal bordo, cioe' 3 di aria verticale contro 8 di orizzontale. Sono
    // due domande diverse — quanto il comando sta lontano dal BORDO (fatto
    // orizzontale, ha gia' il suo numero, `ROW_PX`) e quanto respira nella riga
    // (non si sceglie, cade fuori dal centraggio) — e tenerle insieme faceva
    // decidere l'ALTEZZA della tessera dal rientro del suo bottone: la coda che
    // muove il cane. Il prezzo era 36 contro i 34 di una riga, nella stessa
    // colonna, con le due card una sopra l'altra.
    //
    // Le due proprieta' si asseriscono ancora, separate:
    //  · il rientro DESTRO e' quello canonico di ogni comando in coda;
    //  · l'aria sopra e sotto e' uguale FRA LORO (il bottone e' centrato) e vale
    //    quanto ne lascia la riga, non quanto ne chiede il bottone.
    // Si continua a non scrivere numeri a mano: si legge il rientro dalla
    // tessera stessa e lo si confronta col padding della card.
    const projectPath = "/tmp/e2e-tile-inset";
    const chat = await createTopic(request, `E2E-Inset-${Date.now()}`, { projectPath });
    created.push(chat.id);

    await setPins(page, [`project:${projectPath}`]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    const cella = page.getByTestId("sidebar-pinned-section").locator("div.group\\/cell").first();
    await cella.hover();
    const piu = cella.getByTestId("pane-add-menu-trigger");
    await expect(piu).toBeVisible({ timeout: 10000 });

    const t = (await tiles(page).first().boundingBox())!;
    const p = (await piu.boundingBox())!;
    const sopra = Math.round(p.y - t.y);
    const sotto = Math.round((t.y + t.height) - (p.y + p.height));
    const destra = Math.round((t.x + t.width) - (p.x + p.width));

    // Il bottone e' CENTRATO: sopra e sotto restano uguali fra loro, e questo
    // non dipende da nessuna costante — lo fa `top-1/2 -translate-y-1/2`.
    expect(sotto).toBe(sopra);
    // Nessuno dei due e' zero: un trigger a filo della tessera li farebbe
    // coincidere passando per il verso sbagliato.
    expect(sopra).toBeGreaterThan(0);

    // I TRE SPAZI COINCIDONO — ed e' il VERSO a essere cambiato, non la
    // proprieta'. Prima l'uguaglianza c'era ma girava al contrario: era il
    // rientro del bottone a decidere l'altezza della tessera (36 contro i 34 di
    // una riga). Poi il rientro e' passato al canonico dei comandi in fila
    // (`ROW_PX`, 8) e l'uguaglianza si e' rotta dall'altra parte: «sui pinned il
    // + ha piu' spazio a destra che sopra e sotto» (Attilio, 10/08) — 8 contro
    // 3, e su una tessera l'asimmetria si legge tutta perche' il bottone flotta
    // su una superficie piccola.
    //
    // Adesso: l'aria verticale la lascia il centraggio, `(altezza − box) / 2`, e
    // il rientro destro la COPIA. L'altezza la decide la riga, il rientro segue.
    expect(destra, `il «+» sta ${destra}px dal bordo e ${sopra} sopra`).toBe(sopra);
    expect(sopra).toBe(Math.round((t.height - p.height) / 2));
  });
});

test.describe("Sidebar — rimettere una tessera nella lista", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-21: trascinare una tessera sulla lista la sfissa, e mostra dove finira'", async ({ page, request }) => {
    // Il gesto inverso mancava del tutto: si poteva fissare trascinando, ma per
    // tornare indietro restava solo il menu contestuale.
    const fissata = await createTopic(request, `E2E-Unpin-${Date.now()}`);
    const altra = await createTopic(request, `E2E-Unpin-Altra-${Date.now()}`);
    created.push(fissata.id, altra.id);

    await setPins(page, [fissata.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    const esito = await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      // Il bersaglio è LA LISTA, non una riga qualunque: certe righe hanno un
      // `drop` proprio e lo fermano (lasciare qualcosa su un progetto vuol dire
      // portarcelo dentro, non sfissarlo). Puntare «la prima riga che capita»
      // rendeva il test dipendente da quale riga stesse in cima.
      const lista = document.querySelector('.sidebar-scroll') as HTMLElement;
      const bersaglio = lista;
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      bersaglio.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      await attendi();
      const nodo = document.querySelector('[data-testid="unpin-preview"]');
      const anteprima = !!nodo;
      const avviso = nodo?.getAttribute("data-vanish") === "true";

      bersaglio.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return { anteprima, avviso, listaTrovata: !!lista };
    }, fissata.id);

    expect(esito.anteprima, "durante il drag la riga si vede dove finira'").toBe(true);
    // Questa topic ha la tab aperta (`createTopic` la semina), quindi in lista
    // ci RESTA anche senza pin: l'anteprima dev'essere la riga vera, non
    // l'avviso di sparizione (che e' l'altro ramo, TILE-31).
    expect(esito.avviso, "con la tab aperta la riga sopravvive allo sfissaggio").toBe(false);

    // Sfissata: niente piu' tessera, e il server lo sa.
    await expect(tiles(page)).toHaveCount(0, { timeout: 15000 });
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        return ((env?.value ?? env)?.pinnedItems ?? []) as string[];
      }, { timeout: 15000 })
      .not.toContain(fissata.id);
  });

  test("TILE-22: dentro il blocco dei fissati il drop resta un RIORDINO, non uno sfissaggio", async ({ page, request }) => {
    // Il bersaglio dello sfissaggio sta sul contenitore che scorre, cioe' anche
    // sopra i fissati: senza la guardia, riordinare due tessere le avrebbe
    // sfissate entrambe nello stesso gesto.
    const ids: string[] = [];
    for (const n of ["E2E-NoUnpin-A", "E2E-NoUnpin-B"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids, [[ids[0], ids[1]]]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });

    await page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const riga = document.querySelector('[data-testid="pinned-row"]') as HTMLElement;
      const box = (riga.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      const punto = { clientX: box.left + 2, clientY: box.top + 5 };
      const dt = new DataTransfer();
      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      riga.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      await attendi();
      riga.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
    }, ids[1]);

    // Sono ancora due: il riordino non sfissa.
    await expect(tiles(page)).toHaveCount(2);
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        return ((env?.value ?? env)?.pinnedItems ?? []).length as number;
      }, { timeout: 15000 })
      .toBe(2);
  });

  test("TILE-31: quando il pin e' l'unica ancora l'anteprima lo dice, e l'Annulla la riporta al suo posto", async ({ page, request }) => {
    // Il difetto che ha fatto sparire «edm contratto»: l'anteprima disegnava la
    // riga NEL punto esatto in cui la lista ordinata l'avrebbe messa — una
    // promessa che il filtro di visibilita' poi cancellava, perche' quella roba
    // stava in sidebar SOLO perche' fissata. Si lasciava, e al posto promesso
    // non c'era niente: nessun errore, nessun toast, sparita.
    //
    // Qui il caso e' una chat ARCHIVIATA e fissata: con `showArchived` spento
    // la riga in lista non esiste, esattamente come per un progetto le cui chat
    // sono tutte archiviate. Deterministico, e non dipende dalle tab (che
    // `createTopic` semina sempre).
    const svanisce = await createTopic(request, `E2E-Vanish-${Date.now()}`);
    const resta = await createTopic(request, `E2E-Vanish-Vicina-${Date.now()}`);
    created.push(svanisce.id, resta.id);
    // L'archiviazione passa dalla DELETE con `{archived:true}` — la PATCH
    // ignora il campo (vedi `unarchiveTopic` in api-fixtures).
    await request.delete(`${E2E_BASE}/api/topics/${svanisce.id}`, { data: { archived: true } });

    // Due tessere sulla STESSA riga, la fragile per prima: cosi' l'Annulla deve
    // rimettere a posto anche la DISPOSIZIONE, non solo la lista dei fissati.
    await setPins(page, [svanisce.id, resta.id], [[svanisce.id, resta.id]]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    const primaX = (await boxOf(page, svanisce.name)).x;
    expect(primaX, "la fragile parte a sinistra della compagna").toBeLessThan((await boxOf(page, resta.name)).x);

    // Il gesto in due tempi: si trascina, si guarda cosa promette, poi si
    // lascia. (Dentro una sola `evaluate` l'anteprima si potrebbe leggere solo
    // com'era in quell'istante; qui la si interroga con i locator veri.)
    const trascina = async (key: string) => page.evaluate(async (k) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${k}"]`) as HTMLElement;
      const lista = document.querySelector(".sidebar-scroll") as HTMLElement;
      const dt = new DataTransfer();
      (window as unknown as { __dndUnpin?: DataTransfer }).__dndUnpin = dt;
      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      lista.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      await attendi();
    }, key);
    const lascia = async (key: string) => page.evaluate(async (k) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${k}"]`) as HTMLElement;
      const lista = document.querySelector(".sidebar-scroll") as HTMLElement;
      const dt = (window as unknown as { __dndUnpin?: DataTransfer }).__dndUnpin ?? new DataTransfer();
      lista.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      tile?.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
    }, key);

    await trascina(svanisce.id);
    const anteprima = page.getByTestId("unpin-preview");
    await expect(anteprima).toBeVisible({ timeout: 5000 });
    // LA COSA CHE CONTA: non e' la riga finta posata dove non nascera'. E' un
    // avviso, e nomina cio' che sta per uscire di scena.
    await expect(anteprima, "l'anteprima deve dichiararsi come sparizione").toHaveAttribute("data-vanish", "true");
    expect(
      await anteprima.getByRole("treeitem").count(),
      "niente riga finta dentro l'avviso: quella riga non nascerebbe",
    ).toBe(0);
    await expect(anteprima).toContainText(svanisce.name);

    await lascia(svanisce.id);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });
    // Sparita davvero — e' proprio il punto: senza rete, qui finiva la storia.
    await expect(page.getByRole("treeitem", { name: svanisce.name })).toHaveCount(0);

    // La rete: un Annulla che dura abbastanza da accorgersene.
    const annulla = page.getByTestId("toast-action");
    await expect(annulla, "sfissare qualcosa che sparisce deve offrire l'Annulla").toBeVisible({ timeout: 5000 });
    await annulla.click();

    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    // Torna DOVE STAVA, non in fondo: il ripristino porta indietro la lista dei
    // fissati e la disposizione insieme, altrimenti la tessera riappare
    // accodata all'ultima riga e il gesto e' comunque distruttivo.
    expect(
      (await boxOf(page, svanisce.name)).x,
      "l'Annulla la rimette nella sua cella, a sinistra della compagna",
    ).toBeLessThan((await boxOf(page, resta.name)).x);
    // E lo sa anche il server, non solo lo schermo.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        return ((env?.value ?? env)?.pinnedItems ?? []) as string[];
      }, { timeout: 15000 })
      .toContain(svanisce.id);
  });
});

test.describe("Sidebar — la tessera ci sta dentro", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-23: icona e titolo stanno DENTRO la tessera, anche nell'anteprima", async ({ page, request }) => {
    // A 32px lo stack verticale non ci sta: glifo (16) + nome su due righe (25)
    // chiedono ~43px, e quel che avanza viene tagliato. In riga l'altezza
    // richiesta e' quella dell'elemento piu' alto — l'icona — e ci sta.
    //
    // NON si misura con `scrollHeight`: si misurano i RETTANGOLI di icona e
    // titolo contro quello della tessera, che e' la domanda vera — si vedono
    // per intero? (`scrollHeight` conterebbe anche gli strati decorativi, e
    // per anni ne e' esistito uno che sporgeva di 6px per costruzione: diceva
    // 38 su una tessera perfettamente sana. Ora non sporge piu' niente —
    // TILE-26 lo difende — ma la misura giusta resta questa.)
    const pin = await createTopic(request, `E2E-Fit-Pin-${Date.now()}`);
    const chat = await createTopic(request, `E2E-Fit-Chat-${Date.now()}`);
    created.push(pin.id, chat.id);

    await setPins(page, [pin.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    const dentro = (t: HTMLElement) => {
      const box = t.getBoundingClientRect();
      const parti = [
        t.querySelector('[data-testid="pinned-tile-name"]'),
        t.querySelector("svg, img"),
      ].filter(Boolean) as Element[];
      return {
        parti: parti.length,
        nome: t.querySelector('[data-testid="pinned-tile-name"]')?.textContent ?? null,
        fuori: parti.filter(e => {
          const r = e.getBoundingClientRect();
          return r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
        }).length,
      };
    };

    // 1. La tessera POSATA: icona e titolo, tutti e due interi.
    const posata = await tiles(page).first().evaluate(dentro);
    expect(posata.parti, "icona e titolo ci sono entrambi").toBe(2);
    expect(posata.nome).toContain("E2E-Fit-Pin");
    expect(posata.fuori, "e nessuno dei due esce dalla tessera").toBe(0);

    // Un progetto CON favicon, in una riga LARGA: l'icona identifica, e il
    // titolo ci sta ACCANTO — due progetti con la stessa icona restano
    // distinguibili. Che il titolo se ne vada quando la tessera si stringe fino
    // a diventare un quadrato lo difende TILE-26: la regola e' la forma della
    // tessera, non la presenza dell'icona.
    const conIcona = "/tmp/e2e-tile-favicon";
    mkdirWithIcon(conIcona);
    const proj = await createTopic(request, `E2E-Fit-Proj-${Date.now()}`, { projectPath: conIcona });
    created.push(proj.id);
    await setPins(page, [pin.id, `project:${conIcona}`]);
    await gotoSidebar(page);
    const tessellaProj = tileNamed(page, "e2e-tile-favicon");
    await expect(tessellaProj).toBeVisible({ timeout: 15000 });
    await expect(tessellaProj.locator("img"), "la favicon c'e'").toHaveCount(1, { timeout: 15000 });
    const boxProj = (await tessellaProj.boundingBox())!;
    expect(boxProj.width, "in due su una riga la tessera e' larga, non quadrata").toBeGreaterThan(72);
    await expect(
      tessellaProj.getByTestId("pinned-tile-name"),
      "e allora il titolo si legge accanto all'icona",
    ).toBeVisible();

    // 2. L'ANTEPRIMA, trascinando una riga della lista sui fissati, mostra le
    //    stesse due cose — e nemmeno lei trabocca.
    const riga = page.getByRole("treeitem", { name: chat.name }).first();
    await expect(riga).toBeVisible({ timeout: 15000 });
    const anteprima = await riga.evaluate(async (src) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const row = document.querySelector('[data-testid="pinned-row"]') as HTMLElement;
      const box = (row.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      row.dispatchEvent(new DragEvent("dragover", {
        dataTransfer: dt, bubbles: true, cancelable: true,
        clientX: box.left + 2, clientY: box.top + 5,
      }));
      await attendi();
      const prev = row.querySelector('[data-testid="pinned-drop-preview"]');
      const tile = prev?.querySelector("[data-pinned-tile]") as HTMLElement | null;
      let out: { c: boolean; parti: number; nome: string | null; fuori: number } =
        { c: false, parti: 0, nome: null, fuori: 0 };
      if (tile) {
        const b = tile.getBoundingClientRect();
        const parti = [
          tile.querySelector('[data-testid="pinned-tile-name"]'),
          tile.querySelector("svg, img"),
        ].filter(Boolean) as Element[];
        out = {
          c: true,
          parti: parti.length,
          nome: tile.querySelector('[data-testid="pinned-tile-name"]')?.textContent ?? null,
          fuori: parti.filter(e => {
            const r = e.getBoundingClientRect();
            return r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5;
          }).length,
        };
      }
      src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      return out;
    });

    expect(anteprima.c, "l'anteprima esiste").toBe(true);
    expect(anteprima.parti, "con icona E titolo").toBe(2);
    expect(anteprima.nome, "il titolo e' quello giusto").toContain("E2E-Fit-Chat");
    expect(anteprima.fuori, "e si vedono per intero").toBe(0);
  });

  test("TILE-26: il titolo se ne va quando la tessera diventa un quadrato, e niente si dipinge fuori", async ({ page, request }) => {
    // LA REGOLA E' LA FORMA, NON L'ICONA.
    // Stretta (quattro o piu' per riga, sotto i 72px) la tessera e' quasi un
    // quadrato: un titolo li' dentro sarebbe due caratteri e tre puntini, e se
    // c'e' una favicon a reggere l'identita' se ne va. Larga, la stessa
    // identica tessera torna una riga e il titolo si legge. Si misura la
    // STESSA cosa nelle due forme, cambiando solo quante ne stanno in riga:
    // cosi' il test parla della soglia e non di due tessere diverse.
    const conIcona = "/tmp/e2e-tile-soglia";
    mkdirWithIcon(conIcona);
    const proj = await createTopic(request, `E2E-Soglia-Proj-${Date.now()}`, { projectPath: conIcona });
    created.push(proj.id);
    const chiaveProj = `project:${conIcona}`;
    const riempitivi: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await createTopic(request, `E2E-Soglia-${i}-${Date.now()}`);
      created.push(t.id);
      riempitivi.push(t.id);
    }

    // ── Stretta: cinque su una riga sola ────────────────────────────────────
    const tutte = [chiaveProj, ...riempitivi];
    await setPins(page, tutte, [tutte]);
    await gotoSidebar(page);
    const stretta = tileNamed(page, "e2e-tile-soglia");
    await expect(stretta).toBeVisible({ timeout: 15000 });
    await expect(stretta.locator("img"), "la favicon c'e'").toHaveCount(1, { timeout: 15000 });
    const boxStretta = (await stretta.boundingBox())!;
    expect(boxStretta.width, "cinque in riga: la tessera e' quasi quadrata").toBeLessThan(72);
    await expect(
      stretta.getByTestId("pinned-tile-name"),
      "e allora il titolo non si vede",
    ).toBeHidden();

    // Il nome ACCESSIBILE resta: chi legge con uno screen reader, e i test che
    // cercano la riga per nome, non devono accorgersi che e' un quadrato.
    await expect(stretta).toHaveAttribute("aria-label", "e2e-tile-soglia");

    // NIENTE DIPINTO FUORI. C'era uno strato sfocato a `-inset-1.5` con
    // `blur(9px)`: ~15px di alone oltre il rettangolo, che in una griglia
    // fitta finivano addosso alle tessere vicine. Si misura ogni discendente
    // contro la tessera — l'unica domanda che conta, e che quello strato
    // falliva per costruzione.
    const sbordano = await stretta.evaluate((t: HTMLElement) => {
      const b = t.getBoundingClientRect();
      return [...t.querySelectorAll<HTMLElement>("*")]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 || r.height > 0)
        .filter(({ r }) =>
          r.left < b.left - 0.5 || r.right > b.right + 0.5 ||
          r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5)
        .map(({ e, r }) => `${e.tagName.toLowerCase()}.${e.className || "?"} ${JSON.stringify(r.toJSON())}`);
    });
    expect(sbordano, "nessuno strato esce dalla tessera").toEqual([]);

    // ── Larga: la stessa tessera, da sola sulla riga ────────────────────────
    await setPins(page, [chiaveProj], [[chiaveProj]]);
    await gotoSidebar(page);
    const larga = tileNamed(page, "e2e-tile-soglia");
    await expect(larga).toBeVisible({ timeout: 15000 });
    const boxLarga = (await larga.boundingBox())!;
    expect(boxLarga.width, "da sola in riga la tessera e' larga").toBeGreaterThan(72);
    await expect(
      larga.getByTestId("pinned-tile-name"),
      "e allora il titolo torna, accanto all'icona",
    ).toBeVisible();
  });

  test("TILE-32: da quadrata centra l'ICONA, non il gruppo — il chevron non pesa", async ({ page, request }) => {
    // CENTRATA VUOL DIRE L'ICONA AL CENTRO, non il gruppo al centro.
    // Quando il titolo se ne va resta la sola icona, ma `justify-center` centra
    // quello che sta NEL FLUSSO: col chevron accanto, il centro era quello dei
    // due messi insieme, e l'icona finiva fuori asse di mezzo chevron piu'
    // mezzo spazio — misurati 8px su una tessera larga 56,5. Qui si misura la
    // sola cosa che conta: il centro dell'icona contro il centro della tessera.
    const conIcona = "/tmp/e2e-tile-centro";
    mkdirWithIcon(conIcona);
    const chat = await createTopic(request, `E2E-Centro-Chat-${Date.now()}`, { projectPath: conIcona });
    created.push(chat.id);
    const chiaveProj = `project:${conIcona}`;
    const riempitivi: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await createTopic(request, `E2E-Centro-${i}-${Date.now()}`);
      created.push(t.id);
      riempitivi.push(t.id);
    }

    // -- THERE IS ROOM: the chevron weighs the same at both ends -----------
    // The only lever on the width is HOW MANY fit in the row: hand-written
    // widths do nothing, `reconcilePinnedLayout` evens them out on read. On a
    // 244px row: THREE make ~77 (above the 76 where chevron, icon and mirror
    // all fit, and below the 104 where the title would come back), four make
    // ~56, five ~44, six ~36.
    const inFascia = [chiaveProj, chat.id, riempitivi[0]];
    await setPins(page, inFascia, [inFascia]);
    await gotoSidebar(page);
    const tessera = tileNamed(page, "e2e-tile-centro");
    await expect(tessera).toBeVisible({ timeout: 15000 });
    await expect(tessera.locator("img"), "la favicon c'e'").toHaveCount(1, { timeout: 15000 });
    await expect(tessera.getByTestId("pinned-expand-hint"), "e c'e' da aprire").toHaveCount(1);

    const misura = await tessera.evaluate((t: HTMLElement) => {
      const b = t.getBoundingClientRect();
      const img = t.querySelector("img")!.getBoundingClientRect();
      // A USCIRE DAL FLUSSO E' LO SLOT, non il glifo che ci sta dentro.
      // Da quando il chevron ha uno slot di larghezza fissa (perche' il nome
      // parta dalla stessa x con e senza chevron), `pinned-tile-lead` sta sul
      // wrapper: il glifo dentro resta `static` ed e' giusto cosi'. Questo
      // test leggeva la `position` del glifo e chiedeva `absolute`: misurava
      // il posto sbagliato, quindi era rosso pur essendo tutto a posto.
      const chev = t.querySelector<HTMLElement>('[data-testid="pinned-expand-hint"]')!;
      const slot = t.querySelector<HTMLElement>('[data-testid="pinned-chevron-slot"]')!;
      const c = chev.getBoundingClientRect();
      const mirror = t.querySelector<HTMLElement>('[data-testid="pinned-chevron-mirror"]');
      return {
        larghezza: b.width,
        scarto: (img.left + img.right) / 2 - (b.left + b.right) / 2,
        posizioneChevron: getComputedStyle(slot).position,
        chevronPrecede: c.right - img.left,
        chevronDentro: c.left - b.left,
        slot: +slot.getBoundingClientRect().width.toFixed(1),
        mirror: mirror ? +mirror.getBoundingClientRect().width.toFixed(1) : null,
      };
    });
    // La fascia E' il soggetto del test: se la griglia cambiasse e la tessera
    // ne uscisse, questo test misurerebbe un altro caso senza dirlo.
    expect(misura.larghezza, `larghezza fuori fascia: ${JSON.stringify(misura)}`).toBeGreaterThanOrEqual(76);
    expect(misura.larghezza, `larghezza fuori fascia: ${JSON.stringify(misura)}`).toBeLessThan(104);

    await expect(tessera.getByTestId("pinned-tile-name"), "quadrata: niente titolo").toBeHidden();
    // Prima l'esito, poi il meccanismo: se un giorno si centra in un altro
    // modo, la riga che deve restare rossa e' quella dell'icona fuori asse.
    expect(
      Math.abs(misura.scarto),
      `l'icona sta al centro della tessera: ${JSON.stringify(misura)}`,
    ).toBeLessThanOrEqual(1);
    // THE CHEVRON STAYS IN THE FLOW, AND IT IS MIRRORED.
    // It used to leave the flow between 54 and 72px: the centre came out right
    // and the name ended up UNDER the chevron, because out of the flow it
    // stops reserving its room. Now it weighs 12px at the head and 12 at the
    // tail (same weight at both ends, so it moves nothing) and it overlaps
    // nothing, at any width.
    expect(misura.posizioneChevron, "il chevron resta nel flusso, in testa alla riga").toBe("static");
    expect(misura.chevronPrecede, "il chevron non si sovrappone all'icona").toBeLessThanOrEqual(0);
    expect(misura.chevronDentro, "e resta dentro la tessera").toBeGreaterThanOrEqual(-0.5);
    expect(misura.mirror, "in coda c'e' lo specchio del chevron, largo uguale").toBe(misura.slot);

    // ── Il CONTEGGIO non pesa mai: va nell'angolo ──────────────────────────
    // Non si semina un non-letto vero — servirebbe una chat aperta e non
    // guardata, cioe' una corsa col fuoco — si mette la CLASSE del conteggio
    // dentro la tessera VERA: il contenitore misurato, la larghezza e la
    // regola sono quelli veri, e quel che si guarda e' dove lo mandano e se
    // sposta l'icona di un pixel.
    const conConteggio = await tessera.evaluate((t: HTMLElement) => {
      const img = t.querySelector("img")!;
      const before = img.getBoundingClientRect();
      const finto = document.createElement("span");
      finto.className = "pinned-tile-count flex-shrink-0 min-w-[16px] h-4";
      finto.textContent = "3";
      t.appendChild(finto);
      const b = t.getBoundingClientRect();
      const f = finto.getBoundingClientRect();
      const after = img.getBoundingClientRect();
      // Letta PRIMA di staccarlo: su un nodo fuori dal documento
      // `getComputedStyle` torna vuoto, e l'asserzione non potrebbe fallire.
      const posizione = getComputedStyle(finto).position;
      finto.remove();
      return {
        posizione,
        spostaIcona: Math.abs((after.left + after.right) / 2 - (before.left + before.right) / 2),
        inAlto: f.top - b.top,
        aDestra: b.right - f.right,
        dentro: f.right <= b.right + 0.5 && f.top >= b.top - 0.5 && f.bottom <= b.bottom + 0.5,
      };
    });
    expect(conConteggio.posizione, "il conteggio esce dal flusso").toBe("absolute");
    expect(conConteggio.spostaIcona, "e non sposta l'icona di un pixel").toBeLessThanOrEqual(0.5);
    expect(conConteggio.inAlto, "sta in alto").toBeLessThanOrEqual(4);
    expect(conConteggio.aDestra, "e a destra").toBeLessThanOrEqual(4);
    expect(conConteggio.dentro, "dentro la tessera, come tutto il resto").toBe(true);

    // -- NARROWER STILL: the rule does not change --------------------------
    // There used to be an exception under 54px (the chevron came back into the
    // flow and the icon went off axis) because out of the flow it would have
    // landed ON the icon. With the mirror the alignment has no threshold left:
    // six tiles in a row centre like three. The HINT does go under 76px, where
    // chevron, icon and mirror stop fitting together, and that is the only
    // thing this branch has left to check.
    const strette = [chiaveProj, chat.id, ...riempitivi];
    await setPins(page, strette, [strette]);
    await gotoSidebar(page);
    const minuscola = tileNamed(page, "e2e-tile-centro");
    await expect(minuscola).toBeVisible({ timeout: 15000 });
    const senzaSpazio = await minuscola.evaluate((t: HTMLElement) => {
      const b = t.getBoundingClientRect();
      const img = t.querySelector("img")!.getBoundingClientRect();
      // THE SLOT, not the glyph inside it. The glyph is an <svg>, and an SVG
      // element has no `offsetParent` at all (it is an HTMLElement property):
      // reading it there answers `undefined` on a hidden chevron just as on a
      // visible one, which is an assertion that cannot fail. The slot is the
      // element that carries the `display`, so it is the one to ask.
      const slot = t.querySelector<HTMLElement>('[data-testid="pinned-chevron-slot"]');
      const drawn = slot !== null && getComputedStyle(slot).display !== "none";
      return {
        larghezza: b.width,
        scarto: (img.left + img.right) / 2 - (b.left + b.right) / 2,
        posizioneChevron: drawn ? getComputedStyle(slot!).position : null,
      };
    });
    expect(senzaSpazio.larghezza, `sei in riga: sotto la soglia — ${JSON.stringify(senzaSpazio)}`).toBeLessThan(76);
    expect(senzaSpazio.posizioneChevron, "sotto i 76px il segno se ne va: non ci sta").toBeNull();
    expect(
      Math.abs(senzaSpazio.scarto),
      `anche a ${senzaSpazio.larghezza}px l'icona resta al centro: ${JSON.stringify(senzaSpazio)}`,
    ).toBeLessThanOrEqual(1);
  });

  test("TILE-27: al ricarico il titolo non lampeggia prima dell'icona", async ({ page, request }) => {
    // IL LAYOUT NON PUO' DIPENDERE DA UNA RICHIESTA DI RETE.
    // Lo store dell'icona partiva da 'probing' e si idratava dalla cache in un
    // `useEffect`, cioe' DOPO il primo paint: la tessera disegnava un frame col
    // titolo e poi saltava all'icona sola. Si vedeva a ogni refresh, anche con
    // l'icona in cache da sempre.
    //
    // Non si campiona UN istante — un lampo di un frame passerebbe liscio. Si
    // registra ogni frame dall'inizio del documento e si guarda l'INSIEME degli
    // stati attraversati: se e' uno solo, non c'e' stato nessun salto.
    const conIcona = "/tmp/e2e-tile-lampo";
    mkdirWithIcon(conIcona);
    const proj = await createTopic(request, `E2E-Lampo-Proj-${Date.now()}`, { projectPath: conIcona });
    created.push(proj.id);
    const chiaveProj = `project:${conIcona}`;
    const riempitivi: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await createTopic(request, `E2E-Lampo-${i}-${Date.now()}`);
      created.push(t.id);
      riempitivi.push(t.id);
    }
    const tutte = [chiaveProj, ...riempitivi];
    await setPins(page, tutte, [tutte]);

    // Primo giro: serve solo a far conoscere l'icona alla cache persistita,
    // che e' la condizione del refresh vero (la seconda volta in poi).
    await gotoSidebar(page);
    await expect(tileNamed(page, "e2e-tile-lampo").locator("img")).toHaveCount(1, { timeout: 15000 });

    // Il registratore parte PRIMA di qualunque script della pagina.
    await page.addInitScript(() => {
      const visti = new Set<string>();
      (window as unknown as { __statiNome: Set<string> }).__statiNome = visti;
      const giro = () => {
        const tessera = document.querySelector('[data-pinned-tile^="project:"]');
        // Finche' la tessera non c'e' non si registra niente: l'assenza non e'
        // uno stato attraversato, e' la pagina che non e' ancora nata.
        if (tessera) {
          const nome = tessera.querySelector('[data-testid="pinned-tile-name"]');
          // «Non c'e' proprio» e' uno stato quanto «c'e' ma e' nascosto»: senza
          // registrarlo, un titolo DISEGNATO e poi STACCATO dal DOM lascerebbe
          // un insieme di un elemento solo — cioe' il lampo che stiamo cercando
          // passerebbe per «nessun salto».
          visti.add(nome ? getComputedStyle(nome).display : "assente");
        }
        requestAnimationFrame(giro);
      };
      requestAnimationFrame(giro);
    });

    await gotoSidebar(page);
    const tessera = tileNamed(page, "e2e-tile-lampo");
    await expect(tessera).toBeVisible({ timeout: 15000 });
    await expect(tessera.locator("img"), "la favicon e' arrivata").toHaveCount(1, { timeout: 15000 });
    // Qualche frame in piu' dopo che l'icona e' apparsa: il salto, se c'e',
    // cade proprio li'.
    await page.waitForTimeout(500);

    const stati = await page.evaluate(() =>
      [...(window as unknown as { __statiNome: Set<string> }).__statiNome]);
    expect(stati.length, `il titolo non deve cambiare stato: visti ${JSON.stringify(stati)}`).toBe(1);
    expect(stati[0], "e lo stato e' 'nascosto', perche' la tessera e' stretta").toBe("none");
  });
});

test.describe("Sidebar — avanti e indietro fra lista e fissati", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-24: sfissare trascinando NON archivia: la riga resta nella lista", async ({ page, request }) => {
    // Il difetto piu' grave del gesto inverso. `onTogglePin` porta con se' una
    // semantica giusta altrove — «una chat che sfissi a tab chiusa non ti serve
    // piu', archiviala» — e disastrosa qui: la riga spariva un istante dopo
    // averla trascinata NELLA lista, e senza `showArchived` non c'era piu'
    // modo di riprenderla. Ecco perche' «poi non riesco piu' a farlo».
    const t = await createTopic(request, `E2E-Round-${Date.now()}`);
    created.push(t.id);

    await setPins(page, [t.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    const sullaLista = async () => page.evaluate(async (key) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const lista = document.querySelector(".sidebar-scroll") as HTMLElement;
      const dt = new DataTransfer();
      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      lista.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      await attendi();
      lista.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
    }, t.id);

    await sullaLista();
    await expect(tiles(page)).toHaveCount(0, { timeout: 15000 });

    // LA COSA CHE CONTA: la riga e' nella lista, viva. Non archiviata, non
    // sparita.
    await expect(
      page.getByRole("treeitem", { name: t.name }).first(),
      "la riga deve stare nella lista dove l'hai lasciata",
    ).toBeVisible({ timeout: 15000 });
    // E lo dice anche il server, non solo lo schermo. (`GET /api/topics/:id`
    // non esiste: la lista e' l'unico modo di chiederlo.)
    const dopo = await request.get(`${E2E_BASE}/api/topics`);
    // La risposta è `{ topics: { <id>: Topic }, … }`, non un array.
    const body = (await dopo.json()) as { topics?: Record<string, { archived?: boolean }> };
    const mia = body.topics?.[t.id];
    expect(mia, "la topic esiste ancora").toBeTruthy();
    expect(mia?.archived ?? false, "e non deve essere stata archiviata").toBe(false);
  });

  test("TILE-25: il giro completo si puo' rifare — fissa, sfissa, rifissa", async ({ page, request }) => {
    // «Faccio avanti e indietro e poi non riesco piu'»: lo stato del drag
    // restava acceso quando un gesto finiva FUORI dalla superficie che l'aveva
    // visto nascere, e da li' in poi la griglia si credeva ancora in mezzo a un
    // trascinamento.
    const t = await createTopic(request, `E2E-Ping-${Date.now()}`);
    const compagno = await createTopic(request, `E2E-Ping-Alt-${Date.now()}`);
    created.push(t.id, compagno.id);

    await setPins(page, [compagno.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    const fissaTrascinando = async (nome: string) => {
      const riga = page.getByRole("treeitem", { name: nome }).first();
      await expect(riga).toBeVisible({ timeout: 15000 });
      await riga.evaluate(async (src) => {
        const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const row = document.querySelector('[data-testid="pinned-row"]') as HTMLElement;
        const box = (row.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
        const punto = { clientX: box.left + 2, clientY: box.top + 5 };
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
        row.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
        await attendi();
        row.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
        src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
        await attendi();
      });
    };

    const sfissaTrascinando = async (key: string) => {
      await page.evaluate(async (k) => {
        const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const tile = document.querySelector(`[data-pinned-tile="${k}"]`) as HTMLElement;
        const lista = document.querySelector(".sidebar-scroll") as HTMLElement;
        const dt = new DataTransfer();
        tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
        lista.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
        await attendi();
        lista.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
        await attendi();
      }, key);
    };

    // Due giri interi: se lo stato si incastra, il secondo non passa.
    for (let giro = 0; giro < 2; giro++) {
      await fissaTrascinando(t.name);
      await expect(tiles(page), `giro ${giro}: fissata`).toHaveCount(2, { timeout: 15000 });
      await sfissaTrascinando(t.id);
      await expect(tiles(page), `giro ${giro}: sfissata`).toHaveCount(1, { timeout: 15000 });
    }

    // E il compagno non si e' mosso: i giri non hanno toccato altro.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        return ((env?.value ?? env)?.pinnedItems ?? []) as string[];
      }, { timeout: 15000 })
      .toEqual([compagno.id]);
  });
});
