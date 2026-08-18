/**
 * board-preview-cap.spec.ts — il tetto dell'anteprima sulla card è un RAPPORTO,
 * non un'altezza.
 *
 * Il rilievo: `max-h-36` erano 144px fissi dentro una colonna la cui larghezza
 * è un intervallo (Card.tsx `widthCls`: lavoro 18→26rem, review 22→44rem).
 * Un'altezza fissa in una larghezza variabile è un rapporto variabile, quindi
 * il numero che il protocollo promette agli agenti (`PREVIEW_CARD_MAX_RATIO`)
 * era vero in UNA configurazione e falso in tutte le altre — e falso proprio
 * nella review, la colonna su cui si decide, che è anche la più larga.
 *
 * Il contratto ora, misurato sui rettangoli veri e non a occhio:
 *   1. RAPPORTO — l'altezza del riquadro non supera mai
 *      `PREVIEW_CARD_MAX_RATIO` × la sua larghezza, a QUALSIASI larghezza di
 *      colonna e su mobile;
 *   2. RIEMPIMENTO: la miniatura occupa tutto il suo riquadro, nessuna fascia vuota
 *      è il tetto che tiene il rapporto costante invece di sovrascriverlo (un
 *      `max-h` in px, misurato, riportava il rapporto a scendere colonna per
 *      colonna — cioè il difetto di partenza);
 *   3. NIENTE STIRATURA — un'immagine più BASSA del tetto resta alla sua
 *      altezza naturale: il tetto taglia, non deforma;
 *   4. SCANSIONABILITÀ, a 1280×800 e per colonna: in review la card si vede
 *      INTERA senza scorrere; in una colonna di lavoro se ne vedono DUE. Erano
 *      un numero solo (2/3 ovunque) finché il riquadro aveva un tetto in px;
 *      tolto quello, l'anteprima in review vale da sola più di metà colonna, e
 *      il numero unico chiedeva l'opposto del punto (2). Vedi PREVIEW-CAP-02.
 *
 * `PREVIEW-CAP-03` produce l'evidenza prima/dopo: le stesse card, le stesse tre
 * forme, con e senza il vecchio tetto in 144px rimesso via CSS.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { PREVIEW_CARD_MAX_RATIO, projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-preview-cap-${Date.now()}`;
// Allowlist di /api/media: `${OPENCLAW_DIR}/media/`, e OPENCLAW_DIR del server
// di test è dentro la sua DATA_DIR (helpers/test-server.ts).
const MEDIA_DIR = join(E2E_DATA_DIR, ".openclaw", "media", "preview-cap");
const EVIDENCE_DIR = join(__dirname, "..", "..", "test-results", "preview-cap");

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/**
 * Le tre forme del task, disegnate come SVG invece che come PNG per un motivo
 * pratico: servono dimensioni ESATTE e un contenuto in cui il taglio si veda,
 * e un SVG le dichiara in due attributi senza tirare dentro un encoder.
 * Fasce numerate + una fascia FONDO in coda: quante fasce si contano dice
 * quanto dell'immagine è sopravvissuto al ritaglio.
 */
function shapeSvg(w: number, h: number, label: string): string {
  const bands = 8;
  const bh = h / bands;
  const rows = Array.from({ length: bands }, (_, i) => {
    const last = i === bands - 1;
    const fill = last ? "#b91c1c" : i % 2 === 0 ? "#1e3a5f" : "#274b7a";
    const text = last ? "FONDO" : String(i + 1);
    return (
      `<rect x="0" y="${i * bh}" width="${w}" height="${bh}" fill="${fill}"/>` +
      `<text x="${w / 2}" y="${i * bh + bh * 0.62}" font-family="Helvetica" font-size="${Math.min(bh * 0.5, w * 0.12)}" ` +
      `fill="#ffffff" text-anchor="middle">${text}</text>`
    );
  }).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    rows +
    `<text x="${w / 2}" y="${bh * 0.55}" font-family="Helvetica" font-size="${Math.min(bh * 0.34, w * 0.07)}" ` +
    `fill="#fde68a" text-anchor="middle">${label} ${w}×${h}</text>` +
    `</svg>`
  );
}

const SHAPES = [
  { key: "larga", w: 1440, h: 760 },   // lo screenshot che il protocollo chiede: 0.53
  { key: "quadrata", w: 800, h: 800 }, // 1.00
  { key: "alta", w: 900, h: 1800 },    // 2.00 — quella che il tetto deve tagliare
] as const;

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function seedTask(
  request: import("@playwright/test").APIRequestContext,
  text: string,
  status: string,
  previewImage: string,
): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  const patch = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
    data: { previewImage, status },
  });
  expect(patch.ok(), `PATCH previewImage per ${text}`).toBe(true);
  return task.id;
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-preview-cap/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
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

