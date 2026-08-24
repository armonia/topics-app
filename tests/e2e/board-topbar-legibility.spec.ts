/**
 * board-topbar-legibility.spec.ts — la top bar della kanban si legge da sola.
 *
 * La barra era fatta di NUMERI SENZA FRASE: «Carico critico · max 1» (che cosa
 * devo fare?), «7 worktree» (numero di che cosa?), «3 non su main» all'altro
 * capo della barra rispetto a «Pubblica», che parla della stessa cosa. La
 * spiegazione esisteva, ma stava tutta nei `title`: su un telefono il tooltip
 * non esiste, e col mouse va cercato.
 *
 * Questa spec misura le quattro proprietà che rendono la barra leggibile —
 * niente tooltip, niente occhio: geometria dal DOM e testo visibile.
 *
 *  - TOPBAR-01/02/03  i progetti diventano CHIP FILTRO nello spazio che avanza,
 *    e quando lo spazio manca tornano nel menu: mai a capo (spingerebbe giù la
 *    board), mai un chip tagliato a metà. Tre larghezze: 1440 · 1000 · 390.
 *  - TOPBAR-04  il chip del carico compare SOLO quando c'è qualcosa da fare
 *    (agent in volo > consigliati) e dice l'azione, non l'aggettivo.
 *  - TOPBAR-05  la consegna è UN controllo solo: «non su main» e «su main, non
 *    pubblicato» sono due sezioni dello stesso pannello (erano due badge
 *    adiacenti, letti come lo stesso allarme scritto due volte), e il click
 *    apre l'ELENCO dei task, non il primo della lista.
 *  - TOPBAR-06  il contatore delle cartelle di lavoro dice di che cosa è, e al
 *    click spiega che cosa sono e come si liberano (il GC sta lì dentro).
 *  - TOPBAR-08  i chip dei filtri progetto portano il conteggio PER STATO, con
 *    gli stessi glifi della riga «Board» in sidebar.
 *  - TOPBAR-09  il pannello impostazioni ha sezioni con un titolo invece di
 *    dieci righe tutte uguali, e la prima dice che quell'interruttore è globale.
 *  - TOPBAR-10  il freno di QUESTA board sta nelle sue impostazioni, non fra
 *    le globali: si misura la POSIZIONE, perche' e' quella a dire di chi e'.
 *  - TOPBAR-11  chi sta per pubblicare legge che la release esce a tutti.
 *  - TOPBAR-12  i chip progetto hanno UNA larghezza e UN rientro: con la
 *    favicon e senza, la fila resta dritta.
 *  - TOPBAR-13  sotto la barra non passa nessun filetto: si guarda la catena
 *    dalla barra alla radice, perche' il bordo poteva stare su un involucro.
 *  - TOPBAR-14  alle impostazioni si entra da un posto solo, e lo stato
 *    dell'auto-dispatch ha una copia sola (il ▾ ne teneva una propria).
 *  - TOPBAR-07  audit di layout (`helpers/ui-audit.js`) alle tre larghezze:
 *    nessun overflow orizzontale, nessuna sovrapposizione, niente fuori
 *    schermo, riga a 40px (il contratto `h-10` della chrome).
 *
 * Le sonde di sistema (capacità di dispatch, worktree, rami) sono STUBBATE via
 * `page.route`: il soggetto qui è la barra, e farle dire il vero vorrebbe dire
 * mettere la macchina sotto carico e creare worktree veri — cioè misurare
 * l'ambiente invece della UI.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const AUDIT_JS = readFileSync(join(__dirname, "helpers", "ui-audit.js"), "utf8");
const SHOTS = join(process.cwd(), "test-results", "topbar");
const STAMP = Date.now();
/** Radice unica, nomi progetto CORTI: il chip mostra il basename, e quattro
 *  `e2e-topbar-alpha-1765…` non entrerebbero in nessuna barra — misurerebbero la
 *  lunghezza del nome di test, non lo spazio della riga. */
const ROOT = `/tmp/e2e-topbar-${STAMP}`;
const PROJECTS = ["alfa", "beta", "gamma", "delta"] as const;
const dirOf = (name: string) => `${ROOT}/${name}`;

