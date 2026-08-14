/**
 * MRA — la responsiveness mobile si MISURA, non si guarda.
 *
 * Gemella di `chat-layout-audit.spec.ts`, spostata dalla pane di chat alle
 * superfici che un telefono incontra per prime, e in particolare alle due
 * RICERCHE: ⌘K (command palette) e ⌘P/⌘F (FileSearch). Erano schede centrate
 * pensate per un monitor: `pt-[12vh]` piu' `max-h`, due colonne affiancate,
 * bottoni alti mezza riga. Su 320px quelle scelte non degradano, si rompono.
 *
 * Lo strumento e' `helpers/ui-audit.js`: geometria vera, presa con
 * getBoundingClientRect e getComputedStyle. Overflow orizzontale, elementi
 * fuori dal viewport, sovrapposizioni, bersagli sotto misura. Nessuno
 * screenshot da interpretare: il verdetto sono numeri, e finiscono in
 * `test-results/ui-audit/` cosi' che una regressione si legga come un diff.
 *
 * TRE viewport, scelti per coprire il caso peggiore e i due comuni:
 *   320x568  iPhone SE, il piu' stretto che vale la pena reggere
 *   390x844  iPhone 14
 *   430x932  iPhone 15 Pro Max
 *
 * Sulla soglia dei bersagli, due misure diverse e per una ragione:
 *   · le due superfici di RICERCA si misurano a 44px, la linea guida Apple.
 *     Sono pagine intere fatte per un dito, non UI desktop densa, e 44 e' la
 *     misura per cui sono state disegnate.
 *   · le superfici generali si misurano a 24px, il minimo di WCAG 2.2 AA. E' la
 *     soglia che gia' usa `chat-layout-audit.spec.ts`, e cambiare metro fra due
 *     audit dello stesso repo renderebbe i due numeri non confrontabili.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

// `__dirname`, non `import.meta.url`: Playwright transpila queste spec in CJS.
const UI_AUDIT_PATH = resolve(__dirname, "helpers/ui-audit.js");
const OUT_DIR = resolve(__dirname, "../../test-results/ui-audit");

const PROJECT_DIR = "/tmp/e2e-mobile-responsive-audit";
const PROJECT_PANE = `project:${encodeURIComponent(PROJECT_DIR)}`;

type UiAuditFinding = Record<string, unknown>;
interface UiAuditReport {
  viewport: { w: number; h: number };
  counts: {
    analyzed: number;
    misalign: number;
    spacing: number;
    overlap: number;
    offscreen: number;
    tapTargets: number;
  };
  overflowX: { present: boolean; docWidth: number; offenders: UiAuditFinding[] };
  findings: {
    misalign: UiAuditFinding[];
    spacing: UiAuditFinding[];
    overlap: UiAuditFinding[];
    offscreen: UiAuditFinding[];
    tapTargets: UiAuditFinding[];
  };
}

const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;

async function runUiAudit(page: Page, scope: string, minTap: number): Promise<UiAuditReport> {
  await page.addScriptTag({ path: UI_AUDIT_PATH });
  const raw = await page.evaluate(
    (opts) => (window as unknown as { __uiAudit: (o: unknown) => string }).__uiAudit(opts),
    { scope, tol: 4, maxEls: 400, minTap, limit: 25 },
  );
  return JSON.parse(raw) as UiAuditReport;
}

function persist(name: string, payload: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `${name}.json`), JSON.stringify(payload, null, 2));
}

/**
 * Si NAVIGA da desktop e si stringe DOPO. Sotto i 768px la sidebar e' un
 * overlay chiuso e `goToApp` la aspetta visibile, quindi partire gia' stretti
 * fa fallire il prologo invece della misura. E' anche il percorso reale: chi
 * rimpicciolisce una finestra passa esattamente di qui.
 */
async function openAppAt(page: Page, width: number, height: number) {
  await goToApp(page);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width, height });
  // Il layout deve essersi FERMATO prima di misurarlo: i listener di resize
  // ricalcolano, e una misura presa a meta' corsa e' rumore, non un difetto.
  await page.waitForTimeout(1200);
}

/** I due difetti che nessun contenuto giustifica, su nessuna superficie. */
function expectNoHardDefects(report: UiAuditReport) {
  expect(
    report.overflowX.present ? JSON.stringify(report.overflowX.offenders) : "",
  ).toBe("");
  expect(report.findings.offscreen).toEqual([]);
}

