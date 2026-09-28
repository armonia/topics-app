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

/**
 * Il più AVANTI dei due candidati a fare da base, o `a` se non sono in linea.
 *
 * Serve da quando riportare `main` dentro un ramo è un gesto di routine (lo fa
 * il land stesso, `task-automerge.ts`, su ogni ramo che ha invecchiato). Il
 * padre del commit più vecchio della card è un punto della storia PRIMA che main
 * avanzasse: da lì in poi il diff mostrerebbe anche tutto ciò che il ramo ha
 * inglobato da main, cioè lavoro di altre card, sotto il nome di questa.
 * Prendere il punto di fusione con main quando è più avanti taglia via quella
 * parte e lascia esattamente il lavoro della card.
 *
 * «Non in linea» (nessuno dei due discende dall'altro) si tiene `a`, il padre
 * del commit proprio: è il caso del ramo nato dall'HEAD di un'altra sessione,
 * dove il punto di fusione con main è INDIETRO e usarlo rivendicherebbe i
 * commit di quella sessione.
 */
async function furthest(run: GitRunner, cwd: string, a: string, b: string | null): Promise<string> {
  if (!b || b === a) return a;
  const aBeforeB = await run(cwd, ["merge-base", "--is-ancestor", a, b]);
  return aBeforeB.code === 0 ? b : a;
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
  let base = oldest
    ? await baseOf(run, cwd, oldest)
    : ((await revParse(run, cwd, "HEAD")) ?? (await emptyTree(run, cwd)));
  if (!base) return null;
  if (oldest) {
    // Il ramo può avere inglobato main dopo che la card ha cominciato: allora il
    // «prima» giusto è il punto di fusione, non il padre del primo commit.
    const mergeBase = await run(cwd, ["merge-base", mainRef, branch]);
    const mb = mergeBase.code === 0 ? mergeBase.stdout.trim() : "";
    base = await furthest(run, cwd, base, SHA_RE.test(mb) ? mb : null);
  }
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
 *   · the commit still has work of its own outside main (a cherry-pick land,
 *     whose copies on main have other shas): measured from the parent of the
 *     oldest own commit, or from where the card last met main when that is
 *     further on (as on the live worktree), up to the card's last own commit
 *     before the realign merges that close it (`beforeRealigns`);
 *   · il commit è già DENTRO main — allora ci è entrato con un merge. Serve quando il
 *     messaggio del merge non si fa trovare (rinominato a mano, o tagliato).
 *     The merge is the oldest one on main's first-parent line that holds the
 *     commit; a land by fast-forward has none, and gets `null`.
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

  const rl = await run(repoPath, ["rev-list", "--parents", sha, "--not", mainRef, ...others]);
  if (rl.code !== 0) return null;
  const parentsOf = new Map(lines(rl.stdout).map((l) => {
    const [commit, ...parents] = l.split(" ");
    return [commit!, parents] as const;
  }));
  const oldest = [...parentsOf.keys()].at(-1);
  if (oldest) {
    const tip = beforeRealigns(sha, parentsOf);
    // An oldest commit that merges two lines, neither of them the card's (it
    // began by merging a sibling card that reached main since, c4d48d3e), wrote
    // nothing of its own: the card starts AT it, not at one of its parents.
    const joined = parentsOf.get(oldest)!;
    let base = joined.length > 1 && joined.every((p) => !parentsOf.has(p)) ? oldest : await baseOf(run, repoPath, oldest);
    if (!base) return null;
    // A realign merge the card made BEFORE its last commit is inside the
    // range anyway: from where it met main on, main's side is not the card's.
    const met = await run(repoPath, ["merge-base", mainRef, tip]);
    base = await furthest(run, repoPath, base, met.code === 0 && SHA_RE.test(met.stdout.trim()) ? met.stdout.trim() : null);
    return { source: "delivery-commit", cwd: repoPath, range: `${base}..${tip}`, live: false };
  }

  // The merge that brought the delivery in sits on main's FIRST-PARENT line: a
  // merge of main into the delivering branch after the delivery (the routine
  // realign before a land) is on the ancestry path too, and older, but it is
  // the branch's own and main was not in it yet. `rev-list` goes newest first,
  // so the introducing merge is the oldest one on both lists.
  const [anc, firstParent] = await Promise.all([
    run(repoPath, ["rev-list", "--ancestry-path", "--merges", `${sha}..${mainRef}`]),
    run(repoPath, ["rev-list", "--first-parent", "--merges", `${sha}..${mainRef}`]),
  ]);
  if (anc.code !== 0 || firstParent.code !== 0) return null;
  const onMain = new Set(lines(firstParent.stdout));
  const introducing = lines(anc.stdout).filter((m) => onMain.has(m)).at(-1);
  if (!introducing || !SHA_RE.test(introducing)) return null;
  // The merge speaks for this card only when what it merged IS the delivery.
  // One whose branch went on past it carried other work too: a card born from
  // this one's head that landed first (`merge task <other>`), or an
  // integration branch. Its whole range would put that work under this
  // card's name, so the range stops at the delivery, from where it met main.
  if ((await revParse(run, repoPath, `${introducing}^2`)) === sha) {
    return { source: "landed-merge", cwd: repoPath, range: `${introducing}^1..${introducing}`, live: false };
  }
  const met = await run(repoPath, ["merge-base", `${introducing}^1`, sha]);
  const base = met.stdout.trim();
  // `base === sha`: main already had the delivery before that merge (a land by
  // fast-forward), so no merge says where it came from. `sha..sha` would read
  // as "verified: no code", which is not what is known.
  if (met.code !== 0 || !SHA_RE.test(base) || base === sha) return null;
  return { source: "delivery-commit", cwd: repoPath, range: `${base}..${sha}`, live: false };
}

/**
 * The delivery without the realign merges that close it.
 *
 * The routine before a land is «merge main into the branch», and the review
 * often records THAT merge as the delivery. It is outside main, so it is one of
 * the card's own commits, but what it brings is main's: measured up to it, the
 * range held every other card main had gained since the fork (e8e3b8bf: 208
 * files for its 9). Stepping down its first parent past such merges leaves the
 * card's last own commit. A realign is an own merge with a parent that is not
 * the card's; a merge of two of the card's own lines stays.
 */
function beforeRealigns(sha: string, parentsOf: Map<string, readonly string[]>): string {
  let tip = sha;
  for (;;) {
    const [first, ...merged] = parentsOf.get(tip) ?? [];
    if (!first || !parentsOf.has(first) || !merged.some((p) => !parentsOf.has(p))) return tip;
    tip = first;
  }
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
