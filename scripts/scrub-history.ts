#!/usr/bin/env bun
/**
 * Togliere i nomi dei clienti dalla STORIA, non solo dall'albero.
 *
 * IL FATTO. `armonia/topics-app` è un repo PUBBLICO, e nella sua storia
 * compaiono i nomi di due clienti e la ragione sociale:
 *
 *     [cliente]         19 commit
 *     [azienda]      4 commit
 *     [cliente]   3 commit
 *
 * Nel presente non ci sono più (misurato: zero file tracciati li contengono).
 * Ma `git log -p` continua a mostrarli, e su un repo pubblico questo significa
 * che chiunque può leggere chi sono i clienti e quanta CI consumano.
 *
 * [azienda] è il nome dell'azienda che pubblica l'app: in sé non è una fuga.
 * `[cliente]` e `[cliente]` sì — sono clienti che non hanno chiesto di
 * comparire.
 *
 * PERCHÉ QUESTO SCRIPT NON RISCRIVE NIENTE DA SOLO.
 *
 * `git filter-repo` riscrive OGNI commit, quindi cambia tutti gli SHA. Le
 * conseguenze non sono reversibili e non sono locali:
 *
 *   - ogni clone e ogni fork esistente diventa incompatibile: chi ha lavoro in
 *     corso deve ricostruirlo a mano;
 *   - gli SHA citati nei commenti del codice e nelle card della board smettono
 *     di risolvere (questo repo ne cita molti, di proposito: sono la memoria
 *     del perché di una scelta);
 *   - serve un `push --force` su un ramo pubblico.
 *
 * È esattamente la categoria di gesti che si conferma prima di fare, non dopo.
 * Questo script quindi PREPARA e MISURA: produce la mappa delle sostituzioni,
 * dice quanti commit toccherebbe, e stampa il comando esatto da lanciare —
 * con la sua rete di sicurezza.
 *
 *   bun run scripts/scrub-history.ts          # misura e prepara
 *   bun run scripts/scrub-history.ts --check  # solo la misura, per la CI
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RADICE = new URL("..", import.meta.url).pathname;

/** I termini vengono da `.personal-terms`, che NON è tracciato di proposito:
 *  l'elenco delle cose da nascondere non deve essere esso stesso la fuga. */
function termini(): string[] {
  const f = join(RADICE, ".personal-terms");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((r) => r.split("#")[0]!.trim())
    .filter(Boolean);
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: RADICE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

/** Quanti commit contengono il termine, in tutta la storia. */
function commitCon(termine: string): number {
  const out = git("log", "--oneline", "-S", termine, "--all");
  return out.split("\n").filter(Boolean).length;
}

const soloMisura = process.argv.includes("--check");

const righe: Array<{ termine: string; commit: number }> = [];
for (const t of termini()) {
  righe.push({ termine: t, commit: commitCon(t) });
}
const sporchi = righe.filter((r) => r.commit > 0);

console.log("[scrub] termini nella STORIA (non nell'albero di oggi):");
for (const r of righe) {
  console.log(`  ${r.commit === 0 ? "pulito" : `${r.commit} commit`.padEnd(10)}  ${r.termine}`);
}

if (sporchi.length === 0) {
  console.log("\n[scrub] la storia è pulita: niente da riscrivere.");
  process.exit(0);
}

if (soloMisura) {
  console.log(`\n[scrub] ${sporchi.length} termini ancora nella storia.`);
  process.exit(1);
}

// La mappa per `--replace-text`. Il formato è `cercato==>sostituto`: si
// sostituisce con un segnaposto che DICE che qualcosa è stato tolto, invece di
// cancellare e basta — un diff che si accorcia senza spiegazione è più difficile
// da leggere di uno che porta la sua cicatrice.
const mappa = sporchi.map((r) => `${r.termine}==>[cliente]`).join("\n") + "\n";
const dove = join(RADICE, ".scrub-map.txt");
writeFileSync(dove, mappa);

console.log(`\n[scrub] mappa scritta in ${dove} (NON tracciata: è in .gitignore)`);
console.log(`[scrub] toccherebbe ${sporchi.reduce((n, r) => n + r.commit, 0)} commit.\n`);
console.log("PRIMA di lanciare, tre cose che questo script non può fare al posto tuo:");
console.log("  1. un backup del repo intero (non solo un branch):");
console.log("       git clone --mirror . ../topics-app-backup.git");
console.log("  2. avvisare chi ha cloni o lavoro in corso: i loro SHA moriranno");
console.log("  3. accettare che gli SHA citati nei commenti e nelle card non risolveranno più\n");
console.log("Poi:");
console.log("       git filter-repo --replace-text .scrub-map.txt --force");
console.log("       git remote add origin <url>   # filter-repo lo rimuove apposta");
console.log("       git push --force origin main\n");
console.log("Dopo, per verificare che sia servito:");
console.log("       bun run scripts/scrub-history.ts --check   # deve uscire 0");
