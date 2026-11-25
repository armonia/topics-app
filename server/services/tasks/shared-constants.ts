/**
 * Constants, the service error and the delivery-note tracking shared by the task
 * service modules. Split out of `shared.ts` so the factory modules can import
 * them without a cycle.
 */

import type { Database } from "bun:sqlite";
import type { ServiceOpts, TaskService } from "../tasks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { PREVIEW_CARD_MAX_RATIO, type SubtaskWork, deriveSubtaskWork, isUnattributedSubtask, type CardComment, DISPATCH_CHIP_QUEUED, isAgentWorking, QUEUE_REASON_UNKNOWN, type QueueReason, WAITING_MEMORY_REASON, deriveQueueReason, readTaskWeight, REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL, PROMOTE_PARKED_LABEL, type TaskComment, type TaskActionOrigin, formatStatusEvent, statusEventEnters, type TaskStatus, TASK_STATUSES, parseQuestionBlock, questionAsksHuman, type BlockerRef, type QueueContext } from "../../../shared/board";
import { imageShape } from "../image-shape";
import { isDeliverySheetPath, isAutoCapturedPreview } from "../../../shared/media-kind";
import { renderDeliverySheet } from "../delivery-sheet";
import { createHash } from "node:crypto";
import { RUNS_HERE_SQL } from "../agent-census";
import { sliceCodePoints } from "../../lib/code-points";
import { type LabelSource, type TaskLabel, type TaskLabelRow, isTaskLabel } from "../../../shared/task-labels";
import { readElsewhere } from "../task-elsewhere";
import { currentDispatchBlock, currentMemoryWait, heldResumeBlock } from "../dispatch-block-signal";
import { type Task } from "../task-shapes";
import { INCOMPLETE_CARD_NOTICE_PREFIX, agentCardGaps } from "../../../shared/agent-card-contract";
import { awaitsHumanSql, type WorkflowColumn, agentAskInThread } from "../../../shared/workflow";
import { CHILD_AGENT_COMING } from "../../lib/task-timer-reads";
import { type RepoProbe, checkReport as checkDeliveryReport, gitQuestions } from "../deliveryReportChecks";
import { agentAuthorSql } from "../../../shared/comment-author";
import { probeForRoot, repoProbe } from "../deliveryReportProbe";
import { checkStage } from "../board-workflow";
import { waitsLineAsk } from "../../../shared/waits-on-person";
import { EFFORT_TIERS } from "../../../shared/effort";
import { channelKindOfIcon, type ChannelKind, type ChannelPlace } from "../../../shared/channel-origin";
import { agentOfPath } from "../../../shared/agent-home";
import { channelPlaceOf } from "../channel-place";

/** Automatic requeues of a machine-parked card before it stays for a human. */
export const MACHINE_RETRY_CAP = 3;

/** Rounds a `visibile` card may bounce off the no-preview gate before it stays in backlog for a human. */
export const VISIBLE_PREVIEW_BOUNCE_CAP = 2;

/** First delay before a machine-parked card goes back to todo; doubles each round. */
export const MACHINE_RETRY_BASE_MS = 30 * 60_000;

export const STATUSES: readonly TaskStatus[] = TASK_STATUSES;

/**
 * Reserved board id for tasks created WITHOUT a project (e.g. work spanning
 * several projects). They live on the global board only; the dispatcher skips
 * them entirely (an agent needs a cwd) until a human assigns a real board via
 * move — never a park-bounce to backlog.
 */
export const UNASSIGNED_PROJECT_ID = "_none";

/**
 * Virtual board id the composer posts to when the project is on "Auto": the
 * create route resolves the REAL board from the task text (a known project
 * name mentioned in title/description). Never stored on a task — unresolved
 * creates land on UNASSIGNED_PROJECT_ID.
 */
export const AUTO_PROJECT_ID = "_auto";

/**
 * Does this comment ASK the human something, or is it a DELIVERY that merely
 * offers the next board action as a button?
 *
 * The rule itself is `questionAsksHuman` in shared/board.ts — read it there.
 * This is its text-level entry point, and it adds the one thing a parsed block
 * cannot express: a fence that DID NOT PARSE.
 *
 * `parseQuestionBlock` returns null for a hand-written block whose body is all
 * bullets and no question line (```question / - Sì / - No). The old rule was
 * `content.includes("```question")`, so that shape counted as a question and
 * was exempt from the two review gates; reading the parsed options alone
 * silently reclassified it as a DELIVERY — a `delivered` chip and two 409s on a
 * legitimate mid-work question. An unreadable fence is not evidence of a
 * delivery: it is a fence we failed to read, and the safe reading of that is
 * the one that stops and asks.
 */
export function commentAsksHuman(content: string | null | undefined): boolean {
  const text = content ?? "";
  const parsed = parseQuestionBlock(text);
  if (!parsed) return text.includes("```question");
  return questionAsksHuman(parsed);
}