/**
 * LE TRE CATEGORIE CHE VENIVANO MISURATE E MAI GIUDICATE.
 *
 * `ui-audit.js` raccoglie cinque famiglie, ma questa spec ne asseriva due:
 * `misalign`, `spacing` e `overlap` finivano nel JSON e non toccavano nessun
 * `expect`. Misurato sul codice landato: le superfici di ricerca stanno a ZERO
 * ESATTO su tutte e cinque, su tutte e tre le viewport — cioe' erano gia'
 * pulite e completamente scoperte, dove una regressione di allineamento
 * sarebbe passata senza che nessuno la vedesse.
 *
 * La gemella `chat-layout-audit.spec.ts` le asserisce tutte e tre da sempre:
 * due audit dello stesso repo che giudicano cose diverse sono due numeri che
 * nessuno confronta.
 *
 * NON si applica alla superficie generale della app: li' ci sono uno `spacing`
 * (la gerarchia dello stato vuoto) e tre `tapTargets` (skip-link e maniglie di
 * riordino) che sono scelte, non difetti — il triage del 14/08 li ha guardati
 * uno per uno. Pretendere zero anche li' vorrebbe dire o mentire o cambiare il
 * prodotto per far tacere un test.
 */
function expectPulitaComeOggi(report: UiAuditReport) {
  expect(report.findings.misalign).toEqual([]);
  expect(report.findings.spacing).toEqual([]);
  expect(report.findings.overlap).toEqual([]);
}

/*
 * NON `describe.serial`, e la ragione e' il mestiere di questo file. In serial
 * il primo rosso salta tutti i test successivi, quindi una regressione su
 * 320px cancellerebbe le misure di 390 e 430 proprio nel giro in cui servono.
 * Un audit deve consegnare la tabella intera anche quando e' rosso. Sono
 * indipendenti davvero: il seme sta nel `beforeAll` e ogni test riparte da un
 * `resetPaneStore` suo.
 */
