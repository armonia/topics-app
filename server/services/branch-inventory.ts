/**
 * I rami locali che NON sono su main, con il task a cui appartengono.
 *
 * PERCHÉ. La board sa dire «N task chiusi il cui lavoro non risulta su main»,
 * ma solo per i task CHIUSI: un ramo che appartiene a un task ancora in backlog
 * — o a nessun task — non compare da nessuna parte. È così che quattro rami con
 * lavoro fatto e verificato sono rimasti invisibili per settimane, mentre la
 * board riproponeva come «da fare» cose che erano già scritte lì dentro (task
 * `44e893f4`, scoperto il 04/08 implementando due volte la stessa cosa).
 *
 * E non è solo lavoro duplicato: quei commit vivono su un filo solo. Il
 * cleanup del dispatcher li cancellava quando un task tornava in coda — buco
 * tappato in `afbde262`, ma un ramo che nessuno vede resta un ramo che nessuno
 * salva.
 *
 * COME. Due domande a git (quali rami non sono su main, e quanti commit hanno)
 * e una al DB (di chi sono). L'abbinamento passa per tre strade, in ordine di
 * forza: il branch di consegna registrato sul task, il registro dei worktree, e
 * infine la convenzione del nome. Un ramo che non si abbina resta nell'elenco
 * SENZA task — è anzi il caso più interessante, perché è quello che nessuno
 * reclamerà.
 *
 * La parte pura è l'abbinamento; le due letture (git, DB) sono iniettate.
 */

export interface BranchRow {
  /** Nome del ramo, es. `topics/gallant-plume`. */
  name: string;
  /** Commit che non sono su main. 0 ⇒ il ramo non porta niente di suo. */
  ahead: number;
}

export interface TaskBranchRef {
  taskId: string;
  taskText: string;
  taskStatus: string;
  /** `tasks.delivery_branch`, quando c'è: è la fonte più forte. */
  deliveryBranch?: string | null;
  /** Il ramo del worktree legato al task, se ne ha uno. */
  worktreeBranch?: string | null;
}

export interface InventoryEntry extends BranchRow {
  taskId: string | null;
  taskText: string | null;
  taskStatus: string | null;
  /** Come si è arrivati all'abbinamento — serve a fidarsi o no della riga. */
  matchedBy: "delivery" | "worktree" | "nessuno";
}

/**
 * Abbina i rami ai task. Puro.
 *
 * L'ordine delle fonti NON è arbitrario: `delivery_branch` è ciò che il task ha
 * DICHIARATO di aver consegnato, il worktree è dove stava lavorando. Il primo
 * sopravvive alla potatura del worktree, il secondo no — quindi quando dicono
 * cose diverse vince il primo.
 *
 * Non c'è un ripiego «sul nome che somiglia»: due rami possono chiamarsi in modo
 * simile per caso, e un abbinamento sbagliato è peggio di nessun abbinamento —
 * manderebbe qualcuno a cercare il lavoro nel task sbagliato.
 */
export function buildBranchInventory(
  branches: readonly BranchRow[],
  tasks: readonly TaskBranchRef[],
): InventoryEntry[] {
  const byDelivery = new Map<string, TaskBranchRef>();
  const byWorktree = new Map<string, TaskBranchRef>();
  for (const t of tasks) {
    if (t.deliveryBranch) byDelivery.set(t.deliveryBranch, t);
    if (t.worktreeBranch) byWorktree.set(t.worktreeBranch, t);
  }
  return branches.map((b) => {
    const t = byDelivery.get(b.name) ?? byWorktree.get(b.name) ?? null;
    const matchedBy: InventoryEntry["matchedBy"] =
      byDelivery.has(b.name) ? "delivery" : byWorktree.has(b.name) ? "worktree" : "nessuno";
    return {
      ...b,
      taskId: t?.taskId ?? null,
      taskText: t?.taskText ?? null,
      taskStatus: t?.taskStatus ?? null,
      matchedBy,
    };
  });
}

/**
 * Il riepilogo in una riga, ordinato per quanto è preoccupante.
 *
 * Un ramo ORFANO (nessun task) è il caso peggiore e va per primo: nessuno lo
 * reclamerà mai. Poi quelli di task ancora aperti — lavoro in corso che la board
 * mostra come «da fare» pur essendo già scritto. Per ultimi quelli dei task
 * chiusi, che il chip «non su main» già segnalava.
 */
export function summarizeInventory(entries: readonly InventoryEntry[]): {
  total: number;
  orphan: number;
  onOpenTasks: number;
  onClosedTasks: number;
} {
  let orphan = 0, onOpenTasks = 0, onClosedTasks = 0;
  for (const e of entries) {
    if (!e.taskId) orphan++;
    else if (e.taskStatus === "done") onClosedTasks++;
    else onOpenTasks++;
  }
  return { total: entries.length, orphan, onOpenTasks, onClosedTasks };
}
