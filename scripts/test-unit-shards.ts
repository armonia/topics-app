#!/usr/bin/env bun
/**
 * Esegue la suite `test:unit` COMPLETA in DUE FASI, mantenendo ESATTAMENTE la
 * copertura della corsa seriale (gli stessi 1148 file) in una frazione del
 * wall-clock.
 *
 * IL PROBLEMA (misurato 05/09/2026). `bun test` non ha parallelismo a livello di
 * file: esegue i file in sequenza in un solo processo. La barra di pre-review
 * gira `test:unit` a OGNI card, e serialmente costa ~462s nominali (~7,7 min) e
 * ~18 min sotto carico. Ma il grosso di quel tempo NON è CPU: sono ~121s di CPU
 * reale annegati in ~340s di attesa idle (i test client aspettano timer, gli
 * integration spawnano server e DB e aspettano I/O). Un solo processo lascia
 * 11 core fermi a guardare.
 *
 * PERCHÉ DUE FASI E NON UN POOL UNICO. `bun test` non isola i file dentro un
 * processo: singleton di modulo (`server/db` `_db`), `process.env`, e i global
 * DOM finti installati dai test PERDONO da un file all'altro. La suite è verde
 * solo nell'ORDINE seriale canonico; qualunque ri-raggruppamento espone quelle
 * perdite latenti. Due classi ci hanno morso davvero:
 *   1. ORDINE-DIPENDENZA — un fake `window`/`localStorage`/`document` parziale
 *      lasciato su `globalThis` ribalta le guardie `typeof window` dei file
 *      successivi (es. `useMobile` → `getComputedStyle is not defined`); un `_db`
 *      lasciato aperto fa no-op a `initDatabase` e salta le migration (→ "no
 *      such table"). Nel tier PARALLELO questa classe è stata chiusa alla radice:
 *      ogni test che monta un global lo smonta in `afterAll` (baseline di bun =
 *      nessun global DOM).
 *   2. RACE PER RISORSE OS — i test che spawnano daemon e corrono per un socket
 *      libero (`ai-bridge`) vanno in timeout sotto contesa CPU: 5 daemon che si
 *      contendono una porta con 4 shard che martellano i core non è più il test
 *      che volevi. Questa classe NON si "isola": è racing per costruzione.
 *
 * COSA FA.
 *   FASE 1 (parallela) — QUASI TUTTA la suite (tutto tranne i pochi racer OS
 *   della fase 2), divisa in N worker `bun test` CONCORRENTI bilanciati per
 *   durata (LPT). Misurato ordine-indipendente: 12 raggruppamenti shuffle × 4
 *   shard, 0 rossi, sia sul tier client sia su `server/**`+`tests/integration`.
 *   Il verdetto non dipende dal raggruppamento.
 *   FASE 2 (seriale) — SOLO i racer con asserzioni di tempistica (`ai-bridge*`,
 *   vedi SERIAL_GLOBS), in UN `bun test` DOPO la fase 1 così girano senza
 *   contesa CPU. Sono un pugno di file: la coda costa poco.
 *
 * IL VERDETTO è l'aggregato: verde solo se OGNI worker della fase 1 E la fase 2
 * sono verdi. Lo stdout/stderr di ogni fase rossa viene ristampato per intero,
 * così la barra vede QUALI test sono falliti.
 *
 * LE DURATE (`test-unit-durations.json`, tracciato in git come `e2e-durations.json`)
 * si riscrivono SOLO con `--record` (`bun run test:unit:durations`). Il cancello
 * puro le legge e basta: se le riscrivesse a ogni corsa, ogni worktree di agente
 * uscirebbe dal gate con un file modificato — e il controllo «tree pulito» o il
 * land se lo porterebbero dietro. Un file nuovo senza durata pesa la mediana.
 *
 * PERCHÉ È SICURO. (1) Gira dentro l'UNICO slot di `slot.ts` (label `test:unit`):
 * setta `TOPICS_GATE_HELD` sui worker, così il preload di bun (`bun-test-preload`)
 * NON li ri-accoda per un secondo slot — sono un solo slot logico, non N. (2) I
 * test integration che aprono porte reali usano porte libere + `APP_DATA_DIR`
 * isolate (guardia `global-setup-no-prod-paths.test.ts`), quindi due shard che
 * ne aprono insieme non collidono. (3) La rete di sicurezza resta la CI, che
 * gira `bun test:unit` SERIALE su main: questo script accorcia la corsa, non
 * allarga la fiducia — un raro flake da raggruppamento che sfuggisse ai 12
 * gruppi provati lo prende comunque la CI.
 *
 * QUANDO AGGIUNGERE UN FILE ALLA FASE 2. Solo se diventa flaky sotto parallelo
 * per una risorsa OS reale con asserzioni di tempistica (come `ai-bridge*`): si
 * aggiunge a `SERIAL_GLOBS`, la denylist è l'unica leva, il resto non cambia.
 * NON serializzare per prudenza: la fase 2 è wall-clock seriale, ogni file lì
 * allunga la corsa. La prova che un file NON serve in fase 2 è il repro
 * shuffle × shard verde (vedi la testata).
 *
 * USO
 *   bun run scripts/test-unit-shards.ts            # N = TOPICS_UNIT_SHARDS o 4
 *   TOPICS_UNIT_SHARDS=6 bun run scripts/test-unit-shards.ts
 * In produzione entra dalla barra come:
 *   bun run scripts/slot.ts test:unit -- 'bun run scripts/test-unit-shards.ts'
 */

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { GATE_HELD_ENV } from "./gate-slot.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DURATIONS_PATH = resolve(import.meta.dir, "test-unit-durations.json");

