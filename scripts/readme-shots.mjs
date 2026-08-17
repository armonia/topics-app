/**
 * Screenshot del README da un'installazione DIMOSTRATIVA, incorniciati.
 *
 * ── PERCHE' NON DAL SERVER DI PRODUZIONE ───────────────────────────────────
 * Ci ho provato, e ha funzionato: Playwright apre la stessa UI e non chiede il
 * permesso «Registrazione Schermo» che la cattura di sistema pretende. Poi ho
 * guardato l'immagine prima di pubblicarla e conteneva una PASSWORD IN CHIARO
 * nell'output di un turno, piu' host interni e nomi di clienti. Su un repo
 * pubblico sarebbe finita nella storia di git, dove non si torna indietro.
 *
 * Quindi si scatta contro un DATA_DIR usa-e-getta: dati veri di
 * un'installazione vera, solo non della tua.
 *
 * ── LA CORNICE ─────────────────────────────────────────────────────────────
 * Uno screenshot grezzo appiccicato in un README sembra un ritaglio, non un
 * prodotto: si fonde col bianco della pagina e non ha un bordo dove finire.
 * Qui la UI viene INCORNICIATA nel browser prima dello scatto — angoli
 * arrotondati, un bordo appena percettibile, un'ombra ampia e uno sfondo a
 * gradiente sotto — cosi' l'immagine e' gia' finita e non serve un editor.
 *
 * Si fa in una pagina a parte che carica l'app in un `iframe`: l'alternativa
 * (iniettare stile dentro l'app) cambierebbe cio' che si sta fotografando, ed
 * e' il modo classico di pubblicare uno screenshot di qualcosa che non esiste.
 *
 * ── PERCHE' NON `screencapture` ────────────────────────────────────────────
 * Oltre al permesso, il viewport: qui e' FISSO, quindi due esecuzioni a mesi di
 * distanza producono immagini confrontabili invece di due finestre a caso.
 *
 * USO
 *   DATA_DIR=/tmp/topics-demo BUN_PORT=39520 ./scripts/start-test-server.sh &
 *   bun scripts/readme-shots.mjs https://127.0.0.1:39520
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.argv[2] ?? "https://127.0.0.1:39520";
// DOVE SCRIVE, e perche' non sulle immagini pubblicate.
//
// Due volte uno scatto nuovo e' uscito PEGGIORE di quello gia' su GitHub: la
// prima con gli agenti a lavoro finito e un riquadro d'errore al posto dei
// cronometri, la seconda con tre card «non consegnato». L'app e' viva, quindi
// ogni ri-scatto e' un'immagine NUOVA, non la stessa immagine piu' bella.
//
// Percio' il default scrive in una cartella di lavoro e le immagini vive si
// toccano solo con `--publish`, dopo aver GUARDATO cosa e' uscito.
const PUBLISH = process.argv.includes("--publish");
const OUT = PUBLISH
  ? join(process.cwd(), "landing", "public", "img")
  : join(process.cwd(), "landing", "public", "img", "_new");
mkdirSync(OUT, { recursive: true });
if (!PUBLISH) console.log("scrivo in _new/ — guarda le immagini, poi rilancia con --publish\n");

// L'app: 1440x900 e' la dimensione a cui una schermata resta leggibile dentro
// la colonna di un README. Attorno, 64px di aria per far respirare l'ombra.
const APP = { w: 1440, h: 900 };
const PAD = 72;

/** La pagina che fa da cornice. L'app vive nell'iframe, intatta. */
const frameHtml = (src) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body { margin:0; padding:0; background:#000; }
  .stage {
    position:relative; overflow:hidden;
    width:${APP.w + PAD * 2}px; height:${APP.h + PAD * 2}px;
    display:grid; place-items:center;
    background:#0b0d12;
  }
  /* LO SFONDO SI DEVE VEDERE. La prima versione usava aloni a #1e2740 su
     #0b0d12: differenza di luminosita' troppo piccola, e su un monitor non
     calibrato spariva del tutto — restava un rettangolo nero attorno a una
     finestra nera. Qui i due aloni sono saturi e sfocati per davvero
     (filter: blur), quindi il colore si legge ma non compete con la UI. */
  .stage::before {
    content:""; position:absolute; inset:-20%;
    background:
      radial-gradient(38% 46% at 22% 18%, #3d5bd9 0%, transparent 70%),
      radial-gradient(42% 48% at 82% 88%, #7c3aed 0%, transparent 70%),
      radial-gradient(30% 34% at 92% 12%, #0ea5e9 0%, transparent 70%);
    filter: blur(72px);
    opacity:.55;
  }
  .win, .stage > * { position:relative; z-index:1; }
  /* L'ANELLO DI VETRO. Un filter:blur sullo sfondo sfoca il fondo e basta;
     backdrop-filter sfoca cio' che sta DIETRO un elemento semi-trasparente,
     ed e' l'effetto che si vede nelle finestre di sistema. Qui e' una cornice
     spessa attorno alla UI: il colore del fondo la attraversa sfocato, e la
     finestra sembra appoggiata sopra invece che incollata. */
  .glass {
    padding:18px; border-radius:26px;
    background:rgba(255,255,255,.07);
    -webkit-backdrop-filter: blur(24px) saturate(140%);
    backdrop-filter: blur(24px) saturate(140%);
    border:1px solid rgba(255,255,255,.14);
    box-shadow: 0 2px 8px rgba(0,0,0,.45), 0 40px 110px rgba(0,0,0,.70);
  }
  .win {
    width:${APP.w}px; height:${APP.h}px;
    border-radius:12px; overflow:hidden;
    border:1px solid rgba(255,255,255,.10);
  }
  iframe { width:100%; height:100%; border:0; display:block; }
</style></head>
<body><div class="stage"><div class="glass"><div class="win">
  <iframe src="${src}"></iframe>
</div></div></div></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: APP.w + PAD * 2, height: APP.h + PAD * 2 },
  deviceScaleFactor: 1.5,        // nitido su schermi densi senza i 600 KB a immagine di @2x
  ignoreHTTPSErrors: true,       // il server di prova ha un certificato suo
  colorScheme: "dark",
});
const page = await ctx.newPage();

/** Scatta la cornice intera. `stage` include l'aria, quindi l'ombra non viene tagliata.
 *  JPEG di qualita' alta: un PNG della stessa scena pesa tre volte tanto, e in un
 *  README il peso e' la prima cosa che paga chi ha una connessione lenta. */
async function shoot(name) {
  await page.locator(".stage").screenshot({ path: join(OUT, name), scale: "device", quality: 88, type: "jpeg" });
  console.log("scattato:", join(OUT, name));
}

/** L'app dentro l'iframe: ci si parla via frameLocator, non via page. */
const app = () => page.frameLocator("iframe");

await page.setContent(frameHtml(BASE), { waitUntil: "domcontentloaded" });

// Niente animazioni: un'immagine presa a meta' di una transizione ha bordi
// sfocati e opacita' intermedie, ed e' il difetto che si nota senza saperlo
// nominare. Va iniettato DENTRO l'iframe, non nella cornice.
const killMotion = `*,*::before,*::after{animation-duration:0s!important;
  animation-delay:0s!important;transition-duration:0s!important;
  transition-delay:0s!important;caret-color:transparent!important}`;

await app().locator("body").waitFor({ timeout: 20000 });
await page.waitForTimeout(6000);
await page.frames()[1]?.addStyleTag({ content: killMotion }).catch(() => {});

// 1. La chat: aprire un topic, non fotografare la schermata di benvenuto. Il
// primo tentativo mostrava «Welcome to Topics — select a topic to start»:
// tecnicamente l'app, in pratica la sua stanza vuota.
const topic = app().getByText("topics-app", { exact: false }).first();
if (await topic.count()) {
  await topic.click();
  await page.waitForTimeout(4000);
}
await shoot("readme-topics.jpg");

// 2. La board. Se il tab non c'e' non si scatta: un'immagine sbagliata e'
// peggio di una mancante, perche' quella mancante si nota.
const board = app().getByText("Board", { exact: false }).first();
if (await board.count()) {
  await board.click();
  await page.waitForTimeout(4000);
  await shoot("readme-board.jpg");
} else {
  console.warn("tab Board non trovato: nessuna seconda immagine");
}

// 3. La sidebar di progetto (file, Git changes), per la landing. Le immagini
// sul sito mostrano ancora un prodotto finto («acme-api»): finche' ci sono, le
// due facce pubbliche del progetto si contraddicono.
//
// Si passa dal topic, non dalla board: «Git changes» vive nella sidebar di
// progetto, e quella sidebar esiste solo dentro un topic con un progetto
// collegato. Cercare un tab «Git» non trovava niente.
const topicAgain = app().getByText("topics-app", { exact: false }).first();
if (await topicAgain.count()) {
  await topicAgain.click();
  await page.waitForTimeout(2500);
  const git = app().getByText(/git changes/i).first();
  if (await git.count()) {
    await git.click();
    await page.waitForTimeout(3000);
    await shoot("landing-git.jpg");
  } else {
    console.warn("«Git changes» non trovato: nessuna immagine git per la landing");
  }
}

await browser.close();
