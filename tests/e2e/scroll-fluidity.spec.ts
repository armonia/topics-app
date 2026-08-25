/**
 * @covers SCROLLFLU-01
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp, openTopic } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questa spec riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * IL BANCO DI PROVA DELLA FLUIDITA' (non il cancello: quello e' check:fluido).
 *
 * PERCHE' ESISTE. «Fluido» era una parola in una card e in nessun numero. Il
 * budget di frame a riposo (`idle-frame-budget.spec.ts`) misura l'opposto, cioe'
 * quanti frame si chiedono quando NON succede niente, e per costruzione tace
 * proprio dove l'utente sente il difetto: durante uno scorrimento, quando i
 * frame li vogliamo tutti e il main thread e' occupato a virtualizzare, a
 * misurare item alti e a rifare layout. Una regressione li' oggi non fa fallire
 * niente.
 *
 * COSA MISURA. Tre numeri sulla stessa passata, perche' una fluidita' si rompe
 * in tre modi diversi e nessuno dei tre implica gli altri:
 *
 *   frame persi   quanti frame il display avrebbe potuto mostrare e non ha
 *                 mostrato. E' la misura della sensazione «scatta».
 *   buco peggiore il singolo intervallo piu' lungo fra due frame. Uno stallo da
 *                 300 ms si sente eccome, e su una passata lunga pesa poco in
 *                 percentuale: va guardato da solo.
 *   long task     millisecondi passati dentro task lunghi (>50 ms) mentre si
 *                 scorre. E' la CAUSA, non il sintomo: dice che il difetto e'
 *                 lavoro sul main thread e non il compositore.
 *
 * PERCHE' QUESTA SUPERFICIE. Il trascritto di una chat e' l'unica lista
 * virtualizzata dell'app (react-virtuoso), ed e' gia' il posto dove un difetto
 * di questa famiglia e' stato misurato: la catena
 * ResizeObserver -> rAF -> `offsetParent` di virtuoso costava un layout sincrono
 * per frame. Densa, reale, e con una storia.
 *
 * PERCHE' `scrollTop` E NON LA ROTELLINA. Serve una passata RIPETIBILE: stesso
 * numero di frame, stessa distanza, stessa curva, run dopo run. `mouse.wheel`
 * passa dal protocollo e la sua cadenza dipende da quanto e' carica la macchina,
 * cioe' proprio dalla variabile che stiamo misurando. Scrivere `scrollTop` dentro
 * il rAF fa partire lo stesso evento di scroll, che e' cio' che virtuoso
 * ascolta, con un passo deciso da noi. Il gesto vero (autorita' dello scroll,
 * inerzia) e' coperto da `chat-scroll.spec.ts`; qui interessa il costo di
 * disegnare, non chi comanda lo scroll.
 *
 * QUESTA SPEC NON HA UNA SOGLIA, ED E' VOLUTO. Fallisce solo se il banco stesso
 * non regge (niente da scorrere, macchina che non consegna frame nemmeno da
 * ferma, zero frame raccolti): un rosso qui parla della misura, mai del
 * prodotto. Il confronto con il budget vive in `scripts/check-fluido.ts`, che
 * legge il JSON scritto qui sotto. Cosi' la suite non diventa rossa perche' il
 * portatile stava indicizzando, e il giudizio si da' quando lo si chiede.
 */

/** Frame per passata. 180 a 60Hz = ~3 s di scorrimento continuo. */
const FRAMES_PER_PASS = 180;
/** Frame della calibrazione a riposo: serve solo a dire se la macchina regge. */
const CALIBRATION_FRAMES = 60;
/**
 * Passate misurate, piu' una di riscaldamento SCARTATA. La prima passata dopo il
 * montaggio e' sempre la peggiore, perche' virtuoso misura le altezze vere degli
 * item mentre entrano, e includerla misurerebbe il primo scorrimento della vita di
 * una pane, non lo scorrimento. Cinque passate perche' il cancello prende la
 * MEDIANA: con cinque campioni una passata storta (un GC, un altro processo che
 * si sveglia) non sposta il verdetto.
 */
