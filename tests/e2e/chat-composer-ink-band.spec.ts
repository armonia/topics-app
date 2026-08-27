/**
 * LA FASCIA DIETRO IL COMPOSER NON CONTIENE MAI INCHIOSTRO.
 *
 * Il composer galleggia sopra il trascritto e i messaggi ci scorrono dietro: è
 * il punto dell'overlay. Il difetto segnalato da telefono era il BORDO — la
 * riga che entrava sotto la scatola opaca veniva tagliata di netto e restava lì
 * mezza, illeggibile. Ora l'inchiostro si spegne prima di arrivarci
 * (MessageList, `INK_FADE_RAMP_PX`).
 *
 * COME SI MISURA, e perché non con `getBoundingClientRect`. La domanda non è
 * dove stanno le SCATOLE — quelle si sovrappongono per costruzione, il testo
 * passa sotto e deve continuare a farlo — ma se in quella fascia arriva
 * PITTURA. Quindi si misurano i pixel, e in modo differenziale:
 *
 *   A = la fascia con la chat ferma in fondo (lì, per costruzione, sotto
 *       l'ultima riga c'è solo il varco riservato dal Footer: niente testo)
 *   B = la stessa fascia con il trascritto scorso di qualche decina di pixel,
 *       cioè con messaggi VERI che le passano dietro
 *
 * Se il testo si spegne davvero, A e B sono lo stesso quadro. Ogni pixel che
 * cambia è inchiostro entrato dove non deve andare — e la sua Y dice a che
 * altezza è entrato. Il confronto lo fa il browser (decodifica lui i due PNG
 * su canvas), come in `scripts/landing-painted.mjs`.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { waitForLayoutSettled } from "./helpers/layout";

hermetic(test);

const BASE = E2E_BASE;
const PHONE = { width: 390, height: 844 };

/** Abbastanza testo da riempire più schermate: senza scroll non c'è difetto. */
const SEED_MESSAGES = Array.from({ length: 14 }, (_, i) =>
  i % 2 === 0
    ? `Domanda numero ${i}: cosa succede al testo che scorre dietro l'input?`
    : `Risposta ${i}. ${"Una riga di testo lunga, che va a capo da sola e produce parecchie righe consecutive da far passare dietro al composer. ".repeat(3)}`,
);

/** Il pixel di una glifo differisce ben oltre il rumore dell'antialiasing. */
const GLYPH_DELTA = 24;

interface BandDiff {
  changed: number;
  worst: { x: number; y: number; d: number } | null;
  total: number;
}

/**
 * Lo scroller vero è quello di Virtuoso, un discendente del contenitore: si
 * trova per geometria (è l'unico che scorre), non per classe.
 */
async function scrollBy(page: Page, deltaUp: number): Promise<void> {
  // Ruota vera e non `scrollTop = …`: sopra il trascritto c'è un'autorità dello
  // scroll che riporta in fondo ciò che non ha mosso l'utente (scrollAuthority),
  // e un'assegnazione programmatica può essere annullata prima dello scatto —
  // lasciando una misura che non può fallire.
  await page.mouse.move(PHONE.width / 2, PHONE.height / 2);
  await page.mouse.wheel(0, -deltaUp);
  await page.waitForTimeout(350);
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="chat-scroll-container"]');
    if (!root) throw new Error("nessun contenitore di chat");
    const els = [root, ...Array.from(root.querySelectorAll("*"))] as HTMLElement[];
    const scroller = els.find((el) => el.scrollHeight > el.clientHeight + 4);
    if (!scroller) throw new Error("il trascritto non scorre: niente da provare");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(400);
}

