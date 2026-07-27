#!/usr/bin/env bun
/**
 * Riepilogo unico degli shard E2E.
 *
 * Ogni shard di `e2e-shards.sh` scrive il suo `results.json`; qui li si rilegge
 * tutti e si stampa UNA lista dei falliti. Serve perché l'esito di un run
 * Playwright, letto dal terminale, è inaffidabile: l'exit code confonde
 * "test rosso" con "teardown andato storto", e il riepilogo finale viene mangiato
 * dalle sequenze ANSI del reporter `line`. Il JSON no: dice esattamente quale
 * test, in quale file, con quale errore.
 */

export {}; // top-level await → il file dev'essere un modulo

const shards = Number(process.argv[2] || 4);

type Spec = {
  title: string;
  file: string;
  line: number;
  ok: boolean;
  tests: Array<{
    status: string; // "expected" | "unexpected" | "flaky" | "skipped"
    results: Array<{ error?: { message?: string } }>;
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
let passed = 0;
let skipped = 0;
let missing = 0;

for (let i = 1; i <= shards; i++) {
  const path = `test-results/shard-${i}/results.json`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.log(`⚠️  shard ${i}: nessun results.json (${path}) — lo shard è morto prima di scriverlo`);
    missing++;
    continue;
  }
  const report = (await file.json()) as { suites?: Suite[] };
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
        } else {
          passed++;
        }
      }
    }
  }
}

console.log("═".repeat(78));
console.log(
  `E2E — ${passed} passati, ${failures.length} falliti, ${flaky.length} flaky, ${skipped} skippati (${shards} shard)`,
);
console.log("═".repeat(78));

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

if (missing) process.exit(1);
process.exit(failures.length ? 1 : 0);
