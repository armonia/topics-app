/**
 * 1b.4 — il layout della chat si MISURA, non si guarda.
 *
 * Due strati deterministici sulla pane di chat, con un transcript realistico
 * (paragrafi lunghi, code block largo, lista, URL infrangibile, tabella):
 *
 *  1. `helpers/ui-audit.js` — geometria vera (getBoundingClientRect +
 *     getComputedStyle): overflow-X, allineamenti near-miss, spacing incoerenti
 *     fra fratelli, overlap, elementi fuori viewport, tap target sotto misura.
 *  2. `axe-core` — il sottoinsieme MISURABILE di a11y/WCAG, contrasto incluso.
 *
 * Nessun VLM, nessuno screenshot da guardare: il verdetto sono numeri, e i
 * numeri finiscono in `test-results/ui-audit/chat-<viewport>.json` così che una
 * regressione si legga come un diff invece che come un'impressione.
 *
 * Le soglie qui sotto sono il RISULTATO della prima passata, non un desiderio:
 * ogni tolleranza porta scritto il perché ed è un tetto da abbassare, mai da
 * alzare in silenzio per far tornare il verde.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

hermetic(test);

const BASE = E2E_BASE;
// `__dirname`, non `import.meta.url`: Playwright transpila queste spec in CJS
// (stesso motivo per cui browser-ws-streaming.spec.ts fa così).
const UI_AUDIT_PATH = resolve(__dirname, "helpers/ui-audit.js");
const AXE_PATH = resolve(__dirname, "../../node_modules/axe-core/axe.min.js");
const OUT_DIR = resolve(__dirname, "../../test-results/ui-audit");

/** Radice della pane di chat: header + trascritto + composer. */
const CHAT_SCOPE = '[data-testid="chat-panel"]';

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

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

/**
 * Un transcript che assomiglia a una chat vera. Contenuto scelto per METTERE
 * IN CRISI il layout, non per farlo sembrare bello: se una riga di codice
 * larga o un URL senza spazi possono sfondare la colonna, devono farlo qui.
 */
const SEED_MESSAGES = [
  "Ciao — riassumi lo stato del progetto.",
  `Ecco il riassunto.\n\n${"Il layout della chat va misurato e non guardato, perché l'occhio perdona i near-miss. ".repeat(4)}`,
  "Passi:\n\n- primo punto della lista\n- secondo punto, un filo più lungo del primo\n- terzo punto\n- quarto punto molto più lungo degli altri, che a viewport stretta deve andare a capo senza sfondare la colonna",
  "Fammi vedere il codice.",
  "```ts\nconst reallyLongIdentifierThatShouldNotBreakTheLayout = await measureEverything({ tolerancePx: 4, maxElements: 400, minimumTapTargetSide: 44, includeOffscreen: true });\n```",
  `Link: https://example.invalid/${"segmento-molto-lungo-senza-spazi".repeat(3)}/fine`,
  "| colonna | valore |\n|---|---|\n| primo | 1 |\n| secondo | 2 |",
  "Ultimo messaggio, corto.",
];

async function seedTranscript(request: import("@playwright/test").APIRequestContext, topicId: string) {
  for (const content of SEED_MESSAGES) {
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content },
      ignoreHTTPSErrors: true,
    });
  }
}

async function runUiAudit(page: Page, scope: string): Promise<UiAuditReport> {
  await page.addScriptTag({ path: UI_AUDIT_PATH });
  const raw = await page.evaluate(
    (opts) => (window as unknown as { __uiAudit: (o: unknown) => string }).__uiAudit(opts),
    // minTap 24, non 44: 24×24 CSS px è il minimo MISURABILE dello standard
    // (WCAG 2.2 AA, "Target Size (Minimum)"). I 44 sono la linea guida Apple —
    // legittima come aspirazione, inutile come soglia di rosso su una UI
    // desktop densa, dove ogni icona da 28px la sfonderebbe.
    { scope, tol: 4, maxEls: 400, minTap: 24, limit: 25 },
  );
  return JSON.parse(raw) as UiAuditReport;
}

async function runAxe(page: Page, scope: string): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (sel) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const res = await axe.run(
      { include: [[sel]] },
      { resultTypes: ["violations"], rules: { "color-contrast": { enabled: true } } },
    );
    return res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
    }));
  }, scope) as Promise<AxeViolation[]>;
}

function persist(name: string, payload: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `${name}.json`), JSON.stringify(payload, null, 2));
}

