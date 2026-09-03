/**
 * Worktree garbage collection — the ORIGIN fix for worktree pile-up.
 *
 * Worktrees were only ever reaped on a successful approve→automerge (routes/
 * tasks.ts). Everything that finished WITHOUT that exact path leaked forever:
 * a task rejected then abandoned, a task deleted, an approve that the (old)
 * dirty-main bug skipped, an orphaned dispatch. 27 stale worktrees had piled
 * up by 2026-07-18.
 *
 * This sweep applies the SAME safety contract as the approve-time reap to the
 * whole population, periodically. The contract lives in `decideWorktreeReap`
 * as a pure function so it is exhaustively unit-testable: we only ever destroy
 * a worktree when there is provably nothing to lose.
 *
 * Never reaped: a worktree whose task is still active (backlog/todo/
 * in_progress/review), one with real uncommitted work (junk excluded), one
 * with unmerged commits when we can't safely land them, or one under a live
 * agent turn. A closed task whose clean commits never landed is re-merged
 * first (land-then-reap), never dropped.
 *
 * The one exception to "active ⇒ untouchable" is `abandon`: a task stuck in
 * `in_progress` with no sign of life for days is active only on paper, and it
 * held its checkout forever. That path keeps the BRANCH and parks the task —
 * it frees a directory, never a commit (see `isAbandoned`).
 *
 * UNA CARTELLA NON È UN COMMIT. Fino all'11/08 le uniche risposte per un task
 * chiuso erano «distruggi tutto» o «non toccare niente», e ogni volta che il
 * lavoro non era su main vinceva la seconda: 77 worktree per 33,9 GB tenuti in
 * vita da un solo motivo — «commit non mergiati». Ma `git worktree remove` non
 * tocca i commit: finché un ref li raggiunge, la cartella è una COPIA, e una
 * copia si può buttare. Da qui `free-checkout`, la terza risposta: la cartella
 * va, il branch resta, il lavoro è al sicuro dove è sempre stato.
 */

export type WorktreeReapAction = "reap" | "land-then-reap" | "free-checkout" | "commit-residue" | "abandon" | "keep";

export interface WorktreeReapDecision {
  action: WorktreeReapAction;
  reason: string;
}

export type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

export interface WorktreeReapInput {
  /** Bound task status, or null when the worktree is orphaned (no task/topic). */
  taskStatus: TaskStatus | null;
  /** Bound task archived flag (archived tasks are terminal regardless of status). */
  taskArchived: boolean;
  /** Non-junk uncommitted paths present (from worktreeRealDirt). */
  hasRealDirt: boolean;
  /**
   * The folder is no longer a checkout: git lost its registration
   * (`worktreeDirtProbe` reports `unregistered`). The dirt probe will NEVER
   * answer there, and reading it as "dirty" keeps the folder forever for a
   * closed task. There is no residue to commit (no index, no HEAD): the
   * commits live on the branch or on main, the folder is only weight.
   */
  unregistered?: boolean;
  /** Worktree tip is an ancestor of main → no unmerged commits to lose. */
  mergedIntoMain: boolean;
  /**
   * Il branch del worktree non esiste più nel repo. Allora l'unico ref che
   * raggiunge quei commit è l'HEAD della cartella, e liberare la cartella li
   * renderebbe irraggiungibili: `free-checkout` non è disponibile.
   *
   * Il chiamante di oggi (`sweepWorktrees`) intercetta il branch sparito prima
   * di arrivare qui, ma la sicurezza di una funzione pura non deve dipendere
   * dall'ordine dei controlli di chi la chiama.
   */
  branchGone?: boolean;
  /**
   * L'host sa mettere al sicuro le modifiche non committate sul branch
   * (`worktree-residue.ts`). Assente ⇒ la decisione degrada a `keep`, come per
   * `abandon` e `free-checkout`: senza il mezzo, la vecchia risposta è ancora
   * quella giusta.
   */
  canCommitResidue?: boolean;
  /** The task's board opted into auto-merge (so land-then-reap is allowed). */
  autoMergeEnabled: boolean;
  /** Only `branch`-mode worktrees own a landable branch. */
  mode: "branch" | "reuse" | "detached";
  /**
   * Days since the last sign of life on the bound task — a turn, a comment, a
   * chat message, a write to the agent's transcript. `null` = the host can't
   * measure it, and ignorance is never abandonment (same rule as the
   * dispatcher's liveness net: only a POSITIVE signal of death acts).
   */
  idleDays?: number | null;
  /** TTL for `abandon`: idle days after which an `in_progress` task counts as abandoned. `0`/absent = off. */
  abandonAfterDays?: number;
}

/**
 * The one non-terminal case that is nonetheless finished: a task stuck in
 * `in_progress` — agent dead, or a turn that simply never came back — holding
 * its worktree forever. `decideWorktreeReap` calls it `abandon`, deliberately
 * NOT `reap`: the branch survives (nothing committed is ever lost), only the
 * checkout goes, and the task is parked so nothing resumes into a directory
 * that no longer exists.
 *
 * Every condition here is a reason not to act, in the order that matters:
 * a TTL that's off, the wrong status, an unmeasurable idle, work that is still
 * only in the tree, or commits that live in a detached HEAD and would become
 * unreachable the moment the checkout goes.
 */
function isAbandoned(input: WorktreeReapInput): boolean {
  const ttl = input.abandonAfterDays ?? 0;
  if (ttl <= 0) return false;
  // Only `in_progress` — the state that CLAIMS an agent is at work right now.
  // `todo`/`backlog` are queued (a re-dispatch reuses the tree), `review` is a
  // human's pending decision and its worktree is the evidence they inspect.
  if (input.taskStatus !== "in_progress") return false;
  if (input.idleDays == null || input.idleDays < ttl) return false;
  if (input.hasRealDirt) return false;
  if (input.mode === "detached") return false;
  return true;
}

