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
import { join } from "node:path";
import { personalTerms } from "./personal-terms.ts";

/** The repo this is run FROM, not the one the file lives in: in a worktree they
 *  are different trees, and resolving from cwd is what lets the tests point the
 *  gate at a throwaway repo, which is the only way to watch it turn red. */
function radice(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return new URL("..", import.meta.url).pathname;
  }
}

const RADICE = radice();

/** Terms come from `.personal-terms`, deliberately untracked: a list of what
 *  must be hidden cannot itself live in the repo it is hidden from. */
const termini = () => personalTerms(RADICE);

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: RADICE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

/**
 * How many commits carry the term, across the whole history.
 *
 * TWO QUESTIONS, NOT ONE, and for months this asked only the first. `-S` looks
 * at CONTENT: what entered and left the files. A name written in a commit
 * MESSAGE touches no blob, so `-S` never sees it.
 *
 * Measured on 2026-08-21 during the real rewrite: after a
 * `git filter-repo --replace-text` the contents were at zero and this check came
 * out clean, while 15 commit messages still carried the names in the open on a
 * public repo. The gate said "done" at half the job, which is worse than no gate
 * at all: a missing one you know about, a blind one convinces you.
 *
 * The cure is also downstream: the rewrite wants `--replace-message` next to
 * `--replace-text`, and the instructions printed below now say so.
 */
function commitCon(termine: string, ambito: string[]): number {
  // No scope means no refs to look at. Without this, git would fall back to
  // HEAD and the "published" measure would silently become "the branch I happen
  // to have checked out", which is a different question with a similar answer.
  if (ambito.length === 0) return 0;
  const contenuti = git("log", "--format=%H", "-S", termine, ...ambito);
  const messaggi = git("log", "--format=%H", "--grep", termine, ...ambito);
  const insieme = new Set(
    [...contenuti.split("\n"), ...messaggi.split("\n")].filter(Boolean),
  );
  return insieme.size;
}

/**
 * WHICH REFS THE GATE JUDGES, and why `--all` was the wrong answer.
 *
 * The question worth failing on is "are the names published", and published
 * means reachable from a remote ref. `--all` asks something else: "does any ref
 * on this laptop still carry them". After the 21/08 rewrite that came out red
 * and stays red, because 223 local branches and 57 worktrees still descend from
 * the old commits and rebasing all of them is not something a gate can do. A
 * gate that is structurally red on the only machine that can run it (in CI
 * `.personal-terms` does not exist, so it never looks) is a gate people learn to
 * step over.
 *
 * So the failure is measured on `--remotes`, and the local dirt is reported as a
 * COUNT, not a red: the thing that actually protects it is `pre-push`, which
 * refuses to publish a dirty ancestry (`scripts/check-push-clean.ts`, and its
 * test watches it turn red in both directions).
 */
/**
 * `--remotes` is not "what is published": it is every remote-tracking ref this
 * clone happens to still have. Measured while writing this: `selfcheck/main`,
 * left over from a remote that was removed after the rewrite was verified,
 * carried 9 commits with the names and made the gate report a PUBLIC leak on a
 * remote that does not exist. So the scope is built from the remotes that are
 * actually configured; a ref pointing at a remote nobody can reach publishes
 * nothing.
 */
function remotiVeri(): string[] {
  return git("remote").split("\n").map((r) => r.trim()).filter(Boolean);
}
const PUBBLICO = remotiVeri().map((r) => `--remotes=${r}/*`);
const LOCALE = ["--all", "--not", ...PUBBLICO];

const soloMisura = process.argv.includes("--check");

const ambito = soloMisura ? PUBBLICO : ["--all"];
const righe: Array<{ termine: string; commit: number }> = [];
for (const t of termini()) {
  righe.push({ termine: t, commit: commitCon(t, ambito) });
}
const sporchi = righe.filter((r) => r.commit > 0);

console.log(
  soloMisura
    ? "[scrub] termini nella storia PUBBLICATA (i ref remoti):"
    : "[scrub] termini nella STORIA (non nell'albero di oggi):",
);
for (const r of righe) {
  console.log(`  ${r.commit === 0 ? "pulito" : `${r.commit} commit`.padEnd(10)}  ${r.termine}`);
}

if (soloMisura) {
  const locali = termini().reduce((n, t) => n + commitCon(t, LOCALE), 0);
  if (locali > 0) {
    console.log(
      `\n[scrub] ${locali} commit SOLO locali li contengono ancora: e' la storia di prima` +
        "\n        della riscrittura, che vive nei rami vecchi e nelle worktree." +
        "\n        Non e' pubblicata, e il hook pre-push (scripts/check-push-clean.ts)" +
        "\n        rifiuta di pubblicarla. Per toglierla da un ramo: rebase --onto origin/main.",
    );
  }
  if (sporchi.length > 0) {
    console.log(`\n[scrub] ${sporchi.length} termini sono PUBBLICI: vanno tolti dalla storia remota.`);
    process.exit(1);
  }
  console.log("\n[scrub] niente di pubblicato contiene i nomi.");
  process.exit(0);
}

if (sporchi.length === 0) {
  console.log("\n[scrub] la storia è pulita: niente da riscrivere.");
  process.exit(0);
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
