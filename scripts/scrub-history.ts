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
import { type PersonalTerm, personalTermEntries } from "./personal-terms.ts";

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
 *  must be hidden cannot itself live in the repo it is hidden from. The entries
 *  carry their tier: see the file format in `personal-terms.ts`. */
const termini = (): PersonalTerm[] => personalTermEntries(RADICE);

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: RADICE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

/**
 * EVERY WAY THIS GATE WENT QUIET HAD THE SAME SHAPE, so the cure is here and not
 * at the four places that showed it.
 *
 * `git()` above swallows a failure into `""`, and for a counting question `""`
 * means ZERO. So "git refused to answer" and "nothing to find" were the same
 * value, and a gate whose whole job is to find something read the first as the
 * second. Four separate silent greens were measured on this very branch, all of
 * them this one bug wearing a different hat: a tag ref that does not resolve, a
 * path spelled like a ref, a term with a `[` in it, a remote that did not
 * answer. Each printed "niente di pubblicato contiene i nomi" with the term  allow-italian: quotes the line the gate prints
 * sitting in a published commit.
 *
 * So the measuring path uses this instead: a failure is RECORDED, and a run with
 * anything recorded cannot report a clean bill of health — it exits 2, "non  allow-italian: quotes the line the gate prints
 * misurabile". The question «is this published» has three answers, not two, and
 * the third one had no way to be said.
 */
const cannotMeasure: string[] = [];

/** Never let a term reach the terminal through an error message: the names are
 *  the one thing that must not be printed by a gate someone pipes to a log. */
function redact(text: string): string {
  let out = text;
  for (const entry of termini()) out = out.split(entry.term).join("«termine»");
  return out;
}

function gitMeasure(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: RADICE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const raw = (error as { stderr?: string | Buffer }).stderr?.toString() ?? String(error);
    cannotMeasure.push(`git ${args[0]} ${args[1]}: ${redact(raw.split("\n")[0] ?? "")}`);
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
  // `--` closes the rev list. Without it a working-tree path spelled like a ref
  // makes git exit `fatal: ambiguous argument … both revision and filename` and
  // print nothing, which used to read as "zero commits" for every term.
  const contenuti = gitMeasure("log", "--format=%H", "-S", termine, ...ambito, "--");
  // `--grep` is a REGEX unless `-F` says otherwise, so a term carrying `[`, `(`
  // or `.` silently matched nothing in the MESSAGES — the exact half `--grep`
  // was added for. Measured: `Acme [Milano] srl` in a published commit message,
  // 0 hits without `-F`, 1 with it. (`-S` is a fixed string already.)
  const messaggi = gitMeasure("log", "--format=%H", "-F", "--grep", termine, ...ambito, "--");
  const insieme = new Set(
    [...contenuti.split("\n"), ...messaggi.split("\n")].filter(Boolean),
  );
  return insieme.size;
}

/**
 * The MESSAGE OF AN ANNOTATED TAG is published content that no `git log` walk
 * ever reads: the walk visits commits, and a tag object's own text is neither a
 * commit message nor a blob. Measured: a term only in `git tag -a -m` on a
 * pushed tag came out `pulito`, and the gate went on to advise removing the
 * forward-only marker — an instruction to lower the guard, computed from a count
 * that could not see the exposure.
 *
 * 21 of the 710 published tags here are annotated, so reading them is cheap.
 */