/** Diff pixel-per-pixel di due PNG della STESSA clip, fatto nel browser. */
async function diffBand(page: Page, a: Buffer, b: Buffer, w: number, h: number): Promise<BandDiff> {
  return page.evaluate(
    async ({ aB64, bB64, w, h, glyph }) => {
      const load = (b64: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = "data:image/png;base64," + b64;
        });
      const [ia, ib] = await Promise.all([load(aB64), load(bB64)]);
      const px = (im: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d", { willReadFrequently: true })!;
        x.drawImage(im, 0, 0, w, h);
        return x.getImageData(0, 0, w, h).data;
      };
      const A = px(ia);
      const B = px(ib);
      let changed = 0;
      let worst: { x: number; y: number; d: number } | null = null;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = (y * w + x) * 4;
          const d = Math.max(
            Math.abs(A[k] - B[k]),
            Math.abs(A[k + 1] - B[k + 1]),
            Math.abs(A[k + 2] - B[k + 2]),
          );
          if (d <= glyph) continue;
          changed++;
          if (!worst || d > worst.d) worst = { x, y, d };
        }
      }
      return { changed, worst, total: w * h };
    },
    { aB64: a.toString("base64"), bB64: b.toString("base64"), w, h, glyph: GLYPH_DELTA },
  );
}

test.describe("Chat — la fascia dietro il composer resta senza inchiostro", () => {
  test.describe.configure({ timeout: 120_000 });
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `composer-ink-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    for (const content of SEED_MESSAGES) {
      await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
        data: { content },
        ignoreHTTPSErrors: true,
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("INK-BAND-01: a 390px nessun testo dipinge dietro l'input, a nessuna posizione di scroll", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "CHAT-LAYOUT-01" });
    // Si naviga da desktop e si stringe DOPO: sotto i 768 la sidebar è un
    // overlay chiuso e `goToApp` la aspetta visibile (stessa nota di
    // chat-layout-audit.spec.ts).
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    await expect(page.getByTestId("chat-message-list").first()).toBeVisible({ timeout: 10_000 });
    await page.setViewportSize(PHONE);
    await waitForLayoutSettled(page);

    const area = page.getByTestId("chat-input-area").first();
    await expect(area).toBeVisible();
    const box = (await area.boundingBox())!;
    // La fascia: dal bordo superiore dell'area di input fino in fondo allo
    // schermo. Arrotondata per DIFETTO verso l'alto di 1px non si fa: si parte
    // esattamente dal bordo, che è il tetto dichiarato.
    const band = {
      x: 0,
      y: Math.ceil(box.y),
      width: PHONE.width,
      height: Math.floor(PHONE.height - box.y),
    };
    expect(band.height, "la fascia deve esistere: senza composer misurato non c'è niente da provare").toBeGreaterThan(40);

    // IL TESTIMONE: la striscia SOPRA la fascia. Serve a rendere falsificabile
    // tutto il resto — se lì non cambia niente vuol dire che il trascritto non
    // si è mosso, e allora una fascia pulita non prova nulla.
    const testimone = { x: 0, y: Math.max(0, band.y - 80), width: PHONE.width, height: 80 };

    await scrollToBottom(page);
    const rest = await page.screenshot({ clip: band });
    const restSopra = await page.screenshot({ clip: testimone });

    // Quattro posizioni: quel che rompe non è "scrollare", è dove si FERMA la
    // riga rispetto al bordo — a metà, appena entrata, appena uscita.
    for (const dy of [37, 61, 96, 143]) {
      await scrollToBottom(page);
      await scrollBy(page, dy);

      const sopra = await page.screenshot({ clip: testimone });
      const mosso = await diffBand(page, restSopra, sopra, testimone.width, testimone.height);
      expect(
        mosso.changed,
        `scroll di ${dy}px: sopra la fascia non è cambiato NIENTE — il trascritto non si è mosso, ` +
          `quindi la misura sotto non potrebbe fallire`,
      ).toBeGreaterThan(0);

      const shot = await page.screenshot({ clip: band });
      const diff = await diffBand(page, rest, shot, band.width, band.height);
      expect(
        diff,
        `scroll di ${dy}px: nella fascia dietro l'input è comparsa pittura che da fermo non c'era ` +
          `(${diff.changed} pixel su ${diff.total}, il più forte a y=${diff.worst?.y} dal bordo del composer)`,
      ).toMatchObject({ changed: 0 });
    }
  });
});