const topicIds: string[] = [];
const createdTasks: string[] = [];
/** I due task chiusi che gli stub faranno risultare «non su main». */
const unlandedTitles = [`Consegna A ${STAMP}`, `Consegna B ${STAMP}`];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  projectId: string,
  text: string,
  status: string,
): Promise<void> {
  // `done` non si crea: il servizio rifiuta un task che nasce già chiuso
  // (`cannot create a task already done`). Ci si arriva come ci arriva un
  // umano — creandolo e poi chiudendolo.
  const nasce = status === "done" ? "backlog" : status;
  const res = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, { data: { text, status: nasce } });
  expect(res.ok(), `creazione task «${text}»`).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${projectId}:${task.id}`);
  if (status === "done") {
    const patch = await request.patch(`${E2E_BASE}/api/boards/${projectId}/tasks/${task.id}`, { data: { status: "done" } });
    expect(patch.ok(), `chiusura task «${text}»`).toBe(true);
  }
}

/**
 * Le sonde di sistema, stubbate.
 *
 * `running` è il termine che il chip del carico usa per decidere se esistere:
 * 4 in volo contro 2 consigliati = uno scarto su cui si può agire, quindi il
 * chip c'è. Il caso opposto (`running` basso) è TOPBAR-04b.
 */
async function stubProbes(page: Page, opts?: { running?: number }) {
  const running = opts?.running ?? 4;
  await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recommended: 2, cores: 12, totalMemGB: 32, load1: 15.4, running,
        oursCores: 6.2, budgetCores: 6,
        reason: "12 core → base 4, ridotto a 2: gli agent tengono 6.2 core sui 6 di quota",
      }),
    }));
  await page.route((url) => url.pathname === "/api/worktrees", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ worktrees: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }] }),
    }));
  await page.route((url) => url.pathname === "/api/worktrees/branches", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ summary: { total: 5, orphan: 2, onOpenTasks: 3 } }),
    }));
  // `landing_state` non ha una porta HTTP che lo scriva (lo timbra l'audit
  // periodico dopo un land): i due task chiusi si marcano nella RISPOSTA, che è
  // esattamente l'ingresso da cui la barra li legge.
  //
  // Serve ANCHE il commit di consegna: `showsLandingDebt` (shared/board.ts) tace
  // su un `unlanded` senza fotografia della consegna, perché senza quel commit
  // non c'è nessuna domanda a cui il verdetto stia rispondendo. Un task chiuso
  // via API non ce l'ha, quindi il debito va costruito per intero qui.
  await page.route((url) => /\/api\/(all-boards|boards\/[^/]+)\/tasks$/.test(url.pathname), async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { tasks?: Array<{ text?: string; status?: string; landingState?: string | null; deliveryCommit?: string | null }> };
    for (const t of body.tasks ?? []) {
      if (t.status === "done" && unlandedTitles.includes(t.text ?? "")) {
        t.landingState = "unlanded";
        t.deliveryCommit = "0ff1ce5";
      }
    }
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, PROJECTS[0]);
  await expect(btn).toBeVisible({ timeout: 15000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  // I filtri progetto esistono solo dove c'è più di un progetto da filtrare: la
  // modalità «Tutti i progetti» della board di progetto (che è anche la barra
  // più affollata che esista — ha ancora le cartelle di lavoro del progetto).
  await page.getByRole("button", { name: "Tutti i progetti" }).click();
  await expect(page.getByTestId("filter-project-chip")).toBeVisible({ timeout: 10000 });
}

/**
 * La BOARD GENERALE dalla barra standalone.
 *
 * È la superficie in cui la domanda «i progetti entrano nella barra?» ha senso:
 * niente toggle di modalità, niente cartelle di lavoro di UN progetto, e per
 * costruzione più progetti da filtrare. La board DI progetto in modalità «tutti
 * i progetti» porta ~400px di comandi in più, e con quelli lo spazio libero è
 * zero già a 1440 — che è il ripiego, ed è quello che misura TOPBAR-07.
 */
async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("filter-project-chip")).toBeVisible({ timeout: 10000 });
}

/** I chip progetto DAVVERO visibili (quelli oltre il taglio sono `invisible`). */
async function inlineChips(page: Page) {
  return page.locator('[data-testid^="project-filter-chip-"]:visible').count();
}

/** La riga della barra: una sola riga, e nessun chip oltre il bordo destro. */
async function toolbarGeometry(page: Page) {
  return page.getByTestId("board-toolbar").evaluate((el) => {
    const strip = el.querySelector('[data-testid="project-filter-strip"]');
    const stripRight = strip ? strip.getBoundingClientRect().right : 0;
    const spill = Array.from(el.querySelectorAll('[data-testid^="project-filter-chip-"]'))
      .filter((c) => getComputedStyle(c).visibility !== "hidden")
      .map((c) => c.getBoundingClientRect().right - stripRight)
      .filter((over) => over > 0.5);
    return {
      height: Math.round(el.getBoundingClientRect().height),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      stripWidth: strip ? Math.round(strip.getBoundingClientRect().width) : -1,
      chain: (() => {
        const out: string[] = [];
        let n: Element | null = strip;
        while (n && n !== el) {
          const cs = getComputedStyle(n);
          out.push(`${n.className.toString().slice(0, 24)} w=${Math.round(n.getBoundingClientRect().width)} flex=${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis} min=${cs.minWidth}`);
          n = n.parentElement;
        }
        return out;
      })(),
      spill,
    };
  });
}

async function audit(page: Page) {
  await page.addScriptTag({ content: AUDIT_JS });
  return page.evaluate(() => {
    const fn = (window as unknown as { __uiAudit: (o: unknown) => string }).__uiAudit;
    return JSON.parse(fn({ scope: '[data-testid="board-toolbar"]', minTap: 24 })) as {
      overflowX: { present: boolean; offenders: unknown[] };
      findings: { overlap: unknown[]; offscreen: unknown[] };
    };
  });
}

test.describe("Top bar della kanban — si legge da sola", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(SHOTS, { recursive: true });
    for (const name of PROJECTS) {
      mkdirSync(dirOf(name), { recursive: true });
      writeFileSync(`${dirOf(name)}/package.json`, JSON.stringify({ name }, null, 2));
      const topic = await createTopic(request, `topbar-${name}-${STAMP}`, { projectPath: dirOf(name) });
      topicIds.push(topic.id);
    }
    // Un task aperto per progetto (così ogni progetto è filtrabile) + due task
    // CHIUSI, che gli stub faranno risultare non atterrati su main.
    for (const name of PROJECTS) {
      await apiCreateTask(request, boardIdForPath(dirOf(name)), `Lavoro ${name} ${STAMP}`, "todo");
    }
    for (const title of unlandedTitles) {
      await apiCreateTask(request, boardIdForPath(dirOf(PROJECTS[0])), title, "done");
    }
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [projectId, id] = key.split(":");
      await deleteTask(request, projectId!, id!).catch(() => {});
    }
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    rmSync(ROOT, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, dirOf(PROJECTS[0]));
    await seedProjectPane(page.request, dirOf(PROJECTS[0]));
    await page.addInitScript(() => {
      try { localStorage.removeItem("board:filters-all"); } catch { /* private mode */ }
    });
  });

  test("TOPBAR-01/02/03: i progetti sono filtri quando c'è spazio, e tornano nel menu quando manca", async ({ page }) => {
    // `running: 1` = nessun chip del carico, cioè la barra nel suo stato
    // NORMALE. Col chip acceso (246px di frase) più le cartelle di lavoro, a
    // 1440 la riga è già piena e lo spazio libero è zero: è il ripiego che
    // funziona, ed è il caso che misura TOPBAR-07 — ma non è la larghezza in
    // cui si guarda se i progetti sanno diventare filtri.
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openGlobalBoard(page);

    const conteggi: Record<string, number> = {};
    // La geometria viaggia nei messaggi: un «0 chip» senza la larghezza dello
    // spazio libero non dice se è rotto il calcolo o se lo spazio non c'era.
    const geometrie: Record<string, unknown> = {};
    for (const [etichetta, width] of [["larga", 1440], ["media", 1000], ["stretta", 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      // Il conteggio lo decide un ResizeObserver: si aspetta che si FERMI,
      // invece di misurare il frame in cui la riga sta ancora ridistribuendosi.
      await expect.poll(async () => {
        const a = await inlineChips(page);
        await page.waitForTimeout(120);
        return (await inlineChips(page)) === a ? a : -1;
      }, { timeout: 8000 }).toBeGreaterThanOrEqual(0);
      conteggi[etichetta] = await inlineChips(page);

      const g = await toolbarGeometry(page);
      geometrie[etichetta] = g;
      expect(g.spill, `${etichetta}: nessun chip deve sporgere dal contenitore (mai tagliato a metà)`).toEqual([]);
      // 36px, MISURATI: la barra della board è `py-1.5` attorno a controlli
      // alti 24 (6+24+6), e lo era anche prima di questo giro. Il contratto
      // `h-10` (40px) è quello della riga di CHROME della finestra, che è
      // un'altra riga — qui varrebbe 40 solo cambiando l'altezza del header
      // della board, cioè una modifica che nessuno ha chiesto. Il fatto che
      // conta è che l'altezza NON cambi e la riga resti una: se questi 36
      // diventano 72, i chip dei progetti sono andati a capo.
      expect(g.height, `${etichetta}: la barra resta UNA riga, alta 36px come prima`).toBe(36);

      await page.getByTestId("board-toolbar").screenshot({ path: join(SHOTS, `topbar-${etichetta}.png`) });
    }

    // I numeri viaggiano con l'esito: senza, «larga ≥ media» resterebbe vero
    // anche con 0 chip dappertutto, cioè un verde che non prova niente.
    test.info().attach("geometria-e-conteggi", {
      contentType: "application/json",
      body: JSON.stringify({ conteggi, geometrie }, null, 2),
    });
    expect(conteggi.larga, `a 1440px i progetti stanno nella barra come filtri — ${JSON.stringify(geometrie)}`).toBeGreaterThanOrEqual(3);
    expect(conteggi.media, "restringendo, i chip che non entrano tornano nel menu").toBeLessThan(conteggi.larga!);
    expect(conteggi.stretta, `a 390px la barra è già piena: nessun chip fuori dal menu — ${JSON.stringify(geometrie)}`).toBe(0);

    // …e il menu resta la porta completa: a 390px ci sono TUTTI i progetti.
    await page.getByTestId("filter-project-chip").click();
    for (const name of PROJECTS) {
      await expect(page.getByRole("option", { name: new RegExp(`^${name}`) }), `«${name}» nel menu a 390px`).toBeVisible();
    }
  });

  test("TOPBAR-04: il chip del carico dice l'AZIONE, e non c'è quando non c'è niente da fare", async ({ page }) => {
    await stubProbes(page, { running: 4 }); // 4 in volo, 2 consigliati
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const chip = page.getByTestId("load-advice-chip");
    await expect(chip).toBeVisible({ timeout: 20000 });
    // Il testo VISIBILE — non il `title` — deve dire cosa conviene fare, e
    // dirlo in due parole: la barra è una fila di controlli, non un posto dove
    // si legge una frase. Il resto sta nel popover, qui sotto.
    await expect(chip).toHaveText(/^Fermane 2$/);
    await chip.click();
    await expect(page.getByText("4 agent al lavoro, ne reggo 2")).toBeVisible();
    // Il popover porta la misura VERA (la CPU della flotta), non il load average.
    await expect(page.getByText(/6\.2 core sui 6 che spettano loro/)).toBeVisible();
    await expect(page.getByText(/consiglio/)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "popover-carico.png"), clip: { x: 0, y: 0, width: 1440, height: 320 } });
    await page.keyboard.press("Escape");

    // Stesso carico, ma nessuno scarto su cui agire → il chip non esiste.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stubProbes(page, { running: 1 });
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);
    await expect(chip, "senza scarto il chip non deve comparire").toHaveCount(0);
  });

  test("TOPBAR-05: la consegna è UN controllo con due gradini, e il click apre l'elenco", async ({ page }) => {
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    // UN bottone solo: «N non su main» e «Pubblica M» erano due badge adiacenti
    // che si leggevano come lo stesso allarme scritto due volte.
    const badge = page.getByTestId("delivery-badge");
    await expect(badge).toBeVisible({ timeout: 20000 });
    await expect(badge).toContainText("Consegna");
    await expect(page.getByTestId("delivery-unlanded-count")).toHaveText("2");
    await expect(
      page.locator('[data-testid="delivery-badge"], button:has-text("Pubblica")'),
      "in barra non resta un secondo bottone di consegna",
    ).toHaveCount(1);

    // Il click apre l'INSIEME, non il primo task. E i due gradini hanno due
    // titoli che dicono in che cosa differiscono.
    await badge.click();
    const voci = page.getByTestId("unlanded-item");
    await expect(voci).toHaveCount(2);
    await expect(page.getByText("Non su main", { exact: true })).toBeVisible();
    await expect(page.getByText(/non ancora pubblicato/i)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "popover-consegna.png"), clip: { x: 0, y: 0, width: 1440, height: 460 } });
    await expect(page.getByTestId("task-detail-drawer"), "l'elenco non apre nessun task da solo").toHaveCount(0);
    await voci.first().click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 10000 });
  });

  test("TOPBAR-06: le cartelle di lavoro dicono di cosa sono, e come si liberano", async ({ page }) => {
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const badge = page.getByTestId("worktree-count-badge");
    await expect(badge).toBeVisible({ timeout: 20000 });
    await expect(badge, "il numero dice di che cosa è").toHaveText(/7 cartelle di lavoro/);
    await expect(badge, "i due accumuli restano distinti").toHaveText(/2 rami orfani/);

    await badge.click();
    await expect(page.getByText(/COPIA del repo/)).toBeVisible();
    await expect(page.getByTestId("worktree-branches-line")).toContainText("5 rami");
    await expect(page.getByTestId("worktree-gc-button"), "l'azione sta dove sta la spiegazione").toBeVisible();
    await page.screenshot({ path: join(SHOTS, "popover-cartelle.png"), clip: { x: 0, y: 0, width: 1440, height: 400 } });
  });

  test("TOPBAR-08: i filtri progetto dicono quanto lavoro c'è, e le impostazioni hanno sezioni", async ({ page, request }) => {
    // Il progetto capofila prende un task per stato: senza, «conteggio per
    // stato» sarebbe provato su un solo numero, cioè non provato.
    const alfa = boardIdForPath(dirOf(PROJECTS[0]));
    await apiCreateTask(request, alfa, `Da guardare ${STAMP}`, "review");
    await apiCreateTask(request, alfa, `In corso ${STAMP}`, "in_progress");

    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    // La BOARD GENERALE, per la stessa ragione di TOPBAR-01: è la superficie in
    // cui i chip progetto stanno davvero in barra. Sulla board DI progetto in
    // modalità «tutti» i ~400px di comandi in più lasciano zero spazio libero, e
    // i chip restano dietro il menu (che è il ripiego voluto, misurato lì).
    await openGlobalBoard(page);

    // 1. Il conteggio è SUL chip, non solo dentro il menu: il nome da solo non
    //    dice se quel progetto stia aspettando qualcuno.
    const chipAlfa = page.getByTestId(`project-filter-chip-${alfa}`);
    await expect(chipAlfa).toBeVisible({ timeout: 15000 });
    const conteggi = chipAlfa.getByTestId("project-task-counts");
    await expect(conteggi).toBeVisible();
    // review 1 · in corso 1 · in coda 1 (il «todo» seminato nel beforeAll).
    await expect(conteggi).toHaveText("111");
    // I due chiusi non sono fra gli aperti, ma il dettaglio c'è nel tooltip.
    // NON un `title` nativo: quello lo disegna il sistema operativo, arriva
    // dopo oltre un secondo e sta su una riga sola. Ora è un componente, e il
    // test lo apre davvero col mouse invece di leggere un attributo.
    await expect(chipAlfa).not.toHaveAttribute("title", /./);
    await chipAlfa.hover();
    const tip = page.getByTestId("app-tooltip");
    await expect(tip).toBeVisible({ timeout: 3000 });
    await expect(tip).toContainText("Review: 1");
    await expect(tip).toContainText("Done: 2");
    // La LOCATION del progetto: è ciò che distingue due progetti con lo stesso
    // nome, e nel tooltip vecchio non c'era proprio. I progetti di test stanno
    // in /tmp, quindi qui `homeTilde` non accorcia niente e il path esce intero:
    // va bene, l'asserzione è che il percorso CI SIA.
    await expect(tip).toContainText(dirOf(PROJECTS[0]));
    // Sta dentro la finestra: un tooltip mezzo fuori schermo non si legge.
    const box = await tip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
    // E se ne va da solo quando il mouse esce: un tooltip appiccicato copre
    // la board.
    await page.mouse.move(720, 700);
    await expect(tip).toBeHidden({ timeout: 3000 });

    // 2. Lo stesso conteggio, con la stessa forma, dentro il menu «Progetto».
    await page.getByTestId("filter-project-chip").click();
    await expect(page.getByTestId("project-task-counts").first()).toBeVisible();
    await page.keyboard.press("Escape");

    await page.screenshot({ path: join(SHOTS, "chip-conteggi.png"), clip: { x: 0, y: 0, width: 1440, height: 200 } });

    // 3. E il controllo di consegna: due gradini, un pannello. Anche di qui —
    //    la board generale li vede tutti insieme, che è il caso in cui i due
    //    numeri separati si somigliavano di più.
    await page.getByTestId("delivery-badge").click();
    await expect(page.getByTestId("unlanded-item").first()).toBeVisible();
    await expect(page.getByText(/non ancora pubblicato/i)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "barra-e-consegna.png"), clip: { x: 0, y: 0, width: 1440, height: 560 } });
  });

  /**
   * TOPBAR-12: la fila dei chip progetto e' UNA fila.
   *
   * Era due di tutto. Il chip che apre il menu era tagliato a `11rem` e i
   * suggerimenti accanto a `13rem`: lo STESSO nome, sulla stessa riga, troncato
   * in due punti diversi. E la scatola dell'icona: un progetto con la favicon su
   * disco ne prendeva 12px, uno senza un puntino da 6, quindi i nomi dietro
   * partivano da due rientri diversi. Nessuno dei due chip e' sbagliato da solo:
   * si nota il risultato, cioe' una fila storta.
   *
   * Qui si misura sul DOM, con un progetto CHE HA l'icona e uno che non ce
   * l'ha: e' quella la coppia che sfasava la fila, e senza entrambi il caso non
   * si presenta.
   */
  test("TOPBAR-12: i chip progetto hanno una sola larghezza e un solo rientro", async ({ page }) => {
    // L'icona a UN progetto solo. Il ripiego (nessuna icona) resta sugli altri
    // tre: e' il confronto fra i due rami che il difetto rendeva visibile.
    writeFileSync(`${dirOf(PROJECTS[0])}/favicon.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#4f46e5"/></svg>');

    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openGlobalBoard(page);

    const primo = page.getByTestId(`project-filter-chip-${boardIdForPath(dirOf(PROJECTS[0]))}`);
    await expect(primo).toBeVisible({ timeout: 15000 });

    // Il RIENTRO del nome: dove comincia il testo dentro il chip, misurato dal
    // bordo del chip. E' la distanza che cambiava fra un progetto con icona e
    // uno senza, ed e' cio' che si legge come «fila storta».
    const rientri = await page.evaluate(() => {
      const out: Array<{ id: string; rientro: number; larghezzaMax: string }> = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="project-filter-chip-"]'))) {
        if (el.getBoundingClientRect().width === 0) continue;
        const nome = el.querySelector("span.truncate") ?? el.querySelector("span");
        if (!nome) continue;
        out.push({
          id: el.dataset.testid ?? "",
          rientro: Math.round(nome.getBoundingClientRect().x - el.getBoundingClientRect().x),
          larghezzaMax: getComputedStyle(el).maxWidth,
        });
      }
      return out;
    });

    expect(rientri.length, "servono almeno due chip progetto in barra").toBeGreaterThan(1);
    // UN SOLO RIENTRO, icona o no.
    const soli = [...new Set(rientri.map((r) => r.rientro))];
    expect(soli, `rientri diversi: ${JSON.stringify(rientri)}`).toHaveLength(1);
    // E UNA SOLA LARGHEZZA MASSIMA, anche col chip che apre il menu, che e'
    // l'altra meta' della coppia che divergeva (11rem contro 13rem).
    const apre = await page.getByTestId("filter-project-chip").evaluate((el) => getComputedStyle(el).maxWidth);
    const larghezze = [...new Set([...rientri.map((r) => r.larghezzaMax), apre])];
    expect(larghezze, `larghezze massime diverse: ${larghezze.join(" vs ")}`).toHaveLength(1);

    await page.screenshot({ path: join(SHOTS, "chip-fila-allineata.png"), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  });

  test("TOPBAR-09: le impostazioni della board sono sezioni con un titolo", async ({ page }) => {
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    // Sezioni con un titolo, non dieci righe di seguito. La prima dice che
    // l'interruttore lì sotto è GLOBALE: in cima a una lista piatta si leggeva
    // come un'impostazione di questa board, che è l'opposto di ciò che fa.
    await page.getByTitle("Impostazioni auto-dispatch").click();
    const pannello = page.getByTestId("board-settings-panel");
    await expect(pannello).toBeVisible();
    for (const titolo of ["Vale per tutte le board", "Come lavora l'agente", "Dove lavora", "Quando parte", "Alla consegna"]) {
      await expect(pannello.getByText(titolo, { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: join(SHOTS, "impostazioni-sezioni.png"), clip: { x: 0, y: 0, width: 1440, height: 620 } });
  });

  test("TOPBAR-11: chi sta per pubblicare legge che la release esce a tutti", async ({ page }) => {
    // Su questo repo main e' spedito: il push fa scattare la CI e, se e' verde,
    // gli installer arrivano all'auto-updater di chiunque abbia Topics aperta.
    // Il pannello elencava i commit e offriva «Pubblica» senza dirlo: chi
    // premeva decideva una pubblicazione che nessuna schermata nominava.
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Il gradino «da pubblicare» legge questa rotta: senza un progetto avanti
    // la riga non deve comparire, quindi per vederla serve dichiararne uno.
    //
    // E la rotta si arma PRIMA della navigazione. Stava dopo `openProjectBoard`,
    // cioe' dopo che la board aveva gia' fatto la sua prima chiamata: quella
    // partiva NUDA, tornava «nessun progetto avanti», e la riga non nasceva.
    // Il test passava solo quando un giro di polling successivo ricadeva dentro
    // lo stub — cioe' per fortuna. Il rosso che ne usciva («publish-consequence
    // non trovato») accusava la riga, che non aveva nessuna colpa: nessuno le
    // aveva mai dato i dati per esistere.
    await page.route((url) => url.pathname.endsWith("/all-boards/publish-status"), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [{
            projectId: "topics-app", name: "topics-app", branch: "main", ahead: 3,
            commits: [{ hash: "abc1234", subject: "cancello CI prima della release", author: "jarvis", when: "2h fa" }],
          }],
        }),
      }));

    await page.goto("/");
    await openProjectBoard(page);

    await page.getByTestId("delivery-badge").click();
    const riga = page.getByTestId("publish-consequence");
    await expect(riga).toBeVisible();
    // Nomina CHI la riceve: «pubblica il ramo» sarebbe vero e inutile.
    await expect(riga).toContainText(/tutti/i);

    // E sta SOPRA il bottone: una conseguenza scritta sotto il gesto si legge
    // dopo averlo fatto.
    //
    // Le due misure stanno dentro un `toPass`, e il `!` è sparito. Il pannello
    // di consegna si ridisegna quando arriva la risposta di
    // `publish-status` — che qui è STUBBATA con una `route` registrata dopo il
    // caricamento della board, quindi il primo giro può essere già partito e la
    // riga compare, sparisce e ricompare. In quella finestra `boundingBox()`
    // torna `null`, e `(...)!.y` non falliva su un'asserzione: esplodeva con
    // «Cannot read properties of null (reading 'y')», cioè un TypeError che non
    // nomina né la riga né il bottone. Misurare una geometria è lecito solo a
    // layout fermo: qui la si riprende finché entrambi i rettangoli esistono.
    const bottonePubblica = page.getByRole("button", { name: "Pubblica" }).first();
    await expect(async () => {
      const [boxRiga, boxBottone] = await Promise.all([
        riga.boundingBox(),
        bottonePubblica.boundingBox(),
      ]);
      expect(boxRiga, "la riga della conseguenza deve avere un rettangolo").not.toBeNull();
      expect(boxBottone, "il bottone «Pubblica» deve avere un rettangolo").not.toBeNull();
      expect(boxRiga!.y, "la conseguenza sta sopra il bottone").toBeLessThan(boxBottone!.y);
    }).toPass({ timeout: 10000 });

    // E deve essere LEGGIBILE: un avviso ambra su fondo chiaro e' esattamente
    // il posto dove il contrasto se ne va, e un avviso che non si legge non e'
    // un avviso. Misurato contro il colore davvero dipinto dietro (un antenato
    // con sfondo cambia il risultato), non contro quello del foglio di stile.
    const contrasto = await riga.evaluate((el) => {
      // I colori dell'app sono in oklch: una regex sui numeri li legge come se
      // fossero rgb e restituisce un contrasto inventato (la prima stesura di
      // questo caso diceva 11.7 su un ambra chiaro dipinto su bianco, e
      // passava). L'unico modo onesto e' farli dipingere al browser e rileggere
      // i pixel: spazio colore, alpha e composizione li fa chi li disegna.
      const dipingi = (colore: string, sotto?: string) => {
        const c = document.createElement("canvas"); c.width = c.height = 1;
        const g = c.getContext("2d")!;
        if (sotto) { g.fillStyle = sotto; g.fillRect(0, 0, 1, 1); }
        g.fillStyle = colore; g.fillRect(0, 0, 1, 1);
        const d = g.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const canale = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const lum = (p: number[]) =>
        0.2126 * canale(p[0] / 255) + 0.7152 * canale(p[1] / 255) + 0.0722 * canale(p[2] / 255);
      // Lo sfondo e' quello davvero dipinto dietro: un antenato con background
      // cambia il risultato, quindi si risale finche' non se ne trova uno opaco.
      let sfondo = "rgb(255,255,255)";
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== "transparent" && !c.startsWith("rgba(0, 0, 0, 0)")) { sfondo = c; break; }
      }
      const bg = dipingi(sfondo);
      const fg = dipingi(getComputedStyle(el).color, sfondo);
      const l = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return { rapporto: (l[0] + 0.05) / (l[1] + 0.05), fg, bg };
    });
    expect(contrasto.rapporto, "l'avviso di pubblicazione deve reggere WCAG AA su testo piccolo").toBeGreaterThanOrEqual(4.5);

    await page.screenshot({ path: join(SHOTS, "pubblica-conseguenza.png"), clip: { x: 0, y: 0, width: 1440, height: 460 } });
  });

  test("TOPBAR-10: il freno di QUESTA board sta nelle sue impostazioni, non fra le globali", async ({ page }) => {
    // Il pannello ha due leve che si somigliano e non sono la stessa cosa:
    // l'auto-dispatch GLOBALE (vale per tutte) e la pausa di questa board. Se
    // finissero nella stessa sezione, la seconda si leggerebbe come un doppione
    // della prima — che e' il difetto che questo pannello evita di proposito
    // tenendo la sezione «Vale per tutte le board» separata dal resto.
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await page.getByTitle("Impostazioni auto-dispatch").click();

    const pannello = page.getByTestId("board-settings-panel");
    await expect(pannello).toBeVisible();
    const pausa = page.getByTestId("board-dispatch-paused");
    await expect(pausa).toBeVisible();

    // Nasce NON in pausa: nessuna board si mette in pausa da sola.
    await expect(pausa).not.toBeChecked();

    // E sta sotto «Come lavora l'agente», non sotto le globali: si misura la
    // POSIZIONE, perche' e' la posizione a dire di chi e' la leva.
    const globali = pannello.getByText("Vale per tutte le board", { exact: true });
    const agente = pannello.getByText("Come lavora l'agente", { exact: true });
    const yGlobali = (await globali.boundingBox())!.y;
    const yAgente = (await agente.boundingBox())!.y;
    const yPausa = (await pausa.boundingBox())!.y;
    expect(yPausa).toBeGreaterThan(yGlobali);
    expect(yPausa).toBeGreaterThan(yAgente);

    await page.screenshot({ path: join(SHOTS, "board-pausa.png"), clip: { x: 0, y: 0, width: 1440, height: 620 } });
  });

  test("TOPBAR-07: audit di layout alle tre larghezze (niente overflow, niente sovrapposizioni)", async ({ page }) => {
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    for (const [etichetta, width] of [["larga", 1440], ["media", 1000], ["stretta", 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const a = await audit(page);
      expect(a.overflowX.present, `${etichetta}: overflow orizzontale del documento — ${JSON.stringify(a.overflowX.offenders)}`).toBe(false);
      expect(a.findings.overlap, `${etichetta}: controlli sovrapposti`).toEqual([]);
      expect(a.findings.offscreen, `${etichetta}: controlli fuori dal bordo sinistro`).toEqual([]);
      // Bersagli: il minimo WCAG 2.2 AA è 24×24, ed è anche il massimo che una
      // riga di chrome di 36px possa dare senza rompere l'altezza della riga (i
      // 44px della HIG Apple non ci stanno per costruzione — vedi la nota in
      // testa al file). I controlli NUOVI di questo giro devono starci dentro;
      // il resto della barra è com'era.
      //
      // Misurati per TESTID e non dal risultato dell'audit: `ui-audit.js`
      // identifica gli elementi per tag+classe (`button.flex.items-center`), e
      // un filtro per testid su quelle stringhe non matcherebbe MAI — sarebbe
      // un'asserzione che non può fallire.
      const piccoli = await page.evaluate(() => {
        const sel = '[data-testid="load-advice-chip"],[data-testid="delivery-badge"],[data-testid="worktree-count-badge"],[data-testid^="project-filter-chip-"]';
        return Array.from(document.querySelectorAll(sel))
          .filter((el) => getComputedStyle(el).visibility !== "hidden")
          .map((el) => ({ id: el.getAttribute("data-testid"), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }))
          .filter((b) => b.w < 24 || b.h < 24);
      });
      expect(piccoli, `${etichetta}: bersagli nuovi sotto 24px`).toEqual([]);
    }
  });

  /**
   * TOPBAR-13: sotto la barra non passa nessun filetto.
   *
   * La riga c'era, e disegnava un confine che si vedeva gia' da solo: sotto la
   * barra comincia la board, che ha un fondo diverso e le colonne. Le strisce
   * che compaiono in mezzo (errore, avviso di drop, archivio, impostazioni)
   * portano il proprio bordo quando servono, quindi il filetto fisso era in
   * piu' esattamente quando non serviva a niente.
   *
   * Oggi la regola vive in un COMMENTO sopra il nodo in `KanbanBoardPane.tsx`, e
   * un commento non ferma niente: chi aggiunge un `border-b` all'involucro non
   * lo legge. Qui la regola diventa una misura, e si guarda la CATENA dalla
   * barra alla radice della board — il filetto poteva stare su uno qualunque
   * degli involucri, non solo sulla barra.
   */
  test("TOPBAR-13: sotto la barra non c'e' nessun filetto", async ({ page }) => {
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    /** I bordi bassi di tutta la catena barra → radice, letti dal computed style. */
    const bordiBassi = () =>
      page.evaluate(() => {
        const barra = document.querySelector('[data-testid="board-toolbar"]');
        const radice = document.querySelector('[data-testid="kanban-board"]');
        if (!barra || !radice) return null;
        const out: { nodo: string; larghezza: string; stile: string; colore: string }[] = [];
        let el: Element | null = barra;
        while (el) {
          const cs = getComputedStyle(el);
          out.push({
            nodo: el.getAttribute("data-testid") ?? el.tagName.toLowerCase(),
            larghezza: cs.borderBottomWidth,
            stile: cs.borderBottomStyle,
            colore: cs.borderBottomColor,
          });
          if (el === radice) break;
          el = el.parentElement;
        }
        return out;
      });

    /**
     * Visibile = ha spessore, ha uno stile, e non e' trasparente.
     *
     * La trasparenza si legge SOLO da `rgba(...)` con alfa zero. La prima
     * versione cercava una virgola-zero in fondo alla stringa, e quel filtro
     * scartava anche `rgb(255, 0, 0)`: il rosso puro finisce per «, 0)» perche'
     * il suo canale BLU e' zero. Se n'e' accorta la meta' non vacua qui sotto,
     * che ha messo un filetto rosso e non l'ha piu' ritrovato — cioe' il
     * setaccio era cieco proprio nel verso in cui doveva mordere.
     */
    const trasparente = (colore: string) =>
      colore === "transparent" || /^rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(colore);
    const visibili = (catena: NonNullable<Awaited<ReturnType<typeof bordiBassi>>>) =>
      catena.filter((n) => parseFloat(n.larghezza) > 0 && n.stile !== "none" && !trasparente(n.colore));

    const catena = await bordiBassi();
    expect(catena, "barra o radice della board non trovate").not.toBeNull();
    expect(
      visibili(catena!),
      `un filetto sotto la barra: ${JSON.stringify(visibili(catena!))}`,
    ).toEqual([]);

    // IL SETACCIO MORDE. Senza questa seconda meta', un errore nel giro dei nodi
    // (selettore sbagliato, catena che non risale) darebbe lista vuota e verde
    // per il motivo sbagliato: un filetto messo a mano deve farsi trovare.
    await page.evaluate(() => {
      const barra = document.querySelector('[data-testid="board-toolbar"]') as HTMLElement;
      barra.style.borderBottom = "1px solid rgb(255, 0, 0)";
    });
    const conFiletto = visibili((await bordiBassi())!);
    expect(conFiletto.length, "la misura non riconosce nemmeno un filetto messo a mano").toBeGreaterThan(0);
  });

  /**
   * TOPBAR-14: una porta sola alle impostazioni.
   *
   * Ce n'erano due, a mezzo centimetro l'una dall'altra: il ⚙ in coda alla
   * barra e un menu ▾ accanto al titolo della board. Non erano due strade per
   * la stessa stanza — il ▾ teneva una COPIA PROPRIA dello stato
   * dell'auto-dispatch, quindi le due porte potevano dire cose diverse sullo
   * stesso interruttore, e quale delle due avesse ragione dipendeva da quale
   * era stata aperta per ultima.
   *
   * L'oracolo e' quindi doppio, e la seconda meta' e' quella che conta: non
   * basta che i BOTTONI siano uno, deve essere una sola anche la COPIA dello
   * stato. Con il pannello chiuso, nella board non si vede nessun controllo
   * dell'auto-dispatch; aperto, se ne vede esattamente uno.
   */
  test("TOPBAR-14: alle impostazioni si entra da un posto solo, e lo stato ha una copia sola", async ({ page }) => {
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const board = page.getByTestId("kanban-board");
    const porta = board.getByTitle("Impostazioni auto-dispatch");
    const statoDispatch = board.getByTestId("global-cap-control");
    const pannello = page.getByTestId("board-settings-panel");

    // UNA porta, non due.
    await expect(porta, "le porte alle impostazioni non sono una").toHaveCount(1);

    // A pannello chiuso lo stato dell'auto-dispatch non si vede da nessuna
    // parte: era proprio la copia del ▾ a renderlo visibile in barra.
    await expect(pannello).toHaveCount(0);
    await expect(statoDispatch, "lo stato dell'auto-dispatch e' fuori dal pannello").toHaveCount(0);

    // Aperta la porta: il pannello c'e', e la copia dello stato e' UNA.
    await porta.click();
    await expect(pannello).toBeVisible();
    await expect(statoDispatch, "due copie dello stato dell'auto-dispatch").toHaveCount(1);

    // IL SETACCIO MORDE: `statoDispatch` sa riconoscere il controllo quando c'e'
    // davvero — il conteggio a zero di sopra e' un'assenza misurata, non un
    // selettore che non trova mai niente.
    await expect(statoDispatch).toBeVisible();

    await page.screenshot({ path: join(SHOTS, "porta-unica.png"), clip: { x: 0, y: 0, width: 1440, height: 620 } });
  });
});