function tagMessagesWith(termine: string): number {
  return annotatedTagBodies().filter((body) => body.includes(termine)).length;
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
function remoteReal(): string[] {
  return git("remote").split("\n").map((r) => r.trim()).filter(Boolean);
}

/**
 * TAGS ARE PUBLISHED TOO, and for two months this gate could not see them.
 *
 * `--remotes=<r>/*` covers the remote BRANCHES: 20 published heads here. The
 * same remote publishes 710 tags, and a tag is as readable as a branch — a
 * plain `git clone` fetches every one of them, GitHub lists their commits, and
 * the 21/08/2026 rewrite moved `main` without touching any of them.
 *
 * Measured 22/10/2026 on the author's home directory path: the gate counted 51
 * commits, the union with the published tags counts 112. Three client names
 * reported `pulito` while 14 hits across 12 distinct commits still carried
 * them, all of them under ONE published release tag whose commits were rebased
 * off `main`. Verified by cloning the repo fresh with no flags: 710 tags, all
 * 12 commits present, the names in 12 commit MESSAGES. A gate that undercounts
 * by 2x says "clean" about half of what the public can read.
 *
 * IDENTIFIED BY SHA, NOT BY NAME. `ls-remote` returns both and the first draft
 * of this kept only the name, then let `git log` resolve it — which resolves the
 * LOCAL object. A tag that has moved on either side (a re-cut release, a local
 * `tag -f`) then had the gate measure a different commit than the one the remote
 * serves, and print `pulito` with no caveat. Measured: remote `v1.0` on the
 * leaky commit, local `v1.0` moved to a clean one, exit 0. So the scope is the
 * SHAs the remote named; a name is not an identity.
 *
 * WHY THE LIST COMES FROM THE REMOTE AND NOT FROM `--tags`. 316 of the 1026
 * tags in this clone exist only here, 307 of them `archive/*` backups cut
 * before a rebase. Counting them would make the gate announce a PUBLIC leak on
 * refs nobody can fetch — exactly the `selfcheck/main` bug that taught this file
 * to build its scope from configured remotes in the first place.
 *
 * AND OFFLINE IT SAYS SO INSTEAD OF GUESSING. An earlier draft fell back to the
 * local tags, over-reporting "to be safe": with the remote away that turned an
 * `archive/*` backup into a PUBLIC leak and exited 1. Both directions of guess
 * are wrong, because the honest answer is the third one — the question cannot be
 * answered without the remote, and `cannotMeasure` is how it gets said.
 *
 * `refs/pull/*` is in the scope too: GitHub publishes the head of every pull
 * request under that namespace, and a clone that fetches them can hold a commit
 * no branch and no tag reaches. That leg is matched on LOCAL refs, because no
 * `ls-remote` refspec lists hidden refs — so it can only over-report, never
 * hide, and this clone has none of them.
 */

/** Annotated tag objects among the published ones, for `tagMessagesWith`. */
let annotatedTagShas: string[] = [];
let bodiesRead: string[] | null = null;
function annotatedTagBodies(): string[] {
  bodiesRead ??= annotatedTagShas.map((sha) => gitMeasure("cat-file", "-p", sha));
  return bodiesRead;
}

function publishedTagShas(remotes: string[]): string[] {
  const shas = new Set<string>();
  for (const remote of remotes) {
    let listing: string;
    try {
      listing = execFileSync("git", ["ls-remote", "--tags", remote], {
        cwd: RADICE,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // One silent remote is enough to make the answer unknown: an earlier
      // draft OR-ed the remotes together, so a live tagless one masked a dead
      // one and suppressed both the fallback and the warning.
      cannotMeasure.push(`ls-remote ${remote}: il remoto non ha risposto`);
      continue;
    }
    for (const line of listing.split("\n")) {
      const [sha, ref] = line.split("\t");
      // `^{}` is the peeled commit of an annotated tag; the unpeeled line names
      // the tag OBJECT, and `git log` peels it on its own. Keeping only the
      // unpeeled one also keeps the tag's own message reachable below.
      if (!sha || !ref || !ref.startsWith("refs/tags/") || ref.trim().endsWith("^{}")) continue;
      shas.add(sha.trim());
    }
  }
  if (shas.size === 0) return [];

  // An object the remote names but this clone lacks cannot be measured here,
  // and must not be passed to `git log`: one unresolvable rev makes it exit
  // fatal and print nothing, i.e. zero commits for every term.
  let report: string;
  try {
    report = execFileSync("git", ["cat-file", "--batch-check"], {
      cwd: RADICE,
      encoding: "utf8",
      input: `${[...shas].join("\n")}\n`,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    cannotMeasure.push("cat-file --batch-check: non eseguibile");
    return [];
  }
  const present: string[] = [];
  let missing = 0;
  for (const line of report.split("\n")) {
    const [sha, type] = line.trim().split(/\s+/);
    if (!sha) continue;
    if (!type || type === "missing") {
      missing += 1;
      continue;
    }
    present.push(sha);
    if (type === "tag") annotatedTagShas.push(sha);
  }
  if (missing > 0) {
    cannotMeasure.push(
      `${missing} tag pubblicati non sono in questo clone: git fetch --tags, poi rilancia`,
    );
  }
  return present;
}

const REMOTES = remoteReal();
/** No configured remote means nothing is published, and the scope stays empty so
 *  `commitCon` refuses to fall back to HEAD. A leftover `refs/remotes/<gone>/*`
 *  publishes nothing; that is what the third test in the suite watches. */
const PUBBLICO = REMOTES.length === 0
  ? []
  : [...REMOTES.map((r) => `--remotes=${r}/*`), ...publishedTagShas(REMOTES), "--glob=refs/pull/*"];
const LOCALE = ["--all", "--not", ...PUBBLICO];

const soloMisura = process.argv.includes("--check");

/** An empty list is not a green, it is "nothing to look for here": the normal
 *  state in CI and on a fresh clone. Saying so and stopping is what the push
 *  guard does, and it keeps the verdicts below from judging an empty set — an
 *  earlier draft exited 2 over unfetched tags with no terms to measure. */
if (termini().length === 0) {
  console.log("[scrub] nessun termine in .personal-terms: niente da cercare.");
  process.exit(0);
}

const ambito = soloMisura ? PUBBLICO : ["--all"];
const righe: Array<{ termine: string; commit: number; tagMsg: number; forwardOnly: boolean }> = [];
for (const t of termini()) {
  righe.push({
    termine: t.term,
    commit: commitCon(t.term, ambito),
    tagMsg: soloMisura ? tagMessagesWith(t.term) : 0,
    forwardOnly: t.forwardOnly,
  });
}
const isDirty = (r: { commit: number; tagMsg: number }) => r.commit > 0 || r.tagMsg > 0;
/** Dirty AND blocking: a forward-only term in the published history is a fact to
 *  report, not a failure, because no action available here would change it. */
const sporchi = righe.filter((r) => isDirty(r) && !r.forwardOnly);
const knownExposures = righe.filter((r) => isDirty(r) && r.forwardOnly);

/** Commits and tag messages are two different things and the line says which:
 *  "N commit" over a tag-message hit would be a count of something that does
 *  not exist, and this file's whole subject is numbers that mean what they say. */
function countLabel(r: { commit: number; tagMsg: number }): string {
  const pieces: string[] = [];
  if (r.commit > 0) pieces.push(`${r.commit} commit`);
  if (r.tagMsg > 0) pieces.push(`${r.tagMsg} msg di tag`);
  return (pieces.join(" + ") || "pulito").padEnd(26);
}

console.log(
  soloMisura
    ? "[scrub] termini nella storia PUBBLICATA (rami remoti, tag pubblicati, refs/pull):"
    : "[scrub] termini nella STORIA (non nell'albero di oggi):",
);
for (const r of righe) {
  console.log(`  ${countLabel(r)}  ${r.termine}${r.forwardOnly ? "   [solo in avanti]" : ""}`);
}

if (soloMisura) {
  const locali = termini().reduce((n, t) => n + commitCon(t.term, LOCALE), 0);
  if (locali > 0) {
    console.log(
      `\n[scrub] ${locali} commit SOLO locali li contengono ancora: e' la storia di prima` +
        "\n        della riscrittura, che vive nei rami vecchi e nelle worktree." +
        "\n        Non e' pubblicata, e il hook pre-push (scripts/check-push-clean.ts)" +
        "\n        rifiuta di pubblicarla. Per toglierla da un ramo: rebase --onto origin/main.",
    );
  }
  if (knownExposures.length > 0) {
    console.log(
      `\n[scrub] ${knownExposures.length} termini sono un'esposizione NOTA e accettata (solo in avanti):`,
    );
    for (const r of knownExposures) {
      console.log(`          ${r.termine}: ${countLabel(r).trim()} pubblicati`);
    }
    console.log(
      "        Non fanno rosso: la storia pubblicata non si puo' ritirare (un force-push\n" +
        "        non basta, GitHub continua a servire gli oggetti per SHA). Cio' che si puo'\n" +
        "        ancora impedire e' AGGIUNGERNE, e lo fa il hook pre-push\n" +
        "        (scripts/check-push-clean.ts), che li rifiuta nei commit non ancora pushati.",
    );
  }
  // Only advise dropping a marker when the measurement was complete: the advice
  // is "lower the guard", and computing it from a count that could not look is
  // how a gate talks someone out of its own protection.
  for (const r of righe) {
    if (r.forwardOnly && !isDirty(r) && cannotMeasure.length === 0) {
      console.log(
        `\n[scrub] «${r.termine}» e' marcato solo in avanti ma la storia pubblicata non lo\n` +
          "        contiene: il marcatore non serve e puoi togliere il «>».",
      );
    }
  }
  // A leak already found is certain; what could not be measured is only
  // unknown. The certain bad news wins the exit code: it is the one with a cure.
  if (sporchi.length > 0) {
    console.log(`\n[scrub] ${sporchi.length} termini sono PUBBLICI: vanno tolti dalla storia remota.`);
    process.exit(1);
  }
  if (cannotMeasure.length > 0) {
    console.log("\n[scrub] NON MISURABILE: i conteggi qui sopra non sono una risposta.");
    for (const why of [...new Set(cannotMeasure)]) console.log(`          ${why}`);
    console.log("        «pulito» qui sopra vuol dire «non ho potuto guardare», non «pulito».");
    process.exit(2);
  }
  console.log("\n[scrub] niente di pubblicato contiene i nomi (oltre a cio' che e' gia' noto).");
  process.exit(0);
}

if (cannotMeasure.length > 0) {
  console.log("\n[scrub] attenzione, la misura e' incompleta:");
  for (const why of [...new Set(cannotMeasure)]) console.log(`          ${why}`);
}

if (knownExposures.length > 0) {
  console.log(
    `\n[scrub] ${knownExposures.length} termini sono marcati solo in avanti e NON entrano nella mappa:` +
      "\n        riscriverli non li ritira dal pubblico, e cambiare gli SHA costa comunque.",
  );
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