const PASSES = 5;
/** Il frame a 60Hz. Non si deduce dalla run: vedi la nota in check-fluido.ts. */
/**
 * Il frame di riferimento e' 60 Hz solo come RIPIEGO: la cadenza vera la misura
 * la calibrazione, e si usa quella.
 *
 * Il numero fisso era il buco principale di questa misura, ed era aritmetico.
 * Su uno schermo a 120 Hz il banco consegna un frame ogni 8,3 ms; contando i
 * frame persi con `round(gap / 16,667) - 1` un gap uniforme fino a 24,9 ms da'
 * ZERO frame persi, poi salta di colpo al 50%. Per un rallentamento UNIFORME
 * quel numero non e' una percentuale, e' un gradino: la chat poteva passare da
 * 120 a 41 fps e le tre soglie restavano tutte verdi. Ed e' esattamente la
 * famiglia del difetto storico che questa misura esiste per prendere (un layout
 * sincrono per frame rende ogni frame piu' caro, senza fare buchi).
 *
 * Con il budget preso dalla calibrazione, lo stesso rallentamento e' 3x il
 * tempo per frame, e i frame persi lo dicono.
 */
const FRAME_BUDGET_FALLBACK_MS = 1000 / 60;

/** La cadenza misurata, arrotondata al passo di refresh piu' vicino. */
function budgetDaCalibrazione(calibrationGapMs: number): number {
  // Una calibrazione assurda (macchina in ginocchio, pagina che non consegna)
  // non deve ALLARGARE il proprio metro: sopra i 60 Hz nominali si ricade sul
  // ripiego, cosi' una misura storta non si autoassolve.
  if (!Number.isFinite(calibrationGapMs) || calibrationGapMs <= 0) return FRAME_BUDGET_FALLBACK_MS;
  return Math.min(calibrationGapMs, FRAME_BUDGET_FALLBACK_MS);
}

/** Messaggi seminati. Serve un trascritto ALTO: si scorre per intero due volte. */
const SEED_MESSAGES = 80;

const BASE = E2E_BASE;

const OUT_PATH = resolve(
  process.env.TOPICS_FLUIDO_OUT?.trim() || "test-results/fluido-measure.json",
);

/**
 * Lentezza VERA iniettata nella pagina, in millisecondi di blocco ogni 100 ms.
 *
 * E' il modo in cui questo cancello si vede fallire. Abbassare la soglia
 * proverebbe che una disuguaglianza funziona; bloccare il main thread prova che
 * la SONDA vede un'app che scatta, che e' l'unica cosa di cui il cancello ha
 * un'opinione. Zero (il default) = niente iniezione.
 */
const JANK_MS = Number(process.env.TOPICS_FLUIDO_JANK_MS || 0);
/** Millisecondi bruciati DENTRO ogni frame: la lentezza uniforme, senza buchi. */
const JANK_UNIFORME_MS = Number(process.env.TOPICS_FLUIDO_JANK_UNIFORME_MS || 0);

interface Passata {
  frames: number;
  elapsed_ms: number;
  dropped: number;
  dropped_pct: number;
  worst_gap_ms: number;
  median_gap_ms: number;
  longtask_ms: number;
  longtask_count: number;
  /** Pixel effettivamente percorsi. Testimone: vedi `scroll_span_px` sotto. */
  scroll_span_px: number;
  /** Quante volte e' cambiato il primo item montato dalla virtualizzazione. */
  render_churn: number;
}

/** La mediana, che e' la statistica che regge a una passata storta. */
function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function arrotonda(n: number, cifre = 2): number {
  const f = 10 ** cifre;
  return Math.round(n * f) / f;
}

/**
 * Blocca il main thread a intervalli regolari, PRIMA che il bundle parta.
 *
 * `Atomics.wait` non va: bloccherebbe solo se ci fosse un worker, e comunque sul
 * thread principale il browser lo vieta. Un ciclo che gira su `performance.now()`
 * e' la stessa cosa che fa un componente troppo caro: brucia il thread e basta.
 */
