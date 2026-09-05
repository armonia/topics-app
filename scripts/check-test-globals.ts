#!/usr/bin/env bun
/**
 * CHI LASCIA UN GLOBALE DOM FINTO AL FILE DOPO.
 *
 * IL GUASTO. `bun test` fa girare tutti i file della corsa in UN processo: un
 * `globalThis.window = { localStorage }` installato da un test e mai tolto resta
 * lì per ogni file successivo. Un componente renderizzato dopo passa la guardia
 * `typeof window !== "undefined"`, chiama `getComputedStyle` e il globale non
 * c'è: `ReferenceError`. Misurato il 05/09/2026: 10 file su 1149 lasciavano
 * `window`/`localStorage`/`requestAnimationFrame`, e `dispatchedEnvelope.test.tsx`
 * usciva rosso SOLO quando il raggruppamento dello shard lo metteva dopo uno di
 * loro — un rosso che il triage sul singolo file non riproduce mai.
 *
 * COSA FA. Lancia OGNI file di test da solo, con lo stesso preload della suite
 * (`tests/setup/bun-test-preload.ts`), la cui guardia di fine corsa esce rossa
 * se un globale DOM è comparso e non è stato tolto. Un file da solo = la corsa
 * contiene solo lui = il colpevole è lui. Riporta la lista con i globali lasciati.
 *
 * QUANDO USARLO. Quando la guardia del preload ha fatto uscire rosso uno shard
 * o la suite intera («globali DOM residui»): la guardia dice CHE qualcuno ha
 * perso, non CHI; questo dice chi. Con un sospetto in mano basta anche
 * `bun test <file>` da solo: la stessa guardia gira lì.
 *
 *   bun run check:test-globals              # tutta la suite (~80s, 6 processi)
 *   bun run check:test-globals a.test.ts …  # solo quei file
 *
 * NON è un cancello: è triage. Non passa dal semaforo (`TOPICS_GATE_HELD` sui
 * figli) perché i suoi processi sono brevi e la scansione si lancia a mano.
 */
import { enumerateTestFiles, SUITE_ROOTS } from "./test-unit-shards.ts";
import { GATE_HELD_ENV } from "./gate-slot.ts";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
/** La firma che la guardia del preload stampa (`DOM_LEAK_MARKER`): cambiarla lì vuol dire cambiarla qui. */
const LEAK_MARKER = /leaked DOM globals: (\S+)/;

const requested = process.argv.slice(2);
const files = requested.length ? requested : enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
const parallel = Math.max(1, Number(process.env.TOPICS_CHECK_GLOBALS_PARALLEL) || 6);
console.error(`check:test-globals: ${files.length} file, ${parallel} alla volta`);

const leaks: Array<{ file: string; keys: string }> = [];
const otherReds: string[] = [];
let done = 0;
const started = Date.now();

async function runAlone(file: string): Promise<void> {
  const proc = Bun.spawn(["bun", "test", "--timeout", "30000", file], {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: "1", [GATE_HELD_ENV]: "check:test-globals" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  const m = LEAK_MARKER.exec(stderr);
  if (m) leaks.push({ file, keys: m[1] });
  else if (code !== 0) otherReds.push(`${file} (exit ${code})`);
  done += 1;
  if (done % 100 === 0) console.error(`  ${done}/${files.length}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

const queue = [...files];
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (queue.length) await runAlone(queue.shift()!);
  }),
);

if (leaks.length) {
  console.log(`\n${leaks.length} file lasciano globali DOM al file dopo:`);
  for (const { file, keys } of leaks.sort((a, b) => a.file.localeCompare(b.file))) console.log(`  ${file}  →  ${keys}`);
  console.log("\nRimedio: ripristina in `afterAll`/`afterEach` quello che il file ha trovato (`delete globalThis.window`, ecc.).");
} else {
  console.log(`\nnessun file lascia globali DOM (${files.length} controllati)`);
}
if (otherReds.length) {
  console.log(`\n${otherReds.length} file rossi per altri motivi (non di questa scansione):`);
  for (const r of otherReds) console.log(`  ${r}`);
}
console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s`);
process.exit(leaks.length ? 1 : 0);
