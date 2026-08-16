/**
 * Screenshot del README da un'installazione DIMOSTRATIVA.
 *
 * PERCHE' NON DAL SERVER VERO. Ci ho provato: la prima immagine conteneva una
 * PASSWORD IN CHIARO nell'output di un turno, piu' host interni e nomi di
 * clienti. Su un repo pubblico sarebbe finita nella storia di git, dove non si
 * torna indietro. Quindi si scatta contro un DATA_DIR usa-e-getta con topic
 * creati apposta: dati veri di un'installazione vera, solo non della tua.
 *
 * PERCHE' NON `screencapture`. La cattura di sistema chiede il permesso
 * «Registrazione Schermo», che un agente non puo' concedersi. Playwright apre
 * la stessa UI e in piu' fissa il viewport, quindi due esecuzioni a distanza di
 * mesi producono immagini confrontabili invece di due finestre a caso.
 *
 * USO
 *   DATA_DIR=/tmp/topics-demo BUN_PORT=39520 ./scripts/start-test-server.sh &
 *   bun scripts/readme-shots.mjs https://127.0.0.1:39520
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.argv[2] ?? "https://127.0.0.1:39520";
const OUT = join(process.cwd(), "landing", "public", "img");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  // 1440x900 a densita' 2: la proporzione che GitHub rende senza ritagliare,
  // e la dimensione a cui una schermata di app resta leggibile dentro una
  // colonna di README. Piu' larga e i caratteri diventano illeggibili.
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
  colorScheme: "dark",
});
const page = await ctx.newPage();

// Niente animazioni: un'immagine scattata a meta' di una transizione ha bordi
// sfocati e opacita' intermedie, ed e' il difetto che si nota senza saperlo
// nominare.
await page.addStyleTag({
  content: `*, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }`,
}).catch(() => {});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });

// Non `networkidle`: l'app tiene un WebSocket aperto, quindi la rete non e' mai
// inattiva e l'attesa scadrebbe sempre. Si aspetta il primo pezzo di UI vera.
await page.waitForSelector("body", { timeout: 15000 });
await page.waitForTimeout(5000);

// APRIRE UN TOPIC, non fotografare la schermata di benvenuto. Il primo scatto
// mostrava «Welcome to Topics — select a topic to start»: tecnicamente l'app,
// in pratica la sua stanza vuota. Chi guarda un README vuole vedere il
// prodotto mentre lavora.
const first = page.getByText("topics-app", { exact: false }).first();
if (await first.count()) {
  await first.click();
  await page.waitForTimeout(4000);
} else {
  console.warn("nessun topic da aprire: l'immagine mostrerebbe la stanza vuota");
}

await page.screenshot({ path: join(OUT, "readme-topics.png"), scale: "device" });
console.log("scattato:", join(OUT, "readme-topics.png"));

// La board, seconda immagine del README. Se il tab non c'e' si esce senza
// scattare: un'immagine sbagliata e' peggio di una mancante, perche' quella
// mancante si nota.
const board = page.getByText("Board", { exact: false }).first();
if (await board.count()) {
  await board.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(OUT, "readme-board.png"), scale: "device" });
  console.log("scattato:", join(OUT, "readme-board.png"));
} else {
  console.warn("tab Board non trovato: nessuna seconda immagine");
}

await browser.close();