async function iniettaLentezza(page: Page, ms: number): Promise<void> {
  if (ms <= 0) return;
  await page.addInitScript((blockMs: number) => {
    setInterval(() => {
      const fine = performance.now() + blockMs;
      while (performance.now() < fine) {
        /* occupato: e' il punto */
      }
    }, 100);
  }, ms);
}

/**
 * L'ALTRA forma di lentezza, e serve perche' e' quella che il banco NON vedeva.
 *
 * `iniettaLentezza` e' un `setInterval`: produce jank SPIKY, un buco isolato
 * ogni 100 ms. E' la forma che accende `worst_gap_ms` e `longtask_ms`, cioe'
 * proprio le due soglie piu' sensibili — quindi un rosso ottenuto cosi' non
 * dimostra niente sul caso opposto.
 *
 * Qui il tempo si brucia DENTRO il frame, un po' a ogni `requestAnimationFrame`:
 * nessun buco, nessun long task, solo ogni frame piu' caro. E' la firma del
 * difetto vero che questa misura esiste per prendere (un layout sincrono per
 * frame, un effetto che rimisura, una lista non memoizzata), ed e' il caso che
 * col metro fisso a 60 Hz restava verde fino a 41 fps.
 */
async function iniettaLentezzaUniforme(page: Page, ms: number): Promise<void> {
  if (ms <= 0) return;
  await page.addInitScript((burnMs: number) => {
    const brucia = () => {
      const fine = performance.now() + burnMs;
      while (performance.now() < fine) {
        /* occupato: e' il punto */
      }
      requestAnimationFrame(brucia);
    };
    requestAnimationFrame(brucia);
  }, ms);
}

/**
 * Cadenza a RIPOSO della MACCHINA, misurata su una pagina VUOTA.
 *
 * Serve a una cosa sola: distinguere «l'app scatta» da «il portatile sta
 * indicizzando». Se qui i frame gia' non arrivano, qualunque numero raccolto
 * dopo parla della macchina, e il cancello si dichiara non misurabile invece di
 * dare un rosso che mente.
 *
 * VA MISURATA FUORI DALLA PAGINA DELL'APP, e non e' un dettaglio. Se girasse
 * dentro, la lentezza dell'app (o quella iniettata dal banco) finirebbe anche
 * nella calibrazione: la soglia si allargherebbe esattamente quando il difetto
 * peggiora, e il cancello direbbe «non misurabile» proprio nel caso in cui deve
 * dire rosso. E' lo stesso errore di un freno che si divide per un carico vivo.
 */