/**
 * The safety contract. Pure. Order matters — each guard is a reason NOT to
 * destroy, checked before any reap is allowed.
 */
export function decideWorktreeReap(input: WorktreeReapInput): WorktreeReapDecision {
  // A task that is still being worked or is awaiting human review owns its
  // worktree — never touch it. Orphans (taskStatus === null) ARE terminal.
  const terminal = input.taskStatus === null || input.taskStatus === "done" || input.taskArchived;
  if (!terminal) {
    // Active on paper, abandoned in fact: see `isAbandoned`. The branch is kept,
    // so this frees a checkout and never a commit.
    if (isAbandoned(input)) {
      return { action: "abandon", reason: `task fermo in 'in_progress' da ${Math.floor(input.idleDays!)} giorni` };
    }
    return { action: "keep", reason: `task '${input.taskStatus}' attivo` };
  }

  // A folder git no longer registers is not a checkout: the dirt probe exits
  // 128 forever, so "illegible = dirty" protects nothing here and keeps the
  // folder for good (sage-well: 137 MB, task closed and already on main).
  // There is no residue to commit, because there is no index and no HEAD: the
  // commits live on the branch or on main. Only THAT is looked at.
  if (input.unregistered) {
    if (input.mergedIntoMain) return { action: "reap", reason: "cartella non più registrata in git, lavoro già su main" };
    if (input.mode === "branch" && !input.branchGone) {
      return { action: "free-checkout", reason: "cartella non più registrata in git: branch conservato, checkout liberato" };
    }
    return { action: "keep", reason: "cartella non più registrata in git e nessun ramo che ne conservi i commit" };
  }

  // Real uncommitted work sitting in the tree is the only copy — a closed task
  // can still carry it (a system-forced review). Human decides; we don't nuke.
  //
  // Ma «unica copia» è una CONDIZIONE, non un destino: un branch vivo può
  // ospitarla. Committata lì, la cartella smette di essere l'unico appiglio —
  // ed è parola per parola il ragionamento che questo file fa venti righe più
  // sotto per i commit non landati. Senza il mezzo per farlo, si tiene.
  if (input.hasRealDirt) {
    if (input.canCommitResidue && input.mode === "branch" && !input.branchGone) {
      return { action: "commit-residue", reason: "modifiche non committate: si salvano sul branch, poi il checkout è una copia in più" };
    }
    return { action: "keep", reason: "modifiche non committate (junk escluso)" };
  }

  // Fully on main already → the worktree holds nothing main doesn't. Safe.
  if (input.mergedIntoMain) return { action: "reap", reason: "già interamente su main" };

  // Closed task, clean tree, but commits never landed (e.g. an approve the
  // old dirty-main bug skipped). Land them first, THEN reap — never drop.
  if (input.autoMergeEnabled && input.mode === "branch") {
    return { action: "land-then-reap", reason: "task chiuso con commit non ancora su main" };
  }

  // Commit che non si possono auto-landare (automerge spento, o modo non-branch).
  // Restano da decidere a mano — ma «da decidere» riguarda i COMMIT, non la
  // cartella: se un branch li raggiunge ancora, il checkout è una copia in più e
  // può andarsene senza che nessuno perda niente.
  if (input.mode === "branch" && !input.branchGone) {
    return { action: "free-checkout", reason: "task chiuso, commit non su main: branch conservato, checkout liberato" };
  }

  // `detached` non ha un branch proprio: i suoi commit sono raggiungibili solo
  // dall'HEAD della cartella. `reuse` sta su un ramo di qualcun altro, di cui
  // qui non abbiamo letto lo stato. In entrambi i casi la cartella È l'appiglio.
  return { action: "keep", reason: "commit non mergiati, automerge non disponibile → decisione umana" };
}

// ─────────────────────────────────────────────────────────────────────────

/**
 * Cosa fare del TASK quando la sua riga di worktree è fantasma (branch sparito):
 *  • `none`    — nessun task vivo da toccare: la riga è peso morto e basta;
 *  • `park`    — un task che diceva di lavorarci ha perso il suo ramo: si
 *                parcheggia, perché la sua sessione non esiste più;
 *  • `unbind`  — si scioglie il legame col worktree morto e LO STATO NON SI
 *                TOCCA. Il task non ha fallito niente.
 */
export type GhostRowTaskAction = "none" | "park" | "unbind";

export interface GhostRowInput {
  /** Stato del task legato al worktree, `null` se orfano. */
  taskStatus: TaskStatus | null;
  taskArchived: boolean;
  /**
   * Il commit di consegna del task risulta su main, per CONTENUTO
   * (`classifyLanding`): `true` atterrato, `false` provatamente no, `null` non
   * si può dire (nessuna consegna registrata, repo non leggibile). `null` non è
   * un sinonimo di `false` — stessa regola di `AbandonBranchState.unverified`.
   */
  deliveryLanded: boolean | null;
}

/**
 * LA RIGA FANTASMA HA DUE CAUSE OPPOSTE, e per un anno ne ha vista una sola.
 *
 * Un worktree in modo `branch` il cui branch non esiste più poteva significare
 * «il ramo è andato perduto» oppure «il ramo è stato POTATO perché il lavoro è
 * atterrato». Il GC leggeva sempre la prima, parcheggiava il task come `failed`
 * e lo scaricava in backlog. Il 12/08 è successo a quattro card su quattro nella
 * stessa ora — tutte in `review`, tutte appena landate: il land pota il ramo,
 * la spazzata trova la riga fantasma, e la decisione umana sparisce dalla
 * colonna dove l'umano la guarda. Capitava alle card CHIUSE BENE.
 *
 * Due regole, in quest'ordine, e nessuna delle due è nuova al progetto:
 *  1. se la consegna è su main, il ramo è stato potato dopo un atterraggio
 *     riuscito — è la fine normale della storia (la stessa lettura per contenuto
 *     di `landing-audit`, che regge anche un land squashato);
 *  2. una card in `review` non aspetta un agente, aspetta una PERSONA: il
 *     dispatcher non ha niente da dire su di lei, nemmeno quando davvero non sa
 *     dove sia finito il ramo. Si scioglie il legame, lo si scrive nel thread, e
 *     la card resta dove l'umano la sta guardando.
 * Tutto il resto — un task che dichiara di starci lavorando dentro — si
 * parcheggia come prima: lì la sessione non c'è più davvero.
 */