type Box = {
  status: string;
  shape: string;
  boxW: number;
  boxH: number;
  naturalW: number;
  naturalH: number;
  cardH: number;
  columnBodyH: number;
  wrapW: number;
};

/** I rettangoli VERI di ogni anteprima sulla board, presi dal DOM. */
async function previewBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const out: Box[] = [];
    for (const wrap of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="preview-card"]'))) {
      const img = wrap.querySelector("img");
      if (!img) continue;
      const r = img.getBoundingClientRect();
      if (r.width === 0) continue; // colonna fuori dallo scroll orizzontale
      const card = wrap.closest("[data-task-card]") as HTMLElement | null;
      const column = wrap.closest('[data-testid^="kanban-column-body-"]') as HTMLElement | null;
      out.push({
        status: (column?.getAttribute("data-testid") || "").replace("kanban-column-body-", ""),
        shape: (card?.innerText || "").split("\n").find((l) => l.startsWith("forma:")) || "?",
        boxW: r.width,
        boxH: r.height,
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
        cardH: card?.getBoundingClientRect().height ?? 0,
        columnBodyH: column?.clientHeight ?? 0,
        wrapW: wrap.getBoundingClientRect().width,
      });
    }
    return out;
  }) as Promise<Box[]>;
}

/** Il tetto atteso su QUEL riquadro: il rapporto, e basta — è questo il punto. */
function expectedCap(boxW: number): number {
  return PREVIEW_CARD_MAX_RATIO * boxW;
}

function assertCapContract(boxes: Box[], where: string) {
  expect(boxes.length, `${where}: devono esserci anteprime da misurare`).toBeGreaterThan(0);
  for (const b of boxes) {
    // La misura si LEGGE, non si deduce dal verde. Il confronto col PRIMA è in
    // CAP-03, che il vecchio CSS ce l'ha davvero addosso: dividere 144 per la
    // larghezza di ADESSO darebbe un "prima" che non è mai esistito, perché in
    // review è cambiata anche quella.
    console.log(
      `[preview-cap] ${where} · ${b.status} · ${b.shape}: riquadro ${Math.round(b.boxW)}×${Math.round(b.boxH)} ` +
        `→ rapporto ${(b.boxH / b.boxW).toFixed(2)} · card ${Math.round(b.cardH)}px su colonna ${Math.round(b.columnBodyH)}px`,
    );
    const cap = expectedCap(b.boxW);
    const natural = (b.naturalH / b.naturalW) * b.boxW; // altezza a cui l'immagine vorrebbe stare
    const want = Math.min(cap, natural);
    expect(
      b.boxH,
      `${where} · ${b.shape} in ${b.status}: riquadro ${Math.round(b.boxW)}×${Math.round(b.boxH)}, ` +
        `atteso ${Math.round(want)} (tetto ${Math.round(cap)}, naturale ${Math.round(natural)})`,
    ).toBeGreaterThan(want - 2);
    expect(b.boxH).toBeLessThan(want + 2);
    // (2) la miniatura RIEMPIE la card: nessun tetto in larghezza, perché una
    // fascia vuota a destra in una colonna larga si legge come un difetto
    // (Attilio, 12/08). Il tetto vero è il rapporto, verificato qui sopra, e
    // vale a QUALSIASI larghezza — che è ciò che il protocollo promette agli
    // agenti. Qui si presidia il verso opposto: la miniatura non deve restare
    // più stretta della colonna che la ospita.
    expect(
      b.boxW,
      `${where} · ${b.shape}: la miniatura deve riempire il suo riquadro (${Math.round(b.wrapW)}px)`,
    ).toBeGreaterThan(b.wrapW - 2);
  }
}

