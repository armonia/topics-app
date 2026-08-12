/**
 * QUALE gamma di git risponde a «cosa ha cambiato QUESTA card» — e da dove
 * leggerla quando il worktree non c'è più.
 *
 * Il pannello «Modifiche» del drawer chiedeva `merge-base main HEAD`, cioè TUTTO
 * il ramo dal punto in cui ha forkato. Un ramo nato dall'HEAD del checkout
 * CONDIVISO porta anche i commit della sessione che stava parcheggiata lì, e la
 * card se li intestava: chi rivedeva leggeva righe che nessun agente di quella
 * card aveva scritto. È la stessa bugia già chiusa sulla consegna
 * (`own-commits.ts`) e sul diffstat del fan-out (`worktreeDiffStat`), su una
 * terza superficie — quindi si chiude nello stesso modo, chiedendo quali commit
 * sono PROPRI e misurando dal PADRE del più vecchio di loro.
 *
 * E poi c'è il dopo. Appena la card atterra, il suo worktree viene potato: la
 * domanda restava senza risposta proprio quando serviva di più, cioè a cose
 * fatte. I riferimenti durevoli però esistono, e sono due:
 *
 *   1. il MERGE del land su main — `git merge --no-ff -m "merge task <id>: …"`,
 *      e `<merge>^1..<merge>` è esattamente ciò che quel land ha introdotto
 *      (verificato su `3ae30a9f`: 10 file, +435 −33, identico a `git show --stat`);
 *   2. il COMMIT DI CONSEGNA (`tasks.delivery_commit`) — l'oggetto sopravvive al
 *      ramo potato (`gc.pruneExpire` qui è 90 giorni) e serve quando il land è
 *      andato per cherry-pick, che NON lascia un merge: le copie su main hanno
 *      altri sha, quindi il ramo consegnato è ancora «fuori da main» e la stessa
 *      sottrazione lo sa ancora leggere.
 *
 * CONTRATTO: `null` = nessuna gamma ricostruibile. Non è «non ha cambiato
 * niente» — quello è una gamma che esiste e viene fuori VUOTA, ed è la
 * distinzione per cui questo modulo torna un oggetto e non una stringa: chi
 * chiama deve poter dire «verificato: nessun codice» invece di «non ho potuto
 * guardare», che sul drawer erano lo stesso silenzio.
 */

import { listOwnCommits, otherLocalBranches, defaultRunGit, type GitRunner } from "./own-commits";

/** Da dove viene la gamma — il drawer lo mostra, perché cambia cosa stai leggendo. */
export type TaskDiffSource = "worktree" | "landed-merge" | "delivery-commit";

export interface TaskDiffRange {
  source: TaskDiffSource;
  /** Dove far girare `git diff` (il worktree della card, o il checkout del progetto). */
  cwd: string;
  /** Il selettore da passare a `git diff` — una gamma `a..b`, o una singola revisione. */
  range: string;
  /**
   * `true` = la gamma è una revisione sola e il confronto finisce sull'ALBERO DI
   * LAVORO: il lavoro non ancora committato fa parte della risposta, e vanno
   * ripescati anche i file che git non traccia. `false` = due commit, e
   * l'albero di lavoro non c'entra (un land è già storia).
   */
  live: boolean;
}

export interface TaskDiffRangeOptions {
  /** Il branch d'integrazione. Default `main`. */
  mainRef?: string;
  /** Iniettato nei test. Default: `git` vero. */
  runGit?: GitRunner;
}

/** Sha pieno, sia sha1 (40) sia sha256 (64). */
const SHA_RE = /^[0-9a-f]{40,64}$/;

async function revParse(run: GitRunner, cwd: string, ref: string): Promise<string | null> {
  const r = await run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(sha) ? sha : null;
}

/**
 * L'albero vuoto, per quando il commit più vecchio è la RADICE e non ha un padre
 * da cui misurare. Si chiede a git invece di incollare `4b825dc…`, che è la
 * costante di sha1 e su un repo sha256 non esiste.
 */
