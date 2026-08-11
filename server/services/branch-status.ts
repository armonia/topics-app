/**
 * Branch state relative to `main`, read from the PROJECT repo so it stays
 * correct even after the worktree dir was removed (the ghost case). The worktree
 * GC uses it to decide when a branch holds nothing to lose.
 *
 * "merged" means "nothing unique to lose", TRUE in two cases:
 *   1. the branch tip is a git-ancestor of main (classic merge / fast-forward);
 *   2. the branch was SQUASH-landed — its tip is NOT an ancestor, but every
 *      unique SOURCE file it changed is already byte-identical on main.
 *
 * Case (2) is the fix for worktree/branch pile-up: squash landing is the default
 * path, so a landed task's branch is never a git-ancestor of main and, without
 * (2), leaks its worktree + branch forever (the "unmerged"-by-ancestry pile-up).
 *
 * Generated / lockfile / lockstep-version paths are ignored when comparing
 * content: they carry no task-unique work and every branch differs in them
 * (auto-bumped version, rebuilt bundle, relocked deps), so counting them would
 * make (2) never fire. A real dependency change always shows up in source too,
 * so ignoring the manifest stays safe — genuine work keeps the branch "unmerged".
 */

/** Generated, build-output, lockfile and lockstep-version paths — never unique work. */
const NOISE_RE =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|package\.json|tauri\.conf\.json|Cargo\.toml)$|(^|\/)(public|dist|node_modules)\//;

/** Drop generated/version/lock paths → only files whose diff would be real work. */
export function filterUniqueSourceFiles(paths: string[]): string[] {
  return paths.map((p) => p.trim()).filter((p) => p.length > 0 && !NOISE_RE.test(p));
}

async function gitExit(cwd: string, args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch { return 1; }
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch { return ""; }
}

export type BranchStatus = "gone" | "merged" | "unmerged";

export async function branchStatusFromRepo(
  repoPath: string,
  branch: string | null,
  mainRef = "main",
): Promise<BranchStatus> {
  if (!branch) return "gone";
  if ((await gitExit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== 0) return "gone";
  return statusOfExistingRef(repoPath, branch, mainRef);
}

/**
 * Same verdict for an arbitrary commit-ish (a recorded delivery SHA), not just a
 * live branch name. The landing audit needs this: a task's branch is reaped once
 * it lands, so the only durable handle on "what the agent delivered" is the
 * commit it delivered — and that object outlives the branch (gc.pruneExpire is
 * 90 days here). `gone` = the object is no longer in the repo, so the question
 * can't be answered rather than answered "not landed".
 */
export async function commitStatusFromRepo(
  repoPath: string,
  commit: string | null,
  mainRef = "main",
): Promise<BranchStatus> {
  if (!commit) return "gone";
  if ((await gitExit(repoPath, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])) !== 0) return "gone";
  return statusOfExistingRef(repoPath, commit, mainRef);
}

/**
 * Il branch esiste DAVVERO nel repo? Un `git rev-parse --verify` e basta.
 *
 * Esiste separato da `branchStatusFromRepo` perché a volte serve solo il fatto
 * nudo — «il ref risolve, sì o no» — senza il giudizio su main, e soprattutto
 * senza collassare «non c'è» e «non ho potuto guardare» nello stesso valore:
 * chi compone il messaggio di abbandono (task `5770b9de`) deve poter distinguere
 * un branch assente da un repo non raggiungibile, perché il primo è un allarme e
 * il secondo è ignoranza.
 */
/**
 * L'ultimo commit che appartiene DAVVERO a questo ramo, o null se non ce n'e'
 * nessuno.
 *
 * La punta del ramo non risponde alla domanda «cosa ha prodotto questa card»:
 * il worktree nasceva dall'HEAD del checkout condiviso, quindi il ramo eredita
 * il lavoro di chi stava lavorando li'. Misurato il 10/08: una card rivendicava
 * il commit di un'altra, gia' su main, e chi rivedeva leggeva il diff sbagliato.
 *
 * «Suoi» = raggiungibili dal ramo ma da nessun ALTRO ramo locale (la stessa
 * domanda che si fa il land quando prende solo i propri commit). Se il conto e'
 * zero si torna null: «non ho prodotto codice» e' un'informazione, un puntatore
 * a un commit altrui no.
 */
