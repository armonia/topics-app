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

import { commitIsIn, listOwnCommits } from "./own-commits";

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

/**
 * «QUEL commit è dentro `mainRef`?» — la domanda che un land deve fare su se
 * stesso prima di dichiararsi riuscito.
 *
 * Ancestralità pura, nessuna euristica di contenuto: qui non si indovina se un
 * lavoro sia stato riportato altrove (per quello c'è `commitStatusFromRepo`), si
 * chiede se ESATTAMENTE il commit di fusione appena creato sia raggiungibile da
 * main. Un `git merge` uscito zero non lo dice: dice che una fusione è riuscita,
 * non su quale ramo — e un checkout parcheggiato altrove, o un worktree
 * usa-e-getta mai ricucito, fanno la differenza fra il lavoro nel prodotto e il
 * lavoro perso in silenzio (13/08, tre card).
 *
 * `null` = git non ha risposto (commit sconosciuto, `mainRef` assente, repo
 * illeggibile): «non lo so», mai un sì. Il `1` di git è invece un no vero e
 * proprio, e per questo qui non si passa da `gitExit`, che sul fallimento dello
 * spawn restituirebbe 1 — cioè trasformerebbe un «non lo so» in un'accusa.
 */
export async function commitIsAncestor(
  repoPath: string,
  commit: string,
  mainRef = "main",
): Promise<boolean | null> {
  try {
    const proc = Bun.spawn(["git", "-C", repoPath, "merge-base", "--is-ancestor", commit, mainRef], {
      stdout: "ignore", stderr: "ignore",
    });
    const code = await proc.exited;
    if (code === 0) return true;
    if (code === 1) return false;
    return null;
  } catch { return null; }
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
 * Il verdetto per UN COMMIT di consegna, che è una domanda DIVERSA da quella su
 * un branch. Serve all'audit degli atterraggi: il ramo di una card viene potato
 * appena atterra, quindi l'unica maniglia durevole su «cosa ha consegnato» è il
 * commit (l'oggetto sopravvive: `gc.pruneExpire` qui è 90 giorni).
 *
 * Perché non la stessa strada del branch: quella confronta `main...<ref>`, cioè
 * TUTTO ciò che il ramo ha di suo dal punto in cui ha forkato. Su un ramo nato
 * dall'HEAD del checkout condiviso quella gamma ingloba i commit di un'altra
 * sessione — misurato l'11/08 sulla consegna `8d92173c`: 90 file, di cui 3 suoi.
 * Il confronto trovava differenze (quelle degli altri) e stampava `unlanded` su
 * un lavoro che su main c'era. Un semaforo che dice rosso anche sul verde non lo
 * guarda più nessuno, ed è esattamente com'è finito.
 *
 * Tre modi di essere dentro, in ordine di costo:
 *   1. il commit è ANTENATO di main (merge o fast-forward classico);
 *   2. su main c'è la sua COPIA — stesso autore-data e stesso oggetto. Il land
 *      RICOPIA i commit della card (`cherry-pick … -C <sha>`, che tiene
 *      messaggio e autore) invece di fonderli, quindi la copia atterrata ha un
 *      altro sha e la discendenza non la vede. Non si riconosce dal patch-id: il
 *      pick ADATTA il commit al main del momento;
 *   3. il CONTENUTO del suo cambiamento è già su main — ogni file che il commit
 *      tocca è identico di là. Copre lo squash-land e la rimessa a mano.
 *
 * `gone` = l'oggetto non è più nel repo: la domanda non si può rispondere, e
 * dirlo è meglio che rispondere «non atterrato».
 */
export async function commitStatusFromRepo(
  repoPath: string,
  commit: string | null,
  mainRef = "main",
): Promise<BranchStatus> {
  if (!commit) return "gone";
  if ((await gitExit(repoPath, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])) !== 0) return "gone";

  // (1) Discendenza. La domanda sta in `commitIsIn` perché non è solo di qui: il
  // cancello del land la fa per decidere se c'è qualcosa da pubblicare, questo
  // per decidere se c'è qualcosa da rifare. Due copie che divergono vogliono dire
  // ridispacciare ciò che il land ha appena chiuso.
  if ((await commitIsIn(repoPath, commit, mainRef)) === true) return "merged";

  // (2) La copia ricopiata dal land. `-F` perché l'oggetto di un commit è prosa
  // e contiene parentesi, backtick e accenti: come regex sarebbe un'altra
  // domanda, e a volte un errore.
  const head = (await gitOut(repoPath, ["log", "-1", "--format=%at%x09%s", commit])).trim();
  const tab = head.indexOf("\t");
  const at = tab > 0 ? head.slice(0, tab) : "";
  const subject = tab > 0 ? head.slice(tab + 1) : "";
  if (at && subject) {
    const twins = (await gitOut(repoPath, ["log", mainRef, "-F", `--grep=${subject}`, "--format=%at%x09%s"]))
      .split("\n").map((l) => l.trim());
    if (twins.includes(`${at}\t${subject}`)) return "merged";
  }

  // (3) Il contenuto del SUO cambiamento, non di tutto il ramo. Su un commit
  // radice `^` non esiste: `show` lo elenca comunque.
  const ownDiff = await gitOut(repoPath, ["diff", "--name-only", `${commit}^`, commit]);
  const changed = filterUniqueSourceFiles(
    (ownDiff.trim() ? ownDiff : await gitOut(repoPath, ["show", "--format=", "--name-only", commit])).split("\n"),
  );
  if (changed.length === 0) return "merged"; // solo rumore generato: niente da perdere
  // `git diff --quiet` esce 0 quando NON c'è differenza sui path dati.
  return (await gitExit(repoPath, ["diff", "--quiet", commit, mainRef, "--", ...changed])) === 0 ? "merged" : "unmerged";
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
  /** Il commit PROPRIO più recente, o `null` se il worktree non ne ha nessuno. */
  commit: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface WorktreeDiffStatOptions {
  /** Il branch del worktree. Assente ⇒ letto da `HEAD` (detached ⇒ non misurabile). */
  branch?: string | null;
  /** Il branch d'integrazione. Default `main`. */
  mainRef?: string;
}

/**
 * L'albero vuoto, per il caso in cui il commit più vecchio è la RADICE e quindi
 * non ha un padre da cui misurare. Si chiede a git invece di incollare
 * `4b825dc…`, che è la costante di sha1 e su un repo sha256 non esiste.
 */
async function emptyTree(cwd: string): Promise<string | null> {
  const sha = (await gitOut(cwd, ["hash-object", "-t", "tree", "/dev/null"])).trim();
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * La fotografia di un worktree a fine turno: commit di consegna e diffstat del
 * lavoro SUO. È il numero che il confronto del fan-out mostra accanto a ogni
 * tentativo — cioè quello con cui l'umano sceglie il vincitore.
 *
 * Conta SOLO il lavoro COMMITTATO — di proposito. Il contratto della board è che
 * una consegna è ciò che sta su un commit (`review_needs_commit`); contare anche
 * il working tree farebbe apparire "3 file, +120" un tentativo che non ha
 * consegnato niente, e l'umano sceglierebbe un branch vuoto.
 *
 * La base NON è il merge-base con main: il worktree di un tentativo nasceva da
 * `baseRef: "HEAD"` sul checkout condiviso (ora parte da `main`, vedi
 * `worktree-base-ref.ts`, ma i rami già esistenti restano), quindi
 * `merge-base(main, HEAD)..HEAD`
 * ingloba i commit dell'altra sessione che stava parcheggiata lì e attribuisce
 * al tentativo il lavoro di qualcun altro. È la stessa bugia della consegna
 * (task `95518dab`), su un'altra superficie: si chiude allo stesso modo, cioè
 * chiedendo a `own-commits` quali commit sono PROPRI e misurando dal PADRE del
 * più vecchio di loro.
 *
 * CONTRATTO: `null` = non misurabile (HEAD staccato, git in errore, cartella
 * sparita) — mai uno zero, che dice «misurato: non ha prodotto niente».
 */
export async function worktreeDiffStat(
  cwd: string,
  opts: WorktreeDiffStatOptions = {},
): Promise<WorktreeDiffStat | null> {
  const mainRef = opts.mainRef ?? "main";

  // Senza sapere QUALE branch si sta misurando non si può sapere cosa è suo: un
  // HEAD staccato non è misurabile, e dirlo è meglio di rivendicare tutto.
  const branch = opts.branch ?? (await gitOut(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  if (!branch) return null;

  const own = await listOwnCommits(cwd, branch, { mainRef });
  if (own === null) return null; // git ha sbagliato: nessun numero, non uno zero
  const head = own[0];
  const oldest = own.at(-1);
  if (!head || !oldest) return { commit: null, filesChanged: 0, insertions: 0, deletions: 0 };

  // Il padre del più vecchio commit proprio è il punto in cui il lavoro di
  // QUESTA card comincia; se quel commit è la radice del repo, il "prima" è
  // l'albero vuoto.
  const base = (await resolveCommit(cwd, `${oldest}^`)) ?? (await emptyTree(cwd));
  if (!base) return null;

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
