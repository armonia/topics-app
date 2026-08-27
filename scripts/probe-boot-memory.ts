#!/usr/bin/env bun
/**
 * IL PICCO DI MEMORIA DEL BOOT, con una soglia che può dire di no.
 *
 * PERCHÉ ESISTE. Il 2026-08-19 il server di produzione mostrava
 * `phys_footprint` 936 MB con picco 2,4 GB, contro una heap JS di 52 MB: il
 * numero che ha prodotto la segnalazione «1,8 GB» non descriveva memoria viva.
 * Due difetti distinti, misurati separatamente:
 *
 *   · le pagine dei picchi, swappate e mai restituite → `server/lib/idle-gc.ts`
 *   · il picco stesso, tutto nei primi diciotto secondi di boot: una `.all()`
 *     che materializzava 8.354 righe per **706 MB** per trovarne quattro
 *     (`finalizeOrphanedRunningTools`, ora `iterate()`).
 *
 * Sistemati, il picco è passato da **2,6 GB a 362 MB**. Senza un cancello quel
 * numero è un aneddoto: la prossima `.all()` su `messages` lo riporta su e
 * nessun test diventa rosso, perché ogni test funzionale passa lo stesso —
 * il difetto non sbagliava una risposta, la pagava troppo.
 *
 * COME MISURA, e perché non basta guardare la produzione. Un server di
 * produzione ha un'età: il suo picco è il massimo di tutto quello che gli è
 * successo, non il costo dell'avvio. Qui si AVVIA un server nuovo, isolato
 * (`TOPICS_HOME` e `DATA_DIR` suoi, porta effimera: non tocca la produzione,
 * non ne prende il lock) su una COPIA del DB reale — perché il difetto scala
 * col database, e su un DB vuoto non si vedrebbe affatto.
 *
 * E la metrica è `phys_footprint (peak)`, letta con `vmmap`: è il massimo che
 * il processo ha davvero toccato, che è precisamente la domanda. L'RSS
 * istantaneo campionato ogni tanto se lo perderebbe — il picco dura secondi.
 *
 *   bun run scripts/probe-boot-memory.ts [--db PERCORSO] [--tetto MB]
 *
 * Esce 0 dentro il tetto, 1 fuori, 2 se non ha potuto misurare (niente DB,
 * niente vmmap, server che non parte) — chi non sa non deve poter dire «verde».
 *
 * PERCHE' `probe:` E NON `check:`, che e' come era nato. Un `check:*` in questo
 * repo promette di essere un cancello del CODICE, eseguibile in CI; il test
 * `tests/unit/check-scripts-are-wired.test.ts` lo pretende e mi ha preso in
 * fallo appena l'ho aggiunto. Questa sonda non puo' esserlo per costruzione:
 * vuole `vmmap` (solo macOS) e soprattutto un DATABASE VERO — `data/topics.db`
 * e' in `.gitignore` e su un checkout di CI non esiste, e su un DB vuoto il
 * difetto che misura non si vede affatto. Sarebbe verde per il motivo
 * sbagliato, che e' il modo piu' comune in cui un cancello smette di guardare
 * senza che nessuno se ne accorga. Il prefisso e' il posto dove si dichiara
 * quale delle due cose si e'.
 */
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const RADICE = join(import.meta.dir, "..");
const DB = arg("db", join(RADICE, "data", "topics.db"));

/**
 * Il tetto. Misurato 362 MB col rimedio in piedi e 2,6 GB senza, su un DB di
 * 888 MB: 600 sta largo sopra la misura buona e lontanissimo sotto quella
 * cattiva, cioè non si accende per il rumore di una macchina carica e non si
 * fa sfuggire un ritorno del difetto. Un tetto che non lascia respiro diventa
 * rosso per motivi che non sono il difetto, e allora si impara a ignorarlo.
 */
const CAP_MB = Number(arg("tetto", "600"));
/** Oltre questo il server non sta bootando: sta facendo altro, o è morto. */
const WAIT_MAX_S = 90;

