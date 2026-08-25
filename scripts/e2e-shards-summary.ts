#!/usr/bin/env bun
/**
 * Riepilogo unico degli shard E2E.
 *
 * Ogni shard di `e2e-shards.sh` scrive il suo report JSON; qui li si rilegge
 * tutti e si stampa UNA lista dei falliti. Serve perché l'esito di un run
 * Playwright, letto dal terminale, è inaffidabile: l'exit code confonde
 * "test rosso" con "teardown andato storto", e il riepilogo finale viene mangiato
 * dalle sequenze ANSI del reporter `line`. Il JSON no: dice esattamente quale
 * test, in quale file, con quale errore.
 *
 * DUE MODI DI LEGGERE UNA CORSA CHE NON C'È, entrambi visti:
 *
 * 1. Il posto sbagliato. Fino al 25/08 questo script apriva
 *    `test-results/shard-N/results.json`, che `e2e-shards.sh` non scrive più:
 *    leggeva file di CINQUE GIORNI prima e ne riportava i rossi con la stessa
 *    sicurezza di un verdetto fresco. Misurato: «500 passati, 1 fallito» su una
 *    corsa che ne aveva appena eseguiti 1113 e nessun rosso.
 * 2. Il file sopravvissuto. `$TMPDIR/topics-e2e-shards/` NON si svuota fra una
 *    corsa e l'altra: uno shard che muore prima di scrivere lascia in piedi il
 *    report della corsa PRECEDENTE, e quello si legge come suo. Da qui il
 *    confronto sulle date: un report molto più vecchio del più recente non è un
 *    verdetto, è un residuo, e va contato fra gli shard rotti.
 */

export {}; // top-level await → il file dev'essere un modulo

const shards = Number(process.argv[2] || 4);
/** Dove `e2e-shards.sh:41` scrive. UNA sola sorgente, e senza ripieghi: un ripiego sul vecchio
 *  `test-results/shard-N/results.json` e' esattamente come si legge una corsa di cinque giorni fa
 *  credendola di adesso. Meglio dire «nessun report» che rispondere con l'archivio. */
const OUT_DIR = process.env.E2E_SHARDS_OUT_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/topics-e2e-shards`;
/** Oltre questo scarto dal report più recente, un file è di un'altra corsa. */
const STALE_MS = 30 * 60_000;

async function shardReport(i: number): Promise<{ path: string; mtimeMs: number } | null> {
  const path = `${OUT_DIR}/report-${i}.json`;
  const f = Bun.file(path);
  return (await f.exists()) ? { path, mtimeMs: f.lastModified } : null;
}

const found = await Promise.all(
  Array.from({ length: shards }, (_, k) => shardReport(k + 1)),
);
const newest = Math.max(0, ...found.filter(Boolean).map((f) => f!.mtimeMs));

type Spec = {
  title: string;
  file: string;
  line: number;
  ok: boolean;
  tests: Array<{
    status: string; // "expected" | "unexpected" | "flaky" | "skipped"
    results: Array<{ error?: { message?: string } }>;
    /** Dove Playwright mette il motivo di `test.skip(cond, "perche'")`. */
    annotations?: Array<{ type?: string; description?: string }>;
  }>;
};
type Suite = { specs?: Spec[]; suites?: Suite[] };

function collectSpecs(suite: Suite, out: Spec[] = []): Spec[] {
  for (const spec of suite.specs ?? []) out.push(spec);
  for (const child of suite.suites ?? []) collectSpecs(child, out);
  return out;
}

const failures: Array<{ shard: number; spec: Spec; message: string }> = [];
const flaky: Array<{ shard: number; spec: Spec }> = [];
/**
 * I SALTATI, CON IL LORO MOTIVO.
 *
 * Un `skipped` contato e basta e' la stessa bugia di uno shard morto, in
 * piccolo: la riga finale resta verde mentre un pezzo di suite non ha girato, e
 * nessuno sa che cosa manchi. Misurato il 18/08/2026: due test della dettatura
 * col microfono vero saltavano perche' l'unica chiave STT del server di test
 * risponde 401, e dal riepilogo si leggeva soltanto «2 skippati».
 *
 * Il motivo lo scrive gia' chi salta — `test.skip(cond, "perche'")` finisce
 * nelle annotazioni del report. Qui si limita a NON buttarlo via.
 */
const skips: Array<{ shard: number; spec: Spec; why: string }> = [];
/**
 * Shard che NON hanno prodotto un verdetto: results.json assente, zero spec
 * eseguite, o un errore a livello di report (globalSetup che esplode, un modulo
 * che non si carica). Vanno tenuti separati dai test rossi perché il modo in cui
 * mentono è opposto: un test rosso si conta, uno shard morto **non compare nei
 * conteggi affatto** — e "244 passati, 0 falliti" con due shard morti su quattro
 * è la riga più rassicurante che questo script possa stampare mentre metà suite
 * non ha girato. È esattamente il caso visto in locale il 30/07 (uno shard col
 * server oltre il timeout, uno con la cache di trasformazione in contesa). Da qui
 * in poi il problema sta nella PRIMA riga, non in una nota dopo i conteggi.
 */
const brokenShards: Array<{ shard: number; why: string; detail?: string }> = [];
let passed = 0;
let skipped = 0;

for (let i = 1; i <= shards; i++) {
  const hit = found[i - 1];
  if (!hit) {
    brokenShards.push({ shard: i, why: `nessun report in ${OUT_DIR}/report-${i}.json — non ancora scritto, o morto prima` });
    continue;
  }
  if (newest - hit.mtimeMs > STALE_MS) {
    const eta = Math.round((newest - hit.mtimeMs) / 60_000);
    brokenShards.push({
      shard: i,
      why: `report di un'ALTRA corsa (${eta} min più vecchio del più recente) — questo shard non ha scritto`,
      detail: hit.path,
    });
    continue;
  }
  const path = hit.path;
  const file = Bun.file(path);
  const report = (await file.json()) as { suites?: Suite[]; errors?: Array<{ message?: string }> };

  // Errori a livello di report: non sono test rossi, sono lo shard che non è mai
  // arrivato a eseguire. Playwright li mette qui e i conteggi per-spec non li
  // vedono.
  const reportErrors = report.errors ?? [];
  const specCount = (report.suites ?? []).reduce((n, s) => n + collectSpecs(s).length, 0);
  if (reportErrors.length || specCount === 0) {
    brokenShards.push({
      shard: i,
      why: reportErrors.length
        ? `${reportErrors.length} errore/i di report, ${specCount} spec eseguite`
        : "0 spec eseguite",
      detail: (reportErrors[0]?.message ?? "").split("\n")[0].slice(0, 200) || undefined,
    });
  }

  for (const suite of report.suites ?? []) {
    for (const spec of collectSpecs(suite)) {
      for (const test of spec.tests) {
        if (test.status === "unexpected") {
          const message =
            test.results.find((r) => r.error?.message)?.error?.message ?? "(nessun messaggio)";
          failures.push({ shard: i, spec, message: message.split("\n")[0].slice(0, 200) });
        } else if (test.status === "flaky") {
          flaky.push({ shard: i, spec });
          passed++;
        } else if (test.status === "skipped") {
          skipped++;
          const why = (test.annotations ?? [])
            .filter((a) => a.type === "skip" || a.type === "fixme")
            .map((a) => a.description)
            .find((d) => !!d);
          skips.push({ shard: i, spec, why: why ?? "(nessun motivo dichiarato)" });
        } else {
          passed++;
        }
      }
    }
  }
}

