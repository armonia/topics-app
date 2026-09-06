/**
 * board-task-id-chip.spec.ts — il riferimento al task è un SEGNO, non una parola.
 *
 * Prima: l'eyebrow della card stampava lo slug per esteso ("brave-otter") in un
 * chip `shrink-0`. Non si comprimeva mai, quindi si prendeva ~70px della riga e
 * costringeva il nome del progetto a troncare per fargli posto: «un chip con lo
 * slug del task che sta un pochino davanti» (Attilio, 12/08).
 *
 * Ora è il glifo `#` a 14px — la misura standard di ogni icona di riga
 * (`ROW_GLYPH`) — con lo slug e l'UUID nel `title`. Il click continua a COPIARE
 * l'id pieno: per questo il segno è `#` e non l'icona del link, che prometterebbe
 * una navigazione che non c'è.
 *
 * Questa spec è la barra, non un contorno: misura sul DOM vero
 * (getBoundingClientRect + hit-test) che
 *   · il segno non sborda dalla riga che lo contiene,
 *   · è centrato verticalmente con gli altri chip della riga,
 *   · il bersaglio del dito resta ≥44px anche se il disegno ne occupa 14,
 *   · e che il chip pesa ora una frazione della riga (≤28px contro i ~70 di prima).
 *
 * Produce anche le due schermate della consegna, con `CHIP_SHOT=1`.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-idchip-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** Il minimo che un dito deve poter colpire, in px CSS (HIG Apple / Material). */
const TAP_MIN = 44;
/** Quanto può occupare il segno sulla riga: il glifo (14) più il suo respiro. */
const CHIP_MAX_W = 28;

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string; priority?: number; description?: string },
): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-idchip/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/**
 * La geometria della riga, misurata: il rettangolo del chip, quello della riga
 * che lo contiene, e il bersaglio EFFETTIVO del dito — che non è il rettangolo
 * del bottone ma l'area in cui il hit-test restituisce ancora il bottone (il
 * `::after` invisibile che allarga la presa senza toccare il layout).
 */
type ChipGeometry = {
  chip: { x: number; y: number; w: number; h: number; cy: number };
  /** Il contenitore del segno (il titolo) e il centro della sua PRIMA riga. */
  row: { top: number; bottom: number; left: number; right: number; cy: number };
  /** Il rettangolo dichiarato dal `::after` di `tap-expand` (0 se non c'è). */
  pseudo: { w: number; h: number };
  /** Il hit-test vero a `PROBE` px dal centro, nelle quattro direzioni. */
  reach: { left: boolean; right: boolean; up: boolean; down: boolean };
  coarse: boolean;
};

/**
 * A che distanza dal centro si va a bussare. Un pelo dentro il bordo dei 44px
 * (22 per lato): sul bordo esatto il campionamento a coordinate intere di
 * `elementsFromPoint` cade dentro o fuori a seconda del mezzo pixel a cui il
 * layout ha messo il glifo, e misurerebbe l'arrotondamento invece dell'area.
 * Il numero ESATTO lo dà `pseudo`; questa sonda dice che quell'area è davvero
 * sensibile al tocco e non solo dichiarata.
 */
const PROBE = TAP_MIN / 2 - 1;

