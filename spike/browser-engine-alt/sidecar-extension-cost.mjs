/**
 * QUANTO COSTA AVVIARE IL SIDECAR, PER NUMERO DI ESTENSIONI.
 *
 * La card 2e8bf921 chiedeva di ridurre i 219 MB per pane del sidecar caricando
 * solo le estensioni scelte, e diceva: prima di scrivere UI, misura headful+42,
 * headful+0 e headless+0, perche' se il salto e' fra headless e headful le
 * estensioni non sono la leva.
 *
 * La misura ha trovato altro, e prima: CON 42 ESTENSIONI IL SIDECAR CI METTE
 * 288 SECONDI AD AVVIARSI, e la produzione lo aspetta per dieci. Il consumo per
 * pane, che era la domanda della card, e' una domanda che viene dopo: con
 * questa configurazione il sidecar non arriva vivo fino a li'.
 *
 * MISURATO il 18/09/2026, macchina a 5,8 GB liberi e load 4,9 (non sotto
 * pressione: la stessa scala sotto carico sarebbe un aneddoto). Chromium 1217
 * di Playwright, gli args VERI di `defaultLauncher()` in
 * server/browser-chromium-sidecar.ts:
 *
 *     headless  ext= 0   CDP ok  in   1,5 s
 *     headful   ext= 0   CDP ok  in   1,8 s
 *     headful   ext= 1   CDP ok  in   2,4 s
 *     headful   ext= 5   CDP ok  in  28,8 s
 *     headful   ext=42   CDP ok  in 288,0 s
 *
 * LA CRESCITA NON E' LINEARE e il confronto che conta e' con l'attesa vera:
 * `waitForCdpEndpoint` in produzione aspetta DIECI SECONDI. A cinque estensioni
 * l'avvio ne prende gia' 28, a quarantadue quasi cinque minuti: il lancio del
 * sidecar fallisce, e non per un caso limite, per la configurazione di default
 * di questa macchina.
 *
 * E il fallimento non e' pulito. Il profilo del sidecar e' FISSO, e il
 * `child.kill()` del ramo di errore uccide il capostipite, non l'albero che
 * Chromium ha gia' generato: il residuo tiene il profilo e fa fallire anche il
 * tentativo successivo. Durante questa misura ho trovato dieci processi
 * `Chrome for Testing` orfani con ppid 1, dei miei stessi lanci.
 *
 * NOTA DI METODO, perche' la prima corsa ha mentito. Diceva «TIMEOUT in 317 s»
 * con una deadline di 60: la `fetch` di sondaggio non aveva timeout suo e
 * restava appesa su un browser che stava installando estensioni, sforando il
 * ciclo che avrebbe dovuto contenerla. Con `AbortSignal.timeout(2000)` il
 * numero e' quello vero, ed e' diverso: il CDP ARRIVA, dopo 288 secondi.
 * «Non parte» e «parte in cinque minuti» portano a due decisioni diverse.
 *
 * COSA NE SEGUE PER LA CARD. La UI per scegliere le estensioni resta utile, ma
 * non e' la prima cosa: gia' a CINQUE si sfora l'attesa di produzione, quindi
 * una selezione generosa ricade nello stesso muro. Le due cose da fare prima
 * sono che il sidecar non le carichi tutte per default, e che il ramo di errore
 * uccida l'ALBERO invece del solo capostipite.
 *
 *   bun run spike/browser-engine-alt/sidecar-extension-cost.mjs
 *   LADDER=0,1,5,42 ...   per cambiare i gradini
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { chromium } from "playwright-core";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function installedExtensionPaths() {
  const m = await import("../../server/browser-chromium-extensions.ts");
  return m.discoverInstalledExtensions().map((e) => e.path);
}

/**
 * Un avvio, con `n` estensioni. Ritorna quanto ci ha messo a esporre il CDP, o
 * il timeout: il numero che conta e' questo, non la memoria, perche' senza CDP
 * la memoria non si puo' nemmeno attribuire.
 */
async function bootWith(n, { port, headless, all, timeoutMs }) {
  const exts = all.slice(0, n);
  const dir = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), "sidecar-boot-"));
  // Copiati da `defaultLauncher()`: `--use-mock-keychain` compreso, senza il
  // quale ogni avvio apre il dialogo di autenticazione di macOS.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
  ];
  if (headless) args.push("--headless=new");
  if (exts.length > 0) {
    // `--disable-extensions-except` insieme a `--load-extension`: in un profilo
    // nuovo, senza il primo, Chromium le elenca e non le attiva, e la misura
    // direbbe zero per la ragione sbagliata.
    args.push(`--disable-extensions-except=${exts.join(",")}`);
    args.push(`--load-extension=${exts.join(",")}`);
  }
  const child = spawn(chromium.executablePath(), args, { stdio: "ignore" });
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < timeoutMs) {
    try {
      // Il timeout sulla singola fetch non e' pignoleria: senza, una richiesta
      // a un Chromium che sta installando 42 estensioni resta appesa oltre la
      // deadline del ciclo, e la prima corsa di questa sonda ha riportato
      // «TIMEOUT in 317s» con un limite di 60. Il tetto qui e' sul ciclo.
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok && (await r.json()).webSocketDebuggerUrl) { ok = true; break; }
    } catch { /* non ancora su */ }
    await sleep(200);
  }
  const ms = Date.now() - t0;
  try { child.kill(); } catch { /* gia' andato */ }
  await sleep(1500);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* andato */ }
  return { ok, ms };
}

const all = await installedExtensionPaths();
const ladder = (process.env.LADDER ?? "0,1,5,42").split(",").map(Number);
const TIMEOUT = Number(process.env.BOOT_TIMEOUT_MS ?? 60_000);

console.log(`estensioni installate sulla macchina: ${all.length}`);
console.log(`attesa massima per l'endpoint CDP: ${TIMEOUT / 1000}s`);
console.log(`(in produzione, server/browser-chromium-sidecar.ts, sono 10s)\n`);

let port = 47400;
const headlessBase = await bootWith(0, { port: port++, headless: true, all, timeoutMs: TIMEOUT });
console.log(`headless ext= 0  ${headlessBase.ok ? "CDP ok " : "TIMEOUT"} in ${(headlessBase.ms / 1000).toFixed(1)}s`);

for (const n of ladder) {
  const r = await bootWith(n, { port: port++, headless: false, all, timeoutMs: TIMEOUT });
  console.log(`headful  ext=${String(n).padStart(2)}  ${r.ok ? "CDP ok " : "TIMEOUT"} in ${(r.ms / 1000).toFixed(1)}s`);
  if (!r.ok) {
    console.log(`\n  ⇒ con ${n} estensioni il sidecar NON espone il CDP entro ${TIMEOUT / 1000}s.`);
    console.log(`    In produzione l'attesa e' 10s: qui il lancio fallisce, e il profilo`);
    console.log(`    fisso trattiene il residuo che fa fallire anche il tentativo dopo.`);
  }
}
