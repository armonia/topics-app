/**
 * LA FOTOGRAFIA DI CONSEGNA, IN UN POSTO SOLO.
 *
 * ── Cosa fa ────────────────────────────────────────────────────────────────
 * Chiede al worktree del task qual e' il suo ramo, il suo ultimo commit PROPRIO
 * e quanto lavoro c'e' dentro, lo scrive sulla card (`recordDelivery`) e ne
 * deriva le etichette dai file toccati (`deriveLabelsFromDiff`). E' cio' che
 * permette alla colonna review di dire «7 file, +240 −18» invece di «Approva».
 *
 * ── Perche' e' stata estratta ──────────────────────────────────────────────
 * Ne esistevano TRE copie, e la terza mancava proprio dove serviva di piu':
 *
 *   1. `routes/tasks.ts` `captureDelivery` — sull'edge verso `review`.
 *   2. `routes/tasks.ts` — nel ramo che sceglie il vincitore di un fan-out.
 *   3. `services/task-dispatcher.ts` `onTurnEnd` — NON C'ERA. La consegna
 *      forzata dal sistema leggeva `cur.deliveryBranch` e `cur.deliveryFilesChanged`
 *      su una riga che nessuno aveva ancora scritto, e concludeva sempre la
 *      stessa cosa: «nessun ramo e nessun file toccato».
 *
 * Misurato il 2026-08-18 sulla card `cf15dea6`: il commento di sistema diceva
 * «Nessun lavoro consegnato: 4 turni, nessun ramo e nessun file toccato. Non
 * c'e' un diff da guardare» — mentre il ramo `topics/full-finch` portava il
 * commit `af248dcf9`, il worktree era pulito e tutti e cinque i sottotask erano
 * chiusi. La card mandava il reviewer a non guardare un lavoro finito.
 *
 * Il commento accanto al codice del dispatcher rivendicava «la differenza la
 * sanno le colonne, non il testo». Le colonne lo sanno, ma solo dopo che
 * qualcuno le ha scritte — e li' nessuno lo faceva.
 *
 * ── Best-effort, sempre ────────────────────────────────────────────────────
 * Un singhiozzo di git non deve MAI rifiutare una consegna: ogni errore si
 * ingoia e la card resta senza fotografia, che e' un silenzio onesto. Senza
 * etichetta la card la chiude un umano, che e' il default sicuro.
 */
import type { TaskFile } from "../../shared/task-labels";

export interface DeliveryRef {
  branch: string;
  commit: string | null;
  /** L'entita' del lavoro consegnato, quando git ha saputo dirla. */
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

export interface DeliveryCaptureDeps {
  /** Solo cio' che serve: la fotografia non deve poter fare altro. */
  svc: {
    recordDelivery(args: {
      taskId: string;
      branch: string;
      commit: string | null;
      stat: { filesChanged: number; insertions: number; deletions: number } | null;
    }): unknown;
    deriveLabelsFromDiff(args: { taskId: string; files: TaskFile[] }): unknown;
  };
  /** Il ramo e il commit PROPRI della card. `null` ⇒ niente da fotografare. */
  taskDeliveryRef?: (taskId: string) => Promise<DeliveryRef | null>;
  /** Dove sta il worktree della card, per leggere i file dei suoi commit. */
  taskCheckoutRef?: (taskId: string) => Promise<{ cwd: string; commit: string | null } | null>;
  /** I file dei commit propri, `null` quando non sono contabili. */
  ownCommitFiles: (cwd: string) => Promise<TaskFile[] | null>;
}

export interface DeliveryCapture {
  /**
   * Scrive la fotografia e le etichette. Torna `true` se ha scritto qualcosa,
   * cioe' se da adesso la card ha un ramo da mostrare.
   */
  (taskId: string): Promise<boolean>;
}

export function createDeliveryCapture(deps: DeliveryCaptureDeps): DeliveryCapture {
  return async function capture(taskId: string): Promise<boolean> {
    let scritto = false;
    if (deps.taskDeliveryRef) {
      try {
        const ref = await deps.taskDeliveryRef(taskId);
        // `null` ⇒ task in-place senza branch: non c'e' niente contro cui
        // confrontarsi, e inventare uno zero direbbe «non ha prodotto niente».
        if (ref) {
          deps.svc.recordDelivery({
            taskId,
            branch: ref.branch,
            commit: ref.commit,
            // `undefined` ⇒ NULL in colonna, cioe' «non misurato»: sulla card e'
            // un silenzio, non uno zero.
            stat: ref.filesChanged === undefined ? null : {
              filesChanged: ref.filesChanged,
              insertions: ref.insertions ?? 0,
              deletions: ref.deletions ?? 0,
            },
          });
          scritto = true;
        }
      } catch { /* mai bloccare una consegna su git */ }
    }
    // LE ETICHETTE SOLO SE C'E' UNA CONSEGNA, e non e' un'ottimizzazione: senza
    // ramo non c'e' niente da etichettare, e chiedere comunque i file al
    // worktree disturba git su ogni PATCH di una board che non ha nemmeno un
    // gate. Lo pinna `tasks.test.ts` — «board senza comandi: nemmeno il git
    // viene disturbato» — che e' andato rosso appena l'ordine e' cambiato.
    if (!scritto) return false;
    if (deps.taskCheckoutRef) {
      try {
        const ref = await deps.taskCheckoutRef(taskId).catch(() => null);
        if (ref) {
          const files = await deps.ownCommitFiles(ref.cwd);
          // `null` ⇒ non contabile: non si scrive un verdetto a caso.
          if (files !== null) deps.svc.deriveLabelsFromDiff({ taskId, files });
        }
      } catch { /* l'etichetta non puo' far fallire una consegna */ }
    }
    return scritto;
  };
}