/**
 * Le radici che `test:unit` esegue (package.json). L'enumerazione DEVE combaciare
 * con quello che `bun test <root>` raccoglierebbe, o la corsa shardata coprirebbe
 * meno della seriale. Sotto queste radici esistono solo `*.test.ts`/`*.test.tsx`
 * (verificato: 1132 + 16), niente `.spec`/`.js`/`_test` — quindi il glob combacia.
 */
export const SUITE_ROOTS = [
  "client/src",
  "server",
  "shared",
  "relay",
  "tests/unit",
  "tests/integration",
  "scripts",
  "cli",
] as const;

/**
 * I file che DEVONO girare seriali in fase 2 (glob relativi a `cwd`). NON è più
 * "tutto il tier pesante": misurato il 05/09/2026, `server/**` +
 * `tests/integration/**` girano ordine-INDIPENDENTI su 12 raggruppamenti
 * shuffle × 4 shard (0 rossi) — la gran parte dei test server apre un
 * `new Database(":memory:")` proprio, non tocca il singleton `_db`. Quindi il
 * tier pesante va in fase 1 (parallela) come tutto il resto.
 *
 * Resta in fase 2 SOLO chi corre per una risorsa OS reale con asserzioni di
 * TEMPISTICA: `ai-bridge-singleton` spawna 5 daemon che si contendono un socket
 * e verifica che ne resti UNO solo in ascolto entro un deadline; sotto la
 * contesa CPU di N shard quel deadline salta (misurato: timeout a 15221ms >
 * 15s). Il socket è pid-scoped, quindi NON è una race cross-shard — è
 * real-time-sensibile. In fase 2, senza contesa, la tempistica tiene.
 * `ai-bridge` è la stessa famiglia (spawna il daemon mjs) e costa poco: sta con
 * lei. Chi diventa flaky sotto parallelo si aggiunge qui; il resto del codice
 * non cambia.
 */
export const SERIAL_GLOBS = [
  "server/ai-bridge-singleton.test.ts",
  "server/ai-bridge.test.ts",
] as const;

const TEST_GLOBS = ["**/*.test.ts", "**/*.test.tsx"] as const;