test.describe("Kanban — il tetto dell'anteprima è un rapporto", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-preview-cap" }, null, 2));
    mkdirSync(MEDIA_DIR, { recursive: true });
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const topic = await createTopic(request, "E2E-PreviewCap", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;

    for (const s of SHAPES) {
      const file = join(MEDIA_DIR, `${s.key}.svg`);
      writeFileSync(file, shapeSvg(s.w, s.h, s.key));
      // La stessa forma in una colonna di LAVORO e in REVIEW: sono le due
      // larghezze fra cui il vecchio tetto fisso divergeva di più.
      await seedTask(request, `forma: ${s.key} (todo)`, "todo", file);
      await seedTask(request, `forma: ${s.key} (review)`, "review", file);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) {
      await request.delete(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`).catch(() => {});
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
    rmSync(MEDIA_DIR, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("PREVIEW-CAP-01: lo stesso rapporto a ogni larghezza di colonna", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(page.getByTestId("preview-card").first()).toBeVisible({ timeout: 15000 });

    // 1280 = la review al suo pavimento lg (32rem); 2560 = tutte al soffitto,
    // cioè le due larghezze in cui il vecchio tetto fisso mentiva di più.
    for (const width of [1280, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const boxes = await previewBoxes(page);
      assertCapContract(boxes, `viewport ${width}`);

      // Il punto del task: la colonna review è LARGA, e prima di questo cambio
      // era quella che tagliava di più. Ora il rapporto lì non è più basso che
      // nella colonna di lavoro (a meno del tetto in px, che è dichiarato).
      const review = boxes.filter((b) => b.status === "review" && b.boxH >= expectedCap(b.boxW) - 2);
      for (const b of review) {
        const oldRatio = 144 / b.boxW; // il tetto di prima, sullo stesso riquadro
        expect(
          b.boxH / b.boxW,
          `viewport ${width} · review: il rapporto deve essere migliorato rispetto ai 144px fissi`,
        ).toBeGreaterThan(oldRatio);
      }
    }
  });

  test("PREVIEW-CAP-02: mobile, e una card resta metà colonna", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(page.getByTestId("preview-card").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(300);

    assertCapContract(await previewBoxes(page), "mobile 390");

    // (4) scansionabilità, sul viewport di riferimento — e sono DUE promesse
    // diverse, una per colonna, non un unico numero.
    //
    // In REVIEW: la card si vede INTERA senza scorrere. Non di più, e il perché
    // è aritmetica, non gusto. La colonna review parte da 32rem (`widthCls`),
    // il riquadro riempie la card per scelta dichiarata (12/08: «proporzioni
    // giuste ma non prendono tutta la larghezza»), e il rapporto è
    // `PREVIEW_CARD_MAX_RATIO`: la sola anteprima vale già 0.7 x 472 = 330px su
    // un corpo colonna di ~597: il 55%. Sommato ai comandi di review — che dal
    // 12/08 stanno su OGNI card in review, non solo su quelle di un agente —
    // non esiste nessun tetto sotto il corpo colonna, e chiederne uno vorrebbe
    // dire rimettere un limite in px sul riquadro, cioè disfare (1).
    //
    // In LAVORO: ce ne stanno DUE. Lì la colonna è una lista che si scorre, la
    // card non porta comandi, e la metà è un numero che il layout regge.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    for (const b of await previewBoxes(page)) {
      const share = b.status === "review" ? 1 : 1 / 2;
      expect(
        b.cardH,
        b.status === "review"
          ? `${b.shape} in review: card ${Math.round(b.cardH)}px su un corpo colonna di ${Math.round(b.columnBodyH)}px: deve vedersi intera senza scorrere`
          : `${b.shape} in ${b.status}: card ${Math.round(b.cardH)}px su un corpo colonna di ${Math.round(b.columnBodyH)}px: in colonna di lavoro se ne devono vedere due`,
      ).toBeLessThanOrEqual(b.columnBodyH * share);
    }
  });

  test("PREVIEW-CAP-03: evidenza prima/dopo sulle stesse tre forme", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(page.getByTestId("preview-card").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(300);

    // "Prima" = il vecchio CSS rimesso addosso alla STESSA pagina: l'unica
    // differenza fra i due scatti sono queste due righe, quindi il confronto
    // non può essere sporcato da nient'altro. Sono due e non una perché il
    // vecchio stato era `max-h-36` E nessun tetto sulla larghezza: rimettere
    // solo l'altezza mostrerebbe un "prima" che non è mai esistito.
    const LEGACY =
      '[data-testid="preview-card"] { max-width: none !important; }' +
      '[data-testid="preview-card"] img { max-height: 144px !important; }';
    const shots: Record<string, Record<string, Record<string, string>>> = { prima: {}, dopo: {} };
    const sizes: string[] = [];
    for (const phase of ["prima", "dopo"] as const) {
      await page.evaluate(
        ({ css, on }) => {
          document.getElementById("legacy-cap")?.remove();
          if (!on) return;
          const style = document.createElement("style");
          style.id = "legacy-cap";
          style.textContent = css;
          document.head.appendChild(style);
        },
        { css: LEGACY, on: phase === "prima" },
      );
      await page.waitForTimeout(250);
      for (const b of await previewBoxes(page)) {
        sizes.push(
          `${phase} · ${b.status} · ${b.shape}: ${Math.round(b.boxW)}×${Math.round(b.boxH)} = ${(b.boxH / b.boxW).toFixed(2)}`,
        );
      }
      for (const col of ["todo", "review"] as const) {
        shots[phase][col] = {};
        for (const s of SHAPES) {
          const card = page.locator("[data-task-card]", { hasText: `forma: ${s.key} (${col})` }).first();
          shots[phase][col][s.key] = `data:image/png;base64,${(await card.screenshot()).toString("base64")}`;
        }
      }
    }
    for (const line of sizes) console.log(`[preview-cap] A/B ${line}`);

    // Due strisce e non una: la colonna di lavoro e quella di review sono le
    // due larghezze in cui il vecchio tetto fisso divergeva, e una sola delle
    // due racconterebbe metà del cambio. Larghe e basse di proposito — sono
    // esse stesse anteprime di card, e devono stare sotto la soglia che questo
    // task ha appena spostato.
    const OUT: Record<string, string> = {};
    for (const [col, size, title] of [
      ["todo", { width: 1400, height: 620 }, "colonna di lavoro (miniatura 248px)"],
      ["review", { width: 1400, height: 820 }, "colonna review (card 474px, miniatura ferma a 380px)"],
    ] as const) {
      expect(size.height / size.width).toBeLessThanOrEqual(PREVIEW_CARD_MAX_RATIO);
      const strip = await page.context().newPage();
      await strip.setViewportSize(size);
      await strip.setContent(
        `<body style="margin:0;background:#0f1115;font-family:-apple-system,Helvetica,sans-serif;color:#e5e7eb">
          <div style="padding:14px 18px 0">
            <div style="font-size:17px;font-weight:600">Anteprima sulla card — 144px fissi (prima) contro rapporto 0.70 (dopo) · ${title}</div>
            <div style="font-size:12px;color:#9ca3af;margin-top:2px">stesse card, stesse tre forme, unica differenza il tetto · le fasce numerate dicono quanto si vede · &quot;FONDO&quot; = si vede tutta</div>
          </div>
          ${(["prima", "dopo"] as const).map((phase) => `
            <div style="display:flex;gap:20px;align-items:flex-start;padding:10px 18px">
              <div style="width:58px;font-size:14px;font-weight:600;color:${phase === "prima" ? "#f87171" : "#34d399"};padding-top:16px">${phase.toUpperCase()}</div>
              ${SHAPES.map((s) => `<div><div style="font-size:11px;color:#9ca3af;margin-bottom:4px">${s.key} ${s.w}×${s.h}</div><img src="${shots[phase][col][s.key]}" style="display:block;width:${col === "review" ? 380 : 250}px"></div>`).join("")}
            </div>`).join("")}
        </body>`,
      );
      await strip.waitForTimeout(300);
      OUT[col] = join(EVIDENCE_DIR, `prima-dopo-${col}.png`);
      await strip.screenshot({ path: OUT[col] });
      await strip.close();
      console.log(`[preview-cap] evidenza: ${OUT[col]}`);
    }

    // Terza immagine: quella che va SULLA card, e per starci deve obbedire al
    // cancello del protocollo — «a 268px devi ancora saper dire cosa mostra».
    // Le due strisce qui sopra a 268px stanno al 19% e il testo sparisce; qui
    // ci sono due sole card e due parole, quindi a 268px si legge ancora.
    const CARD = { width: 900, height: 560 };
    expect(CARD.height / CARD.width).toBeLessThanOrEqual(PREVIEW_CARD_MAX_RATIO);
    const hero = await page.context().newPage();
    await hero.setViewportSize(CARD);
    await hero.setContent(
      `<body style="margin:0;background:#0f1115;font-family:-apple-system,Helvetica,sans-serif;color:#e5e7eb">
        <div style="padding:16px 20px 0;font-size:26px;font-weight:700">Anteprima in colonna review — 0.31 → 0.70</div>
        <div style="display:flex;gap:26px;padding:14px 20px">
          ${(["prima", "dopo"] as const).map((phase) => `
            <div style="flex:1">
              <div style="font-size:22px;font-weight:700;color:${phase === "prima" ? "#f87171" : "#34d399"};margin-bottom:8px">${phase.toUpperCase()}</div>
              <img src="${shots[phase]["review"]["alta"]}" style="display:block;width:100%">
            </div>`).join("")}
        </div>
      </body>`,
    );
    await hero.waitForTimeout(300);
    const heroOut = join(EVIDENCE_DIR, "card-preview.png");
    await hero.screenshot({ path: heroOut });
    await hero.close();
    console.log(`[preview-cap] evidenza: ${heroOut}`);
  });
});