async function calibra(page: Page, frames: number): Promise<number> {
  return page.evaluate(async (n: number) => {
    const gaps: number[] = [];
    await new Promise<void>((resolve) => {
      let i = 0;
      let last = 0;
      const tick = (t: number) => {
        gaps.push(t - last);
        last = t;
        if (++i >= n) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame((t) => {
        last = t;
        requestAnimationFrame(tick);
      });
    });
    const s = gaps.sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }, frames);
}

/** Una passata: giu' fino in fondo e su fino in cima, contando i frame. */
async function passata(
  scroller: Locator,
  frames: number,
  budgetMs: number,
): Promise<Passata> {
  return scroller.evaluate(
    async (el: HTMLElement, { n, budget }: { n: number; budget: number }) => {
      const gaps: number[] = [];
      const longtasks: number[] = [];
      let po: PerformanceObserver | null = null;
      try {
        po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longtasks.push(e.duration);
        });
        // `buffered: false`: interessa solo cio' che succede DENTRO la passata.
        po.observe({ type: "longtask", buffered: false });
      } catch {
        // Un browser senza longtask non fa fallire la misura dei frame: il
        // cancello se ne accorge da `longtask_count === 0` su una passata janky.
      }

      const corsa = Math.max(1, el.scrollHeight - el.clientHeight);
      const meta = Math.floor(n / 2);
      const t0 = performance.now();

      // Il TESTIMONE del lavoro. Un banco che scorre e non fa montare niente
      // riporterebbe zero frame persi su zero lavoro, e sarebbe verde per
      // sempre: e' il modo tipico in cui una misura smette di misurare senza
      // dirlo. `data-index` e' l'indice che react-virtuoso scrive sull'item, e
      // vederlo cambiare e' la prova che la virtualizzazione sta lavorando.
      const primoIndice = (): number => {
        const item = el.querySelector("[data-index]");
        const v = item?.getAttribute("data-index");
        return v === null || v === undefined ? -1 : Number(v);
      };
      let indicePrec = primoIndice();
      let churn = 0;
      let minTop = el.scrollTop;
      let maxTop = el.scrollTop;

      await new Promise<void>((resolve) => {
        let i = 0;
        let last = 0;
        const tick = (t: number) => {
          gaps.push(t - last);
          last = t;
          const idx = primoIndice();
          if (idx !== indicePrec) {
            churn++;
            indicePrec = idx;
          }
          if (el.scrollTop < minTop) minTop = el.scrollTop;
          if (el.scrollTop > maxTop) maxTop = el.scrollTop;
          // Andata e ritorno: la risalita monta item che la discesa aveva
          // smontato, ed e' la meta' dove virtuoso lavora di piu'.
          const frazione = i < meta ? i / meta : (n - i) / (n - meta);
          el.scrollTop = Math.round(corsa * Math.min(1, Math.max(0, frazione)));
          if (++i >= n) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame((t) => {
          last = t;
          requestAnimationFrame(tick);
        });
      });

      const elapsed = performance.now() - t0;
      po?.disconnect();

      let dropped = 0;
      let worst = 0;
      for (const g of gaps) {
        dropped += Math.max(0, Math.round(g / budget) - 1);
        if (g > worst) worst = g;
      }
      const ord = [...gaps].sort((a, b) => a - b);
      const mid = Math.floor(ord.length / 2);

      return {
        frames: gaps.length,
        elapsed_ms: elapsed,
        dropped,
        // Quota sui frame che il display AVREBBE potuto mostrare: consegnati
        // piu' persi. Un denominatore fatto dei soli consegnati direbbe 100%
        // quando ne perdi uno ogni due, che e' gia' ingiudicabile.
        dropped_pct: (dropped / (gaps.length + dropped)) * 100,
        worst_gap_ms: worst,
        median_gap_ms: ord.length % 2 ? ord[mid]! : (ord[mid - 1]! + ord[mid]!) / 2,
        longtask_ms: longtasks.reduce((a, b) => a + b, 0),
        longtask_count: longtasks.length,
        scroll_span_px: maxTop - minTop,
        render_churn: churn,
      };
    },
    { n: frames, budget: budgetMs },
  );
}