export async function ownTipOfBranch(
  repoPath: string, branch: string, mainRef = "main",
): Promise<string | null> {
  const refs = (await gitOut(repoPath, ["for-each-ref", "--format=%(refname)", "refs/heads/"]))
    .split("\n").map((r) => r.trim()).filter(Boolean);
  const others = refs.filter((r) => r !== `refs/heads/${branch}` && r !== `refs/heads/${mainRef}`);
  const out = await gitOut(repoPath, ["rev-list", "-1", `${mainRef}..${branch}`, "--not", ...others]);
  const sha = out.trim().split("\n")[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export async function branchExistsInRepo(repoPath: string, branch: string | null): Promise<boolean> {
  if (!branch) return false;
  return (await gitExit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) === 0;
}

/**
 * Quanti commit ha il branch OLTRE `mainRef`. `null` = non contabile (branch
 * assente, `mainRef` inesistente, git in errore) — mai `0`, che vorrebbe dire
 * «verificato: non contiene niente» ed è un'affermazione diversa.
 */
export async function countCommitsAhead(
  repoPath: string,
  branch: string | null,
  mainRef = "main",
): Promise<number | null> {
  if (!branch) return null;
  const out = (await gitOut(repoPath, ["rev-list", "--count", `${mainRef}..${branch}`])).trim();
  return /^\d+$/.test(out) ? Number.parseInt(out, 10) : null;
}

/**
 * Full SHA of a commit-ish, or null when the repo doesn't have it. Used to
 * snapshot what a task delivered: the branch is reaped on landing, the SHA is
 * what survives.
 */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  const sha = (await gitOut(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** The shared verdict for a ref that is known to exist. */
async function statusOfExistingRef(repoPath: string, ref: string, mainRef: string): Promise<BranchStatus> {
  const branch = ref;
  // (1) Classic ancestry: the tip is already on main.
  if ((await gitExit(repoPath, ["merge-base", "--is-ancestor", branch, mainRef])) === 0) return "merged";

  // The content comparison is only meaningful with a shared history; an
  // unrelated branch is left "unmerged" (never reaped by the GC).
  if ((await gitExit(repoPath, ["merge-base", branch, mainRef])) !== 0) return "unmerged";

  // (2) Squash-landed: `main...branch` is the branch's OWN changes since it
  // forked, so a branch merely BEHIND main (main evolved those files) still
  // shows a diff and stays "unmerged". If every unique source file it touched is
  // already identical on main, the branch holds nothing to lose.
  const changed = filterUniqueSourceFiles(
    (await gitOut(repoPath, ["diff", "--name-only", `${mainRef}...${branch}`])).split("\n"),
  );
  if (changed.length === 0) return "merged"; // only generated/version noise differs

  // `git diff --quiet` exits 0 when there is NO difference for the given paths.
  const differs = await gitExit(repoPath, ["diff", "--quiet", branch, mainRef, "--", ...changed]);
  return differs === 0 ? "merged" : "unmerged";
}

/** Quanto ha prodotto un worktree rispetto al punto in cui ha forkato. */
export interface WorktreeDiffStat {
  /** Il tip, o `null` se il worktree non ha NESSUN commit oltre la base. */
  commit: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * La fotografia di un worktree a fine turno: commit di punta e diffstat rispetto
 * al merge-base con `main`. È il numero che il confronto del fan-out mostra
 * accanto a ogni tentativo.
 *
 * Conta SOLO il lavoro COMMITTATO — di proposito. Il contratto della board è che
 * una consegna è ciò che sta su un commit (`review_needs_commit`); contare anche
 * il working tree farebbe apparire "3 file, +120" un tentativo che non ha
 * consegnato niente, e l'umano sceglierebbe un branch vuoto.
 *
 * Il merge-base, non `main`: se main è andato avanti mentre il tentativo
 * lavorava, un diff contro la punta di main gli attribuirebbe anche il lavoro
 * degli altri.
 */
export async function worktreeDiffStat(cwd: string, mainRef = "main"): Promise<WorktreeDiffStat | null> {
  const head = await resolveCommit(cwd, "HEAD");
  if (!head) return null; // repo senza commit / cartella sparita: niente da dire
  const base = (await gitOut(cwd, ["merge-base", mainRef, "HEAD"])).trim() || mainRef;
  if (base === head) return { commit: null, filesChanged: 0, insertions: 0, deletions: 0 };

  const numstat = await gitOut(cwd, ["diff", "--numstat", base, head]);
  let filesChanged = 0, insertions = 0, deletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [add, del] = line.split("\t");
    filesChanged++;
    // I binari escono come `-\t-`: contano come file toccato, non come righe.
    insertions += Number.parseInt(add ?? "", 10) || 0;
    deletions += Number.parseInt(del ?? "", 10) || 0;
  }
  return { commit: head, filesChanged, insertions, deletions };
}