function esci(codice: number, msg: string): never {
  console.log(msg);
  process.exit(codice);
}

if (!existsSync(DB)) {
  esci(2, `[boot-memory] nessun DB da misurare in ${DB} — questo cancello vuole un database VERO (il difetto scala con la sua taglia)`);
}
if (spawnSync("which", ["vmmap"]).status !== 0) {
  esci(2, "[boot-memory] `vmmap` non c'è (non-macOS?) — non si misura, e non si dichiara verde");
}

const casa = join(tmpdir(), `topics-bootmem-${process.pid}`);
const dati = join(casa, "data");
mkdirSync(dati, { recursive: true });
mkdirSync(join(casa, "home"), { recursive: true });

console.log(`[boot-memory] copio il DB (${Math.round(Bun.file(DB).size / 1048576)} MB)…`);
copyFileSync(DB, join(dati, "topics.db"));

/** `phys_footprint (peak)` in MB, o null. */
function peakMB(pid: number): number | null {
  const r = spawnSync("/bin/bash", ["-lc", `vmmap -summary ${pid} 2>/dev/null | grep 'footprint (peak)'`], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/([\d.]+)([MGK])/);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : n);
}

const figlio = spawn("bun", ["run", "server.ts"], {
  cwd: RADICE,
  env: {
    ...process.env,
    TOPICS_HOME: join(casa, "home"),
    DATA_DIR: dati,
    PORT: "0", // porta effimera: non litiga con la produzione
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let bootFinito = false;
let uscita = "";
const guarda = (b: Buffer) => {
  uscita += b.toString();
  // Il boot è finito quando il server ha superato il setaccio dei parziali e
  // ha aperto la porta: da lì in poi il picco non cresce più per l'avvio.
  if (/Server running|listening on|partial sweep/i.test(uscita)) bootFinito = true;
};
figlio.stdout?.on("data", guarda);
figlio.stderr?.on("data", guarda);

let picco: number | null = null;
const scadenza = Date.now() + WAIT_MAX_S * 1000;
// Si campiona fitto: il picco dura secondi, e un campionamento lento lo manca.
while (Date.now() < scadenza) {
  await Bun.sleep(300);
  if (figlio.exitCode !== null) break;
  const p = peakMB(figlio.pid!);
  if (p !== null) picco = Math.max(picco ?? 0, p);
  // Dopo il segnale di boot si continua ancora un momento: le ultime
  // allocazioni dell'avvio arrivano subito dopo la riga di log.
  if (bootFinito && Date.now() > scadenza - (WAIT_MAX_S - 20) * 1000) break;
}

try { figlio.kill("SIGTERM"); } catch {}
await Bun.sleep(1500);
try { figlio.kill("SIGKILL"); } catch {}
try { rmSync(casa, { recursive: true, force: true }); } catch {}

if (picco === null) {
  console.log(uscita.split("\n").slice(-15).join("\n"));
  esci(2, "[boot-memory] non ho letto nessun picco — il server non è partito, o `vmmap` non ha risposto");
}

const verdetto = picco <= CAP_MB ? "DENTRO" : "FUORI";
console.log(`[boot-memory] picco di boot: ${picco} MB · tetto ${CAP_MB} MB → ${verdetto}`);

if (picco > CAP_MB) {
  esci(1, [
    "",
    "Il boot ha toccato più memoria di quanta gliene sia concessa.",
    "",
    "La causa già vista una volta: un `.all()` su `messages` che materializza",
    "trenta giorni di righe (706 MB su questo DB) per trovarne quattro, con",
    "`decodeCol` che raddoppia decomprimendo. Si cerca lì: `.all()` su tabelle",
    "pesanti nel cammino di avvio → `iterate()`.",
    "",
    "Se invece il numero è legittimamente cresciuto, si alza il tetto NELLA",
    "STESSA modifica che lo giustifica, con la misura accanto.",
  ].join("\n"));
}