export function decideGhostRow(input: GhostRowInput): { task: GhostRowTaskAction; reason: string } {
  const terminal = input.taskStatus === null || input.taskStatus === "done" || input.taskArchived;
  if (terminal) return { task: "none", reason: "branch già sparito (riga fantasma)" };
  if (input.deliveryLanded === true) {
    return { task: "unbind", reason: "il ramo è stato potato dopo un atterraggio riuscito" };
  }
  if (input.taskStatus === "review") {
    return { task: "unbind", reason: "il branch del worktree non esiste più" };
  }
  return { task: "park", reason: "il branch del worktree non esiste più" };
}

// ─────────────────────────────────────────────────────────────────────────

export type LandOutcome = "landed" | "nothing" | "conflict" | "skipped";

export interface PostLandInput {
  /** What `tryLand` reported. */
  outcome: LandOutcome;
  /** Branch state re-read from the repo AFTER the land attempt. */
  branchAfter: BranchStatus;
  /** Non-junk uncommitted paths still in the worktree AFTER the land. */
  dirtAfter: string[];
  /**
   * La sonda ha potuto leggere l'albero? `false` = `git status` non ha risposto,
   * e allora `dirtAfter` vuoto non significa «pulito» ma «non lo so». Qui si
   * distrugge: non sapere vale quanto sporco.
   */
  dirtReadable?: boolean;
}

/**
 * The post-land guard — the ONE place that decides whether a landing earned the
 * right to destroy a branch. Pure, so both callers (the GC sweep and the manual
 * `landTask`) share the exact same contract instead of each growing their own
 * half of it.
 *
 * Why it exists: `tryLand` reporting `"landed"` — or `"nothing"`, meaning "the
 * branch has no commits main doesn't" — is a CLAIM, not proof. On 2026-07-19 a
 * task's only copy of 139 lines (the `watching` phase) was reaped on the back of
 * that claim: the branch was deleted, the commit survived only in the reflog.
 * The old code said as much in a comment — *"landed OR nothing (superseded) →
 * the branch holds nothing to lose now"* — and never checked.
 *
 * So we re-READ the repo after the attempt and reap only against evidence:
 *   • conflict/skipped → the land didn't happen at all;
 *   • dirt still in the tree → uncommitted work is the only copy (task `e8780726`,
 *     the same hole seen from the other side: not-landed vs not-committed);
 *   • branch still `unmerged` → the content is provably NOT on main.
 * Anything else and the branch keeps living until a human says otherwise.
 *
 * Il branch, appunto — non la cartella. Un land fallito è un motivo per non
 * distruggere i COMMIT, e per anni è stato letto anche come motivo per tenere il
 * checkout: da `03ca44c3` il land si rifiuta ogni volta che il branch porta
 * commit di un'altra sessione, cioè quasi sempre, e ogni rifiuto lasciava una
 * cartella immortale. Quando il branch c'è e l'albero è pulito la risposta giusta
 * non è né `reap` né `keep`, è `free-checkout`.
 */
export function decidePostLandReap(input: PostLandInput): WorktreeReapDecision {
  // Prima di tutto il resto: lavoro non committato esiste SOLO nella cartella.
  // Nessun esito del land può autorizzare a toccarla. (Stava dopo il controllo
  // su conflict/skipped, che restituiva comunque `keep`: lì l'ordine non si
  // vedeva, qui sì, perché adesso quel ramo può liberare la cartella.)
  if (input.dirtReadable === false) {
    return { action: "keep", reason: "stato dell'albero illeggibile dopo il land (git status non ha risposto)" };
  }
  if (input.dirtAfter.length > 0) {
    return { action: "keep", reason: `modifiche non committate dopo il land (${input.dirtAfter.length} file)` };
  }
  if (input.outcome === "conflict" || input.outcome === "skipped") {
    // Il land non è avvenuto. Il branch resta l'unico posto dove vive il lavoro
    // — e se è sparito sotto di noi, la cartella è l'ultimo appiglio: si tiene.
    return input.branchAfter === "gone"
      ? { action: "keep", reason: `land ${input.outcome} e branch sparito: la cartella è l'unica copia` }
      : { action: "free-checkout", reason: `land ${input.outcome}: branch conservato, checkout liberato` };
  }
  // `gone` = the land itself deleted the ref; there is no branch left to lose.
  if (input.branchAfter === "unmerged") {
    return {
      action: "free-checkout",
      reason: `land '${input.outcome}' ma il contenuto NON risulta su main: branch conservato, checkout liberato`,
    };
  }
  return { action: "reap", reason: `land '${input.outcome}' verificato su main` };
}

// ─────────────────────────────────────────────────────────────────────────

export interface GcWorktree {
  id: string;
  projectId: string;
  absPath: string;
  branchName: string | null;
  mode: "branch" | "reuse" | "detached";
}

/** Branch state read from the PROJECT repo (robust to a removed worktree dir). */
export type BranchStatus = "gone" | "merged" | "unmerged";