test.describe("Chat layout — audit misurato (1b.4)", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `layout-audit-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    await seedTranscript(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`geometria della pane di chat — ${vp.name}`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "CHAT-LAYOUT-01" });
      // Si NAVIGA sempre da desktop e si stringe DOPO: sotto i 768px la
      // sidebar è un overlay chiuso, e `goToApp` la aspetta visibile. È anche
      // il percorso reale — l'utente rimpicciolisce una finestra già aperta —
      // e il resize listener di GroupLayout fa il resto.
      await goToApp(page);
      await openTopic(page, new RegExp(topicName));
      await expect(page.locator(CHAT_SCOPE).first()).toBeVisible({ timeout: 10_000 });
      // Il trascritto è virtualizzato: aspetta che gli item siano misurati,
      // altrimenti si audita un contenitore ancora vuoto e passa tutto.
      await expect(page.locator('[data-testid="chat-message-list"]').first()).toBeVisible({ timeout: 10_000 });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(1500);

      const report = await runUiAudit(page, CHAT_SCOPE);
      persist(`chat-${vp.name}`, report);

      // 1. La colonna non sfonda MAI in orizzontale: è l'unico difetto che
      //    l'utente vede sempre, su qualsiasi contenuto.
      expect(
        report.overflowX.present ? JSON.stringify(report.overflowX.offenders) : "",
      ).toBe("");

      // 2. Niente elementi fuori dal viewport e niente sovrapposizioni: un
      //    testo sotto un altro testo è illeggibile, non "denso".
      expect(report.findings.offscreen).toEqual([]);
      expect(report.findings.overlap).toEqual([]);

      // 3. Allineamenti e spaziature: i near-miss (1–4px) sono il difetto che
      //    l'occhio registra come "sciatto" senza saper dire perché. Oggi sono
      //    zero misurati, non zero sperati: se questa riga diventa rossa è una
      //    regressione da guardare, non una soglia da alzare.
      expect(report.findings.misalign).toEqual([]);
      expect(report.findings.spacing).toEqual([]);

      // 4. Tap target sotto il minimo WCAG 2.2 AA (24px), link inline esclusi
      //    per l'eccezione dello standard stesso.
      expect(report.findings.tapTargets).toEqual([]);

      // 5. Qualcosa è stato davvero misurato — senza questa riga un contenitore
      //    vuoto renderebbe verdi tutte le asserzioni qui sopra.
      expect(report.counts.analyzed).toBeGreaterThan(30);
    });
  }

  /**
   * Le cinque righe di zeri qui sopra valgono solo se il misuratore SA fallire.
   * Questo test rompe la pane di proposito — un near-miss di 3px, due fratelli
   * sovrapposti, un bottone da 20px, un elemento fuori a sinistra, un ritmo
   * verticale incoerente — e pretende che ogni categoria si accenda. Senza,
   * un audit che non misura più niente resterebbe verde per sempre.
   */
  test("il misuratore sa fallire (difetti iniettati apposta)", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    await expect(page.locator(CHAT_SCOPE).first()).toBeVisible({ timeout: 10_000 });

    const clean = await runUiAudit(page, CHAT_SCOPE);
    expect(clean.counts.misalign + clean.counts.overlap + clean.counts.offscreen + clean.counts.tapTargets).toBe(0);

    await page.evaluate((sel) => {
      const host = document.querySelector(sel);
      if (!host) throw new Error("scope non trovato");
      const probe = document.createElement("div");
      probe.id = "ui-audit-selftest";
      probe.innerHTML = [
        // near-miss di 3px su un bordo che dovrebbe essere condiviso
        '<div style="display:flex;align-items:flex-start">',
        '<div style="width:40px;height:20px;background:#111"></div>',
        '<div style="width:40px;height:20px;background:#222;margin-top:3px"></div>',
        "</div>",
        // due fratelli static che si accavallano
        '<div style="display:flex;align-items:flex-start">',
        '<div style="width:40px;height:20px;background:#333"></div>',
        '<div style="width:40px;height:20px;background:#444;margin-left:-20px"></div>',
        "</div>",
        // ritmo verticale incoerente (0, 0, 30)
        '<div><div style="height:10px;background:#555"></div>',
        '<div style="height:10px;background:#666"></div>',
        '<div style="height:10px;margin-top:30px;background:#777"></div></div>',
        // tap target sotto i 24px
        '<button style="width:20px;height:20px">x</button>',
        // fuga orizzontale a sinistra: nessuno scroll la recupera.
        // `relative`, non `fixed`: la pane di chat ha antenati con transform
        // (l'aura, le transizioni), e lì `fixed` si ancora all'antenato invece
        // che al viewport — l'elemento sarebbe finito dentro lo schermo.
        '<div style="position:relative;left:-4000px;width:30px;height:10px;background:#888"></div>',
      ].join("");
      host.appendChild(probe);
    }, CHAT_SCOPE);

    const broken = await runUiAudit(page, CHAT_SCOPE);
    expect({
      misalign: broken.counts.misalign > 0,
      overlap: broken.counts.overlap > 0,
      spacing: broken.counts.spacing > 0,
      tapTargets: broken.counts.tapTargets > 0,
      offscreen: broken.counts.offscreen > 0,
    }).toEqual({ misalign: true, overlap: true, spacing: true, tapTargets: true, offscreen: true });
  });

  test("a11y misurabile della pane di chat (axe-core, contrasto incluso)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    await expect(page.locator(CHAT_SCOPE).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    const violations = await runAxe(page, CHAT_SCOPE);
    persist("chat-axe", violations);

    // Solo serious/critical: sono quelle che rendono la chat inusabile per
    // qualcuno, non quelle di stile. Il messaggio dell'assert porta l'elenco,
    // così il rosso si legge senza aprire il JSON.
    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(
      blocking.map((v) => `${v.id} (${v.impact}) → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  });
});