async function emptyTree(run: GitRunner, cwd: string): Promise<string | null> {
  const r = await run(cwd, ["hash-object", "-t", "tree", "/dev/null"]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(sha) ? sha : null;
}

/** Il «prima» di una serie di commit propri: il padre del più vecchio. */
async function baseOf(run: GitRunner, cwd: string, oldest: string): Promise<string | null> {
  return (await revParse(run, cwd, `${oldest}^`)) ?? (await emptyTree(run, cwd));
}

function lines(out: string): string[] {
  return out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * La gamma di un worktree VIVO: dal padre del più vecchio commit proprio fino
 * all'albero di lavoro.
 *
 * Finisce sull'albero e non sulla punta del ramo di proposito, ed è l'unica
 * differenza voluta rispetto a `worktreeDiffStat`: quello misura una CONSEGNA
 * (che per contratto è ciò che sta su un commit), questo disegna il pannello che
 * si guarda MENTRE l'agente lavora — un file appena scritto e non ancora
 * committato è la cosa che il reviewer vuole vedere per prima.
 *
 * Nessun commit proprio ⇒ la base è `HEAD`: resta esattamente il lavoro non
 * committato, che è la risposta giusta per una card che ha appena cominciato.
 *
 * `null` = non misurabile (HEAD staccato, git in errore) — mai una gamma a caso.
 */
export async function worktreeOwnRange(
  cwd: string,
  opts: TaskDiffRangeOptions & { branch?: string | null } = {},
): Promise<TaskDiffRange | null> {
  const run = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  const branch =
    opts.branch?.trim() || (await run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch) return null;

  const own = await listOwnCommits(cwd, branch, { mainRef, runGit: run });
  if (own === null) return null;

  const oldest = own.at(-1);
  const base = oldest
    ? await baseOf(run, cwd, oldest)
    : ((await revParse(run, cwd, "HEAD")) ?? (await emptyTree(run, cwd)));
  if (!base) return null;
  return { source: "worktree", cwd, range: base, live: true };
}

/** Il merge che il land scrive su main. Deve restare uguale a `task-automerge.ts`. */
function mergeSubjectFor(taskId: string): string {
  return `merge task ${taskId}`;
}

/**
 * La gamma di un land già avvenuto: il merge che porta il nome della card.
 *
 * `--merges` non è decorazione: `--no-ff` garantisce un commit a due genitori, e
 * senza quel filtro un commit qualunque che citasse l'id della card (il messaggio
 * di un agente, per dire) verrebbe scambiato per l'atterraggio. `-F` perché il
 * titolo della card è prosa e come regex sarebbe un'altra domanda.
 */
export async function landedMergeRange(
  repoPath: string,
  taskId: string,
  opts: TaskDiffRangeOptions = {},
): Promise<TaskDiffRange | null> {
  const run = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  const id = taskId.trim();
  if (!id) return null;
  const r = await run(repoPath, [
    "log", mainRef, "--merges", "-n", "1", "-F", `--grep=${mergeSubjectFor(id)}`, "--format=%H",
  ]);
  if (r.code !== 0) return null;
  const sha = lines(r.stdout)[0] ?? "";
  if (!SHA_RE.test(sha)) return null;
  return { source: "landed-merge", cwd: repoPath, range: `${sha}^1..${sha}`, live: false };
}

/**
 * La gamma ricostruita dal commit di CONSEGNA, per il land che non ha lasciato
 * un merge (il cherry-pick selettivo) o per una card consegnata e mai atterrata
 * il cui ramo è già stato potato.
 *
 * Due esiti, entrambi utili:
 *   · il commit ha ancora del suo fuori da main — è il caso del cherry-pick, le
 *     cui copie su main hanno altri sha: si misura dal padre del più vecchio,
 *     esattamente come sul worktree vivo;
 *   · il commit è già DENTRO main — allora ci è entrato con un merge, e il primo
 *     merge sul cammino fra i due è quello che l'ha portato. Serve quando il
 *     messaggio del merge non si fa trovare (rinominato a mano, o tagliato).
 */
export async function deliveryCommitRange(
  repoPath: string,
  delivery: { branch: string | null; commit: string | null },
  opts: TaskDiffRangeOptions = {},
): Promise<TaskDiffRange | null> {
  const run = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  const wanted = delivery.commit?.trim();
  if (!wanted) return null;

  // L'oggetto può essere stato raccolto dal gc: allora la domanda non ha più una
  // risposta, e dirlo è meglio che disegnare il diff di qualcos'altro.
  const sha = await revParse(run, repoPath, wanted);
  if (!sha) return null;

  // Il ramo consegnato va ESCLUSO dai «altri»: se esiste ancora, sottrarlo da sé
  // stesso non lascerebbe niente. Quando non c'è più, la lista è la stessa.
  const others = await otherLocalBranches(repoPath, delivery.branch ?? mainRef, { mainRef, runGit: run });
  if (others === null) return null;

  const rl = await run(repoPath, ["rev-list", sha, "--not", mainRef, ...others]);
  if (rl.code !== 0) return null;
  const own = lines(rl.stdout);
  if (own.length > 0) {
    const base = await baseOf(run, repoPath, own[own.length - 1]!);
    if (!base) return null;
    return { source: "delivery-commit", cwd: repoPath, range: `${base}..${sha}`, live: false };
  }

  const anc = await run(repoPath, ["rev-list", "--ancestry-path", "--merges", `${sha}..${mainRef}`]);
  if (anc.code !== 0) return null;
  // `rev-list` va dal più recente: il più VECCHIO dei merge sul cammino è quello
  // che ha introdotto il commit, i successivi se lo sono solo portati dietro.
  const introducing = lines(anc.stdout).at(-1);
  if (!introducing || !SHA_RE.test(introducing)) return null;
  return { source: "landed-merge", cwd: repoPath, range: `${introducing}^1..${introducing}`, live: false };
}

export interface TaskDiffAnchors extends TaskDiffRangeOptions {
  taskId: string;
  /** Il worktree VIVO della card, se ne ha ancora uno su disco. */
  worktree?: { cwd: string; branch: string | null } | null;
  /** Il checkout principale del progetto: è lì che vive main dopo il land. */
  repoPath?: string | null;
  /** Lo scatto della consegna (`tasks.delivery_branch` / `delivery_commit`). */
  delivery?: { branch: string | null; commit: string | null } | null;
}

/**
 * I tre ancoraggi in ordine di autorità: il worktree vivo (che è l'unico a
 * conoscere anche il lavoro non committato), poi il merge del land, poi il
 * commit di consegna. `null` = nessuno dei tre ha saputo rispondere.
 */
export async function resolveTaskDiffRange(a: TaskDiffAnchors): Promise<TaskDiffRange | null> {
  const opts: TaskDiffRangeOptions = { mainRef: a.mainRef, runGit: a.runGit };
  if (a.worktree?.cwd) {
    const live = await worktreeOwnRange(a.worktree.cwd, { ...opts, branch: a.worktree.branch });
    if (live) return live;
  }
  if (a.repoPath) {
    const landed = await landedMergeRange(a.repoPath, a.taskId, opts);
    if (landed) return landed;
    if (a.delivery) {
      const delivered = await deliveryCommitRange(a.repoPath, a.delivery, opts);
      if (delivered) return delivered;
    }
  }
  return null;
}