export interface WorktreeGcDeps {
  /** Ready worktrees to consider (the manager's store, status='ready'). */
  listWorktrees: () => GcWorktree[];
  /**
   * Resolve the task bound to a worktree (worktree → topic → task).
   * `null` task ⇒ orphan. Returns the bits the decision needs.
   */
  resolveTask: (worktreeId: string) =>
    | { taskId: string; status: TaskStatus; archived: boolean }
    | { taskId: null };
  /** True while a dispatched turn for the task is in flight — never reap under it. */
  isBusy: (taskId: string) => boolean;
  /** Whether the worktree directory still exists on disk. */
  diskPresent: (absPath: string) => boolean;
  /**
   * Non-junk uncommitted paths, PIU' il fatto di aver potuto guardare
   * (`worktreeDirtProbe`). Ha senso solo a cartella presente.
   *
   * `ok: false` — `git status` uscito non-zero, o esploso — NON vale «pulito»:
   * qui si decide se cancellare, e una cartella su cui non si e' potuto leggere
   * niente va trattata come se contenesse lavoro. Prima la sonda restituiva un
   * array vuoto in entrambi i casi e un singhiozzo di git (index.lock, volume
   * che non risponde) SBLOCCAVA il reap invece di fermarlo.
   *
   * `unregistered: true` is a fact read, not a default: the folder is no longer
   * a checkout (see `worktreeDirtProbe`) and the probe will never answer. The
   * decision then looks only at the branch and at main.
   */
  realDirt: (absPath: string) => Promise<{ ok: boolean; paths: string[]; unregistered?: boolean }>;
  /**
   * The branch's state relative to main, read from the project repo (so it's
   * correct even after the worktree dir was removed): `gone` (branch deleted),
   * `merged` (ancestor of main → nothing to lose), or `unmerged`.
   */
  branchStatus: (wt: GcWorktree) => Promise<BranchStatus>;
  /** The worktree's board opted into auto-merge. */
  autoMergeEnabled: (projectId: string) => boolean;
  /**
   * Days since the last sign of life on the task, or `null` when unmeasurable.
   * Absent ⇒ the abandon TTL is off entirely.
   */
  idleDays?: (taskId: string) => number | null;
  /** TTL in days for the abandon path (see `isAbandoned`). Absent/0 = off. */
  abandonAfterDays?: number;
  /**
   * Retire an abandoned task: park it (freeing its topic binding) and remove
   * ONLY the checkout, keeping the branch. Both halves belong together — a
   * worktree removed under a task that still reads `in_progress` would let a
   * later resume run in the base repo, next to the human's own work.
   * Returns false if it couldn't complete (kept, then).
   */
  abandon?: (taskId: string, wt: GcWorktree, reason: string) => Promise<boolean>;
  /**
   * Il park che NON declassa: scioglie il legame col worktree morto, ne rimuove
   * il checkout (branch già sparito, non c'è niente da conservare) e lascia il
   * task nella sua colonna. È la risposta per una card in `review` e per
   * qualunque card la cui consegna sia già su main — vedi `decideGhostRow`.
   *
   * Assente ⇒ la decisione degrada a `keep`, come per `abandon`: senza il mezzo
   * per farlo in sicurezza, non si fa.
   */
  unbind?: (taskId: string, wt: GcWorktree, reason: string, deliveryLanded: boolean) => Promise<boolean>;
  /**
   * Il commit di consegna del task è su main, letto per CONTENUTO. `null` quando
   * non si può dire (nessuna consegna registrata, repo non leggibile) — e
   * `null` non autorizza a chiamarlo fallimento.
   */
  deliveryLanded?: (taskId: string, wt: GcWorktree) => Promise<boolean | null>;
  /** Land the task's branch. Returns the coarse outcome. */
  tryLand: (taskId: string) => Promise<LandOutcome>;
  /** Reap worktree + branch + row (worktreeManager.delete). */
  reap: (worktreeId: string) => Promise<boolean>;
  /**
   * Libera SOLO la cartella: worktree rimosso, riga cancellata, BRANCH INTATTO
   * (`worktreeManager.delete(id, { deleteBranch: false })`). È l'unica differenza
   * con `reap`, ed è tutta la differenza: i commit restano raggiungibili dal ref.
   *
   * Assente ⇒ l'host non sa liberare un checkout e la decisione degrada a `keep`
   * — la stessa regola di `abandon`: senza il mezzo per farlo in sicurezza, non
   * si fa.
   */
  freeCheckout?: (worktreeId: string) => Promise<boolean>;
  /**
   * Surface a refused reap on the task itself (a system comment). A branch kept
   * because its content never reached main is exactly the failure that went
   * unnoticed for 8 days — it must be visible where the human looks.
   */
  noteOnTask?: (taskId: string, message: string, opts?: { kind?: "service"; once?: boolean }) => void;
  /**
   * TIMBRA IL RAMO SULLA CARD prima che la cartella sparisca.
   *
   * Senza questo, `free-checkout` produceva una card che NON si può più landare,
   * ed è così che si è perso il fix `_close` (card 714c2fc5, due volte). La
   * catena: liberata la cartella, `topics.worktree_id` resta vuoto, quindi
   * `worktreeOfTask` non risolve, quindi `taskDeliveryRef` risponde `null`,
   * quindi `captureDelivery` non scrive `delivery_branch` — e
   * `chooseMergeTarget(null, {branch: null})` risponde `no-branch`, l'unico
   * codice che lascia la card chiusa senza aver fuso niente.
   *
   * Qui il ramo è ancora noto (`wt.branchName`): è l'ultimo istante in cui si
   * può dire alla card dove vive il suo lavoro. Il ripiego di
   * `chooseMergeTarget` sul `delivery_branch` esiste già da sempre; mancava solo
   * qualcuno che lo alimentasse.
   */
  stampDeliveryBranch?: (taskId: string, branch: string) => void;
  /**
   * Butta gli artefatti rigenerabili (dipendenze, cache di build) da un worktree
   * che RESTA in piedi, e restituisce i byte liberati. Vedi `worktree-slim`.
   *
   * È la risposta intermedia fra `keep` e `free-checkout`: il `keep` è la
   * decisione giusta sui COMMIT e su ciò che è tracciato, ma non dice niente sui
   * ~260 MB di `node_modules` che una card consegnata si porta dietro per giorni
   * mentre aspetta un umano. Assente ⇒ il GC non snellisce, e basta.
   */
  slim?: (wt: GcWorktree) => Promise<number>;
  /**
   * Mette al sicuro sul branch le modifiche non committate di un worktree, e
   * dice se ci è riuscita (`worktree-residue.ts`). È ciò che trasforma un
   * `keep` per sporcizia in un `free-checkout`: non indebolisce la regola —
   * toglie la condizione che la faceva scattare.
   *
   * Assente ⇒ `decideWorktreeReap` non propone nemmeno `commit-residue`.
   */
  commitResidue?: (wt: GcWorktree) => Promise<boolean>;
  log: (msg: string) => void;
}

