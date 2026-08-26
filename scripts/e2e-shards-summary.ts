#!/usr/bin/env bun
/**
 * One single summary of the E2E shards.
 *
 * Every shard of `e2e-shards.sh` writes its own JSON report; here they are all
 * read back and ONE list of the failures is printed. It is needed because the
 * outcome of a Playwright run, read off the terminal, is unreliable: the exit
 * code confuses "red test" with "teardown gone wrong", and the final summary
 * gets eaten by the ANSI sequences of the `line` reporter. The JSON does not:
 * it says exactly which test, in which file, with which error.
 *
 * TWO WAYS OF READING A RUN THAT IS NOT THERE, both of them seen:
 *
 * 1. The wrong place. Until 25/08 this script opened
 *    `test-results/shard-N/results.json`, which `e2e-shards.sh` no longer
 *    writes: it read files FIVE DAYS old and reported their reds with the same
 *    confidence as a fresh verdict. Measured: "500 passed, 1 failed" on a run
 *    that had just executed 1113 of them and had no reds at all.
 * 2. The surviving file. `$TMPDIR/topics-e2e-shards/` is NOT emptied between
 *    one run and the next: a shard that dies before writing leaves the report
 *    of the PREVIOUS run standing, and that one gets read as its own. Hence the
 *    comparison on the dates: a report much older than the most recent one is
 *    not a verdict, it is a leftover, and it counts among the broken shards.
 */

export {}; // top-level await -> the file has to be a module

const shards = Number(process.argv[2] || 4);
/** Where `e2e-shards.sh:41` writes. ONE single source, and no fallbacks: a fallback onto the old
 *  `test-results/shard-N/results.json` is exactly how a five-day-old run gets read as if it were
 *  the current one. Better to say "no report" than to answer with the archive. */
const OUT_DIR = process.env.E2E_SHARDS_OUT_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/topics-e2e-shards`;
/** Past this gap from the most recent report, a file belongs to a different run. */
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
    /** Where Playwright puts the reason given to `test.skip(cond, "why")`. */
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
 * THE SKIPPED ONES, WITH THEIR REASON.
 *
 * A `skipped` that is merely counted is the same lie as a dead shard, in
 * miniature: the final line stays green while a piece of the suite never ran,
 * and nobody knows what is missing. Measured on 18/08/2026: two dictation tests
 * driving the real microphone were skipping because the test server's only STT
 * key answers 401, and all the summary said was "2 skipped".
 *
 * The reason is already written down by whoever skips - `test.skip(cond, "why")`
 * ends up in the report annotations. All this does is NOT throw it away.
 */
const skips: Array<{ shard: number; spec: Spec; why: string }> = [];
/**
 * Shards that produced NO verdict: results.json missing, zero specs executed,
 * or a report-level error (globalSetup blowing up, a module that fails to
 * load). They have to be kept apart from red tests because the way they lie is
 * the opposite one: a red test gets counted, a dead shard **does not show up in
 * the counts at all** - and "244 passed, 0 failed" with two shards dead out of
 * four is the most reassuring line this script can print while half the suite
 * never ran. It is exactly the case seen locally on 30/07 (one shard with the
 * server past the timeout, one with the transform cache under contention). From
 * here on the problem goes in the FIRST line, not in a note after the counts.
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

  // Report-level errors: these are not red tests, they are the shard never
  // getting as far as executing. Playwright puts them here and the per-spec
  // counts do not see them.
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
  // First line = the problem. A count that looks green must never be the first
  // thing read when part of the suite did not run.
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
  // Grouped by reason: it is nearly always ONE environment cause stopping a
  // good number of them, and seeing it once says straight away what is missing
  // on this machine instead of making someone read N identical lines.
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
  // Grouped by file: the reds of this suite nearly always arrive in a cluster
  // from the same file (shared state), and seeing them together is what
  // distinguishes "a bug" from "a spec that dragged the state along with it".
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
