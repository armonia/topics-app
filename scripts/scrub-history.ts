#!/usr/bin/env bun
/**
 * Togliere i nomi dei clienti dalla STORIA, non solo dall'albero.
 *
 * IL FATTO. `armonia/topics-app` è un repo PUBBLICO, e nella sua storia
 * compaiono i nomi di due clienti e la ragione sociale dell'azienda: in tutto
 * ventinove commit al 17/08, e il numero CRESCE finché nessuno riscrive.
 *
 * Quali siano NON sta scritto qui: stanno in `.personal-terms`, che non è
 * tracciato di proposito. Un file che elenca le cose da nascondere, dentro il
 * repo da cui vanno nascoste, è la fuga che dice di voler chiudere — e questo
 * commento, prima, li elencava tutti e tre per nome. Lo ha preso
 * `tests/unit/no-personal-data-tracked.test.ts`, che è esattamente il suo
 * mestiere.
 *
 * Per vedere l'elenco con i conteggi si lancia lo script: li legge dal file
 * locale e li stampa sul terminale di chi lo esegue, che è l'unico posto in cui
 * quei nomi possono stare.
 *
 * Nel presente non ci sono più (misurato: zero file tracciati li contengono).
 * Ma `git log -p` continua a mostrarli, e su un repo pubblico questo significa
 * che chiunque può leggere chi sono i clienti e quanta CI consumano.
 *
 * La ragione sociale in sé non è una fuga: è il nome di chi pubblica l'app. I
 * due clienti sì — non hanno chiesto di comparire.
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

/**
 * Quanti commit portano il termine, in tutta la storia.
 *
 * DUE DOMANDE, NON UNA, e per mesi qui se ne faceva una sola. `-S` guarda i
 * CONTENUTI, cioe' cosa e' entrato e uscito dai file. Un nome scritto nel
 * MESSAGGIO di un commit non tocca nessun blob, quindi `-S` non lo vede mai.
 *
 * Misurato il 2026-08-21, durante la riscrittura vera: dopo un
 * `git filter-repo --replace-text` i contenuti erano a zero e questo controllo
 * usciva pulito, mentre 15 messaggi di commit portavano ancora i nomi in chiaro
 * su un repo pubblico. Il gate diceva «fatto» a meta' lavoro, che e' peggio di
 * un gate che non c'e': uno assente lo sai, uno cieco ti convince.
 *
 * La cura sta anche a valle: la riscrittura vuole `--replace-message` accanto a
 * `--replace-text`, e le istruzioni stampate qui sotto ora lo dicono.
 */
function commitCon(termine: string): number {
  const contenuti = git("log", "--format=%H", "-S", termine, "--all");
  const messaggi = git("log", "--format=%H", "--grep", termine, "--all");
  const insieme = new Set(
    [...contenuti.split("\n"), ...messaggi.split("\n")].filter(Boolean),
  );
  return insieme.size;
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
console.log("       git filter-repo --replace-text .scrub-map.txt \\");
console.log("                        --replace-message .scrub-map.txt --force");
console.log("       # --replace-message NON e' facoltativo: --replace-text da solo");
console.log("       # lascia i nomi nei MESSAGGI dei commit (misurato: 15 rimasti)");
console.log("       git remote add origin <url>   # filter-repo lo rimuove apposta");
console.log("       git push --force origin main\n");
console.log("Dopo, per verificare che sia servito:");
console.log("       bun run scripts/scrub-history.ts --check   # deve uscire 0");