const reporting = shards - brokenShards.length;

console.log("═".repeat(78));
if (brokenShards.length) {
  // Prima riga = il problema. Un conteggio che sembra verde non deve mai essere
  // la prima cosa che si legge quando parte della suite non ha girato.
  console.log(
    `E2E — INCOMPLETO: ${brokenShards.length}/${shards} shard non hanno eseguito test ` +
      `(i conteggi sotto coprono solo ${reporting}/${shards} shard)`,
  );
} else {
  console.log(
    `E2E — ${passed} passati, ${failures.length} falliti, ${flaky.length} flaky, ${skipped} skippati (${shards} shard)`,
  );
}
console.log("═".repeat(78));

if (brokenShards.length) {
  console.log("\nSHARD SENZA VERDETTO (non è un test rosso: è suite che NON ha girato):");
  for (const { shard, why, detail } of brokenShards) {
    console.log(`  · shard ${shard}: ${why}`);
    if (detail) console.log(`    ${detail}`);
    console.log(`    log: ${OUT_DIR}/shard-${shard}.log`);
  }
  console.log(
    "\n  Quasi sempre è contesa fra shard sulla stessa macchina (server di test oltre\n" +
      "  il timeout, cache di trasformazione in corsa). Riprova quello shard da solo per\n" +
      "  distinguerla da un rosso vero:\n" +
      `    E2E_PORT=13340 npx playwright test --shard=<i>/${shards}`,
  );
  console.log(
    `\n  Conteggi parziali (${reporting}/${shards} shard): ${passed} passati, ` +
      `${failures.length} falliti, ${flaky.length} flaky, ${skipped} skippati`,
  );
}

if (skips.length) {
  console.log("\nSALTATI (non hanno girato — il motivo lo dice il test stesso):");
  // Raggruppati per motivo: quasi sempre e' UNA causa d'ambiente che ne ferma
  // parecchi, e vederla una volta sola dice subito che cosa manca su questa
  // macchina invece di far leggere N righe uguali.
  const perMotivo = new Map<string, typeof skips>();
  for (const s of skips) {
    if (!perMotivo.has(s.why)) perMotivo.set(s.why, []);
    perMotivo.get(s.why)!.push(s);
  }
  for (const [why, list] of [...perMotivo.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${list.length}× ${why}`);
    for (const s of list) console.log(`      · ${s.spec.file}:${s.spec.line} — ${s.spec.title}`);
  }
}

if (flaky.length) {
  console.log("\nFLAKY (passati al retry — vanno comunque guardati):");
  for (const { shard, spec } of flaky) {
    console.log(`  [${shard}] ${spec.file}:${spec.line} — ${spec.title}`);
  }
}

if (failures.length) {
  console.log("\nFALLITI:");
  // Raggruppati per file: i rossi di questa suite arrivano quasi sempre a
  // grappolo dallo stesso file (stato condiviso), e vederli insieme è ciò che
  // distingue "un bug" da "una spec che si è portata dietro lo stato".
  const byFile = new Map<string, typeof failures>();
  for (const f of failures) {
    if (!byFile.has(f.spec.file)) byFile.set(f.spec.file, []);
    byFile.get(f.spec.file)!.push(f);
  }
  for (const [file, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${file}  (${list.length})`);
    for (const f of list) {
      console.log(`    · [shard ${f.shard}] ${f.spec.title}`);
      console.log(`      ${f.message}`);
    }
  }
}

process.exit(failures.length || brokenShards.length ? 1 : 0);
