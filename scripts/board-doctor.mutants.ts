#!/usr/bin/env bun
/**
 * La prova che i test del doctor sanno diventare rossi.
 *
 * Una suite che passa non dice niente finche' non si e' visto almeno una volta
 * che sa fallire: venti test verdi su venti controlli che non controllano
 * niente hanno lo stesso aspetto di venti test veri. Qui si rompe `board-doctor.ts`
 * un pezzo per volta — sempre disattivando UNA guardia, cioe' introducendo
 * esattamente il falso allarme (o il silenzio) che quella guardia esiste per
 * evitare — e si verifica che la suite lo becchi.
 *
 * Due mutazioni sono sfuggite la prima volta che questo e' girato, ed erano
 * due difetti veri dei test:
 *   · il guardiano delle negazioni («nessuno dei sottotask») non era coperto da
 *     nessun caso in cui potesse fare la differenza: codice morto;
 *   · il test sul fuso era scritto sull'ora ambientale, ma `bun test` gira in
 *     UTC — dove la lettura ingenua e quella corretta coincidono. Il test era
 *     cieco proprio sul bug che doveva vedere. Ora il fuso lo forza lui.
 *
 * ATTENZIONE: scrive su `scripts/board-doctor.ts` mentre gira e lo ripristina
 * alla fine (anche su Ctrl-C). Rifiuta di partire se il file ha modifiche non
 * committate, cosi' un'interruzione brutale non puo' mangiarsi del lavoro.
 *
 *   bun scripts/board-doctor.mutants.ts
 */
import { spawnSync } from "node:child_process";

const FILE = "scripts/board-doctor.ts";
const TESTS = "scripts/board-doctor.test.ts";

/** [nome, riga da spegnere, riga che la spegne] — sempre una guardia per volta. */
const MUTATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["1 non guarda se i sottotask esistono", "      if (t.subtaskCount > 0) continue;", "      if (false) continue;"],
  ["1 ignora la negazione «nessun sottotask»", "  if (DENIES_SUBTASKS.test(comment)) return false;", "  if (false) return false;"],
  ["2 non guarda l'anteprima", '      if ((t.previewImage ?? "").trim()) continue;', "      if (false) continue;"],
  ["2 non distingue la superficie visibile", "      if (visible.length === 0) continue;", "      if (visible.length < 0) continue;"],
  ["3 scatta anche a zero commit estranei", "      if (foreign <= 0) continue;", "      if (foreign < 0) continue;"],
  ["4 salta la prova positiva di morte", "      if (!verdict.dead) continue; // regola del non-allarme: senza prova di morte, silenzio", "      if (false) continue;"],
  ["4 ignora la risposta umana", "      if (answered !== null && answered >= asked) continue; // l'umano ha risposto: non e' fermo", "      if (false) continue;"],
  ["4 ignora l'eta' della domanda", "      if (ageMs < DOCTOR.needsInput.minAgeMs) continue;", "      if (ageMs < 0) continue;"],
  ["4 ignora il numero di tentativi", "      if (t.dispatchAttempts < DOCTOR.needsInput.minAttempts) continue;", "      if (t.dispatchAttempts < 0) continue;"],
  ["5 parla senza il confronto nel checkout principale", "      if (r.mainExit !== 0) continue;", "      if (false) continue;"],
  ["5 parla anche su un verde", "      if (r.worktreeExit === 0) continue; // niente rosso, niente da dire", "      if (false) continue;"],
  ["6 abbassa la soglia a zero", "      if (ratio < DOCTOR.cost.factor) continue;", "      if (ratio < 0) continue;"],
  ["6 ignora la numerosita' della classe", "      if (!base || base.n < DOCTOR.cost.minClassN || base.median <= 0) continue;", "      if (!base || base.median <= 0) continue;"],
  ["morte: basta un sondaggio", "  if (probes.length < minProbes) {", "  if (probes.length < 0) {"],
  ["morte: ignora i figli vivi", "  if (alive > 0) {", "  if (alive > 99) {"],
  ["morte: ignora l'avanzamento", "  if (signatures.size > 1) {", "  if (signatures.size > 99) {"],
  ["tempo: legge i timestamp come locali", '  const iso = hasZone ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`;', "  const iso = s;"],
  ["prova: lascia passare un comando che scrive", "    if (SHELL_WRITERS.has(head)) return false;", "    if (false) return false;"],
  ["prova: lascia passare `git merge`", "      if (!GIT_READ_VERBS.has(verb)) return false;", "      if (false) return false;"],
  ["registro: non tace mai niente", "  for (const f of findings) (said[f.occurrence] ? suppressed : fresh).push(f);", "  for (const f of findings) fresh.push(f);"],
];

const dirty = spawnSync("git", ["status", "--porcelain", "--", FILE], { encoding: "utf8" }).stdout ?? "";
if (dirty.trim()) {
  console.error(`${FILE} ha modifiche non committate: committale prima, questo script lo riscrive.`);
  process.exit(2);
}

const original = await Bun.file(FILE).text();
const restore = () => Bun.write(FILE, original);
process.on("SIGINT", () => { void restore().then(() => process.exit(130)); });

let escaped = 0;
try {
  for (const [name, from, to] of MUTATIONS) {
    if (!original.includes(from)) {
      console.log(`  NON TROVATA  ${name} — la riga e' cambiata, la mutazione va riscritta`);
      escaped++;
      continue;
    }
    await Bun.write(FILE, original.replace(from, to));
    const run = spawnSync("bun", ["test", TESTS], { encoding: "utf8" });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const fails = Number(out.match(/(\d+) fail/)?.[1] ?? "-1");
    if (fails <= 0) escaped++;
    console.log(`  ${fails > 0 ? `rosso (${fails})`.padEnd(12) : "SFUGGITA    "} ${name}`);
  }
} finally {
  await restore();
}

console.log(escaped === 0
  ? `\n${MUTATIONS.length}/${MUTATIONS.length} mutazioni beccate: i test sanno diventare rossi.`
  : `\n${escaped} mutazioni su ${MUTATIONS.length} sono passate indenni: i test non reggono.`);
process.exit(escaped === 0 ? 0 : 1);
