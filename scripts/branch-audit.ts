#!/usr/bin/env bun
/**
 * Verdetto sui rami locali PER CONTENUTO, non per discendenza.
 *
 * Il pile-up dei rami (133 il 12/08, 109 dopo il primo giro) nasce dal fatto che
 * la consegna atterra in squash: il ramo di un task landato NON è mai un antenato
 * di main, quindi `git branch --merged` lo dichiara vivo per sempre. Chiedere a
 * `merge-base` "è dentro?" risponde alla domanda sbagliata.
 *
 * Le due domande giuste, e questo script le tiene SEPARATE perché non sono la
 * stessa affermazione:
 *
 *   identico     ogni file-sorgente unico che il ramo tocca è byte-identico su
 *                main (`git diff --quiet <ramo> main -- <file>`). È il criterio
 *                di `server/services/branch-status.ts` caso (2), ed è quello che
 *                autorizza la cancellazione: non c'è niente da perdere.
 *   riassorbito  il diff del ramo si toglie da main senza conflitti
 *                (`git apply --reverse --check` contro un indice temporaneo
 *                popolato da main). Più permissivo: dice che le sue modifiche ci
 *                sono, ma main può averne aggiunte altre sugli stessi file.
 *                NON basta a cancellare — si elenca e la chiama l'umano.
 *
 * `git apply --cached` lavora sull'INDICE, non sul working tree: è ciò che rende
 * il secondo controllo possibile da una worktree qualsiasi senza fare il checkout
 * di main da qualche parte (GIT_INDEX_FILE + read-tree main).
 *
 * Un ramo non si cancella mai se: è main, è il ramo di una worktree registrata
 * (git rifiuterebbe comunque), o ha commit propri non riassorbiti.
 *
 * Usage:  bun run scripts/branch-audit.ts                 # elenca, non tocca niente
 *         bun run scripts/branch-audit.ts --delete-landed # cancella SOLO gli "identico"
 *
 * `--delete-landed` scrive PRIMA l'elenco `<ramo> <sha>` in
 * ~/.topics/backups/branches-deleted-<ts>.txt: è il modo di riaverli
 * (`git branch <ramo> <sha>`), e senza quel file non cancella.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isDisposableBranchName,
  isSafeToDelete,
  landedVerdict,
  makeMainIndex,
  uniqueSourceFiles,
  type Landed,
} from "./landed-lib";

const MAIN = "main";
const DELETE = process.argv.includes("--delete-landed");
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function gitOk(args: string[]): boolean {
  return spawnSync("git", args, { cwd: REPO, stdio: "ignore" }).status === 0;
}

type Verdict = Landed;

interface Row {
  branch: string;
  sha: string;
  verdict: Verdict;
  ahead: number;
  files: string[];
  worktree: string | null;
}

/** I rami che una worktree tiene occupati: git rifiuta di cancellarli, e ha ragione. */
function checkedOutBranches(): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of git(["worktree", "list", "--porcelain"]).split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && branch) out.set(branch, path);
  }
  return out;
}

function classify(branch: string, indexPath: string | null, occupied: Map<string, string>): Row {
  const sha = git(["rev-parse", branch]);
  const worktree = occupied.get(branch) ?? null;
  const ahead = Number.parseInt(git(["rev-list", "--count", `${MAIN}..${branch}`]) || "0", 10);
  const verdict = landedVerdict(REPO, branch, MAIN, indexPath);
  // I file servono solo per DIRE cosa contiene un ramo che resta: chiederli a
  // git per uno che è già dentro main è tempo speso per una riga vuota.
  const files = verdict === "antenato" ? [] : uniqueSourceFiles(REPO, branch, MAIN);
  return { branch, sha, verdict, ahead, files, worktree };
}

const occupied = checkedOutBranches();
const indexPath = makeMainIndex(REPO, MAIN);
const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
  .split("\n")
  .map((b) => b.trim())
  .filter((b) => b.length > 0 && b !== MAIN && b !== "master");

const rows = branches.map((b) => classify(b, indexPath, occupied));
const by = (v: Verdict) => rows.filter((r) => r.verdict === v);

console.log(`\n=== ${rows.length} rami locali oltre ${MAIN} ===\n`);
for (const v of ["antenato", "identico", "riassorbito", "vivo"] as Verdict[]) {
  const group = by(v);
  if (group.length === 0) continue;
  console.log(`--- ${v} (${group.length}) ---`);
  for (const r of group) {
    const tail =
      v === "vivo"
        ? `  ${r.ahead} commit, ${r.files.length} file: ${r.files.slice(0, 3).join(", ")}${r.files.length > 3 ? " …" : ""}`
        : v === "riassorbito"
          ? `  ${r.files.length} file, main ci ha scritto sopra`
          : "";
    console.log(`  ${r.sha.slice(0, 12)}  ${r.branch}${r.worktree ? "  [worktree]" : ""}${tail}`);
  }
  console.log("");
}

// Cancellabili: contenuto già su main, nessuna worktree che li tiene aperti E
// nome generato dalla macchina. Il terzo non è pedanteria: senza, il primo giro
// del 12/08 ha cancellato `electron-archive`, che il README cita per nome.
const landed = rows.filter((r) => isSafeToDelete(r.verdict) && !r.worktree);
const deletable = landed.filter((r) => isDisposableBranchName(r.branch));
const named = landed.filter((r) => !isDisposableBranchName(r.branch));
console.log(`cancellabili ora : ${deletable.length}  (contenuto su ${MAIN}, nessuna worktree, nome generato)`);
console.log(`da tenere        : ${by("vivo").length} vivi + ${by("riassorbito").length} riassorbiti (chiamata umana)`);
console.log(`bloccati da wt   : ${rows.filter((r) => r.worktree && r.verdict !== "vivo").length}`);
if (named.length > 0) {
  console.log(`\nDentro ${MAIN} ma battezzati a mano — li cancella l'umano, uno per uno:`);
  for (const r of named) console.log(`  ${r.sha.slice(0, 12)}  ${r.branch}  (${r.verdict})`);
}

if (!DELETE) {
  console.log(`\nNiente è stato toccato. Per cancellare i ${deletable.length}: --delete-landed\n`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(homedir(), ".topics", "backups");
mkdirSync(dir, { recursive: true });
const receipt = join(dir, `branches-deleted-${stamp}.txt`);
writeFileSync(
  receipt,
  [
    `# Rami cancellati il ${new Date().toISOString()} da scripts/branch-audit.ts`,
    `# Per riaverne uno:  git branch <nome> <sha>`,
    ...deletable.map((r) => `${r.sha} ${r.branch} (${r.verdict})`),
  ].join("\n") + "\n",
);
console.log(`\nricevuta: ${receipt}`);

let done = 0;
for (const r of deletable) {
  // -D e non -d: per gli "identico" il ramo NON è antenato di main e -d
  // rifiuterebbe. La prova è già stata fatta sopra, e lo sha è nella ricevuta.
  if (gitOk(["branch", "-D", r.branch])) done++;
  else console.log(`  NON cancellato: ${r.branch}`);
}
console.log(`cancellati: ${done}/${deletable.length}\n`);
