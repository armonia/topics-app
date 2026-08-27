/**
 * clip.ts — la clip di consegna si REGISTRA corta, non si taglia dopo.
 *
 * COM'ERA. La clip si otteneva con `E2E_EVIDENCE=1`, che accende `slowMo: 300`
 * e `video: "on"` su OGNI test della suite. Due conseguenze, entrambe pagate:
 * il video comincia all'apertura del contesto, quindi contiene tutto il setup
 * (l'app che parte, il progetto che si apre, la board che si monta) prima del
 * gesto che dovrebbe provare qualcosa; e ogni azione costa 300 ms in più, per
 * cui la stessa scena dura il triplo. `board-recapture-preview` usciva a 26,9s
 * contro i 20s del protocollo ed è stata tagliata a mano con `ffmpeg`,
 * scegliendo a occhio l'istante di partenza. Metodo non ripetibile: chi taglia
 * male consegna una clip che comincia dopo il click, e non lo scopre nessuno.
 *
 * COM'E'. Un contesto DEDICATO, acceso sul solo tratto utile:
 *
 *  1. Il browser è NOSTRO. `slowMo` non è un'opzione di contesto ma di LANCIO:
 *     un `browser.newContext()` preso dalla fixture eredita i 300 ms anche se
 *     la clip non li vuole. L'unico modo di non averli è lanciare un browser
 *     senza. Costa mezzo secondo, e lo paga il setup, non la clip.
 *  2. Il `prologo` gira su una pagina il cui video viene BUTTATO. In Playwright
 *     il video è per-PAGINA e comincia quando la pagina nasce: aprire il
 *     progetto, montare la board, arrivare allo stato di partenza costa quel
 *     che costa, ma sta in un file che cancelliamo. La pagina della `scena`
 *     nasce dopo, nello stesso contesto — quindi con la stessa cache HTTP,
 *     lo stesso `localStorage` e gli stessi cookie del prologo: il suo `goto`
 *     è a caldo, e il layout si ridrata già aperto sulla board.
 *  3. La durata si MISURA sul .webm (`webm-duration.ts`) e supera il tetto
 *     alza. Il file resta comunque su disco: un rosso che dice «26,9s» e dà il
 *     path è utile, uno che cancella la prova no.
 *
 * QUANDO REGISTRA. Solo con `E2E_CLIP=1`. Senza, la funzione fa girare prologo
 * e scena esattamente uguali ma senza video e senza cancello: il percorso di
 * codice del test è UNO, così la clip non prova una strada diversa da quella
 * che gira nel gate. E il cancello sul tempo non entra nella passata normale,
 * dove un rosso da macchina carica sarebbe un rosso che non parla del prodotto.
 *
 * Uso:
 *
 *     await clipDiConsegna({
 *       nome: "recapture-01",
 *       context: { baseURL: E2E_BASE, locale: "it-IT", viewport: { width: 1280, height: 680 } },
 *       prologo: async (p) => { await p.goto("/"); await apriLaBoard(p); },
 *       scena:   async (p) => { await p.goto("/"); await p.click(…); },
 *     });
 *
 *     E2E_CLIP=1 ./client/node_modules/.bin/playwright test -g "RECAPTURE-01"
 */
import { chromium, type BrowserContextOptions, type Page } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { misuraWebmFile, type MisuraWebm } from "./webm-duration";

/** Il tetto del protocollo board per un'anteprima video. */
export const CLIP_BUDGET_MS = 20_000;

/** Il checkout a cui appartiene questo file, come in `test-server.ts`. */
const CHECKOUT_ROOT = resolve(__dirname, "../../..");

/** `videos/` è già gitignored per i .webm: le clip non entrano nella storia. */
const DIR_CLIP = join(CHECKOUT_ROOT, "videos", "clip");

export const isClipRun = (): boolean => process.env.E2E_CLIP === "1";

export interface OptionsClip {
  /** Nome del file finale, senza estensione. */
  nome: string;
  /** Tetto della clip. Oltre, `clipDiConsegna` alza. */
  budgetMs?: number;
  /** Dove finisce il .webm. Default `videos/clip/`. */
  dir?: string;
  /**
   * Opzioni del contesto. Il contesto è nostro, quindi NON eredita niente dal
   * `use` di `playwright.config.ts`: `baseURL`, `locale` e `viewport` vanno
   * passati, o la clip gira su un'app in inglese a 1280x720.
   */
  context?: BrowserContextOptions;
  /** Setup: gira su una pagina il cui video viene buttato. */
  prologo?: (page: Page) => Promise<void>;
  /** Il tratto utile: gira sulla pagina il cui video si tiene. */
  scena: (page: Page) => Promise<void>;
  /** Default headless, come il resto della suite. */
  headless?: boolean;
}