/**
 * L'effort di board accetta anche `auto`, come il modello.
 *
 * Fissarlo per tutta una board significa pagare lo stesso sforzo su un typo e su
 * un refactor — e non e' una differenza teorica: misurato il 2026-08-09 sullo
 * stesso micro-task, `medium` costa 61,1k token di lavoro e `xhigh` 108,8k. Su
 * `auto` lo sceglie il classificatore task per task (`task-model-picker.ts`),
 * con pavimento a `medium` cosi' non puo' peggiorare niente in silenzio.
 */
export const VALID_EFFORT = new Set<string>([...EFFORT_TIERS, "auto"]);

/**
 * Le colonne che descrivono LO SNAPSHOT DI UNA CONSEGNA: ramo, commit,
 * diffstat e risultati dei controlli automatici.
 *
 * Una fonte sola per tutti e tre i punti di azzeramento:
 *   - `update()` quando la card esce da review/done verso la coda;
 *   - `reviewDecision("reject")` che scrive a SQL grezzo;
 *   - `recordDelivery` che le sovrascrive con i dati nuovi.
 *
 * Aggiungere una colonna qui la porta automaticamente in tutti e tre i
 * punti: la prossima colonna di consegna non nasce dimenticata da due di loro.
 *
 * `checks_state`/`checks_json`/`checks_commit` fanno parte dello snapshot
 * perche' descrivono la barra verde DI QUELLA CONSEGNA. Su un commit
 * diverso da quello consegnato un verde non e' un verde: `whoCloses` legge
 * `checksState` per decidere se il conduttore puo' chiudere da solo, e
 * senza azzeramento decide su dati di una consegna che non esiste piu'.
 */
/** Consecutive same-tip redeliveries sent back to todo before the card goes to review flagged. */
export const SAME_TIP_BOUNCE_CAP = 2;

export const DELIVERY_SNAPSHOT_COLUMNS = [
  "delivery_branch",
  "delivery_commit",
  "delivery_files_changed",
  "delivery_insertions",
  "delivery_deletions",
  // The work that exists WITHOUT a commit, counted at delivery time. It is part
  // of the snapshot for the same reason as the diffstat: sent back to the queue
  // the card starts a new turn, and the old count would describe a worktree the
  // next turn is free to change.
  "delivery_uncommitted_files",
  "checks_state",
  "checks_json",
  "checks_commit",
] as const;

/**
 * Is a card's delivery branch still work that main lacks? A landed (or
 * superseded) branch is not a base for the next run: main already has it.
 */
export function branchStillAhead(row: { landing_state?: string | null }): boolean {
  return row.landing_state !== "landed" && row.landing_state !== "superseded" && row.landing_state !== "unpushed";
}

export const clampInt = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.trunc(Number.isFinite(n) ? n : lo)));

/** Recoverable, structured error — the route maps `.code` to an HTTP status. */
export class TaskServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "TaskServiceError";
  }
}

/**
 * Per quanto una rivendicazione di interruzione tiene il campo.
 *
 * Tre minuti, e la misura viene dal disco: le quattro lines che hanno motivato
 * questo cancello stavano dentro tre minuti (tre «Server ripartito a metà
 * turno» a quindici secondi l'una dall'altra, poi «ripreso in diretta»), mentre
 * due interruzioni DAVVERO distinte sullo stesso task distano quanto il tetto a
 * orologio del turno — molto di più. La finestra separa le due cose senza
 * doverle distinguere, ed è il motivo per cui non è un lock permanente: un
 * secondo riavvio vero, un'ora dopo, ha ancora la sua riga.
 */
export const INTERRUPT_CLAIM_MS = 3 * 60_000;

/**
 * How far BACK from `reopened_at` a human rejection's own words may sit.
 *
 * They are not written after the reopen, they are written just before it: the
 * comment lands first, the status row an instant later. Measured 2026-09-17 on
 * the live DB - `f981f62c` has the comment at 13:49:31.716 and the
 * `review→in_progress` row at 13:49:31.732, sixteen milliseconds apart;
 * `f68e46c9` and `cdc9f39b` are two and one millisecond apart. A filter that
 * asks for words STRICTLY after the reopen finds nothing on all three, which
 * is the worst possible failure here: the fix looks done and changes nothing.
 *
 * Five seconds is far wider than any of those gaps and far narrower than the
 * gap to the turn before, which is minutes at the very least.
 */
export const REOPEN_COMMENT_SLACK_MS = 5_000;

/** Reserved board_settings row that carries the global auto-dispatch switch. */
export const GLOBAL_SETTINGS_KEY = "*";

/** Delivery notes waiting on git (see `annotateDeliveryClaims`). */
export const deliveryNotes = new Set<Promise<void>>();

export function trackDeliveryNote(p: Promise<void>): void {
  deliveryNotes.add(p);
  void p.finally(() => deliveryNotes.delete(p));
}

/**
 * @internal Test seam: resolves once every delivery note already on its way has been written or
 * dropped. A note that needs git is written after the update returns, so a test
 * that reads it, or checks it is absent, waits here first: an absence read too
 * early would pass for the wrong reason.
 */
export async function deliveryNotesInFlight(): Promise<void> {
  while (deliveryNotes.size > 0) await Promise.all([...deliveryNotes]);
}