test.describe("MRA — responsiveness mobile misurata", () => {
  let topicId: string | null = null;

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(`${PROJECT_DIR}/nota-di-prova.txt`, "parolachiavecercabile\nseconda riga\n");
    writeFileSync(`${PROJECT_DIR}/altro-file-con-nome-lungo.ts`, "export const parolachiavecercabile = 1;\n");
    const topic = await createTopic(request, "E2E-MobileAudit", { projectPath: PROJECT_DIR });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  for (const vp of VIEWPORTS) {
    /* ── ⌘K, la palette ─────────────────────────────────────────────────── */

    test(`MRA-01 ⌘K e' una pagina e non sfonda — ${vp.name}`, async ({ page, request }) => {
      await resetPaneStore(request, []);
      await openAppAt(page, vp.width, vp.height);

      await page.keyboard.press("Meta+k");
      const palette = page.getByTestId("command-palette");
      await expect(palette).toBeVisible();
      await page.waitForTimeout(400);

      // Si MISURA e si SALVA prima di giudicare. Un artefatto che esiste solo
      // quando il test e' verde non serve a niente: la baseline che interessa
      // e' proprio quella di un rosso.
      const vuota = await runUiAudit(page, '[data-testid="command-palette"]', 44);
      persist(`mobile-palette-vuota-${vp.name}`, vuota);

      // I numeri dicono SE e' rotta, la figura dice che aspetto ha. Costa tre
      // PNG piccoli e toglie il bisogno di uno script a parte per la consegna:
      // si rigenera rilanciando l'audit, come tutto il resto.
      mkdirSync(OUT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(OUT_DIR, `palette-${vp.name}.png`) });

      // Con una query la palette cambia corpo: era `grid-cols-2`, ed e' il caso
      // che su 320px dava due colonne da 150px.
      await palette.locator("input").fill("e2e");
      await page.waitForTimeout(900);
      const conQuery = await runUiAudit(page, '[data-testid="command-palette"]', 44);
      persist(`mobile-palette-query-${vp.name}`, conQuery);

      // Sotto i 768px la variante a PAGINA deve essere quella attiva. Senza
      // questa riga l'audit misurerebbe la scheda desktop e direbbe che va
      // bene, misurando la cosa sbagliata.
      await expect(palette).toHaveAttribute("data-page", "true");

      expectNoHardDefects(vuota);
      expectPulitaComeOggi(vuota);
      expect(vuota.findings.tapTargets).toEqual([]);
      // Senza questa riga un contenitore vuoto renderebbe verde tutto il resto.
      expect(vuota.counts.analyzed).toBeGreaterThan(10);

      expectNoHardDefects(conQuery);
      expectPulitaComeOggi(conQuery);
      expect(conQuery.findings.tapTargets).toEqual([]);
    });

    /* ── ⌘P e ⌘F, la ricerca file ───────────────────────────────────────── */

    test(`MRA-02 ⌘P/⌘F e' una pagina e non sfonda — ${vp.name}`, async ({ page, request }) => {
      await resetPaneStore(request, [PROJECT_PANE]);
      await openAppAt(page, vp.width, vp.height);

      await page.keyboard.press("Meta+p");
      const panel = page.getByTestId("file-search");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("file-search-mode-name")).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(400);

      const perNome = await runUiAudit(page, '[data-testid="file-search"]', 44);
      persist(`mobile-filesearch-nome-${vp.name}`, perNome);

      await expect(panel).toHaveAttribute("data-page", "true");
      expectNoHardDefects(perNome);
      expectPulitaComeOggi(perNome);
      expect(perNome.findings.tapTargets).toEqual([]);
      expect(perNome.counts.analyzed).toBeGreaterThan(5);

      // Modo CONTENUTO: e' il caso peggiore dell'intestazione, perche' aggiunge
      // «Aa» e «.*» agli interruttori che c'erano gia'.
      await page.keyboard.press("Meta+f");
      await expect(panel.getByTestId("file-search-mode-content")).toHaveAttribute("aria-pressed", "true");
      await panel.getByTestId("file-search-input").fill("parolachiavecercabile");
      await page.waitForTimeout(1200);

      const perContenuto = await runUiAudit(page, '[data-testid="file-search"]', 44);
      persist(`mobile-filesearch-contenuto-${vp.name}`, perContenuto);
      expectNoHardDefects(perContenuto);
      expect(perContenuto.findings.tapTargets).toEqual([]);
      expect(perContenuto.findings.overlap).toEqual([]);
      expect(perContenuto.findings.spacing).toEqual([]);
      // UN misalign da 2px fra due span della stessa riga (`text-[11px]` contro
      // `text-xs`): e' la differenza di baseline fra due misure di carattere,
      // non un difetto di layout. Si DICHIARA invece di pretendere zero — cosi'
      // il secondo, se arriva, e' rosso.
      expect(perContenuto.findings.misalign.length).toBeLessThanOrEqual(1);
    });

    /* ── Il resto della app ─────────────────────────────────────────────── */

    test(`MRA-03 la app non sfonda in orizzontale — ${vp.name}`, async ({ page, request }) => {
      await resetPaneStore(request, []);
      await openAppAt(page, vp.width, vp.height);

      const app = await runUiAudit(page, "body", 24);
      persist(`mobile-app-${vp.name}`, app);

      // L'overflow orizzontale resta il cancello duro: non lo giustifica niente.
      expect(
        app.overflowX.present ? JSON.stringify(app.overflowX.offenders) : "",
      ).toBe("");

      /*
       * Qui `offscreen` NON e' zero, e non deve esserlo. Sotto i 768px la
       * sidebar e' un cassetto CHIUSO, cioe' spinta fuori a sinistra, e i suoi
       * controlli stanno fuori dal viewport per costruzione. Lo sa gia' anche
       * `sidebar-touch-audit.spec.ts` (vedi il commento sui due bottoni «Expand
       * sidebar» / «Close sidebar»), e infatti quella spec misura la sidebar
       * col cassetto APERTO.
       *
       * Quindi la regola non e' «zero fuori» ma «fuori solo a SINISTRA»: un
       * cassetto chiuso esce a sinistra, un layout rotto esce a destra o sotto.
       * Misurati oggi: 2 elementi, entrambi a left negativo. Se ne compare uno
       * a destra questa riga diventa rossa, ed e' la regressione giusta.
       */
      const fuoriADestra = app.findings.offscreen.filter(
        (o) => typeof o.left === "number" && (o.left as number) >= 0,
      );
      expect(fuoriADestra).toEqual([]);
      expect(app.findings.offscreen.length).toBeLessThanOrEqual(2);

      expect(app.counts.analyzed).toBeGreaterThan(20);
    });
  }

  /**
   * Le righe di zeri qui sopra valgono solo se il misuratore SA fallire. Questo
   * test rompe la palette di proposito e pretende che le categorie si
   * accendano. Senza, un audit che ha smesso di misurare resterebbe verde per
   * sempre e nessuno se ne accorgerebbe.
   */
  test("MRA-04 il misuratore sa fallire (difetti iniettati apposta)", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await openAppAt(page, 390, 844);
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.waitForTimeout(400);

    const pulita = await runUiAudit(page, '[data-testid="command-palette"]', 44);
    expect(pulita.counts.offscreen + pulita.counts.tapTargets).toBe(0);

    await page.evaluate(() => {
      const host = document.querySelector('[data-testid="command-palette"]');
      if (!host) throw new Error("palette non trovata");
      const probe = document.createElement("div");
      probe.id = "mra-selftest";
      // Un bersaglio troppo piccolo e un elemento spinto fuori a sinistra.
      probe.innerHTML =
        '<button style="width:20px;height:20px">x</button>' +
        '<div style="position:fixed;left:-400px;top:10px;width:120px;height:40px">fuori</div>';
      host.appendChild(probe);
    });

    const rotta = await runUiAudit(page, '[data-testid="command-palette"]', 44);
    expect(rotta.counts.tapTargets).toBeGreaterThan(0);
    expect(rotta.counts.offscreen).toBeGreaterThan(0);
  });
});