export interface Clip {
  /** Path assoluto del .webm. */
  path: string;
  durataMs: number;
  budgetMs: number;
  /** Da dove esce la durata (vedi `webm-duration.ts`). */
  fonte: MisuraWebm["fonte"];
  /** Quanto è durata la scena a orologio: se diverge molto dal video, guarda. */
  muroMs: number;
}

/**
 * Esegue prologo e scena in un contesto dedicato e, sotto `E2E_CLIP=1`,
 * consegna il .webm della sola scena. Ritorna `null` quando non registra.
 */
export async function clipDiConsegna(opts: OptionsClip): Promise<Clip | null> {
  const registra = isClipRun();
  const budgetMs = opts.budgetMs ?? CLIP_BUDGET_MS;
  const dirFinale = opts.dir ?? DIR_CLIP;
  const destinazione = join(dirFinale, `${opts.nome}.webm`);
  const temporaryDir = join(dirFinale, `.grezzo-${opts.nome}-${process.pid}-${Date.now()}`);

  // Vedi il punto 1 del docstring: `slowMo` sta sul browser, non sul contesto.
  const browser = await chromium.launch({ headless: opts.headless ?? true });

  const viewport = opts.context?.viewport ?? undefined;
  const context = await browser.newContext({
    ...opts.context,
    ...(registra
      ? { recordVideo: { dir: temporaryDir, ...(viewport ? { size: viewport } : {}) } }
      : {}),
  });

  let errorScene: unknown = null;
  let muroMs = 0;
  let video: ReturnType<Page["video"]> = null;

  try {
    if (opts.prologo) {
      const paginaPrologo = await context.newPage();
      try {
        await opts.prologo(paginaPrologo);
      } finally {
        // Chiudere qui è ciò che chiude anche il SUO video: il file resta nella
        // cartella temporanea e sparisce con lei.
        await paginaPrologo.close();
      }
    }

    const pagina = await context.newPage();
    video = pagina.video();
    const t0 = Date.now();
    try {
      await opts.scena(pagina);
    } finally {
      muroMs = Date.now() - t0;
    }
  } catch (e) {
    errorScene = e;
  }

  // `close()` finalizza i video: prima di qui il .webm sul disco è troncato.
  await context.close().catch(() => {});

  let salvata = false;
  if (registra && video) {
    try {
      mkdirSync(dirname(destinazione), { recursive: true });
      if (existsSync(destinazione)) unlinkSync(destinazione);
      await video.saveAs(destinazione);
      salvata = true;
    } catch (e) {
      if (!errorScene) errorScene = e;
    }
  }

  await browser.close().catch(() => {});
  rmSync(temporaryDir, { recursive: true, force: true });

  // L'errore della scena viene PRIMA del cancello sul tempo: un test rotto non
  // va rietichettato come «clip troppo lunga».
  if (errorScene) throw errorScene;
  if (!registra || !salvata) return null;

  const misura = misuraWebmFile(destinazione);
  const clip: Clip = {
    path: destinazione,
    durataMs: misura.ms,
    budgetMs,
    fonte: misura.fonte,
    muroMs,
  };

  const secondi = (ms: number) => (ms / 1000).toFixed(1);
  // eslint-disable-next-line no-console -- è l'unico canale con cui il path arriva a chi ha lanciato il test
  console.log(
    `[clip] ${opts.nome}: ${secondi(clip.durataMs)}s (fonte ${clip.fonte}, ` +
      `tetto ${secondi(budgetMs)}s, scena a orologio ${secondi(muroMs)}s)\n` +
      `[clip] ${destinazione}`,
  );

  if (clip.durataMs > budgetMs) {
    throw new Error(
      `Clip «${opts.nome}» fuori budget: ${secondi(clip.durataMs)}s contro un tetto di ${secondi(budgetMs)}s. ` +
        `Il file è su disco (${destinazione}): accorcia la SCENA — una pausa di lettura di troppo, ` +
        `un'attesa che poteva stare nel prologo — invece di tagliare il video dopo.`,
    );
  }
  return clip;
}