/**
 * Un worktree TENUTO può comunque perdere gli artefatti rigenerabili? Sì,
 * quando nessuno sta per riaprirlo a breve.
 *
 * `review` è il caso che conta — la card consegnata che aspetta un umano — e
 * `done`/archiviato/orfano sono già finiti. `backlog` e `todo` NO: sono in coda
 * per il dispatcher, e snellirli trenta secondi prima che un agent ci entri
 * regalerebbe un `bun install` senza liberare niente per più di quei trenta
 * secondi. `in_progress` men che meno: lì dentro c'è qualcuno.
 */
export function shouldSlimOnKeep(taskStatus: TaskStatus | null, taskArchived: boolean): boolean {
  if (taskStatus === null) return true;
  if (taskArchived) return true;
  return taskStatus === "review" || taskStatus === "done";
}

export interface WorktreeGcSummary {
  total: number;
  reaped: number;
  landed: number;
  /** Checkouts freed under a task abandoned in `in_progress` (branch kept). */
  abandoned: number;
  /**
   * Righe fantasma sciolte da un task che NON è stato declassato: la sua
   * consegna è su main, o sta in review ad aspettare una persona. Contate a
   * parte da `abandoned` apposta — sommarle direbbe che quattro card sono
   * fallite mentre quattro card avevano appena funzionato.
   */
  unbound: number;
  /** Cartelle liberate su task CHIUSI, con il branch conservato (`free-checkout`). */
  freed: number;
  kept: number;
  /**
   * Worktree le cui modifiche non committate sono state salvate sul branch
   * prima di liberare il checkout. Contati a parte da `freed` apposta: dicono
   * quante volte la potatura ha SCRITTO qualcosa invece di limitarsi a
   * cancellare, ed è il numero da guardare se un residuo va cercato.
   */
  residueCommitted: number;
  /** Worktree TENUTI a cui sono stati tolti gli artefatti rigenerabili. */
  slimmed: number;
  /** Byte liberati dallo snellimento (i `reap`/`free-checkout` non contano qui). */
  slimmedBytes: number;
  errors: number;
  /**
   * PERCHÉ i `kept` sono stati tenuti, contati per motivo.
   *
   * Il motivo veniva calcolato (`decideWorktreeReap` lo restituisce) e poi
   * buttato via: la passata stampava «38 kept» e nient'altro. Con quel numero
   * soltanto, un accumulo LEGITTIMO (lavoro non ancora landato) e uno PATOLOGICO
   * (righe fantasma, decisioni bloccate) sono indistinguibili — e uno sprawl che
   * non si sa spiegare ricresce in silenzio, che è esattamente com'è ricresciuto.
   *
   * Il testo è la ragione della decisione, normalizzata: le parti variabili
   * (numero di giorni, di file) sono tolte, altrimenti ogni worktree sarebbe una
   * categoria a sé e il conteggio non aggregherebbe niente.
   */
  keptReasons: Record<string, number>;
}

/**
 * Toglie le parti variabili da una ragione, così motivi uguali si sommano.
 *
 * Solo i NUMERI: «fermo da 9 giorni» e «fermo da 12 giorni» sono la stessa
 * categoria. Gli stati fra apici (`task 'review' attivo`) restano, perché sono
 * un insieme chiuso di cinque valori e distinguerli è l'informazione utile —
 * «tenuti perché il task è in review» e «tenuti perché è in backlog» chiedono
 * due azioni diverse.
 */
export function normalizeKeepReason(reason: string): string {
  return reason.replace(/\d+/g, "N").trim();
}

/**
 * One sweep pass. Best-effort and side-effect-isolated: any single worktree
 * failing (git hiccup, race with a manual delete) is logged and skipped, never
 * aborting the rest.
 */