/** I file di test sotto le radici, come path relativi a `cwd`, ordinati e unici. */
export function enumerateTestFiles(roots: readonly string[], cwd: string): string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    for (const pattern of TEST_GLOBS) {
      const glob = new Bun.Glob(`${root}/${pattern}`);
      for (const rel of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
        seen.add(rel);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Divide i file nei due tier: `serial` (combacia una `SERIAL_GLOBS`) e `parallel`
 * (tutti gli altri). L'unione è esattamente `files`, così la copertura non cambia
 * mai per colpa della partizione.
 */
export function partitionTiers(
  files: string[],
  serialGlobs: readonly string[] = SERIAL_GLOBS,
): { parallel: string[]; serial: string[] } {
  const matchers = serialGlobs.map((g) => new Bun.Glob(g));
  const parallel: string[] = [];
  const serial: string[] = [];
  for (const f of files) {
    if (matchers.some((m) => m.match(f))) serial.push(f);
    else parallel.push(f);
  }
  return { parallel, serial };
}

/** Durate note (secondi per file), scritte dalla corsa precedente. {} se assenti. */
export function loadDurations(): Record<string, number> {
  if (!existsSync(DURATIONS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DURATIONS_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** LPT: dal più lento al più veloce, ognuno nel secchio finora meno carico. */
export function planShards(
  files: string[],
  durations: Record<string, number>,
  shards: number,
): Array<{ files: string[]; seconds: number }> {
  const known = files.map((f) => durations[f]).filter((d): d is number => typeof d === "number" && d > 0);
  const sortedKnown = [...known].sort((a, b) => a - b);
  const median = sortedKnown.length ? sortedKnown[Math.floor(sortedKnown.length / 2)] : 1;

  const weighted = files
    .map((file) => ({ file, seconds: durations[file] ?? median }))
    .sort((a, b) => b.seconds - a.seconds);

  const buckets = Array.from({ length: Math.max(1, shards) }, () => ({ files: [] as string[], seconds: 0 }));
  for (const { file, seconds } of weighted) {
    let lightest = 0;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].seconds < buckets[lightest].seconds) lightest = i;
    }
    buckets[lightest].files.push(file);
    buckets[lightest].seconds += seconds;
  }
  return buckets;
}

/**
 * Somma il `time` (secondi) di ogni `<testcase>` per `file`. Il `<testsuite file>`
 * ha `time="0"` a livello di file in bun, quindi la durata vera è la somma dei
 * testcase. Gli attributi possono essere in qualunque ordine (`time` prima di
 * `file`), quindi si estraggono indipendentemente dal tag.
 */
export function parseJunitDurations(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  const tagRe = /<testcase\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0];
    const file = /\bfile="([^"]*)"/.exec(tag)?.[1];
    const time = Number(/\btime="([^"]*)"/.exec(tag)?.[1]);
    if (!file || !Number.isFinite(time)) continue;
    out[file] = (out[file] ?? 0) + time;
  }
  return out;
}

/** Verde (0) solo se OGNI worker è verde; altrimenti il primo codice non-zero. */
export function aggregateVerdict(exitCodes: number[]): number {
  const failed = exitCodes.find((c) => c !== 0);
  return failed ?? 0;
}

// ── esecuzione di un gruppo di file in un processo `bun test` ─────────────────
interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  wallS: number;
  fileCount: number;
  measured: Record<string, number>;
}