async function measureChip(page: Page, taskId: string): Promise<ChipGeometry> {
  const card = page.locator(`[data-task-card="${taskId}"]`).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  const chip = card.getByTestId("task-id-chip");
  await expect(chip).toBeVisible({ timeout: 10000 });

  return chip.evaluate((el, probe) => {
    const r = el.getBoundingClientRect();
    // La casa del segno e' il TITOLO: dal 16/08 sta davanti al nome del task,
    // non piu' nell'eyebrow del progetto (dove leggeva come una proprieta' del
    // progetto, «topics-app #»). La riga e' un flex con due figli — il gruppo
    // dei segni e il nome — e il riferimento verticale e' il RETTANGOLO DELLA
    // PRIMA RIGA DI TESTO, preso con un Range: non l'altezza del blocco, che su
    // un titolo che va a capo scende sotto il glifo e farebbe misurare l'andare
    // a capo invece dell'allineamento.
    const gruppo = el.parentElement!;
    const rowEl = gruppo.parentElement!;
    const rr = rowEl.getBoundingClientRect();
    // IL TITOLO E' UN NODO DI TESTO DELLA RIGA, non un elemento dentro di essa.
    //
    // Fino al 16/08 la riga era un flex con DUE figli (gruppo dei segni + uno
    // span col nome), e `lastElementChild` era quello span. Dal 17/08 il titolo
    // sta in linea nella riga - serve perche' vada a capo AL BORDO invece che
    // sotto se stesso (IDCHIP-05) - quindi `lastElementChild` e' tornato ad
    // essere il gruppo dei segni, e questa sonda misurava il chip contro se
    // stesso: 10,25px di «scarto» su un layout corretto.
    //
    // Si prende il primo nodo di TESTO con del contenuto, ovunque stia: regge
    // sia la vecchia forma (dentro uno span) sia quella nuova (in linea).
    const camminatore = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
    let testo: Text | undefined;
    for (let n = camminatore.nextNode(); n; n = camminatore.nextNode()) {
      // Salta il testo che sta DENTRO i segni (il `#a1b2` del chip): quello e'
      // il soggetto della misura, non il suo riferimento.
      if (gruppo.contains(n)) continue;
      if ((n.textContent ?? '').trim().length > 0) { testo = n as Text; break; }
    }
    let firstLineCy = rr.top + rr.height / 2;
    if (testo) {
      const rg = document.createRange();
      rg.selectNodeContents(testo);
      const first = rg.getClientRects()[0];
      if (first) firstLineCy = first.y + first.height / 2;
    }
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const reaches = (dx: number, dy: number) =>
      document.elementsFromPoint(cx + dx, cy + dy).includes(el);
    const after = getComputedStyle(el, "::after");
    return {
      chip: { x: r.x, y: r.y, w: r.width, h: r.height, cy },
      row: { top: rr.top, bottom: rr.bottom, left: rr.left, right: rr.right, cy: firstLineCy },
      pseudo: { w: parseFloat(after.width) || 0, h: parseFloat(after.height) || 0 },
      reach: {
        left: reaches(-probe, 0),
        right: reaches(probe, 0),
        up: reaches(0, -probe),
        down: reaches(0, probe),
      },
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  }, PROBE);
}

/**
 * La card più in BASSO fra quelle seminate — cioè una card qualunque, non la
 * prima della colonna.
 *
 * Misurato: l'area proiettata da `tap-expand` è alta 44 e centrata sul glifo,
 * ma la lista delle card è un contenitore che scorre, e un contenitore che
 * scorre RITAGLIA. Sulla card in cima alla colonna la metà superiore
 * dell'area finisce oltre il bordo del contenitore e il hit-test la restituisce
 * all'intestazione della colonna: 44px pieni lassù non esistono per nessun
 * bersaglio, qualunque sia il disegno. Su ogni altra card — cioè il caso
 * normale — l'area è tutta lì, ed è quella che questo test misura.
 */
async function lowerCardId(page: Page, ids: string[]): Promise<string> {
  const tops = await Promise.all(ids.map(async (id) => {
    const box = await page.locator(`[data-task-card="${id}"]`).first().boundingBox();
    return { id, top: box?.y ?? -Infinity };
  }));
  return tops.sort((a, b) => b.top - a.top)[0].id;
}

test.describe("Board card — il riferimento al task è un segno, non una parola", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-idchip" }, null, 2));
    const topic = await createTopic(request, "E2E-IdChip", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    await apiCreateTask(request, {
      text: "Rivedere l'eyebrow della card e il riferimento al task",
      status: "todo",
      priority: 2,
    });
    // La seconda card serve al test del dito: vedi `lowerCardId`.
    await apiCreateTask(request, {
      text: "Seconda card, per misurare il bersaglio lontano dal bordo della colonna",
      status: "todo",
      priority: 2,
    });
    // La TERZA ha un titolo che va a capo per forza: serve a IDCHIP-05, che
    // misura DOVE ricomincia la seconda riga.
    await apiCreateTask(request, {
      text: "Un titolo lungo abbastanza da andare a capo dentro la colonna della board, "
        + "perche' e' esattamente li' che si vedeva il difetto dell'incolonnamento",
      status: "todo",
      priority: 2,
    });
  });

  test.afterAll(async ({ request }) => {
    for (const tid of createdTasks) await deleteTask(request, PROJECT_ID, tid);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await openProjectBoard(page);
  });

  test("IDCHIP-01: il segno sta nella riga, centrato, e non la occupa", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-44" });
    const g = await measureChip(page, createdTasks[0]);

    expect(g.chip.w, `il segno deve pesare ≤${CHIP_MAX_W}px sulla riga`).toBeLessThanOrEqual(CHIP_MAX_W);
    // Dentro la riga su tutti e quattro i lati: 0.5px di tolleranza è il
    // sub-pixel del layout, non un permesso a sbordare.
    expect(g.chip.y).toBeGreaterThanOrEqual(g.row.top - 0.5);
    expect(g.chip.y + g.chip.h).toBeLessThanOrEqual(g.row.bottom + 0.5);
    expect(g.chip.x).toBeGreaterThanOrEqual(g.row.left - 0.5);
    expect(g.chip.x + g.chip.w).toBeLessThanOrEqual(g.row.right + 0.5);
    // ALLINEATO CON IL TESTO ACCANTO: i segni stanno in un gruppo alto
    // esattamente una riga di titolo e ci si centrano dentro, quindi i due
    // centri coincidono per costruzione e non per taratura. Misurato prima e
    // dopo il 16/08: era 1,81px di scarto con `align-middle` inline, e nessuno
    // dei sette valori di `vertical-align` provati scendeva sotto 1,3 — perche'
    // il chip e' piu' alto della riga di testo e quindi e' LUI a definirla.
    //
    // UN PIXEL, e non mezzo, ed e' il font a deciderlo. Lo scarto residuo e' la
    // distanza fra il centro geometrico della riga e il centro OTTICO del
    // glifo, che dipende dalle metriche della faccia effettivamente montata:
    // 0,1px su macOS con la San Francisco di sistema, 0,625px sul runner Linux
    // che ripiega su un'altra faccia. Con la soglia a 0,5 il cancello misurava
    // quale font ha la macchina, non se il layout e' allineato — verde in
    // locale, rosso in CI, sullo stesso identico DOM.
    // Un pixel resta un cancello vero: la regressione che questo test esiste
    // per fermare valeva 1,81px, e passare da qui richiederebbe di raddoppiare
    // lo scarto peggiore mai misurato su una macchina qualsiasi.
    expect(Math.abs(g.chip.cy - g.row.cy)).toBeLessThanOrEqual(1);
  });

  test("IDCHIP-01b: l'allineamento REGGE ANCHE SOTTO UN ALTRO FONT", async ({ page }) => {
    // IL CONFINE CHE HA FATTO CADERE QUESTO TEST IN CI.
    //
    // `IDCHIP-01` misura mezzo pixel, e mezzo pixel dipende dalla FACCIA
    // montata: in locale c'e' la San Francisco di sistema, sul runner Linux ce
    // n'e' un'altra. Un verde sul portatile non dice niente su cosa succede
    // la'; e' esattamente cosi' che questo caso e' passato in locale ed e'
    // stato rosso in CI.
    //
    // La prova che serve non e' «passa anche altrove» (non posso installare i
    // font del runner), ma «l'allineamento non DIPENDE dal font». Il gruppo
    // dei segni e' alto una line-box e si allinea alla line-box (`align-top`),
    // e la line-box vale 19,25px con qualunque faccia: e' `leading-snug` sul
    // font-size, non una metrica del carattere.
    //
    // Misurato il 17/08 su cinque facce con metriche molto diverse: il testo
    // passa da 15px (Times) a 17px (sistema) di altezza, e lo scarto del chip
    // resta fra 0,125 e 0,625 - sempre sotto la soglia di 1.
    //
    // Col vecchio `align-text-bottom` sarebbe stato meta' della differenza fra
    // line-box e testo, cioe' 1,125px col font di sistema e 2,125 con Times:
    // fuori soglia SEMPRE, e di quanto lo decideva il carattere.
    const FACCE = [
      ['Georgia, serif', 'serif con x-height alta'],
      ['"Times New Roman", serif', 'serif con x-height bassa'],
      ['"Courier New", monospace', 'monospazio'],
      ['Verdana, sans-serif', 'sans con x-height alta'],
    ];
    for (const [family, che] of FACCE) {
      await page.addStyleTag({ content: `:root, body, * { font-family: ${family} !important; }` });
      const g = await measureChip(page, createdTasks[0]);
      // eslint-disable-next-line no-console
      console.log(`[IDCHIP-01b] ${che.padEnd(24)} scarto ${(g.chip.cy - g.row.cy).toFixed(3)}px`);
      expect(
        Math.abs(g.chip.cy - g.row.cy),
        `con ${family} (${che}) il chip e' fuori asse: l'allineamento dipende dal font, e in CI la faccia e' un'altra`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("IDCHIP-02: col mouse l'area sensibile resta quella del glifo", async ({ page }) => {
    // Il rovescio del patto: su puntatore fine `tap-expand` non proietta
    // niente, quindi il segno non ruba i clic al nome del progetto accanto né
    // al titolo sotto (che aprono la card). Senza questa metà, allargare il
    // bersaglio sarebbe un peggioramento travestito da accessibilità.
    const g = await measureChip(page, createdTasks[0]);
    expect(g.coarse, "il contesto desktop deve avere puntatore fine").toBe(false);
    expect(g.pseudo.w, "col mouse nessuna area proiettata").toBe(0);
    expect(g.reach, "a 21px dal centro il bottone non deve più rispondere")
      .toEqual({ left: false, right: false, up: false, down: false });
  });

  test("IDCHIP-03: il click copia l'UUID pieno e lo conferma", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const taskId = createdTasks[0];
    const card = page.locator(`[data-task-card="${taskId}"]`).first();
    const chip = card.getByTestId("task-id-chip");

    // Lo slug non è perso: vive nel title, insieme all'id pieno.
    await expect(chip).toHaveAttribute("title", new RegExp(taskId.replace(/-/g, "\\-")));

    await chip.click();
    await expect(chip).toHaveAttribute("data-copied", "true");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(taskId);
    // Il click sul segno non apre la card: `stopPropagation` regge.
    await expect(page.getByTestId("task-detail-drawer")).toHaveCount(0);
  });

  test("IDCHIP-06: clipboard absence never confirms the copy", async ({ page }) => {
    const chip = page.locator(`[data-task-card="${createdTasks[0]}"]`).first().getByTestId("task-id-chip");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));

    await chip.click();

    await expect(chip).not.toHaveAttribute("data-copied", "true");
  });

  test("IDCHIP-05: un titolo lungo va a capo AL BORDO, non sotto il cancelletto", async ({ page }) => {
    // Segnalato: «il titolo non va piu' a capo bene, ma e' incolonnato a
    // partire dal cancelletto».
    //
    // I segni e il nome erano due colonne flex: i centri coincidevano per
    // costruzione (parte buona, tenuta) ma il titolo diventava una COLONNA
    // larga quanto lo spazio rimasto, quindi andava a capo sotto se stesso e
    // la card leggeva come un paragrafo rientrato.
    //
    // Si misura la GEOMETRIA e non l'aspetto: la seconda riga di testo deve
    // cominciare alla stessa x della prima, cioe' al bordo del testo della
    // card. Un VLM o un'occhiata non distinguono 11px da 35px con sicurezza;
    // due rettangoli si'.
    const card = page.locator(`[data-task-card="${createdTasks[2]}"]`).first();
    await expect(card).toBeVisible({ timeout: 10000 });

    const righe = await card.evaluate((el) => {
      // LA RIGA DEL TITOLO, non il gruppo dei segni.
      //
      // `chip.closest('span')` risale al primo span che contiene il chip: dal
      // 17/08 quello e' il GRUPPO dei segni (`inline-flex`), quindi il suo
      // `parentElement` era la riga - ma solo per un pelo, e la stessa
      // espressione su un DOM che cambia una volta di piu' misura un'altra
      // cosa senza dirlo. Meglio chiedere l'elemento per quello che E': il
      // blocco che porta il testo del titolo.
      const chip = el.querySelector('[data-testid="task-id-chip"]');
      const gruppo = chip?.parentElement;
      const riga = gruppo?.parentElement;
      if (!riga || !gruppo) return null;
      const box = el.getBoundingClientRect();
      // UN RETTANGOLO PER RIGA DI TESTO, e li da' solo un Range sul NODO DI
      // TESTO. `riga.getClientRects()` su un elemento `display: block` torna un
      // rettangolo solo - quello del blocco intero - quindi il caso trovava
      // sempre `length === 1` e si fermava dicendo «questo titolo deve andare a
      // capo», su un titolo che a capo ci andava eccome. Funzionava prima solo
      // perche' il titolo stava in uno span IN LINEA, e per quelli i rettangoli
      // sono davvero uno per riga.
      const w = document.createTreeWalker(riga, NodeFilter.SHOW_TEXT);
      let testo: Node | null = null;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (gruppo.contains(n)) continue;
        if ((n.textContent ?? '').trim().length > 0) { testo = n; break; }
      }
      if (!testo) return null;
      const rg = document.createRange();
      rg.selectNodeContents(testo);
      return [...rg.getClientRects()].map((r) => +(r.left - box.left).toFixed(1));
    });

    expect(righe, "il titolo dev'essere misurabile").not.toBeNull();
    expect(righe!.length, "questo titolo deve andare a capo, o il caso non misura niente")
      .toBeGreaterThan(1);
    // LA PRIMA RIGA COMINCIA DOPO IL CHIP, ed e' giusto cosi': il chip sta IN
    // LINEA nel titolo, quindi il testo gli scorre accanto. Misurato: prima
    // riga a x=35, le altre a x=11.
    //
    // Il difetto segnalato era l'opposto - «il titolo e' incolonnato a partire
    // dal cancelletto», cioe' TUTTE le righe a x=35, perche' il titolo era una
    // colonna flex larga quanto lo spazio rimasto. Quindi cio' che va asserito
    // e' che le righe DOPO la prima tornino al bordo del testo, non che tutte
    // partano insieme: la vecchia formulazione avrebbe preteso di rimettere il
    // difetto.
    expect(righe!.length, "servono almeno due righe, o non c'e' niente da misurare").toBeGreaterThan(1);
    const dopo = righe!.slice(1);
    // Le righe successive sono allineate FRA LORO...
    for (const x of dopo) {
      expect(Math.abs(x - dopo[0]!),
        `una riga parte da x=${x} mentre la seconda e' a x=${dopo[0]}: le righe del titolo non sono allineate`,
      ).toBeLessThanOrEqual(0.5);
    }
    // ...e stanno PIU' A SINISTRA della prima, cioe' sono tornate al bordo
    // invece di restare rientrate sotto il chip. E' la riga che diventa rossa
    // se qualcuno rimette il titolo in una colonna.
    expect(dopo[0]!,
      `la seconda riga parte da x=${dopo[0]} come la prima (x=${righe![0]}): il titolo e' incolonnato sotto il cancelletto`,
    ).toBeLessThan(righe![0]! - 1);
  });

  test("IDCHIP-04: schermata della riga per la consegna", async ({ page }, testInfo) => {
    test.skip(process.env.CHIP_SHOT !== "1", "manca CHIP_SHOT=1: non è un AC, produce su richiesta lo scatto di consegna");
    const card = page.locator(`[data-task-card="${createdTasks[0]}"]`).first();
    await expect(card).toBeVisible();
    await card.screenshot({ path: `${testInfo.project.outputDir}/../chip-${process.env.CHIP_SHOT_NAME || "shot"}.png` });
  });

  // Il dito: stesso board, contesto con touch — è lì che `tap-expand` esiste.
  test.describe("col dito", () => {
    test.use({ hasTouch: true });

    test("IDCHIP-05b: il bersaglio del dito è ≥44px pur restando un glifo da 14", async ({ page }) => {
      const g = await measureChip(page, await lowerCardId(page, createdTasks));
      // Se il contesto non è a puntatore grossolano la regola non è nemmeno
      // attiva e il test misurerebbe il vuoto: si ferma qui invece di passare.
      expect(g.coarse, "il contesto touch deve avere puntatore grossolano").toBe(true);
      expect(g.chip.w, "il DISEGNO resta piccolo").toBeLessThanOrEqual(CHIP_MAX_W);
      expect(g.pseudo.w, "larghezza del bersaglio").toBeGreaterThanOrEqual(TAP_MIN);
      expect(g.pseudo.h, "altezza del bersaglio").toBeGreaterThanOrEqual(TAP_MIN);
      // Dichiarata E sensibile: il hit-test risponde in tutte le direzioni.
      expect(g.reach).toEqual({ left: true, right: true, up: true, down: true });
    });
  });
});