export async function sweepWorktrees(deps: WorktreeGcDeps): Promise<WorktreeGcSummary> {
  const worktrees = deps.listWorktrees();
  const summary: WorktreeGcSummary = {
    total: worktrees.length, reaped: 0, landed: 0, abandoned: 0, unbound: 0, freed: 0, kept: 0,
    residueCommitted: 0, slimmed: 0, slimmedBytes: 0, errors: 0, keptReasons: {},
  };
  /** Un keep senza motivo registrato e' un keep che nessuno puo' spiegare. */
  const keep = (reason: string) => {
    summary.kept += 1;
    const k = normalizeKeepReason(reason);
    summary.keptReasons[k] = (summary.keptReasons[k] ?? 0) + 1;
  };

  /**
   * Libera la cartella tenendo il branch, e lo DICE sul task.
   *
   * La riga sul task non è cortesia: chi torna su una card chiusa e trova la
   * cartella sparita deve leggere, lì, dove sta il suo lavoro — altrimenti
   * «liberato lo spazio» e «perso il lavoro» si assomigliano troppo. Restituisce
   * `false` quando non si è potuto fare, così il chiamante ripiega su `keep`.
   */
  async function freeCheckout(wt: GcWorktree, taskId: string | null, reason: string): Promise<boolean> {
    if (!deps.freeCheckout) return false;
    // PRIMA di liberare, non dopo: dopo, il ramo non è più nominabile da nessuno
    // (la riga `worktrees` sparisce e con lei l'unico modo che la card ha di
    // risalirci). Il timbro è ciò che tiene la card LANDABILE, ed è il motivo
    // per cui questa funzione ha bisogno di sapere il task.
    if (taskId && wt.branchName) {
      try { deps.stampDeliveryBranch?.(taskId, wt.branchName); }
      catch (err) { deps.log(`[worktree-gc] timbro del ramo fallito per ${taskId}: ${String(err)}`); }
    }
    const ok = await deps.freeCheckout(wt.id);
    if (!ok) return false;
    summary.freed += 1;
    deps.log(`[worktree-gc] checkout liberato ${wt.branchName ?? wt.id} — ${reason} (branch conservato)`);
    if (taskId && wt.branchName) {
      deps.noteOnTask?.(
        taskId,
        `🧹 Cartella del worktree liberata per fare spazio: ${reason}. ` +
        `Il lavoro NON è perso: vive sul branch \`${wt.branchName}\`, che è intatto ` +
        `(\`git log main..${wt.branchName}\` per vederlo, \`git switch ${wt.branchName}\` per riprenderlo).`,
      );
    }
    return true;
  }

  /**
   * TENUTA, MA NON PIENA. Un worktree che resta in piedi non deve restare
   * pesante: gli artefatti rigenerabili se ne vanno comunque, e la cartella, il
   * branch e i file tracciati restano esattamente com'erano.
   *
   * Best-effort come tutto il resto della passata: uno snellimento che fallisce
   * è un peccato, non un motivo per interrompere il giro.
   */
  async function slimKept(wt: GcWorktree, taskStatus: TaskStatus | null, taskArchived: boolean, present: boolean) {
    if (!deps.slim || !present || !shouldSlimOnKeep(taskStatus, taskArchived)) return;
    try {
      const bytes = await deps.slim(wt);
      if (bytes > 0) {
        summary.slimmed += 1;
        summary.slimmedBytes += bytes;
      }
    } catch (err) {
      deps.log(`[worktree-gc] slim fallito su ${wt.branchName ?? wt.id}: ${(err as Error)?.message ?? err}`);
    }
  }

  for (const wt of worktrees) {
    try {
      const t = deps.resolveTask(wt.id);
      const taskId = t.taskId;

      // Never reap under a live turn, even if the task row reads terminal.
      if (taskId && deps.isBusy(taskId)) { keep("turno in corso sul task"); continue; }

      const branch = wt.mode === "branch" ? await deps.branchStatus(wt).catch(() => "unmerged" as BranchStatus) : "merged";

      // Ghost row: a `branch`-mode worktree whose branch is already gone holds
      // nothing — the disk dir (if any) is a leftover, the row is dead weight.
      // Reap directly (the manager prunes the missing dir + deletes the row).
      if (wt.mode === "branch" && branch === "gone") {
        // …unless a task still claims to be working in it. Deleting the row
        // under a live binding leaves the task pointing at a cwd that no longer
        // resolves, and its next resume would run in the base repo. Slegarlo
        // prima è obbligatorio in ogni caso; se sia anche un FALLIMENTO lo
        // decide `decideGhostRow`, non il fatto che il ref non risolva.
        const status = taskId ? (t as { status: TaskStatus }).status : null;
        const landed = taskId && deps.deliveryLanded
          ? await deps.deliveryLanded(taskId, wt).catch(() => null)
          : null;
        const ghost = decideGhostRow({
          taskStatus: status,
          taskArchived: taskId ? !!(t as { archived?: boolean }).archived : false,
          deliveryLanded: landed,
        });
        if (taskId && ghost.task === "park" && deps.abandon) {
          const ok = await deps.abandon(taskId, wt, ghost.reason);
          if (ok) { summary.abandoned += 1; deps.log(`[worktree-gc] abbandonato ${wt.branchName ?? wt.id} — branch sparito sotto un task '${status}'`); }
          else keep("parcheggio fallito su branch sparito");
          continue;
        }
        if (taskId && ghost.task === "unbind" && deps.unbind) {
          const ok = await deps.unbind(taskId, wt, ghost.reason, landed === true);
          if (ok) { summary.unbound += 1; deps.log(`[worktree-gc] slegato ${wt.branchName ?? wt.id} — ${ghost.reason} (task '${status}' fermo dov'era)`); }
          else keep("scioglimento fallito su branch sparito");
          continue;
        }
        // Un task vivo senza il mezzo per slegarlo in sicurezza: si tiene la
        // riga, che è l'unica cosa che ancora dice dove stava.
        if (taskId && ghost.task !== "none") { keep(`branch sparito ma l'host non sa ${ghost.task === "park" ? "parcheggiare" : "slegare"}`); continue; }
        const ok = await deps.reap(wt.id);
        if (ok) { summary.reaped += 1; deps.log(`[worktree-gc] reaped ${wt.branchName ?? wt.id} — branch già sparito (riga fantasma)`); }
        else summary.errors += 1;
        continue;
      }

      // A removed worktree dir can hold no uncommitted work; only inspect the
      // tree for dirt when it actually exists.
      const present = deps.diskPresent(wt.absPath);
      // Cartella assente = niente lavoro non committato, ed e' un fatto letto,
      // non un default. Cartella presente ma sonda muta (`ok: false`, incluso il
      // reject) = SPORCA: chi non ha potuto guardare non ha il diritto di
      // distruggere.
      const probe: { ok: boolean; paths: string[]; unregistered?: boolean } = present
        ? await deps.realDirt(wt.absPath).catch(() => ({ ok: false, paths: [] as string[] }))
        : { ok: true, paths: [] as string[] };
      const dirt = probe.paths;
      const unregistered = probe.unregistered === true;
      const taskStatus = taskId ? (t as { status: TaskStatus }).status : null;
      const taskArchived = taskId ? (t as { archived: boolean }).archived : false;

      // An unregistered folder has one question left: is the work on main?
      // The branch answers by ancestry; the card's delivery answers by CONTENT,
      // which survives a squashed land. Asked only here, because anywhere else
      // the answer would not change the decision.
      const landedForUnregistered = unregistered && branch !== "merged" && taskId && deps.deliveryLanded
        ? await deps.deliveryLanded(taskId, wt).catch(() => null)
        : null;

      let decision = decideWorktreeReap({
        taskStatus,
        taskArchived,
        canCommitResidue: !!deps.commitResidue,
        hasRealDirt: !probe.ok || dirt.length > 0,
        unregistered,
        mergedIntoMain: branch === "merged" || landedForUnregistered === true,
        branchGone: branch === "gone",
        autoMergeEnabled: deps.autoMergeEnabled(wt.projectId),
        mode: wt.mode,
        // Measured only for a task that could BE abandoned: for everything else
        // the answer changes nothing and the probe (a stat on the transcript)
        // isn't worth doing.
        idleDays:
          taskId && deps.idleDays && (t as { status: TaskStatus }).status === "in_progress"
            ? deps.idleDays(taskId)
            : null,
        abandonAfterDays: deps.abandonAfterDays,
      });

      // IL RESIDUO PRIMA DELLA RESA. La cartella è l'unica copia solo finché
      // nessuno ha copiato: si prova a farlo, e solo se non riesce si torna
      // alla vecchia risposta — che a quel punto è di nuovo quella giusta.
      if (decision.action === "commit-residue") {
        const saved = deps.commitResidue ? await deps.commitResidue(wt).catch(() => false) : false;
        if (saved) {
          summary.residueCommitted += 1;
          deps.log(`[worktree-gc] residuo salvato sul branch ${wt.branchName ?? wt.id} — la cartella non è più l'unica copia`);
          if (await freeCheckout(wt, taskId, "modifiche non committate salvate sul branch")) continue;
        }
        decision = { action: "keep", reason: "modifiche non committate (junk escluso)" };
      }

      if (decision.action === "keep") {
        keep(decision.reason);
        // Modifiche non committate: il worktree sopravvive, ma l'umano deve
        // saperlo — altrimenti non sa dove cercare il lavoro. Senza questa
        // nota la card era silenziosa anche quando il suo worktree conteneva
        // l'unica copia del lavoro non committato (misurato il 18/08 su
        // `eef64e32`: `groovy-frond` era vivo ma nessuno sapeva dove guardare).
        //
        // La condizione legge la ragione, non un flag a parte: "modifiche non
        // committate" è l'unica nota che `decideWorktreeReap` aggiunge quando
        // si ferma per sporco, e nient'altro usa quella stringa.
        if (taskId && decision.reason.includes("non committate")) {
          const dirtNote = (!probe.ok)
            ? `⚠️ Worktree \`${wt.branchName ?? wt.id}\` tenuto: la sonda git non ha risposto (path: \`${wt.absPath}\`). ` +
              "Verificare a mano: potrebbe contenere lavoro non committato."
            : `⚠️ Worktree \`${wt.branchName ?? wt.id}\` tenuto per modifiche non committate (path: \`${wt.absPath}\`). ` +
              "Il lavoro non si perde, ma non e' su nessun commit: committare o salvare prima di eliminare il worktree.";
          // SERVICE E UNA VOLTA SOLA. La condizione «worktree sporco» dura finche'
          // qualcuno non tocca quella cartella, e il GC ripassa ogni 30 minuti:
          // senza questi due flag la stessa frase da 244 caratteri si riscrive
          // per giorni. Misurato il 18/08: 108 copie su 12 card in quattro ore,
          // dieci-dodici byte-per-byte sulla stessa card. Il testo poi e'
          // un'ISTRUZIONE PER L'AGENTE («committare o salvare prima di eliminare
          // il worktree») recapitata nel thread di chi deve solo decidere.
          deps.noteOnTask?.(taskId, dirtNote, { kind: "service", once: true });
        }
        await slimKept(wt, taskStatus, taskArchived, present);
        continue;
      }

      if (decision.action === "free-checkout") {
        if (!(await freeCheckout(wt, taskId, decision.reason))) {
          keep(decision.reason);
          // Il `free-checkout` non è riuscito (l'host non sa farlo, o git ha
          // rifiutato): la cartella resta, e allora almeno non resta piena.
          await slimKept(wt, taskStatus, taskArchived, present);
        }
        continue;
      }

      if (decision.action === "abandon") {
        // Needs both a task to park and a host able to do it; without either,
        // keeping is the only safe answer.
        if (!taskId || !deps.abandon) { keep(taskId ? "da abbandonare ma l'host non sa parcheggiare" : "da abbandonare ma senza task a cui agganciarsi"); continue; }
        const ok = await deps.abandon(taskId, wt, decision.reason);
        if (ok) {
          summary.abandoned += 1;
          deps.log(`[worktree-gc] abbandonato ${wt.branchName ?? wt.id} — ${decision.reason} (branch conservato)`);
        } else {
          keep("parcheggio del task abbandonato fallito");
        }
        continue;
      }

      if (decision.action === "land-then-reap") {
        // Needs a real task to land. An orphan (taskId null) with unmerged
        // commits can't be landed → keep it for a human rather than lose work.
        if (!taskId) {
          // Nessun task a cui landare — ma il BRANCH raggiunge ancora quei
          // commit, quindi la cartella è una copia in più esattamente come nel
          // ramo `free-checkout` di `decideWorktreeReap`. Tenerla per sempre
          // non protegge nessun commit: costa solo disco.
          if (wt.mode === "branch" && branch !== "gone"
              && await freeCheckout(wt, null, "orfano: nessun task a cui landare, branch conservato")) continue;
          keep("commit non su main e nessun task a cui landarli (orfano)");
          await slimKept(wt, taskStatus, taskArchived, present);
          continue;
        }
        const outcome = await deps.tryLand(taskId);
        if (outcome === "landed") summary.landed += 1;

        // VERIFY BEFORE DESTROY. Re-read the repo — the land's own verdict is
        // not evidence (see `decidePostLandReap`).
        const [branchAfter, probeAfter] = await Promise.all([
          deps.branchStatus(wt).catch(() => "unmerged" as BranchStatus),
          deps.diskPresent(wt.absPath)
            ? deps.realDirt(wt.absPath).catch(() => ({ ok: false, paths: [] as string[] }))
            : Promise.resolve({ ok: true, paths: [] as string[] }),
        ]);
        const dirtAfter = probeAfter.paths;
        const post = decidePostLandReap({ outcome, branchAfter, dirtAfter, dirtReadable: probeAfter.ok });
        // Il land non è passato (quasi sempre: il cancello di `03ca44c3` rifiuta
        // un branch che porta commit di un'altra sessione), ma l'albero è pulito
        // e il branch c'è. I commit restano dove sono; la cartella no.
        //
        // Se l'host non sa liberare un checkout si ricade nel `keep` qui sotto,
        // NOTA COMPRESA: la riga che avverte «il branch è conservato, verificalo»
        // è l'unica cosa che rende visibile un worktree tenuto in vita, e perderla
        // in silenzio riaprirebbe il buco da otto giorni che l'ha fatta scrivere.
        if (post.action === "free-checkout" && await freeCheckout(wt, taskId, post.reason)) continue;
        if (post.action === "keep" || post.action === "free-checkout") {
          deps.log(`[worktree-gc] keep ${wt.branchName ?? wt.id}: ${post.reason}`);
          if (outcome === "landed" || outcome === "nothing") {
            // Anche qui si dice solo ciò che è stato VERIFICATO: `branchAfter` è
            // la ri-lettura del repo dopo il land. Un keep può nascere dallo
            // sporco nel tree con il branch già cancellato dal land stesso, e in
            // quel caso «il branch è stato conservato» sarebbe falso — la stessa
            // bugia del task `5770b9de`, vista da questo lato.
            const branchNote = branchAfter === "gone"
              ? `Il branch \`${wt.branchName ?? wt.id}\` NON è più nel repo: quello che resta è nel worktree, controllalo prima che sparisca.`
              : `Il branch \`${wt.branchName ?? wt.id}\` è stato conservato. Verifica a mano prima di cancellarlo.`;
            // Stessa famiglia: si riscrive a ogni passata finche' il worktree
            // resta li'. Il FATTO conta (il ramo puo' non esserci piu'), la
            // ripetizione no.
            deps.noteOnTask?.(taskId, `⚠️ Worktree NON ripulito: ${post.reason}. ${branchNote}`, { once: true });
          }
          keep(post.reason);
          await slimKept(wt, taskStatus, taskArchived, deps.diskPresent(wt.absPath));
          continue;
        }
      }

      const ok = await deps.reap(wt.id);
      if (ok) {
        summary.reaped += 1;
        deps.log(`[worktree-gc] reaped ${wt.branchName ?? wt.id} — ${decision.reason}`);
        // The folder vanishes without anyone asking: say it ONCE, and say the
        // real fact (registration lost, work on main), never "may hold
        // uncommitted work".
        if (unregistered && taskId) {
          deps.noteOnTask?.(
            taskId,
            `🧹 Cartella del worktree \`${wt.branchName ?? wt.id}\` non più registrata in git, rimossa (path: \`${wt.absPath}\`). Il lavoro è su main.`,
            { kind: "service", once: true },
          );
        }
      } else {
        summary.errors += 1;
      }
    } catch (err) {
      summary.errors += 1;
      deps.log(`[worktree-gc] error on ${wt.id}: ${(err as Error)?.message ?? err}`);
    }
  }

  if (summary.reaped || summary.landed || summary.abandoned || summary.freed || summary.residueCommitted || summary.slimmed || summary.errors) {
    deps.log(
      `[worktree-gc] sweep done: ${summary.reaped} reaped, ${summary.landed} landed, ` +
      `${summary.freed} checkout liberati, ${summary.residueCommitted} residui salvati, ` +
      `${summary.abandoned} abbandonati, ` +
      `${summary.slimmed} snelliti (${(summary.slimmedBytes / 1_048_576).toFixed(0)} MB), ` +
      `${summary.kept} kept, ${summary.errors} errors (of ${summary.total})`,
    );
  }
  // I MOTIVI dei kept, sempre — anche quando la passata non ha fatto altro.
  //
  // La riga sopra è condizionata a reap/land/abbandoni/errori: una passata che
  // tiene TUTTO non stampava niente. È così che 38 worktree tenuti sono
  // diventati invisibili — nessuna riga, nessun numero, nessun perché, mentre
  // sul disco crescevano. Un GC che tace quando non agisce è indistinguibile da
  // un GC che non gira.
  //
  // Ordinati per frequenza: la categoria più grossa è quella su cui vale la
  // pena agire, e va letta per prima.
  const reasons = Object.entries(summary.keptReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    deps.log(
      `[worktree-gc] ${summary.kept} tenuti (di ${summary.total}) — ` +
      reasons.map(([r, n]) => `${n}× ${r}`).join("; "),
    );
  }
  return summary;
}