/** Lancia UN processo `bun test` sui `files` dati e ne raccoglie esito+durate. */
async function runBunTest(
  files: string[],
  xmlPath: string,
  timeoutMs: number,
): Promise<RunResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(
    ["bun", "test", "--timeout", String(timeoutMs), "--reporter=junit", `--reporter-outfile=${xmlPath}`, ...files],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CI: "1",
        // Copre i figli con lo slot già tenuto da questo processo: il preload
        // di bun vede il marcatore e NON ri-accoda per un secondo slot.
        [GATE_HELD_ENV]: process.env[GATE_HELD_ENV] ?? "test-unit-shards",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let measured: Record<string, number> = {};
  try {
    if (existsSync(xmlPath)) measured = parseJunitDurations(readFileSync(xmlPath, "utf8"));
  } catch {
    /* xml incompleto: si tengono le durate vecchie per quei file */
  }
  return { code, stdout, stderr, wallS: (Date.now() - t0) / 1000, fileCount: files.length, measured };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const shardsN = Math.max(1, Number(process.env.TOPICS_UNIT_SHARDS) || 4);
  const timeoutMs = Number(process.env.TOPICS_TEST_TIMEOUT_MS) || 30000;

  const files = enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
  if (files.length === 0) {
    console.error("test-unit-shards: nessun file di test trovato sotto", SUITE_ROOTS.join(", "));
    process.exit(2);
  }

  const { parallel, serial } = partitionTiers(files);
  const durations = loadDurations();
  const xmlDir = mkdtempSync(join(tmpdir(), "topics-unit-shards-"));
  const started = Date.now();

  // ── FASE 1: quasi tutta la suite in N shard concorrenti ─────────────────────
  const N = Math.min(shardsN, Math.max(1, parallel.length));
  const buckets = planShards(parallel, durations, N).filter((b) => b.files.length > 0);
  const phase1 = await Promise.all(
    buckets.map((bucket, i) => runBunTest(bucket.files, join(xmlDir, `p1-shard-${i}.xml`), timeoutMs)),
  );

  // ── FASE 2: i racer ai-bridge seriali (dopo la fase 1: nessuna contesa CPU) ──
  const phase2 = serial.length
    ? await runBunTest(serial, join(xmlDir, "p2-serial.xml"), timeoutMs)
    : null;

  const totalWallS = (Date.now() - started) / 1000;

  // Ristampa per intero l'output di ogni fase rossa: la barra deve vedere QUALI
  // test sono falliti, non solo che una fase è rossa.
  const reds: Array<{ label: string; r: RunResult; files: readonly string[] }> = [];
  phase1.forEach((r, i) => { if (r.code !== 0) reds.push({ label: `fase1 shard ${i}`, r, files: buckets[i].files }); });
  if (phase2 && phase2.code !== 0) reds.push({ label: "fase2 seriale", r: phase2, files: serial });
  for (const { label, r, files: shardFiles } of reds) {
    console.error(`\n───── ${label} FALLITO (exit ${r.code}, ${r.fileCount} file, ${r.wallS.toFixed(1)}s) ─────`);
    if (r.stderr.trim()) console.error(r.stderr.trimEnd());
    if (r.stdout.trim()) console.error(r.stdout.trimEnd());
    // Un rosso che dipende dal RAGGRUPPAMENTO (un file che lascia un globale
    // sporco a quello dopo) si riproduce solo con la stessa lista nello stesso
    // ordine: il piano cambia a ogni corsa, quindi la lista si stampa qui o si
    // perde. Il 05/09 uno shard è uscito rosso su `getComputedStyle` e la
    // composizione dello shard non era più ricostruibile.
    console.error(`\nriproduci: bun test --timeout ${timeoutMs} ${shardFiles.join(" ")}`);
  }

  // Riepilogo.
  console.log("\n── test:unit shards (ibrido: fase1 parallela + fase2 seriale) ──");
  phase1.forEach((r, i) => {
    console.log(`  fase1 shard ${i}: ${r.code === 0 ? "ok " : "RED"}  ${r.fileCount} file  ${r.wallS.toFixed(1)}s`);
  });
  if (phase2) {
    console.log(`  fase2 seriale : ${phase2.code === 0 ? "ok " : "RED"}  ${phase2.fileCount} file  ${phase2.wallS.toFixed(1)}s`);
  }
  const codes = [...phase1.map((r) => r.code), ...(phase2 ? [phase2.code] : [])];
  const verdict = aggregateVerdict(codes);
  console.log(
    `  ${verdict === 0 ? "PASS" : "FAIL"}  ${files.length} file (${parallel.length} par / ${serial.length} ser) in ${N} shard  wall ${totalWallS.toFixed(1)}s` +
      (verdict === 0 ? "" : `  (exit ${verdict})`),
  );

  // Riscrive le durate misurate solo su richiesta (merge sulle vecchie: un file
  // mai raggiunto da questa corsa mantiene la stima precedente invece di sparire).
  if (process.argv.includes("--record")) {
    const merged: Record<string, number> = { ...durations };
    for (const r of [...phase1, ...(phase2 ? [phase2] : [])]) {
      for (const [f, s] of Object.entries(r.measured)) merged[f] = s;
    }
    try {
      writeFileSync(DURATIONS_PATH, JSON.stringify(sortKeys(merged), null, 0) + "\n");
      console.log(`  durate aggiornate: ${Object.keys(merged).length} file → ${DURATIONS_PATH}`);
    } catch {
      /* durate non critiche: la prossima corsa userà la mediana */
    }
  }

  rmSync(xmlDir, { recursive: true, force: true });
  process.exit(verdict);
}

/** Chiavi ordinate: il json delle durate resta un diff pulito fra le corse. */
function sortKeys(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
