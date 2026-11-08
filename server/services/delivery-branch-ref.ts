/**
 * DOVE CHIEDERE A GIT COSA HA CONSEGNATO UNA CARD, quando la cartella non c'è più.
 *
 * La fotografia della consegna (`deliveryPointer`) ha bisogno di due cose: un
 * checkout in cui parlare con git, e il NOME del ramo. Fin qui le prendeva solo
 * da `worktreeOfTask`, che risolve una catena di tre anelli:
 *
 *     task → `assignedTopicId` → `topic.worktreeId` → riga in `worktrees`
 *
 * Rotto UNO dei tre, la funzione risponde `null` e non si fotografa niente. E
 * gli anelli si rompono da soli, per strada: un re-dispatch riassegna il topic,
 * il GC su free-checkout stacca la cartella, il reap cancella la riga. Da quel
 * momento `delivery_commit` non può più essere riempito da nessuno, mai: il
 * backfill periodico ripassa ogni 30 minuti e cade sullo stesso `null`.
 *
 * Il ramo però la card ce l'ha già. Il GC lo scrive apposta prima di liberare la
 * cartella (`stampDeliveryBranch` → `setDeliveryBranch`), e il commento accanto
 * a quella chiamata dice il perché: è ciò che la tiene landabile dopo che la
 * cartella se n'è andata. Nessuno lo rileggeva. Misurato il 18/08 sulla board di
 * topics-app: 23 card in review/done con `delivery_branch` scritto e
 * `delivery_commit` NULL, e di quelle 13 portavano un'accusa «non è su main» che
 * l'audit non poteva più togliere, perché i suoi candidati filtrano
 * `delivery_commit IS NOT NULL`.
 *
 * Quindi qui si risponde a una domanda sola, e prima di ogni altra: DOVE e su
 * QUALE ramo. La sottrazione dei commit propri resta dov'era.
 *
 * CONTRATTO: `null` = non c'è nessun ramo su cui chiedere. Mai un ripiego
 * inventato. In particolare NON si cade mai sulla punta del worktree (`HEAD`):
 * è esattamente il difetto che `own-commits.ts` esiste per non ripetere, cioè
 * intestare a una card il commit di un'altra sessione.
 */

/** Il minimo che serve del worktree: il resto della riga non riguarda questa domanda. */
export interface DeliveryWorktree {
  mode: "branch" | "reuse" | "detached";
  branchName: string | null;
  /** L'id del progetto nel ProjectStore (UUID), non quello di board. */
  projectId: string;
  absPath: string;
}

/** Cosa la card RICORDA della sua consegna, quando la cartella non c'è più. */
export interface RecordedDelivery {
  /** L'id di BOARD del progetto (`projectIdForPath`), non un UUID dello store. */
  projectId: string;
  deliveryBranch: string | null;
}

export interface DeliveryBranchRef {
  /** Il checkout in cui fare le domande. I ref sono condivisi fra i worktree. */
  repoPath: string;
  branch: string;
  /**
   * La cartella del worktree, se è ancora viva. `null` = restano solo i ref, e
   * chi misura l'albero di lavoro deve saperlo invece di leggere quello altrui.
   */
  worktreePath: string | null;
  /** Da dove viene la risposta. Serve a chi la registra e a chi la legge nei test. */
  source: "worktree" | "card";
}

export interface DeliveryBranchDeps {
  worktreeOfTask: (taskId: string) => DeliveryWorktree | null;
  /** Il checkout principale di un progetto dello store (UUID). */
  storeRepoPath: (projectId: string) => string | null;
  /** Il progetto di board e il ramo che la card si è tenuta. */
  recordedDelivery: (taskId: string) => RecordedDelivery | null;
  /** Il checkout di un progetto di BOARD, l'hash invertito come fa il dispatch. */
  boardRepoPath: (boardProjectId: string) => string | null;
  /** Il ramo risolve ancora in quel repo? Un nome che non risolve non è un ramo. */
  branchExists: (repoPath: string, branch: string) => Promise<boolean>;
}

/**
 * Il worktree per primo, che è la strada calda e l'unica che conosce anche la
 * cartella; il ramo scritto sulla card come RIPIEGO, e solo se quel ramo esiste
 * ancora davvero nel repo.
 *
 * Il controllo di esistenza non è prudenza di troppo: su un ramo potato ogni
 * domanda successiva torna `null` comunque (`rev-list` esce non-zero), ma
 * restituire un riferimento che non risolve farebbe scrivere a chi chiama
 * «verificato: nessun commit proprio» dove la verità è «non c'è più niente da
 * guardare». Sono le due affermazioni che questo modulo tiene separate ovunque.
 */
export async function resolveDeliveryBranch(
  deps: DeliveryBranchDeps,
  taskId: string,
): Promise<DeliveryBranchRef | null> {
  const wt = deps.worktreeOfTask(taskId);
  if (wt && wt.mode === "branch" && wt.branchName) {
    const repoPath = deps.storeRepoPath(wt.projectId);
    if (repoPath) {
      return { repoPath, branch: wt.branchName, worktreePath: wt.absPath, source: "worktree" };
    }
  }

  const card = deps.recordedDelivery(taskId);
  const branch = card?.deliveryBranch?.trim();
  if (!card || !branch) return null;
  const repoPath = deps.boardRepoPath(card.projectId);
  if (!repoPath) return null;
  if (!(await deps.branchExists(repoPath, branch))) return null;
  return { repoPath, branch, worktreePath: null, source: "card" };
}
