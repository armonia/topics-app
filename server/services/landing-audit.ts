/**
 * Landing audit — "done" must mean "è nel prodotto".
 *
 * The failure this exists for: on 2026-07-19 a task was approved, its branch was
 * reaped, and its 139 lines never reached main. Nobody noticed for 8 days,
 * because the board's notion of "done" was a column, not a fact about the repo.
 *
 * The audit closes that loop. At delivery time (the transition into `review`) we
 * record the branch tip — the COMMIT, because the branch itself is reaped as
 * soon as it lands and cannot be the durable handle. Periodically we ask the
 * repo whether that commit's content is on main, by CONTENT rather than
 * ancestry so a squash-land still reads as landed, and stamp the verdict on the
 * task. The board then shows the number of delivered-but-not-landed tasks.
 *
 * Deliberately conservative: a commit the repo no longer has is `unverifiable`,
 * never `unlanded`. A false "all good" is what cost us the work; a false alarm
 * would cost trust just as fast.
 */

import type { BranchStatus } from "./branch-status";
import type { LandingEsito } from "./landing-verdict";

/** 'landed' = content is on main · 'unlanded' = provably not · 'unverifiable' = can't tell. */
export type LandingState = "landed" | "unlanded" | "unverifiable";

export interface AuditTask {
  id: string;
  projectId: string;
  /** Branch recorded at delivery time (diagnostics / the message to the human). */
  deliveryBranch: string | null;
  /** Branch tip recorded at delivery time — the durable handle. */
  deliveryCommit: string | null;
}

/** Map a repo verdict onto the audit's vocabulary. Pure. */
export function classifyLanding(status: BranchStatus): LandingState {
  if (status === "merged") return "landed";
  if (status === "unmerged") return "unlanded";
  // The commit is no longer in the repo (pruned, or the project moved): we
  // cannot answer. Saying "unlanded" here would cry wolf on every old task.
  return "unverifiable";
}

/**
 * IL VERDETTO RICCO, tradotto nel vocabolario di tre stati.
 *
 * `unmerged` è una risposta a una domanda sola («la punta è dentro?»), e la
 * board ne fa un'accusa: «non su main, landalo». Ma fra il lavoro che manca e il
 * lavoro che manca PERCHÉ QUALCUN ALTRO L'HA RIFATTO MEGLIO c'è la differenza fra
 * un debito e un fossile, e sulle 14 card misurate il 13/08 i fossili erano tre.
 * Un elenco dove il debito sta in mezzo ai fossili è un elenco che si smette di
 * leggere, ed è esattamente com'era finito (`landing-verdict.ts`).
 *
 * Quindi solo `fuori` accusa. `superato` e `non-decidibile` diventano «non lo
 * so»: non sono un'assoluzione, sono l'assenza di un'accusa — e la pastiglia
 * rossa, che vive su `unlanded`, tace (`shared/board.showsLandingDebt`).
 */
export function classifyLandingEsito(esito: LandingEsito): LandingState {
  if (esito === "dentro") return "landed";
  if (esito === "fuori") return "unlanded";
  return "unverifiable";
}

export interface LandingAuditDeps {
  /**
   * Tasks worth auditing: not archived, terminal-or-delivered (`review`/`done`)
   * and carrying a recorded delivery commit.
   */
  listCandidates: () => AuditTask[];
  /** Absolute path of the project's main checkout, or null when unknown. */
  repoPath: (projectId: string) => string | null;
  /** Content-aware status of a commit relative to main (commitStatusFromRepo). */
  commitStatus: (repoPath: string, commit: string) => Promise<BranchStatus>;
  /**
   * LA SECONDA DOMANDA, e si paga solo su chi ha già risposto «fuori».
   *
   * `commitStatus` costa tre comandi git e chiude il caso su quasi tutte le
   * card. Quando dice `unmerged` non ha ancora finito di chiedere: restano la
   * patch inversa sul ramo vivo e la supersessione, che costano un indice delle
   * righe di main e vanno pagate solo qui — su una board di 234 consegne
   * riguardano dieci righe.
   *
   * Assente ⇒ ci si ferma alla prima risposta: l'audit resta quello di prima,
   * più severo, mai più permissivo.
   */
  debtVerdict?: (task: AuditTask, repoPath: string) => Promise<LandingState>;
  /** Persist the verdict (landing_state + landing_checked_at). */
  record: (taskId: string, state: LandingState, checkedAt: string) => void;
  /** Called once per task that flipped INTO `unlanded` — the human must see it. */
  onNewlyUnlanded?: (task: AuditTask) => void;
  /** Previous verdict, to detect the edge into `unlanded`. */
  previousState: (taskId: string) => LandingState | null;
  now: () => string;
  log: (msg: string) => void;
}

export interface LandingAuditSummary {
  checked: number;
  landed: number;
  unlanded: number;
  unverifiable: number;
}

/**
 * One audit pass. Best-effort per task: a git hiccup on one project never
 * aborts the sweep, and an unreadable repo yields `unverifiable`, not a scare.
 */
export async function auditLandings(deps: LandingAuditDeps): Promise<LandingAuditSummary> {
  const summary: LandingAuditSummary = { checked: 0, landed: 0, unlanded: 0, unverifiable: 0 };
  const checkedAt = deps.now();

  for (const task of deps.listCandidates()) {
    if (!task.deliveryCommit) continue;
    try {
      const repo = deps.repoPath(task.projectId);
      let state: LandingState = repo
        ? classifyLanding(await deps.commitStatus(repo, task.deliveryCommit))
        : "unverifiable";
      // Un `unlanded` è un'ACCUSA, e prima di scriverla si chiede la seconda
      // volta: il contenuto potrebbe essere di là comunque (la patch inversa),
      // oppure quel lavoro potrebbe averlo rifatto qualcun altro, e allora non
      // c'è niente da landare.
      if (state === "unlanded" && repo && deps.debtVerdict) {
        state = await deps.debtVerdict(task, repo);
      }

      const before = deps.previousState(task.id);
      deps.record(task.id, state, checkedAt);
      summary.checked += 1;
      summary[state] += 1;

      if (state === "unlanded" && before !== "unlanded") {
        deps.log(
          `[landing-audit] ${task.id}: consegnato su ${task.deliveryBranch ?? "?"} ` +
          `(${task.deliveryCommit.slice(0, 8)}) ma NON su main`,
        );
        deps.onNewlyUnlanded?.(task);
      }
    } catch (err) {
      summary.unverifiable += 1;
      deps.log(`[landing-audit] error on ${task.id}: ${(err as Error)?.message ?? err}`);
    }
  }

  if (summary.unlanded > 0) {
    deps.log(`[landing-audit] ${summary.unlanded}/${summary.checked} task consegnati NON sono su main`);
  }
  // `unverifiable` è conservativo per scelta, e per questo è anche il posto
  // dove un audit rotto si nasconde: se `repoPath` non risolve più nulla, ogni
  // task diventa "non so" e il contatore resta muto mentre non verifica NIENTE
  // (è successo: il wiring cercava il board id nel ProjectStore, dove non c'è
  // mai stato). Un verdetto mancante va DETTO, non solo contato.
  if (summary.unverifiable > 0) {
    deps.log(
      `[landing-audit] ${summary.unverifiable}/${summary.checked} non verificabili ` +
      "(commit potato o progetto non risolto)",
    );
  }
  return summary;
}
