/**
 * LO SCREENCAST SU WEBKIT: NON C'E' IL CDP, E NON SERVE.
 *
 * La card bf04951a (migrazione del browser remoto a Playwright WebKit) nomina
 * un rischio preciso: «le parti che parlano CDP grezzo (screencast,
 * browser-cdp-port.ts, i target in browser-cdp-targets.json) su WebKit non
 * hanno lo stesso trasporto. Va guardato prima di iniziare: se un pezzo dipende
 * da CDP nudo, quello e' il lavoro vero, non lo switch».
 *
 * Questa sonda guarda, invece di dedurre. Due fatti misurati il 19/09/2026:
 *
 * 1. WebKit RIFIUTA il CDP, esplicitamente: `context.newCDPSession(page)`
 *    solleva «CDP session is only available in Chromium». Non e' un trasporto
 *    diverso da trovare, e' una porta che non esiste. Lo screencast di
 *    `browser-service.ts` (Page.startScreencast + screencastFrameAck) non si
 *    porta: si riscrive.
 *
 * 2. La strada alternativa REGGE, e con margine. Screenshot ripetuti, che e'
 *    l'unico modo su WebKit, stanno abbondantemente sopra il pavimento di
 *    BROWSER-CHAT-02 (15 FPS):
 *
 *      pagina viva, 1280x800 di default   67,1 FPS   16 KB/frame
 *      pagina DENSA con scroll a ogni frame  31,9 FPS  200 KB/frame
 *
 *    Per confronto, sullo stesso banco e sulla stessa macchina, Chromium con
 *    screenshot fa 3,9 FPS: WebKit e' 17x piu' veloce a produrre un fotogramma.
 *    Il suo screencast CDP e' piu' efficiente degli screenshot di Chromium, ma
 *    la domanda della card non e' quale sia il piu' elegante: e' se togliendo il
 *    CDP il budget regge. Regge.
 *
 * COSA NE SEGUE. Lo screencast smette di essere «il lavoro vero» che potrebbe
 * far saltare la card: e' una riscrittura contenuta con un budget verificato.
 * Restano da guardare gli altri consumatori di CDP nudo prima di impegnarsi -
 * sono cinque chiamate in due file (Runtime.evaluate, Storage.clearDataForOrigin,
 * Target.getTargetInfo, piu' le due dello screencast) - ma nessuno di quelli ha
 * la forma «stream continuo» che rendeva lo screencast il candidato a bloccare
 * tutto.
 *
 * IL KB/FRAME E' IL NUMERO DA TENERE D'OCCHIO, non gli FPS: 200 KB a fotogramma
 * su una pagina densa sono 6 MB/s a 30 FPS verso un telefono. Il budget di
 * BROWSER-CHAT-02 ha una q70 e un everyNthFrame proprio per questo, e la
 * riscrittura dovra' portarseli dietro: qui non sono stati applicati perche' la
 * domanda era un'altra.
 *
 *   WK_EXE=<pw_run.sh> bun run spike/browser-engine-alt/webkit-screencast.mjs
 *   FRAMES=10 ...   campione piu' corto
 *
 * DOVE GIRARLA. Su una macchina SCARICA. I numeri qui sopra sono stati presi
 * con load ~5; rilanciandola con load 14 il `launch` di WebKit si impianta e la
 * sonda non arriva in fondo. Non e' un difetto del motore ne' della misura: e'
 * la stessa ragione per cui la clip di consegna delle e2e si produce su un
 * runner e non qui (card 8d9e2ebc). Il primo fatto - il CDP rifiutato - si
 * misura comunque, perche' costa un solo launch.
 */
import { webkit, chromium } from "playwright-core";

const N = Number(process.env.FRAMES ?? 30);

/** Il CDP esiste su questo motore? La risposta e' il primo dei due fatti. */
async function provaCdp() {
  const b = await webkit.launch({ headless: true, executablePath: process.env.WK_EXE });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  let esito;
  try {
    await ctx.newCDPSession(page);
    esito = "ACCETTA (inatteso: la sonda va riletta)";
  } catch (err) {
    esito = `rifiuta - ${String(err.message).split("\n")[0]}`;
  }
  await b.close();
  return esito;
}

async function fps(nome, L, opts, contenuto, scroll) {
  const b = await L.launch({ headless: true, ...opts });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.setContent(contenuto);
  // Il primo frame paga il primo layout: si scarta lasciando assestare.
  await new Promise((r) => setTimeout(r, 600));
  let bytes = 0;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    if (scroll) await p.evaluate((n) => window.scrollTo(0, n * 37), i);
    bytes += (await p.screenshot({ type: "jpeg", quality: 70 })).length;
  }
  const ms = Date.now() - t0;
  await b.close();
  const f = N / (ms / 1000);
  console.log(
    `${nome.padEnd(26)} ${N} frame in ${(ms / 1000).toFixed(1)}s -> ${f.toFixed(1).padStart(5)} FPS | ${(bytes / N / 1024).toFixed(0).padStart(3)} KB/frame`,
  );
  return f;
}

const VIVA = "<body style='margin:0'><h1 id=t>0</h1><script>let i=0;setInterval(()=>{document.getElementById('t').textContent=++i},16)</script></body>";
const DENSA = `<body style="margin:0;font:13px system-ui">${Array.from(
  { length: 400 },
  (_, i) =>
    `<div style="padding:4px;background:linear-gradient(90deg,hsl(${i % 360} 70% 60%),#fff)">riga ${i} con del testo che occupa spazio e costringe a ridisegnare davvero</div>`,
).join("")}</body>`;

console.log(`newCDPSession su webkit: ${await provaCdp()}\n`);

const wkOpts = process.env.WK_EXE ? { executablePath: process.env.WK_EXE } : {};
const a = await fps("webkit, pagina viva", webkit, wkOpts, VIVA, false);
const b = await fps("webkit, densa + scroll", webkit, wkOpts, DENSA, true);
if (process.env.CH_EXE) {
  await fps("chromium, pagina viva", chromium, { executablePath: process.env.CH_EXE }, VIVA, false);
}

const PAVIMENTO = 15;
console.log(`\npavimento BROWSER-CHAT-02: ${PAVIMENTO} FPS`);
console.log(`webkit senza CDP: ${Math.min(a, b) >= PAVIMENTO ? "DENTRO" : "FUORI"} anche nel caso peggiore (${Math.min(a, b).toFixed(1)} FPS)`);