test.describe("Banco della fluidita' dello scorrimento", () => {
  // Semina 80 messaggi, monta la chat e fa sei passate da tre secondi: i 30 s
  // di default non bastano, e il timeout arriverebbe prima della misura.
  test.describe.configure({ timeout: 180_000 });

  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    topicName = `fluido-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    for (let i = 0; i < SEED_MESSAGES; i++) {
      await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
        data: {
          content:
            `Messaggio ${i + 1} del banco fluidita'. ` +
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4),
        },
        ignoreHTTPSErrors: true,
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("misura i frame persi scorrendo il trascritto", async ({ page, request }) => {
    await resetPaneStore(request, [topicId]);

    // Calibrazione su una pagina VUOTA e SEPARATA: `addInitScript` e' per-pagina,
    // quindi qui la lentezza iniettata non arriva e questa misura resta cio' che
    // deve essere: un giudizio sulla macchina, non sull'app.
    const paginaVuota = await page.context().newPage();
    await paginaVuota.goto("about:blank");
    const calibration_gap_ms = await calibra(paginaVuota, CALIBRATION_FRAMES);
    await paginaVuota.close();

    await iniettaLentezza(page, JANK_MS);
    await iniettaLentezzaUniforme(page, JANK_UNIFORME_MS);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page
      .locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]')
      .first();
    await scroller.waitFor({ state: "visible", timeout: 20_000 });

    // Un banco che misura uno scorrimento deve dire a voce alta se non c'e'
    // niente da scorrere, invece di riportare zero frame persi su zero pixel.
    // E' lo stesso errore che `assertScrollabile` evita in chat-scroll.spec.ts.
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight), {
        timeout: 20_000,
      })
      .toBeGreaterThan(2000);

    // Riscaldamento SCARTATO: virtuoso misura le altezze vere degli item la
    // prima volta che ci passa sopra, e quel costo si paga una volta sola.
    const budgetFrame = budgetDaCalibrazione(calibration_gap_ms);
    await passata(scroller, FRAMES_PER_PASS, budgetFrame);

    const passate: Passata[] = [];
    for (let i = 0; i < PASSES; i++) {
      passate.push(await passata(scroller, FRAMES_PER_PASS, budgetFrame));
    }

    // I tre modi in cui questo banco puo' smettere di misurare restando verde.
    // Meglio un rosso qui, che parla della misura, di un JSON di zeri che il
    // cancello leggerebbe come «tutto liscio».
    for (const p of passate) {
      expect(p.frames, "la sonda non ha raccolto frame").toBeGreaterThan(FRAMES_PER_PASS / 2);
      expect(p.scroll_span_px, "lo scorrimento non si e' mosso").toBeGreaterThan(2000);
      expect(p.render_churn, "la virtualizzazione non ha montato niente").toBeGreaterThan(10);
    }

    const misura = {
      $schema: "fluido-measure-v1",
      surface: "chat-thread-virtuoso",
      measured_at: new Date().toISOString(),
      jank_injected_ms: JANK_MS,
      protocol: {
        frames_per_pass: FRAMES_PER_PASS,
        passes: PASSES,
        warmup_passes: 1,
        frame_budget_ms: arrotonda(budgetDaCalibrazione(calibration_gap_ms), 3),
        seeded_messages: SEED_MESSAGES,
      },
      calibration_gap_ms: arrotonda(calibration_gap_ms),
      median: {
        dropped_pct: arrotonda(mediana(passate.map((p) => p.dropped_pct))),
        worst_gap_ms: arrotonda(mediana(passate.map((p) => p.worst_gap_ms))),
        longtask_ms: arrotonda(mediana(passate.map((p) => p.longtask_ms))),
        longtask_count: arrotonda(mediana(passate.map((p) => p.longtask_count))),
        median_gap_ms: arrotonda(mediana(passate.map((p) => p.median_gap_ms))),
      },
      // I testimoni, in chiaro nel JSON: chi legge il numero vede anche che il
      // banco stava davvero scorrendo qualcosa quando l'ha prodotto.
      witness: {
        scroll_span_px: arrotonda(mediana(passate.map((p) => p.scroll_span_px))),
        render_churn: arrotonda(mediana(passate.map((p) => p.render_churn))),
      },
      passes: passate.map((p) => ({
        frames: p.frames,
        elapsed_ms: arrotonda(p.elapsed_ms),
        dropped: p.dropped,
        dropped_pct: arrotonda(p.dropped_pct),
        worst_gap_ms: arrotonda(p.worst_gap_ms),
        median_gap_ms: arrotonda(p.median_gap_ms),
        longtask_ms: arrotonda(p.longtask_ms),
        longtask_count: p.longtask_count,
        scroll_span_px: p.scroll_span_px,
        render_churn: p.render_churn,
      })),
    };

    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(misura, null, 2)}\n`);
    console.log(
      `[fluido] frame persi ${misura.median.dropped_pct}%  buco peggiore ` +
        `${misura.median.worst_gap_ms}ms  long task ${misura.median.longtask_ms}ms  ` +
        `(calibrazione ${misura.calibration_gap_ms}ms) -> ${OUT_PATH}`,
    );
  });
});
