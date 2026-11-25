/**
 * Shared state and helpers used by the task service core and by every
 * `server/services/tasks/*.ts` sibling module: row mappers, comment
 * rendering, delivery-preview bookkeeping, parked-children bookkeeping, and
 * the few constants/classes several of them need (moved here, not left in
 * `tasks.ts`, so no sibling module has to import from `tasks.ts` itself).
 */

import type { Database } from "bun:sqlite";
import type { ServiceOpts, TaskService } from "../tasks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { projectIsPaused } from "../project-pause";
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

import { parseChecksJson, parseChecksProgress, parseChecksCi } from "../tasks-checks";
export { parseChecksJson, parseChecksProgress, parseChecksCi };

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

export function createTasksShared(db: Database, opts: ServiceOpts) {
  // `agentAskOnThread` needs to call back into the fully
  // assembled TaskService (same as `svc: TaskService` params elsewhere), but
  // it is called bare, with no caller to pass `this`/`svc` through. The
  // core wires this once, right after building `service`, via `bindService`.
  let serviceRef: TaskService | undefined;
  function bindService(s: TaskService): void { serviceRef = s; }

/**
   * LA FILA, ORDINATA UNA VOLTA SOLA invece di contata due volte per riga.
   *
   * `countAhead`/`countBehind` erano due COUNT correlati per ogni card in
   * `todo`: su una board con Q task in coda la lista costava O(Q²) scansioni, e
   * il feed globale del 15/08 (467 radici) ne pagava ~200 da solo.
   *
   * Qui l'insieme idoneo si legge UNA volta, già ordinato con la disciplina del
   * tick (priorità prima, anzianità a parità), e la posizione di ogni card si
   * trova con una ricerca binaria. Stesso insieme, stessi predicati, stesso
   * confronto: le due `COUNT` erano il conto degli elementi PRIMA e DOPO questa
   * chiave, che è esattamente ciò che il lower/upper bound restituisce.
   *
   * Le lines con la STESSA coppia (priorità, creazione) non sono né davanti né
   * dietro, come prima: `countBehind` chiedeva `created_at > ?`, quindi la
   * parità era già esclusa da entrambi i versi e l'`id != ?` era ridondante.
   */
  interface QueueRank {
    ahead(priority: number, createdAt: string): number;
    behind(priority: number, createdAt: string): number;
  }

  /**
   * I fatti che `rowToTask` andava a chiedere UNA RIGA ALLA VOLTA, letti una
   * volta per lotto.
   *
   * Misurato il 15/08 su `GET /api/all-boards/tasks` (467 radici, DB da
   * 651 MB): da 4 a 7 statement per riga — etichette, bloccante, topic per
   * modello ed effort, dipendenti, stato del padre, impostazioni della board, e
   * per ogni `todo` i due COUNT della fila — cioè ~1.500 statement e 145 ms per
   * una lista sola. Qui sono ~10, indipendenti dal numero di lines.
   *
   * `rowToTask` resta la porta UNICA (ci passano anche update, claim e release,
   * che il server ribalta sul WS): è implementata come un lotto da una riga, così
   * i due percorsi non possono divergere sul contenuto del payload.
   */
  interface TaskBatch {
    nowIso: string;
    labels: Map<string, TaskLabelRow[]>;
    waitingOn: Map<string, number>;
    topics: Map<string, { model: string | null; effort: string | null }>;
    blockers: Map<string, BlockerRef>;
    parentStatus: Map<string, string>;
    retryCap: Map<string, number>;
    openChildren: Map<string, number>;
    comments: Map<string, CardComment[]>;
    /** Cards whose last word in the thread is an unanswered question. */
    awaiting: Set<string>;
    /** Le altre evidenze del thread, per il carosello della card. */
    previewImages: Map<string, string[]>;
    queue: QueueRank | null;
    /**
     * The NAME of every node a card in this batch names. The chip has to say
     * which machine went silent, and an id in that sentence names nothing to
     * whoever reads it. Empty when no row names a node: a board of local cards
     * pays no read at all.
     */
    nodeNames: Map<string, string>;
    /** Where an In-progress card with no agent here works (`task-elsewhere.ts`). */
    elsewhere: Map<string, NonNullable<QueueContext["elsewhere"]>>;
    peopleNames: Map<string, string>;
    deviceNames: Map<string, string>;
    autoDispatch: boolean;
    heavy: boolean;
    /**
     * Il DB non sa rispondere sulla coda (schema ridotto di un test,
     * `board_settings` assente): la ragione si dichiara `unknown` invece di
     * ricadere sul chip «in coda», che è proprio la parola vaga che quel campo
     * esiste per togliere. Stessa scelta del `catch` che questo sostituisce.
     */
    queueReadable: boolean;
  }

const now = opts.now ?? (() => new Date().toISOString());

const uuid = opts.uuid ?? (() => crypto.randomUUID());

const fileExists = opts.fileExists ?? existsSync;

const writeDeliverySheet = opts.writeDeliverySheet;

/**
   * L'ultima parola VERA del thread di una card, o `null`.
   *
   * «Vera» come sulla card: si saltano `status` (cronologia delle transizioni)
   * e `service` (contabilita' del dispatcher), perche' non sono parole di
   * nessuno — e' lo stesso taglio di `isThreadSpeech`, che il client applica
   * prima di decidere cosa mostrare. Se le due divergessero, la scheda
   * scriverebbe una riga che la card non mostra.
   */
  function lastWordOfThread(taskId: string): string | null {
    try {
      const r = db.prepare(
        `SELECT content FROM task_comments
          WHERE task_id = ? AND COALESCE(kind, 'comment') NOT IN ('status', 'service')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(taskId) as { content?: string } | undefined;
      const t = (r?.content ?? "").trim();
      return t || null;
    } catch { return null; }
  }

// ── Review-evidence promotion ──
// The delivery protocol asks agents for update_task(previewImage=…), but in
// practice they attach the evidence to the delivery COMMENT and the board
// card stays blind (3 out of 3 first real dispatches). Same philosophy as
// the dispatcher's mirrored delivery comment: the server GUARANTEES the
// outcome instead of relying on agent discipline. When a task is in review
// with no preview, promote the newest previewable comment attachment
// (image/video, absolute path, existing on disk) to `preview_image`.
// Idempotent and best-effort: an explicit previewImage always wins (we only
// fill the empty case), and any failure just leaves the card without
// preview — exactly the status quo.
//
// `svg` è in lista dal 10/08: il protocollo (`PREVIEW_RULE`) ha un terzo ramo
// — DIAGRAMMA — per le consegne senza superficie renderizzata (un piano,
// un'architettura, una migrazione), e senza l'estensione qui quel ramo
// nasceva morto: l'agente allegava il diagramma al commento di consegna e la
// promozione lo saltava, lasciando la card cieca.
const PREVIEWABLE_MEDIA = /\.(png|jpe?g|gif|webp|svg|webm|mp4|mov)$/i;

/**
   * The paths this card's retirement has already REJECTED.
   *
   * It lives in a column and not in memory because the question comes back
   * after a restart, and that is exactly where it did damage:
   * `sweepReviewPreviews` fished the just-retired shot back out of the thread.
   * The column is a JSON array; an unreadable row counts as "nothing
   * rejected", which is the previous behaviour and never loses real evidence.
   */
  const rejectedPaths = (raw: string | null | undefined): string[] => {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  };

/** Quante evidenze al massimo finiscono nel carosello della card. Oltre, non
   *  e' piu' un carosello ma un archivio, e quello e' il thread nel drawer. */
  const PREVIEW_SLIDES_MAX = 8;

const VIDEO_MEDIA = /\.(webm|mp4|mov)$/i;

/**
   * Gate di FORMA — non un quarto cancello di review.
   *
   * Un'immagine molto più alta che larga, nel riquadro `object-cover` della
   * card, non si rimpicciolisce: si taglia. Promuoverla mette sulla board la
   * fascia alta di un documento e fa sembrare consegnata un'evidenza che
   * nessuno può leggere — è così che la card di un PIANO ha finito per mostrare
   * la fotografia del piano stesso.
   *
   * Quindi la promozione si ferma e lascia una nota. Si FERMA LA PROMOZIONE,
   * non la consegna: il task resta in review, l'allegato resta nel thread, e
   * l'agente legge nella nota quale ramo del protocollo era quello giusto. Un
   * rifiuto qui non deve mai costare un giro di dispatch.
   *
   * La soglia è `PREVIEW_CARD_MAX_RATIO`, la STESSA della card. Erano due (0.7
   * qui, 0.537 là) perché il tetto della card era un'altezza fissa e quindi un
   * rapporto ballerino: si promuoveva col numero largo ciò che poi la card
   * tagliava col numero stretto. Ora la card ha un tetto proporzionale, quindi
   * il gate dice esattamente «la card taglierebbe questa» — un numero solo per
   * la stessa immagine. Forma non misurabile (video, formato esotico, file
   * illeggibile) ⇒ si promuove: vedi `imageShape`.
   */
  function tooTallForCard(path: string): { ratio: number; width: number; height: number } | null {
    if (VIDEO_MEDIA.test(path)) return null;
    const shape = imageShape(path);
    if (!shape) return null;
    return shape.ratio > PREVIEW_CARD_MAX_RATIO ? shape : null;
  }

/**
   * L'ULTIMO RAMO, quello che non puo' fallire: se la card non ha evidenza, la
   * si DISEGNA con i fatti che stanno gia' in colonna (ramo, file, lines,
   * passi, etichette).
   *
   * Idempotente: si rigenera solo sopra il vuoto o sopra una scheda precedente,
   * mai sopra l'evidenza di qualcuno. Best-effort come tutto quello che sta
   * attorno: senza `writeDeliverySheet` iniettata (test, host minimi) non fa
   * niente e la card resta com'era.
   */
  function ensureDeliverySheet(taskId: string): void {
    if (!writeDeliverySheet) return;
    try {
      const row = getTaskRow(taskId) as {
        status?: string;
        text?: string | null;
        preview_image?: string | null;
        delivery_branch?: string | null;
        delivery_files_changed?: number | null;
        delivery_insertions?: number | null;
        delivery_deletions?: number | null;
        delivery_uncommitted_files?: number | null;
      } | undefined;
      if (!row || row.status !== "review") return;
      const attuale = (row.preview_image ?? "").trim();
      if (attuale && !isDeliverySheetPath(attuale)) return;
      const figli = db.prepare(
        "SELECT status FROM tasks WHERE parent_task_id = ? AND COALESCE(archived, 0) = 0",
      ).all(taskId) as Array<{ status: string }>;
      const labels = (db.prepare(
        "SELECT label FROM task_labels WHERE task_id = ? ORDER BY label",
      ).all(taskId) as Array<{ label: string }>).map((r) => r.label);
      const svg = renderDeliverySheet({
        taskId,
        title: row.text ?? "",
        branch: row.delivery_branch ?? null,
        filesChanged: row.delivery_files_changed ?? null,
        insertions: row.delivery_insertions ?? null,
        deletions: row.delivery_deletions ?? null,
        // The work that is NOT on a commit: without this number the sheet has
        // one sentence for two opposite situations (nothing to hand over, and a
        // delivery left behind in the worktree), and the reviewer picks blind.
        uncommittedFiles: row.delivery_uncommitted_files ?? null,
        subtasksTotal: figli.length,
        subtasksDone: figli.filter((f) => f.status === "done").length,
        labels,
        // COSA E' STATO FATTO, quando non ci sono numeri da mostrare.
        //
        // La stessa riga che la card disegna sopra il titolo: l'ultima parola
        // vera del thread, saltando cronologia e contabilita' (`status` e
        // `service` non sono parole di nessuno). Senza, il ramo senza codice
        // scriveva «Nessun codice consegnato» — un'assenza al posto di
        // un'informazione, sul 60% della larghezza della scheda.
        summary: lastWordOfThread(taskId),
      });
      const path = writeDeliverySheet(taskId, svg);
      if (!path) return;
      // Il ritiro NON si spegne qui: una scheda non e' l'evidenza nuova che
      // supera un ritiro, e' il ripiego che tiene la card leggibile intanto.
      db.prepare("UPDATE tasks SET preview_image = ?, updated_at = ? WHERE id = ?")
        .run(path, now(), taskId);
    } catch { /* best-effort: senza scheda la card torna com'era, vuota */ }
  }

function promoteReviewPreview(taskId: string): void {
    try {
      const row = getTaskRow(taskId);
      if (!row || row.status !== "review") return;
      // Una SCHEDA vale come riquadro vuoto: e' il ripiego che abbiamo disegnato
      // noi, quindi la prima evidenza vera deve poterla sostituire. Qualunque
      // altra anteprima, invece, e' di qualcuno e non si tocca.
      const attuale = (row.preview_image ?? "").trim();
      if (attuale && !isDeliverySheetPath(attuale)) return;
      // WHAT WAS REJECTED DOES NOT COME BACK. The retired image stays attached
      // to the comment that carried it, which is precisely where we fish below:
      // without this line the startup sweep put the just-rejected shot back on
      // the card, and turned the retirement off while doing it.
      const alreadyRejected = rejectedPaths(row.preview_rejected);
      const rows = db.prepare(
        "SELECT media FROM task_comments WHERE task_id = ? AND media IS NOT NULL ORDER BY created_at DESC LIMIT 10",
      ).all(taskId) as Array<{ media: string }>;
      const rejected: Array<{ path: string; shape: { ratio: number; width: number; height: number } }> = [];
      for (const r of rows) {
        let files: unknown;
        try { files = JSON.parse(r.media); } catch { continue; }
        if (!Array.isArray(files)) continue;
        for (const f of files) {
          if (typeof f !== "string" || !f.startsWith("/") || !PREVIEWABLE_MEDIA.test(f)) continue;
          if (alreadyRejected.includes(f)) continue;
          if (!fileExists(f)) continue;
          const tall = tooTallForCard(f);
          if (tall) { rejected.push({ path: f, shape: tall }); continue; }
          // Anche l'adozione automatica supera il ritiro: la card ha di nuovo
          // un'evidenza, quindi il fatto «ritirata» ha smesso di valere.
          // A DUPLICATE AUTO SHOT IS EVIDENCE OF NOTHING, so it is refused
          // instead of merely noted. The note stays a note for an image a
          // PERSON attached: two cards on the same panel really can share one,
          // which is why this was never a block. An automatic capture is a
          // different animal - byte-identical to another card's means the app
          // was in the same state, and that says nothing about THIS delivery.
          // Measured 2026-09-01: task 1f225c0f carried the very screenshot of
          // 1c8fd103 (md5 f8a398c6), the machine wrote the note, and then used
          // the image anyway. Reported: «si vede solo uno screen a cazzo».
          // allow-italian: the words that reported it, quoted.
          const isDuplicate = noteDuplicatePreview(taskId, f);
          if (isDuplicate && isAutoCapturedPreview(f)) continue;
          db.prepare(
            "UPDATE tasks SET preview_image = ?, preview_retired_at = NULL, preview_retired_reason = NULL, updated_at = ? WHERE id = ?",
          ).run(f, now(), taskId);
          return;
        }
      }
      // Nessun candidato da promuovere. Il riquadro NON resta vuoto: il vuoto
      // valeva come segnale finche' era raro, e il 20/08 era 9 card su 16.
      // Vedi `services/delivery-sheet.ts` per il perche' e per l'onesta' della
      // scheda (dichiaratamente disegnata, sostituita dalla prima evidenza
      // vera). Le istruzioni su come allegare l'evidenza restano nell'envelope
      // dell'agente (PREVIEW_RULE), non nel thread di chi decide.
      ensureDeliverySheet(taskId);
      if (!rejected.length && !rows.some((r) => (r.media ?? "").trim())) {
        return;
      }
      // Nessun candidato promosso ma qualcuno scartato per forma: la card
      // resterebbe cieca senza che nessuno sappia perché.
      if (rejected.length) {
        const { path, shape } = rejected[0]!;
        reviewNote(
          taskId,
          `Anteprima non promossa: \`${baseName(path)}\` è ${shape.width}×${shape.height}, altezza/larghezza ${shape.ratio.toFixed(2)} (soglia ${PREVIEW_CARD_MAX_RATIO}). ` +
            "Sulla card se ne vedrebbe solo la fascia alta. La consegna resta in review e l'allegato resta nel thread: " +
            "se il lavoro non ha una superficie renderizzata il ramo giusto è un DIAGRAMMA `.svg` (la struttura, non la foto del documento); " +
            "se è UI, ricattura a viewport ≤1440×900. Poi `update_task(preview_image=…)`.",
        );
      }
    } catch { /* best-effort — the card just stays without a preview */ }
  }

/**
   * SEGNALE, mai blocco: l'anteprima appena messa è byte per byte quella di un
   * altro task.
   *
   * Nel rilievo che ha aperto questo lavoro c'erano 16 PNG identici da 10.191
   * byte sparsi su altrettante card — lo stesso screenshot riciclato, cioè
   * consegne senza evidenza propria. Ma alcuni di quei duplicati sono legittimi
   * (due task sullo stesso pannello, uno stato vuoto che è davvero identico):
   * un blocco farebbe strage di consegne buone. Quindi si scrive una nota e si
   * lascia decidere a chi legge.
   */
  /**
   * The other card carrying THE SAME IMAGE, byte for byte, or null.
   *
   * Pure on purpose: the adoption path wants to write a note about it, the
   * review sweep only wants to ask. Asking used to mean writing, so the sweep
   * could not use it without dripping the same note into the thread every pass.
   */
  function duplicatePreviewOf(taskId: string, path: string): { id: string; text: string; path: string } | null {
    try {
      const mine = fileDigest(path);
      if (!mine) return null;
      const others = db.prepare(
        "SELECT id, text, preview_image FROM tasks WHERE preview_image IS NOT NULL AND preview_image != '' AND id != ? ORDER BY updated_at DESC LIMIT 200",
      ).all(taskId) as Array<{ id: string; text: string; preview_image: string }>;
      for (const o of others) {
        if (o.preview_image === path) continue; // stesso file, non un duplicato di contenuto
        if (fileDigest(o.preview_image) !== mine) continue;
        return { id: o.id, text: o.text ?? "", path: o.preview_image };
      }
    } catch { /* best-effort: the signal is an extra, not an invariant */ }
    return null;
  }

function noteDuplicatePreview(taskId: string, path: string): boolean {
    const other = duplicatePreviewOf(taskId, path);
    if (!other) return false;
    try {
      const mine = fileDigest(path) ?? "";
      {
        const o = other;
        reviewNote(
          taskId,
          `Anteprima IDENTICA (md5 \`${mine.slice(0, 8)}\`) a quella del task \`${o.id}\`, «${o.text.slice(0, 60)}». ` +
            "Non è un blocco: due task sullo stesso pannello possono avere davvero la stessa immagine. " +
            "Ma se è una svista, questa consegna non ha ancora un'evidenza sua.",
        );
      }
    } catch { /* best-effort: il segnale è un extra, non un invariante */ }
    return true;
  }

/** md5 del file, con cache su (path, size, mtime): la scansione dei duplicati
   *  rilegge le stesse anteprime a ogni consegna. `null` se non si può leggere. */
  const digestCache = new Map<string, { key: string; md5: string }>();

function fileDigest(path: string): string | null {
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size === 0 || st.size > 16 * 1024 * 1024) return null;
      const key = `${st.size}:${st.mtimeMs}`;
      const hit = digestCache.get(path);
      if (hit && hit.key === key) return hit.md5;
      const md5 = createHash("md5").update(readFileSync(path)).digest("hex");
      digestCache.set(path, { key, md5 });
      return md5;
    } catch { return null; }
  }

function baseName(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }

/**
   * Una nota della MACCHINA nel thread (`kind: 'review-note'`): il canale che
   * il client rende come annotazione di review e che NON sveglia l'agente —
   * lo stesso che usa `preview-manager`. Inserimento diretto e non via
   * `addComment`, che ri-chiamerebbe la promozione da cui questa nota nasce.
   * Deduplicata sul contenuto: la promozione gira a ogni transizione in review
   * e a ogni commento con allegati, e la stessa nota non va ripetuta.
   */
  function reviewNote(taskId: string, content: string): void {
    try {
      const dupe = db.prepare(
        "SELECT id FROM task_comments WHERE task_id = ? AND kind = 'review-note' AND content = ? LIMIT 1",
      ).get(taskId, content);
      if (dupe) return;
      const ts = now();
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, mentions, media, kind, created_at) VALUES (?, ?, ?, ?, NULL, NULL, 'review-note', ?)",
      ).run(uuid(), taskId, "system", content, ts);
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, taskId);
    } catch { /* best-effort */ }
  }

// The global start switch (row '*'). Closure helper — never `this` — so the
// methods survive being destructured off the service.
const readGlobalDispatch = (): boolean => {
    // `app_settings` e non piu' la riga '*' di `board_settings`: e' una
    // preferenza di MACCHINA, e stava in una tabella per progetto solo per
    // ragioni storiche. Finche' e' stata li', lo zero di default sulle lines
    // per-progetto ha avuto l'aria di una scelta e ha prodotto due diagnosi
    // sbagliate (11/08 e 15/08). Vedi la migration
    // 20260816112635-board-settings-drop-dead-auto-dispatch.
    // Best-effort come ogni altra lettura di preferenza in questo file: un DB
    // senza `app_settings` (gli schemi minimi dei test, un host a meta'
    // migrazione) vale «spento», non un'eccezione. Il verso conta: l'errore
    // opposto sarebbe far esplodere il tick del dispatcher su una tabella
    // mancante, cioe' fermare tutto per una preferenza.
    try {
      const r = db.query("SELECT auto_dispatch FROM app_settings LIMIT 1").get() as { auto_dispatch?: number | null } | undefined;
      return r ? !!r.auto_dispatch : false;
    } catch {
      return false;
    }
  };

// C'è un task pesante con un agente vivo ADESSO? Closure e non `this`, come
// sopra: il claim lo chiama, e il claim deve sopravvivere a essere destrutturato.
// Un pesante che aspetta SOLO la CI remota non macina niente qui: `ci` entra
// in checks_json (onCiWait) solo dopo i check locali, quindi finche' i check
// girano sul Mac il blocco resta (09/11: 14 card ferme 20 min dietro una CI).
const heavyInFlight = (): boolean =>
    !!db.query(
      `SELECT 1 AS h FROM tasks
        WHERE status = 'in_progress' AND dispatch_state IN ('starting','working')
          AND archived = 0 AND dispatch_weight = 'heavy' AND ${RUNS_HERE_SQL}
          AND NOT (checks_state = 'running' AND json_valid(checks_json)
                   AND json_extract(checks_json, '$.ci') IS NOT NULL) LIMIT 1`,
    ).get();

/**
   * Chi lavora un sottotask che non ha né topic né chip: risalendo i padri.
   *
   * Sta in `rowToTask` accanto a `resolveBlocker` per due ragioni. La prima: il
   * client non può risolverlo da sé — la sua lista è un progetto, `rootsOnly`,
   * non archiviati, e il padre di un sottotask quasi mai ci sta dentro. La
   * seconda: `rowToTask` è il mappatore UNICO, quindi metterlo qui è l'unico
   * modo perché `list`, `get`, `update` e `boundRootOf` dicano tutti la stessa
   * cosa; riempirlo nei soli `list`/`get` (come i contatori dei sottotask) lo
   * lascerebbe spento sul payload di ritorno di ogni scrittura.
   *
   * Costa ZERO sul caso normale: la guardia `isUnattributedSubtask` esclude
   * tutto tranne la forma ambigua — 1 riga viva su ~1.276 alla misura dell'11/08
   * — e solo lì parte la risalita, UNA query sola su `idx_tasks_parent`, con la
   * catena misurata profonda 2.
   *
   * NON è `boundRootOf`, che pure risale gli stessi padri: quella cerca il primo
   * antenato con un TOPIC, al lavoro o no. Qui la differenza è tutta: un padre
   * con un topic ma tornato in `backlog`/`blocked` è esattamente il caso da
   * segnalare, e `boundRootOf` lo darebbe per buono.
   *
   * La query porta su la catena e il verdetto lo dà `isAncestorAtWork` in JS —
   * non un `WHERE` che riscrive quel predicato in SQL. `ACTIVE_DISPATCH_STATES`
   * è dichiarato una volta in `shared/board` proprio perché era una lista
   * copiata in cinque posti: una sesta copia dentro una stringa SQL non la
   * vedrebbe nemmeno il compilatore.
   *
   * Il tetto sulla profondità non è per la catena vera (2), è perché una che si
   * richiude su sé stessa qui aprirebbe una CTE infinita: il cancello di
   * `parent_task_id` (migration 034) dice che un id nuovo non può essere
   * antenato di una riga esistente, ma un ciclo scritto da una migration futura
   * non deve poter appendere il server.
   */
  const MAX_ANCESTOR_DEPTH = 32;

function resolveSubtaskWork(r: any): SubtaskWork | null {
    const task = {
      status: r.status,
      parentTaskId: r.parent_task_id ?? null,
      assignedTopicId: r.assigned_topic_id ?? null,
      dispatchState: r.dispatch_state ?? null,
    };
    if (!isUnattributedSubtask(task)) return null;

    // CROSS JOIN pins the chain (a handful of ancestors) as the outer loop.
    // With planner stats on `tasks` and none on a CTE, a plain JOIN let
    // SQLite scan every task and probe the chain: 26 -> 1,133 pages.
    const rows = db.prepare(
      `WITH RECURSIVE chain(id, parent, depth) AS (
         SELECT id, parent_task_id, 0 FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_task_id, c.depth + 1
           FROM tasks t JOIN chain c ON t.id = c.parent
          WHERE c.depth < ?
       )
       SELECT t.id, t.text, t.status, t.dispatch_state, t.archived
         FROM chain c CROSS JOIN tasks t ON t.id = c.id
        WHERE c.depth > 0
        ORDER BY c.depth ASC`,
    ).all(r.id, MAX_ANCESTOR_DEPTH) as any[];

    return deriveSubtaskWork(task, rows.map((a) => ({
      id: a.id, text: a.text, status: a.status,
      dispatchState: a.dispatch_state ?? null, archived: !!a.archived,
    })));
  }

/**
   * UNA LISTA DI ID COME PARAMETRO UNICO: `json_each(?)`, non una fila di `?`.
   *
   * Due ragioni, nessuna cosmetica. `bun:sqlite` tiene compilata solo la SQL
   * passata a `db.query`, e la chiave della cache è il TESTO: un
   * `IN (?, ?, …)` costruito sulla lunghezza del lotto è una stringa diversa a
   * ogni lista, quindi non si riuserebbe mai. E il tetto dei 999 parametri di
   * SQLite sparisce senza doverlo spezzare a mano: 467 radici ci stavano,
   * 2.135 task no.
   */
  const idParam = (ids: Iterable<string>): string => JSON.stringify([...new Set(ids)]);

/**
   * Quanti commenti «di conversazione» viaggiano sulla card (vedi
   * `recentComments`). La card ne DISEGNA due — l'ultima parola e la richiesta
   * umana che risponde — ma per trovare la seconda deve guardare indietro oltre
   * la prima: `selectCardComments` risale il thread finché non trova una
   * richiesta, e con due sole lines una risposta in due tempi («ci provo» +
   * l'esito) lasciava la card senza contesto.
   */
  const CARD_COMMENTS_DEPTH = 3;

/**
   * «Parola vera», in SQL: 1 quando la riga e' la voce di qualcuno, 0 quando e'
   * contabilita' della macchina.
   *
   * E' il gemello di `contorno()` — qui sotto in `cardCommentsFor`, e in
   * `client/src/components/Board/cardComments.ts`. Le tre copie devono dire la
   * stessa cosa: se questa fosse piu' larga, la finestra trasporterebbe una
   * nota che il client poi scarta, e la card resterebbe muta come prima.
   */
  const SQL_PAROLA =
    "CASE WHEN COALESCE(c.kind, 'comment') = 'review-note' THEN 0 " +
    "     WHEN c.author = 'system' AND c.content NOT LIKE '%```question%' THEN 0 " +
    "     ELSE 1 END";

/**
   * «Questa riga l'ho scritta IO», in SQL.
   *
   * Serve alla finestra, e per una ragione misurata: `CARD_COMMENTS_DEPTH` ne
   * porta tre, e su una card viva le note della macchina si accumulano DOPO
   * l'ultima cosa che ho detto. Su `a41af39a` (20/08) fra il mio messaggio e la
   * cima c'erano 26 lines, su `235afe11` 17, su `b673a253` 16: il mio messaggio
   * stava in posizione SETTE e alla card non arrivava mai — non perche' il
   * client lo scartasse, ma perche' il server non glielo mandava.
   *
   * Chiesto cosi': «da review dovrei SEMPRE vedere l'ultimo suo e mio
   * messaggio». Senza questa riga il «sempre» valeva solo per i thread corti.
   *
   * Il gemello di `isHumanComment` (client) tenuto stretto come quello: solo
   * `kind = 'comment'`, perche' il server firma `user` anche la propria
   * narrazione quando una leva l'ha tirata una persona (Stop, archiviazione),
   * e quelle non sono parole mie.
   */
  const SQL_MIA =
    "CASE WHEN c.author = 'user' AND COALESCE(c.kind, 'comment') = 'comment' THEN 1 ELSE 0 END";

/**
   * "This row IS THE DELIVERY", in SQL.
   *
   * Same reason as `SQL_MIA`, from the other side of the thread: the summary is
   * written on the move into review and the machine speaks right after it — the
   * `review-note` with the preview, system notifications, the checks outcome.
   * `rn_parola = 1` is not enough to carry it: if the agent writes again after
   * delivering (a follow-up, a rework note), THAT is the last real word and the
   * summary drops out of the window. The card prefers it over recency, so it
   * has to be able to SEE it.
   */
  const SQL_IS_DELIVERY =
    "CASE WHEN COALESCE(c.kind, 'comment') = 'delivery' THEN 1 ELSE 0 END";

/**
   * Quanto testo di un commento viaggia sulla card, e sono DUE misure perché la
   * card ne disegna due in modo diverso.
   *
   * L'ULTIMA parola del thread la card la stampa intera, formattata, senza
   * clamp: quella tiene 1.200 caratteri (misurato il 15/08 sul DB di questa
   * macchina: 1.538 commenti idonei, 544 KB, il più lungo 4.020 caratteri —
   * sopra il tetto ci finisce il 6% di loro). Quelle PRIMA di lei compaiono
   * come riga di contesto, sotto la risposta che stanno spiegando.
   *
   * ── PERCHÉ IL CONTESTO NON È PIÙ 200 ──────────────────────────────────────
   * Erano 200 quando quella riga era «una riga sola tagliata con `truncate`»,
   * e allora bastavano. Non lo è più da un pezzo: il client la ripiega su tre
   * lines con un «mostra di più» che scatta a 190 caratteri
   * (`RICHIESTA_PIEGA_CHARS`), e la sua doc promette «il testo c'è tutto,
   * basta un click».
   *
   * Quella promessa era falsa, e di molto. Misurati i messaggi umani su questa
   * macchina: 1.215 lines, mediana 520 caratteri, p90 1.776 — il 76% sopra i
   * 200. Il bottone «mostra di più» apriva su un testo che il SERVER aveva già
   * buttato: tre lines e poi il vuoto, senza che niente lo dicesse.
   *
   * Ora il contesto tiene 620, che è `COMMENTO_PIEGA_CHARS` del client: la
   * soglia oltre la quale la card offre «mostra di più». Sotto quel numero il
   * testo c'è davvero tutto e il bottone non compare; sopra, il bottone apre su
   * qualcosa invece che sul vuoto.
   *
   * IL NUMERO NON È SCELTO, È IL PIÙ ALTO CHE STA NEL BUDGET. C'è un cancello
   * sul peso del payload della board (`tests/integration/board-payload-weight`),
   * e il suo commento nomina proprio questo errore fra i modi di sfondarlo:
   * «togliendo il taglio del testo». Misurato per gradi sulla sua fixture:
   * 200/400/620 passano, 800 sfonda (2.701 byte per task contro un tetto di
   * 2.600), e 1.200 sfonda di brutto (2.968). Alzare il tetto per far entrare
   * la mia scelta sarebbe stato spegnere il cancello invece di rispettarlo.
   *
   * Cosa compra: i messaggi umani interi passano dal 24% al 54% (1.215 lines su
   * questa macchina). Il resto arriva tagliato ma con il pieghevole che ha
   * qualcosa da aprire, che è il contratto che il client dichiara.
   *
   * Il costo in lines è misurato e trascurabile (vedi `cardCommentsFor`: 84
   * lines in più su 1.980, query invariata a 57 ms su 18.579 commenti).
   *
   * Il dettaglio del task porta il thread intero: qui basta ciò che si legge su
   * una scheda.
   */
  const CARD_COMMENT_CHARS = 1200;

const CARD_CONTEXT_CHARS = 620;

/**
   * Il taglio del testo di un commento, CHE NON PUÒ SPEZZARE UNA ```question.
   *
   * Il blocco domanda non è prosa: `parseQuestionBlock` lo legge e ne ricava i
   * bottoni di risposta rapida della card. Tagliato a metà non fallisce, torna
   * `null` — la card perde i bottoni e stampa il recinto grezzo, senza che
   * niente diventi rosso. Quindi il tetto vale sulla prosa, e un recinto aperto
   * prima del tetto viaggia fino alla sua chiusura (il più lungo sul disco il
   * 15/08 misurava 1.132 caratteri, sotto il tetto: la guardia è per quello che
   * non lo è).
   */
  const FENCE = "```";

const QUESTION_FENCE = "```question";

function cardCommentContent(content: string, max: number): string {
    if (content.length <= max) return content;
    const open = content.indexOf(QUESTION_FENCE);
    if (open >= 0 && open < max) {
      const close = content.indexOf(FENCE, open + QUESTION_FENCE.length);
      if (close >= 0) return `${content.slice(0, Math.max(max, close + FENCE.length))}…`;
    }
    return `${content.slice(0, max)}…`;
  }

/**
   * Chi DISEGNA i commenti sulla card: la colonna review, e nessun altro.
   *
   * Il gate della card è `task.status === 'review'` (Board/Card.tsx: sia il ramo
   * dell'agente sia la domanda di sistema stanno dentro quel ramo). Attaccarli a
   * tutti significava spedirli per 455 schede su 467 — 731 KB su un feed di 2 MB
   * — perché ne leggesse 11. Il predicato guarda solo la RIGA, così ogni porta
   * (lista, dettaglio, scrittura ribaltata sul WS) risponde la stessa cosa per
   * lo stesso task.
   */
  //
  // AND IN PROGRESS, since 2026-09-03: the kickoff asks the agent to comment as
  // soon as the work is framed, and it does (measured: 6 rows on one working
  // card, 2 on another), yet from the kanban the progress was a stopwatch. The
  // card draws ONE, the agent's last word (`progressWord`, client side).
  const drawsCardComments = (r: { status?: string }): boolean => r.status === "review" || r.status === "in_progress";

/** Quanti caratteri di `description` viaggiano nella lista (vedi `descriptionPreview`). */
  const DESCRIPTION_PREVIEW_CHARS = 240;

/**
   * L'anteprima parte da dove comincia la SOSTANZA, non dal preambolo.
   *
   * Segnalato guardando una card: «anche la descrizione non ha senso». Su
   * `235afe11` i 240 caratteri dell'anteprima erano cosi':
   *
   *     «Potremmo fare una roba molto figa per poter assicurarci che il nostro
   *      browser ide sia effettivamente perfetto e interessante.
   *      - Omologare la cronologia delle tab di navigazione con la cronologia
   *        delle tab normali.
   *      - Metterlo anche come menu»
   *
   * Meta' dello spazio bruciata da una frase che non dice niente, e il secondo
   * punto elenco tagliato a meta'. La sostanza — cosa c'e' da fare — comincia
   * al primo trattino.
   *
   * Quindi: se il testo ha un ELENCO, l'anteprima parte da li'. E' un taglio
   * strutturale, non un giudizio sul contenuto: non si decide che una frase e'
   * inutile, si osserva che chi ha scritto ha messo i punti sotto un cappello,
   * e che i punti sono la parte che si legge.
   *
   * Il preambolo non si perde: il drawer mostra la descrizione INTERA. Qui si
   * sceglie solo da dove far partire i 240 caratteri che stanno sulla card.
   */
  function anteprimaUtile(testo: string): string {
    const t = testo.trimStart();
    // Il primo punto elenco, se comincia una RIGA (non un trattino in mezzo a
    // una frase) e se ha del testo sopra: senza cappello non c'e' niente da
    // saltare, e partire dal secondo punto perderebbe il primo.
    const m = t.match(/\n\s*(?:[-*•]\s+|\d+[.)]\s+)/);
    if (!m || m.index === undefined) return t;
    const cappello = t.slice(0, m.index).trim();
    // Un cappello CORTO e' gia' il punto, non un preambolo: «Tre cose da fare:»
    // vale piu' del primo elenco. Si salta solo cio' che e' lungo abbastanza da
    // mangiarsi l'anteprima.
    if (cappello.length < 80) return t;
    return t.slice(m.index).trimStart();
  }

/**
   * Il taglio dell'anteprima sui percorsi a riga singola, CON LA STESSA UNITÀ
   * dell'altro.
   *
   * `substr` di SQLite conta CARATTERI, `String.slice` conta unità UTF-16: su
   * un'emoji (o su qualunque carattere fuori dal piano base) le due porte
   * tagliavano in due punti diversi, e la stessa card mostrava due anteprime a
   * seconda che arrivasse dalla lista o da una scrittura ribaltata sul WS.
   * `Array.from` itera per punti di codice, che è l'unità di `substr`.
   */
  const previewOf = (s: string): string =>
    sliceCodePoints(anteprimaUtile(s), DESCRIPTION_PREVIEW_CHARS);

function rankQueue(nowIso: string): QueueRank {
    const rows = db.query(
      `SELECT t.priority AS priority, t.created_at AS created_at
         FROM tasks t
         LEFT JOIN board_settings bs ON bs.project_id = t.project_id
        WHERE t.archived = 0 AND t.status = 'todo'
          AND t.parent_task_id IS NULL
          AND t.project_id != ?
          AND t.assigned_topic_id IS NULL
          AND t.dispatch_attempts < COALESCE(bs.dispatch_retry_cap, 2)
          AND (t.dispatch_deferred_until IS NULL OR t.dispatch_deferred_until <= ?)
          AND t.scheduled_by IS NULL
          AND (t.blocked_by_task_id IS NULL OR EXISTS (
                 SELECT 1 FROM tasks bk
                  WHERE bk.id = t.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1)))
        ORDER BY t.priority DESC, t.created_at ASC`,
    ).all(UNASSIGNED_PROJECT_ID, nowIso) as Array<{ priority: number; created_at: string }>;
    // Il confronto in JS è lo stesso di SQLite: `created_at` è ISO-8601 ASCII e
    // la collazione di default è BINARY, quindi `<` sulle stringhe ordina come
    // l'`ORDER BY` che ha appena prodotto queste lines.
    const bound = (p: number, c: string, orEqual: boolean): number => {
      let lo = 0; let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = rows[mid]!;
        const primaDiNoi = r.priority > p
          || (r.priority === p && (orEqual ? r.created_at <= c : r.created_at < c));
        if (primaDiNoi) lo = mid + 1; else hi = mid;
      }
      return lo;
    };
    return {
      ahead: (p, c) => bound(p, c, false),
      behind: (p, c) => rows.length - bound(p, c, true),
    };
  }

/** Quali colonne ha davvero lo `topics` di questo database (vedi `buildBatch`). */
  const topicsColumns = (): Set<string> => {
    try {
      return new Set((db.query("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name));
    } catch { return new Set<string>(); }
  };

let topicsCols: Set<string> | null = null;

const topicsHasModel = (): boolean => (topicsCols ??= topicsColumns()).has("model");

const topicsHasEffort = (): boolean => (topicsCols ??= topicsColumns()).has("effort");

function labelsFor(ids: readonly string[]): Map<string, TaskLabelRow[]> {
    const out = new Map<string, TaskLabelRow[]>();
    const rows = db.query(
      `SELECT task_id, label, source FROM task_labels
        WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY label ASC`,
    ).all(idParam(ids)) as Array<{ task_id: string; label: string; source: string }>;
    for (const r of rows) {
      if (!isTaskLabel(r.label)) continue;
      const list = out.get(r.task_id);
      const row = { label: r.label as TaskLabel, source: r.source as LabelSource };
      if (list) list.push(row); else out.set(r.task_id, [row]);
    }
    return out;
  }

/**
   * Gli ultimi commenti PARLATI di ogni task, sulla card.
   *
   * Senza questi la board apriva un `GET /api/tasks/:id` pieno per ogni card in
   * review solo per sapere cosa c'era scritto in fondo al thread — e quel
   * dettaglio si porta dietro l'INTERO thread (`svc.get`), non tre lines.
   *
   * Viaggiano su OGNI payload, non solo su `list`/`get`, per la stessa ragione
   * di `waitingOnCount` e `blockedBy`: le scritture escono sul WS come
   * `task:updated`, e un campo riempito solo in lettura si spegnerebbe a ogni
   * giro di WS fino al fetch successivo.
   *
   * Escono come `CardComment` — tre campi, testo tagliato — e non come lines
   * intere del thread: chiamati solo per le schede che li disegnano
   * (`drawsCardComments`) e ridotti a ciò che la card legge, sono 731 KB di
   * feed che non partono più.
   *
   * `kind` 'status' e 'service' restano fuori: sono cronologia delle transizioni
   * e contabilità del dispatcher, non le parole di nessuno — lo stesso taglio di
   * `isThreadSpeech`, che è il predicato con cui il client sceglie la coppia da
   * mostrare. `COALESCE` perché le lines scritte prima che `kind` esistesse lo
   * hanno NULL, e `NULL NOT IN (…)` è NULL: senza, sparivano tutte.
   *
   * L'ordine finale è `rn DESC`, non `created_at ASC`: dentro lo stesso secondo
   * (o dentro lo stesso istante di un orologio finto) due lines hanno lo STESSO
   * `created_at`, e ordinare su quello lascia decidere a SQLite. `rn` viene
   * dalla finestra, che il `rowid` lo usa già come spareggio: qui si legge al
   * contrario e la coda del thread esce sempre nello stesso ordine.
   */
  /**
   * WHO IS WAITING ON AN ANSWER, read from the thread instead of from memory.
   *
   * The live hold travels as the transient `task:awaiting-human` event, which is
   * edge-triggered and carried by nothing else: a server restart, a page reload
   * or a client that connects after the edge never learns about it, and the card
   * falls back to whatever chip it had over a turn parked on a question nobody
   * can see. Measured on 2026-09-01: one card sat 36 hours on an unanswered
   * mid-turn question showing only `queued`, and the queue read as broken.
   *
   * The durable fact is the thread, so it is recomputed on every read and cannot
   * survive the answer. It is deliberately NOT persisted into `dispatch_state`:
   * that chip takes the task out of `ACTIVE_DISPATCH_STATES`, the orphan-recovery
   * door, and a restart would strand it `in_progress` for ever - the defect this
   * repo already paid for once.
   */
  function awaitingAnswerFor(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    try {
      const rows = db.query(
        `SELECT task_id, content FROM (
           SELECT c.task_id AS task_id, c.content AS content, c.created_at AS asked_at,
                  t.in_progress_at AS turn_started,
                  row_number() OVER (
                    PARTITION BY c.task_id ORDER BY c.created_at DESC, c.rowid DESC) AS rn
             FROM task_comments c
             JOIN tasks t ON t.id = c.task_id
            WHERE c.task_id IN (SELECT value FROM json_each(?))
              AND COALESCE(c.kind, 'comment') NOT IN ('status', 'service')
              AND ${SQL_PAROLA} = 1
         ) WHERE rn = 1
             AND (turn_started IS NULL OR asked_at > turn_started)`,
      ).all(idParam(ids)) as Array<{ task_id: string; content: string | null }>;
      // A QUESTION BELONGS TO ITS TURN, and dies with it.
      //
      // Without the `asked_at > turn_started` guard the card kept claiming your
      // attention over a question whose turn had been dead for 36 hours: a fresh
      // agent was dispatched on top of it and working, and the board still read
      // "waiting on you". Reported the moment it shipped, and it is the same
      // staleness `parked-question.ts` already guards for the parked-children
      // variant.
      //
      // The SAME predicate the dispatcher uses to pick the end-of-turn chip: a
      // fence it cannot read counts as a question, never as a delivery.
      for (const r of rows) if (commentAsksHuman(r.content)) out.add(r.task_id);
    } catch { return out; }
    return out;
  }

function cardCommentsFor(ids: readonly string[]): Map<string, CardComment[]> {
    const out = new Map<string, CardComment[]>();
    if (ids.length === 0) return out;
    let rows: any[];
    try {
      // LA FINESTRA NON BASTA: SERVE UNA GARANZIA.
      //
      // `rn <= DEPTH` prende le ultime tre lines parlate, e il client poi
      // scarta le note di macchina per trovare la parola vera. Funziona finche'
      // le note dopo una consegna sono meno di tre. Non lo sono: dopo ogni
      // ingresso in review ne arrivano di norma TRE — l'esito dei checks, la
      // nota sull'anteprima, «Non e' su main: <sha> — landa il ramo prima che
      // venga potato» — e il riassunto dell'agente esce dalla finestra prima
      // ancora di partire. Il client filtra correttamente e non trova niente da
      // mostrare: ripiega sulle note, e la card apre con «Non e' su main».
      //
      // Misurato il 2026-08-18 sulla board vera: delle 26 card in review/done
      // lavorate davvero da un agente, 23 avevano il suo riassunto nel thread e
      // ZERO lo mostravano; su 24 l'ultima parola era di sistema. Segnalato:
      // «parecchi task non hanno un commento utile, hanno soltanto un commento
      // di sistema, e questo mi fa capire che c'e' qualcosa di rotto».
      //
      // Quindi la seconda finestra: l'ULTIMA PAROLA VERA entra sempre, quale
      // che sia la sua distanza dal fondo. Costa al massimo una riga per card.
      // Il predicato e' lo stesso `contorno` di qui sotto e del client, scritto
      // in SQL: tre copie della stessa regola sono gia' il difetto di
      // `hasMetaRow`, ma qui la terza serve a NON trasportare cio' che le altre
      // due poi scarterebbero.
      rows = db.query(
        `SELECT * FROM (
           SELECT c.*,
                  row_number() OVER (
                    PARTITION BY c.task_id ORDER BY c.created_at DESC, c.rowid DESC) AS rn,
                  row_number() OVER (
                    PARTITION BY c.task_id, ${SQL_PAROLA}
                    ORDER BY c.created_at DESC, c.rowid DESC) AS rn_parola,
                  -- L'ULTIMA COSA CHE HO DETTO IO viaggia sempre, per quanto
                  -- indietro sia finita sotto le note della macchina.
                  row_number() OVER (
                    PARTITION BY c.task_id, ${SQL_MIA}
                    ORDER BY c.created_at DESC, c.rowid DESC) AS rn_mia,
                  -- AND THE DECLARED DELIVERY, the row the card exists for:
                  -- the machine's notes pile up right underneath it.
                  row_number() OVER (
                    PARTITION BY c.task_id, ${SQL_IS_DELIVERY}
                    ORDER BY c.created_at DESC, c.rowid DESC) AS rn_delivery,
                  ${SQL_IS_DELIVERY} AS delivery,
                  ${SQL_MIA} AS mia,
                  ${SQL_PAROLA} AS parola
             FROM task_comments c
            WHERE c.task_id IN (SELECT value FROM json_each(?))
              AND COALESCE(c.kind, 'comment') NOT IN ('status', 'service')
         ) WHERE rn <= ${CARD_COMMENTS_DEPTH}
              OR (parola = 1 AND rn_parola = 1)
              OR (mia = 1 AND rn_mia = 1)
              OR (delivery = 1 AND rn_delivery = 1)
         ORDER BY task_id ASC, rn DESC`,
      ).all(idParam(ids)) as any[];
    } catch { return out; }
    // CHI RICEVE IL TESTO INTERO E' CHI LA CARD STAMPERA', e non è più «il più
    // recente».
    //
    // La `review-note` la scrive la macchina a OGNI ingresso in review
    // («Consegna SENZA anteprima…», «Anteprima viva pronta — http://…»), quindi
    // arriva sempre DOPO il riassunto di chi ha consegnato. Con la regola
    // vecchia il taglio pieno finiva alla nota e il riassunto — che è ciò che
    // la card disegna (`selectCardComments`) — arrivava mozzato a 200
    // caratteri: misurato sulla board vera il 17/08, sette card su otto
    // troncate a esattamente 201.
    //
    // La regola nuova è la STESSA che usa il client per scegliere: la prima
    // parola vera scendendo dal più recente, e la nota solo se non c'è altro.
    // Due regole diverse sullo stesso fatto sono la forma esatta del difetto
    // già pagato con `hasMetaRow`.
    // `typeof rows` e non un `any[]` nuovo: le lines sono le stesse, e il
    // cricchetto degli `any` conta ogni occorrenza scritta a mano.
    const perTask = new Map<string, typeof rows>();
    for (const r of rows) {
      const l = perTask.get(r.task_id);
      if (l) l.push(r); else perTask.set(r.task_id, [r]);
    }
    for (const [taskId, lines] of perTask) {
      // `rn` numera dal più recente, e le lines arrivano `ORDER BY rn DESC`:
      // la più recente è l'ultima. Fra quelle, la prima che non è una nota.
      const dalPiuRecente = [...lines].reverse();
      // STESSA REGOLA DEL CLIENT, e stavolta per intero: contorno non e' solo
      // la `review-note`. Le NOTIFICHE DI STATO del sistema (`author:
      // 'system'`, `kind: 'comment'`) sono 3984 nel db, la specie piu'
      // numerosa - «l'agent ha lavorato 2 turni ma non ha spostato il task»,
      // «Worktree e branch ripuliti» - e arrivano sempre DOPO il riassunto,
      // perche' il sistema scrive per ultimo. Misurato il 17/08: un riassunto
      // da 1832 caratteri arrivava alla card tagliato a 201, perche' i 1200
      // se li prendeva la notifica.
      //
      // Una DOMANDA del sistema no: il recinto ```question e' la firma di
      // qualcosa che aspetta una risposta, ed e' l'unica cosa che tiene ferma
      // la card. Vedi `contorno()` in client/src/components/Board/cardComments.ts:
      // le due regole devono dire la stessa cosa, o il testo pieno va a una
      // riga che il client non disegna.
      const contorno = (r: (typeof rows)[number]): boolean => {
        const c = rowToComment(r);
        if (c.kind === "review-note") return true;
        if (c.author !== "system") return false;
        return !c.content.includes("```question");
      };
      // A DECLARED DELIVERY BEATS RECENCY, and the full quota follows it.
      //
      // Third copy of the rule that lives in `selectCardComments`: here we
      // decide WHO gets the 1,200 characters, there WHO gets printed. Let the
      // two drift apart and the card draws a row that arrived cut at 200 —
      // exactly the defect already paid for with the `review-note`.
      //
      // A person speaking AFTER the delivery takes it back: that is a rework,
      // and the last word is theirs again.
      const parole = dalPiuRecente.filter((r) => !contorno(r));
      const firstWord = parole.find((r) => {
        const c = rowToComment(r);
        return c.kind === "delivery" || (c.author === "user" && c.kind === "comment");
      });
      const scelta = (firstWord && rowToComment(firstWord).kind === "delivery")
        ? firstWord
        : (parole[0] ?? dalPiuRecente[0]);
      for (const r of lines) {
        const full = rowToComment(r);
        // `rowToComment` normalizza `kind` (una riga scritta prima che la
        // colonna esistesse vale 'comment'): il taglio dei campi viene DOPO, o
        // la card riceverebbe il `kind` grezzo del disco.
        const c: CardComment = {
          author: full.author,
          content: cardCommentContent(full.content, r === scelta ? CARD_COMMENT_CHARS : CARD_CONTEXT_CHARS),
          kind: full.kind,
          ...(full.messageId ? { messageId: full.messageId } : {}),
          ...(full.origin ? { origin: full.origin } : {}),
          ...(full.actorPersonName ? { actorPersonName: full.actorPersonName } : {}),
          ...(full.actorDeviceName ? { actorDeviceName: full.actorDeviceName } : {}),
        };
        const list = out.get(taskId);
        if (list) list.push(c); else out.set(taskId, [c]);
      }
    }
    return out;
  }

/**
   * LE ALTRE EVIDENZE di ogni card: i media allegati nel thread.
   *
   * A COSA SERVE. `preview_image` e' UNA sola — la copertina che il server ha
   * scelto — e finora il resto restava sepolto nel thread. Ma un agente che
   * consegna un lavoro visivo allega spesso piu' scatti (prima/dopo, tre
   * schermate di un flusso), e chi guarda la board li vedeva solo aprendo il
   * task e scorrendo i commenti. Segnalato: «assicuriamoci che la preview possa
   * avere anche piu' slide navigabili».
   *
   * UNA QUERY PER PAGINA, non una per card: stesso motivo per cui i commenti
   * passano da `cardCommentsFor`. Il tetto per card esiste perche' un thread
   * lungo puo' avere decine di allegati, e un carosello da trenta slide non e'
   * un carosello: e' un archivio, e quello sta nel drawer.
   */
  function previewImagesFor(ids: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    /* REJECTED evidence stays out of the carousel. `retirePreview` removes the
     * cover, but the slides are fished from those same attachments: without
     * this read the retired shot stayed visible next to the good one, so the
     * card kept showing exactly what the retirement had declared false. One
     * query, like the media above. */
    const rejectedByTask = new Map<string, string[]>();
    try {
      const rr = db.query(
        `SELECT id, preview_rejected FROM tasks
          WHERE id IN (SELECT value FROM json_each(?)) AND preview_rejected IS NOT NULL`,
      ).all(JSON.stringify(ids)) as Array<{ id: string; preview_rejected: string | null }>;
      for (const r of rr) rejectedByTask.set(r.id, rejectedPaths(r.preview_rejected));
    } catch { /* column missing (old db): nothing rejected, as before */ }
    /* Il tipo della riga e' DICHIARATO, non `any`: sono due colonne, si
     * scrivono. Il cricchetto sugli `any` (`check:any-budget`) mi ha preso
     * proprio qui, e aveva ragione — `r.media` su un `any` non avrebbe detto
     * niente se un domani la colonna cambiasse nome. */
    let rows: Array<{ task_id: string; media: string | null }>;
    try {
      rows = db.query(
        `SELECT task_id, media FROM task_comments
          WHERE task_id IN (SELECT value FROM json_each(?)) AND media IS NOT NULL
          ORDER BY created_at ASC`,
      ).all(JSON.stringify(ids)) as Array<{ task_id: string; media: string | null }>;
    } catch { return out; }
    for (const r of rows) {
      if (!r.media) continue;
      let files: unknown;
      try { files = JSON.parse(r.media); } catch { continue; }
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        // Le stesse regole della promozione: path assoluto, estensione che
        // qualcuno sa disegnare. Un `.pdf` fra le slide sarebbe un buco.
        if (typeof f !== "string" || !f.startsWith("/") || !PREVIEWABLE_MEDIA.test(f)) continue;
        if (rejectedByTask.get(r.task_id)?.includes(f)) continue;
        const list = out.get(r.task_id);
        if (!list) { out.set(r.task_id, [f]); continue; }
        if (list.length >= PREVIEW_SLIDES_MAX) continue;
        if (!list.includes(f)) list.push(f);
      }
    }
    return out;
  }

function buildBatch(rows: readonly any[], opts: { reasonsOnly?: boolean } = {}): TaskBatch {
    const ids = rows.map((r) => r.id as string);
    // `reasonsOnly`: the caller reads only `queueReasonOf`, so the facts a card face draws (labels,
    // comments, the open question, preview images) are not paid for.
    const light = opts.reasonsOnly === true;
    const b: TaskBatch = {
      nowIso: new Date().toISOString(),
      labels: light ? new Map() : labelsFor(ids),
      waitingOn: new Map(),
      topics: new Map(),
      blockers: new Map(),
      parentStatus: new Map(),
      retryCap: new Map(),
      openChildren: new Map(),
      comments: light ? new Map() : cardCommentsFor(rows.filter(drawsCardComments).map((r) => r.id as string)),
      // Only the two columns where a hold can be open, so a board of closed
      // cards pays nothing: a review card already carries its comments and the
      // client reads the question straight out of those.
      awaiting: light ? new Set() : awaitingAnswerFor(
        rows.filter((r) => r.status === "todo" || r.status === "in_progress").map((r) => r.id as string),
      ),
      previewImages: light ? new Map() : previewImagesFor(ids),
      queue: null,
      nodeNames: new Map(),
      // Only the In-progress cards no agent is in: the `no_agent` branch.
      elsewhere: readElsewhere(db, rows.filter((r) => r.status === "in_progress" && !isAgentWorking(r.dispatch_state))),
      peopleNames: new Map(),
      deviceNames: new Map(),
      autoDispatch: false,
      heavy: false,
      queueReadable: true,
    };

    // Quanti task VIVI aspettano ciascuno di questi. Una GROUP BY sull'indice
    // `idx_tasks_blocked_by` (migration 042) al posto di una COUNT per riga.
    for (const r of db.query(
      `SELECT blocked_by_task_id AS bid, COUNT(*) AS n FROM tasks
        WHERE blocked_by_task_id IN (SELECT value FROM json_each(?))
          AND archived = 0 AND status != 'done'
        GROUP BY blocked_by_task_id`,
    ).all(idParam(ids)) as Array<{ bid: string; n: number }>) b.waitingOn.set(r.bid, r.n);

    const blockerIds = rows.map((r) => r.blocked_by_task_id).filter(Boolean) as string[];
    if (blockerIds.length) {
      // Anche ARCHIVIATI: un bloccante archiviato non blocca più, ma dirlo è
      // compito del client (`archived: true`), non di un `null` muto.
      for (const r of db.query(
        "SELECT id, text, status, archived FROM tasks WHERE id IN (SELECT value FROM json_each(?))",
      ).all(idParam(blockerIds)) as any[]) {
        b.blockers.set(r.id, { id: r.id, text: r.text, status: r.status, archived: !!r.archived });
      }
    }

    const topicIds = rows.map((r) => r.assigned_topic_id).filter(Boolean) as string[];
    if (topicIds.length) {
      // Le due colonne si CHIEDONO prima di leggerle: gli stub `topics` degli
      // harness ne hanno una sola (uno ha `effort` e non `model`, un altro il
      // contrario), e una `SELECT id, model, effort` fallisce per intero — cioè
      // spegne il modello sulla card per una colonna che serviva all'altro
      // campo. Erano due letture separate, ciascuna col suo try/catch, apposta.
      try {
        for (const t of db.query(
          `SELECT id${topicsHasModel() ? ", model" : ""}${topicsHasEffort() ? ", effort" : ""}
             FROM topics WHERE id IN (SELECT value FROM json_each(?))`,
        ).all(idParam(topicIds)) as any[]) {
          b.topics.set(t.id, { model: t.model ?? null, effort: t.effort ?? null });
        }
      } catch { /* niente tabella `topics` del tutto: come prima, si tace */ }
    }

    try {
      b.autoDispatch = readGlobalDispatch();
      // Tutta la tabella in una lettura: `board_settings` ha una riga per board
      // più la riga globale, e il JOIN per riga costava più della tabella intera.
      for (const s of db.query("SELECT project_id, dispatch_retry_cap FROM board_settings").all() as any[]) {
        if (s.dispatch_retry_cap != null) b.retryCap.set(s.project_id, s.dispatch_retry_cap);
      }
      const parentIds = rows.map((r) => r.parent_task_id).filter(Boolean) as string[];
      if (parentIds.length) {
        for (const p of db.query(
          "SELECT id, status FROM tasks WHERE id IN (SELECT value FROM json_each(?))",
        ).all(idParam(parentIds)) as Array<{ id: string; status: string }>) b.parentStatus.set(p.id, p.status);
      }
      // Il conto dei figli aperti si paga SOLO in review, come prima: è la
      // domanda «approvarla la chiuderebbe?», e fuori da lì non se la pone
      // nessuno.
      const reviewIds = rows.filter((r) => r.status === "review").map((r) => r.id as string);
      if (reviewIds.length) {
        for (const c of db.query(
          `SELECT parent_task_id AS pid, COUNT(*) AS n FROM tasks
            WHERE parent_task_id IN (SELECT value FROM json_each(?))
              AND archived = 0 AND status != 'done'
            GROUP BY parent_task_id`,
        ).all(idParam(reviewIds)) as Array<{ pid: string; n: number }>) b.openChildren.set(c.pid, c.n);
      }
      // The nodes named by these cards, in one read. Outside the `try` there is
      // nothing to protect: a database without a `machines` table is a reduced
      // harness schema, and there the chip falls back to the id rather than
      // making the whole batch unreadable.
      const machineIds = [...new Set(rows.map((r) => r.machine_id).filter(Boolean) as string[])];
      if (machineIds.length) {
        try {
          for (const m of db.query(
            "SELECT id, name FROM machines WHERE id IN (SELECT value FROM json_each(?))",
          ).all(idParam(machineIds)) as Array<{ id: string; name: string }>) b.nodeNames.set(m.id, m.name);
        } catch { /* no `machines` table: the chip says the id, which still points at something */ }
      }
      const personIds = [...new Set(rows.map((r) => r.run_initiator_person_id).filter(Boolean) as string[])];
      if (personIds.length) {
        try {
          for (const p of db.query("SELECT id, display_name FROM people WHERE id IN (SELECT value FROM json_each(?))")
            .all(idParam(personIds)) as Array<{ id: string; display_name: string }>) b.peopleNames.set(p.id, p.display_name);
        } catch { /* Reduced task harnesses do not model collaborator identities. */ }
      }
      const deviceIds = [...new Set(rows.map((r) => r.run_initiator_device_id).filter(Boolean) as string[])];
      if (deviceIds.length) {
        try {
          for (const d of db.query("SELECT id, name FROM devices WHERE id IN (SELECT value FROM json_each(?))")
            .all(idParam(deviceIds)) as Array<{ id: string; name: string }>) b.deviceNames.set(d.id, d.name);
        } catch { /* Reduced task harnesses do not model collaborator identities. */ }
      }
      const inCoda = rows.filter((r) => r.status === "todo" && !r.parent_task_id);
      if (inCoda.length) b.queue = rankQueue(b.nowIso);
      // `heavyInFlight` era in fondo a due `&&` per non pagarlo su una riga
      // normale: qui la stessa disciplina è «solo se nel lotto c'è almeno una
      // card col chip `queued`», e vale una lettura per lotto invece che per riga.
      if (inCoda.some((r) => r.dispatch_state === DISPATCH_CHIP_QUEUED)) b.heavy = heavyInFlight();
    } catch {
      b.queueReadable = false;
    }
    return b;
  }

function queueReasonOf(r: any, b: TaskBatch): QueueReason | null {
    // `review` entra qui insieme a `todo` per un caso solo: la checklist
    // congelata. Non è una ragione di coda ed è giusto che stia nella stessa
    // funzione — è la stessa domanda, «perché questa card non si muove», e
    // averla in due posti significherebbe due risposte che possono divergere.
    if (r.status === "done") return null;
    if (!b.queueReadable) return QUEUE_REASON_UNKNOWN;
    // La fila si conta solo per chi la sta davvero facendo. Fuori da `todo`
    // «3 davanti» non è un'attesa più corta o più lunga: è un numero su una
    // coda di cui questa card non fa parte.
    const inCoda = r.status === "todo" && !r.parent_task_id;
    const heldResume = r.status === "in_progress" && r.dispatch_state === DISPATCH_CHIP_QUEUED && !r.parent_task_id;
    try {
      return deriveQueueReason(
        {
          status: r.status,
          parentTaskId: r.parent_task_id ?? null,
          dispatchState: r.dispatch_state ?? null,
          dispatchAttempts: r.dispatch_attempts ?? 0,
          dispatchDeferredUntil: r.dispatch_deferred_until ?? null,
          dispatchError: r.dispatch_error ?? null,
          scheduledBy: r.scheduled_by ?? null,
          deliveredReason: r.delivered_reason ?? null,
          blockedByTaskId: r.blocked_by_task_id ?? null,
          blockedBy: r.blocked_by_task_id ? (b.blockers.get(r.blocked_by_task_id) ?? null) : null,
          assignedTo: r.assigned_to ?? null,
          machineId: r.machine_id ?? null,
          updatedAt: r.updated_at ?? null,
        },
        {
          now: b.nowIso,
          autoDispatch: b.autoDispatch,
          // Resolved here and not in the client: the chip's sentence is composed
          // server side, and a client that has not read `/api/machines` yet
          // would print an id for a node it can name perfectly well.
          nodeName: r.machine_id ? (b.nodeNames.get(r.machine_id) ?? null) : null,
          retryCap: b.retryCap.get(r.project_id) ?? 2,
          ahead: inCoda && b.queue ? b.queue.ahead(r.priority, r.created_at) : 0,
          // Un pesante trattenuto DAL CARICO è il tappo della coda, e la card lo
          // dichiara. Il chip `queued` da solo non basta a riconoscerlo:
          // `noteHeavyHold` lo scrive in DUE rami del tick, e i due non hanno
          // niente in comune se non il chip.
          //
          //  - ramo del CARICO: il pesante è in testa, il gate è chiuso, il
          //    `break` ferma la fila dietro di lui. Lì è davvero lui il tappo,
          //    l'attesa ha un tetto, e abbassargli la priorità sposta la fila.
          //  - ramo `heavyBusy`: c'è già un pesante AL LAVORO, e il tick esce
          //    prima del ciclo mettendo il chip su OGNI todo. Lì l'ordine della
          //    coda è irrilevante, il tetto dell'attesa non si applica e la
          //    priorità non sblocca niente.
          //
          // Si legge dal DB e non da uno stato vivo del tick apposta: il
          // mappatore gira anche fuori dal processo che dispaccia, e una ragione
          // che dipendesse dalla memoria del dispatcher sparirebbe proprio
          // aprendo la card da un'altra finestra.
          heavyHeld: inCoda
            && readTaskWeight(r.dispatch_weight) === "heavy"
            && r.dispatch_state === DISPATCH_CHIP_QUEUED
            && !b.heavy,
          // L'altra metà della stessa distinzione: il ramo `heavyBusy` chipa
          // OGNI todo, non solo i pesanti, quindi qui non si guarda il peso di
          // questa riga ma se c'è un turno pesante in volo.
          heavyInFlight: inCoda && r.dispatch_state === DISPATCH_CHIP_QUEUED && b.heavy,
          behind: inCoda && b.queue ? b.queue.behind(r.priority, r.created_at) : 0,
          // The two blocks that stop the WHOLE machine: the RAM/disk floor and
          // the 24h spend cap. The tick reads them once per round and then
          // skips every card, so no column records them: without this the card
          // fell through to the queue branch and said "in coda, la prossima" on
          // a board that had not moved in hours. Only for a card really in the
          // queue: outside it, this block is not what it waits on
          // (`dispatch-block-signal.ts`). A resume held in the In-progress column
          // says the block that holds ITS resume, written by that hold and
          // believed only while the row carries the same sentence: the published
          // block is refreshed only by a tick that reaches it, and a board with
          // no todos or a paused one leaves it at a floor that has cleared.
          // Una card in attesa di memoria porta il codice, non la frase del
          // pavimento (KANBAN-97): resta un blocco della macchina, o la card
          // ricadrebbe sul ramo dello slot.
          dispatchBlock: inCoda
            ? (r.dispatch_error === WAITING_MEMORY_REASON ? { kind: "resources", reason: WAITING_MEMORY_REASON } : currentDispatchBlock())
            : heldResume ? heldResumeBlock(r.id, r.dispatch_error) : null,
          // Only a card that waits (the queued chip) pays the one indexed row read.
          projectPaused: (inCoda || heldResume) && r.dispatch_state === DISPATCH_CHIP_QUEUED && projectIsPaused(db, r.project_id),
          memoryWait: r.dispatch_error === WAITING_MEMORY_REASON ? currentMemoryWait() : null,
          elsewhere: b.elsewhere.get(r.id) ?? null,
          parentStatus: r.parent_task_id ? (b.parentStatus.get(r.parent_task_id) ?? null) : null,
          projectless: r.project_id === UNASSIGNED_PROJECT_ID,
          openSubtasks: r.status === "review" ? (b.openChildren.get(r.id) ?? 0) : 0,
        },
      );
    } catch {
      return QUEUE_REASON_UNKNOWN;
    }
  }

function mapRow(r: any, b: TaskBatch): Task {
    const topic = r.assigned_topic_id ? b.topics.get(r.assigned_topic_id) : undefined;
    // `description_preview` lo calcola SQL nel percorso `list` (`substr`, così
    // i 470 KB di descrizioni non attraversano la serializzazione); sui percorsi
    // a riga singola, che leggono `SELECT *`, si taglia qui. Una sola forma per
    // il client, due modi di arrivarci.
    const description: string | null = r.description ?? null;
    // UNA SOLA REGOLA PER I DUE PERCORSI. `description_preview` arriva da SQL
    // con piu' materiale del necessario (`PREVIEW_SQL_CHARS`) proprio perche'
    // la scelta di DOVE cominciare si fa qui, in un posto solo: se il taglio
    // finale vivesse in due punti, la card mostrerebbe cose diverse a seconda
    // che la riga venga da una lista o da una scrittura ribaltata sul WS.
    const preview: string | null = r.description_preview !== undefined
      ? (r.description_preview === null ? null : previewOf(r.description_preview))
      : description === null ? null : previewOf(description);
    return {
      id: r.id,
      projectId: r.project_id,
      text: r.text,
      description,
      descriptionPreview: preview,
      status: r.status,
      priority: r.priority,
      kanbanOrder: r.kanban_order,
      assignedTo: r.assigned_to ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      assignedTopicId: r.assigned_topic_id ?? null,
      archived: !!r.archived,
      dispatchState: r.dispatch_state ?? null,
      dispatchAttempts: r.dispatch_attempts ?? 0,
      dispatchError: r.dispatch_error ?? null,
      dispatchDeferredUntil: r.dispatch_deferred_until ?? null,
      waitStreak: r.wait_streak ?? 0,
      waitReason: r.wait_reason ?? null,
      waitSince: r.wait_since ?? null,
      dispatchWeight: readTaskWeight(r.dispatch_weight),
      parentTaskId: r.parent_task_id ?? null,
      urlProbeStatus: (r.url_probe_status as 'live' | 'dead' | 'unknown' | null) ?? null,
      previewImage: r.preview_image ?? null,
      // I due campi RARI si aggiungono solo quando hanno un contenuto: vedi le
      // note sui tipi. Su una lista di 600 task sono ~4 KB risparmiati.
      ...(() => {
        const slides = b.previewImages.get(r.id as string);
        return slides && slides.length ? { previewImages: slides } : {};
      })(),
      ...(r.checks_state === "running"
        ? (() => {
            const p = parseChecksProgress(r.checks_json);
            const ci = parseChecksCi(r.checks_json);
            return { ...(p ? { checksProgress: p } : {}), ...(ci ? { checksCi: ci } : {}) };
          })()
        : {}),

      // THREE FIELDS THAT ALWAYS TRAVELLED AND THAT NOBODY READS.
      //
      // Same rule as the two rare fields just above: they travel only when
      // they have content. On a list of 600 cards a repeated `null` is not
      // information, it is the name of the key - 44 of the 70 keys of this
      // payload are ALWAYS null and on their own weigh 840 bytes per task.
      //
      // Only THREE, and the selection is the important part. The criterion is
      // not "who is null" but "for whom `null` is NOT a state": here they are
      // an external id and two probe timestamps - absent and never-checked are
      // the same thing. All the fields where `null` does say something stayed
      // fixed instead: `checksCommit` (where "null is not a green" is written
      // down in a test), `doneActor`, `waitStreak`/`waitReason`/`waitSince`.
      // Tried removing them: eight red tests, and they were in the right.
      ...(r.claude_task_id ? { claudeTaskId: r.claude_task_id } : {}),
      ...(r.url_probe_checked_at ? { urlProbeCheckedAt: r.url_probe_checked_at } : {}),
      ...(r.landing_checked_at ? { landingCheckedAt: r.landing_checked_at } : {}),

      // NINE MORE FIELDS THAT TRAVELLED EMPTY ON EVERY CARD.
      //
      // Same rule, one round later: event timestamps and external ids ride
      // only when they have a value. Every one of these answers "when did it
      // happen" or "which one is it": absent and never-happened say the same
      // thing, so a repeated `null` here is the name of the key and nothing
      // else. The fields where `null` IS an answer stayed fixed: the state
      // enums (`dispatchState`, `landingState`, `checksState`, `deployState`),
      // `checksCommit`, `doneActor`, `waitStreak`/`waitReason`/`waitSince`,
      // and `parentTaskId`, where null means root.
      ...(r.due_date ? { dueDate: r.due_date } : {}),
      ...(r.scheduled_by ? { scheduled: { by: r.scheduled_by, at: r.scheduled_at ?? null } } : {}),
      ...(r.chat_id ? { chatId: r.chat_id } : {}),
      ...(r.completed_at ? { completedAt: r.completed_at } : {}),
      ...(r.plan_comment_id ? { planCommentId: r.plan_comment_id } : {}),
      ...(r.in_progress_at ? { inProgressAt: r.in_progress_at } : {}),
      ...(r.interrupted_at ? { interruptedAt: r.interrupted_at } : {}),
      ...(r.output_url ? { outputUrl: r.output_url } : {}),

      previewRetiredAt: r.preview_retired_at ?? null,
      previewRetiredReason: r.preview_retired_reason ?? null,
      // The rejected paths reach the client because that is where what to draw
      // gets decided: the card needs them so the carousel does not redraw the
      // very image the retirement declared false.
      previewRejected: rejectedPaths(r.preview_rejected),
      planFirst: !!r.plan_first,
      agentMs: r.agent_ms ?? 0,
      agentTokens: r.agent_tokens ?? 0,
      agentCacheReadTokens: r.agent_cache_read_tokens ?? 0,
      agentCostCents: r.agent_cost_cents ?? 0,
      priorityAuto: r.priority_auto == null ? true : !!r.priority_auto,
      // Il modello mostrato deve SEMPRE riflettere ciò che ha girato davvero:
      // `tasks.model` può essere nullo («auto») anche dopo il dispatch, ma il
      // TOPIC dell'agente è stato creato col modello risolto.
      model: r.model ?? topic?.model ?? null,
      ...(r.model_effort ? { modelEffort: r.model_effort } : {}),
      topicsRouting: r.topics_routing == null ? null : !!r.topics_routing,
      // WHERE it runs. `null` is «this machine», which is what every card
      // written before the column existed says (KANBAN-76).
      machineId: r.machine_id ?? null,
      // "This Mac only": absent column (old harness) reads as unmarked.
      // A pin with a deadline (`stay_local_until`, set after an empty node run)
      // reads as unmarked once the deadline is past.
      stayLocal: !!r.stay_local && !(r.stay_local_until && r.stay_local_until <= now()),
      ...(r.overflow_skip_machine && r.overflow_skip_until && r.overflow_skip_until > now() ? { overflowSkipMachine: String(r.overflow_skip_machine).split(",").at(-1), overflowSkipMachines: String(r.overflow_skip_machine).split(",") } : {}),
      // Only while it still runs where the overflow sent it.
      ...(r.overflowed_at && r.machine_id ? { overflowedAt: r.overflowed_at } : {}),
      ...(r.base_branch ? { baseBranch: r.base_branch } : {}),
      ...(r.prior_branch ? { priorBranch: r.prior_branch } : {}),
      ...(r.past_delivery_branches ? { pastDeliveryBranches: String(r.past_delivery_branches).split(/\s+/).filter(Boolean) } : {}),
      ...(r.prior_uncommitted_files ? { priorUncommittedFiles: r.prior_uncommitted_files } : {}),
      // WHO opened it; NULL for every card written before the column.
      createdBy: r.created_by ?? null,
      ...(r.created_source ? { createdSource: r.created_source } : {}),
      ...(r.bar ? { bar: r.bar } : {}),
      ...liveCardGaps(r),
      ...openerOf(r),
      ...channelOf(r),
      // The workflow column, only when it is not the default one: a board with
      // the default workflow sends the same row as before.
      ...(r.stage ? { stage: r.stage } : {}),
      ...(r.human_ask ? { humanAsk: r.human_ask } : {}),
      ...(r.land_intent ? { landIntent: r.land_intent } : {}),
      ...(r.land_intent_commit ? { landIntentCommit: r.land_intent_commit } : {}),
      // Delegation metadata is rare. Absence means an ordinary owner run, not
      // a UI state, so five repeated null keys on every board card carry no
      // information. A delegated row still gets the complete audit identity.
      ...(r.machine_id ? { runComputerName: b.nodeNames.get(r.machine_id) ?? r.machine_id } : {}),
      ...(r.delegated_start_capability_id
        ? { delegatedStartCapabilityId: r.delegated_start_capability_id }
        : {}),
      ...(r.run_initiator_person_id
        ? {
            runInitiatorPersonId: r.run_initiator_person_id,
            runInitiatorPersonName: b.peopleNames.get(r.run_initiator_person_id) ?? r.run_initiator_person_id,
          }
        : {}),
      ...(r.run_initiator_device_id
        ? {
            runInitiatorDeviceId: r.run_initiator_device_id,
            runInitiatorDeviceName: b.deviceNames.get(r.run_initiator_device_id) ?? r.run_initiator_device_id,
          }
        : {}),
      // Non c'è una colonna `tasks.effort` e non serve: l'autorità è il TOPIC,
      // che è ciò che viene davvero passato allo spawn. Duplicarla su `tasks`
      // creerebbe due verità libere di divergere.
      effort: r.assigned_topic_id ? (topic?.effort ?? null) : null,
      blockedByTaskId: r.blocked_by_task_id ?? null,
      blockedBy: r.blocked_by_task_id ? (b.blockers.get(r.blocked_by_task_id) ?? null) : null,
      subtaskWork: resolveSubtaskWork(r),
      waitingOnCount: b.waitingOn.get(r.id) ?? 0,
      awaitingAnswer: b.awaiting.has(r.id),
      queueReason: queueReasonOf(r, b),
      deliveryBranch: r.delivery_branch ?? null,
      deliveryCommit: r.delivery_commit ?? null,
      // Only when the column is really there: the list projection does not select it, and a
      // hard `?? null` would turn "not asked for" into "no tip was ever sent back".
      ...(r.prior_commit ? { priorCommit: r.prior_commit as string } : {}),
      // Da quando aspetta una risposta umana (migration 20260816214500).
      reviewAt: r.review_at ?? null,
      // L'ENTITÀ DEL LAVORO, sulla card e non dietro un clic: la colonna review
      // chiedeva «Approva» senza dire cosa si stesse approvando.
      deliveryFilesChanged: r.delivery_files_changed ?? null,
      deliveryInsertions: r.delivery_insertions ?? null,
      deliveryDeletions: r.delivery_deletions ?? null,
      // The work that is NOT on a commit: it is what turns the chip's "nothing
      // committed" into "nothing committed, and N files are waiting there".
      deliveryUncommittedFiles: r.delivery_uncommitted_files ?? null,
      landingState: r.landing_state ?? null,
      deployState: (r.deploy_state as Task["deployState"]) ?? null,
      ...(r.deploy_command_at_propose ? { deployCommandAtPropose: r.deploy_command_at_propose } : {}),
      checksState: r.checks_state ?? null,

      checksAt: r.checks_at ?? null,
      checksCommit: r.checks_commit ?? null,
      // `checks_json` non è nella proiezione della LISTA (217 KB sui 1,4 MB del
      // feed, e la card non li disegna): lì la colonna non c'è e questo resta
      // null. `svc.get` legge `SELECT *` e li porta interi.
      checks: parseChecksJson(r.checks_json),
      deliveredBy: r.delivered_by ?? null,
      deliveredReason: r.delivered_reason ?? null,
      doneActor: r.done_actor ?? null,
      reopenedAt: r.reopened_at ?? null,
      reopenedBy: r.reopened_by ?? null,
      reopenedActor: r.reopened_actor ?? null,
      reuseBlockerContext: !!r.reuse_blocker_context,
      subtaskCount: 0,
      subtaskDoneCount: 0,
      userCommentCount: 0,
      labels: b.labels.get(r.id) ?? [],
      recentComments: b.comments.get(r.id) ?? [],
    };
  }

function rowsToTasks(rows: readonly any[]): Task[] {
    if (rows.length === 0) return [];
    const b = buildBatch(rows);
    return rows.map((r) => mapRow(r, b));
  }

/**
   * A GROUPING PARENT IS NOT A WORK CARD. A card born in backlog that no turn
   * ever touched becomes a container the moment a child is hung under it (same
   * predicate as PARKED_CHILDREN_CANDIDATES_SQL in task-timer-reads.ts): the
   * agent-card contract asks a work card for a bar and a source, a container
   * has nothing to finish on its own. Measured 08/11: 15 grouping parents,
   * each born with "Incomplete card" in its thread and the chip on top. The
   * flag goes, and with it the system comment the birth wrote.
   */
  function releaseContainerFromCardContract(parentId: string): void {
    const released = db.prepare(
      `UPDATE tasks SET created_missing = NULL
        WHERE id = ? AND created_missing IS NOT NULL
          AND status = 'backlog' AND dispatch_attempts = 0
          AND in_progress_at IS NULL AND delivered_by IS NULL AND dispatch_state IS NULL`,
    ).run(parentId);
    if (Number(released.changes ?? 0) === 0) return;
    db.prepare("DELETE FROM task_comments WHERE task_id = ? AND author = 'system' AND content LIKE ?")
      .run(parentId, `${INCOMPLETE_CARD_NOTICE_PREFIX}%`);
  }

/**
   * What an agent's card still lacks, recomputed from the row so it shrinks as
   * the card is completed. Only a card born subject to the contract
   * (`created_missing` not NULL) is ever flagged: old cards stay as they were.
   */
  function liveCardGaps(r: { created_missing?: unknown; description?: string | null; description_preview?: string | null; bar?: string | null; created_source?: string | null; project_id?: string }): { createdMissing?: string[] } {
    if (r.created_missing == null) return {};
    const gaps = agentCardGaps({
      // The lean list carries the 800-char SQL preview instead of the body: enough to judge context.
      description: r.description ?? r.description_preview, bar: r.bar, source: r.created_source,
      hasDirectory: r.project_id !== AUTO_PROJECT_ID && r.project_id !== UNASSIGNED_PROJECT_ID,
    });
    return gaps.length ? { createdMissing: gaps } : {};
  }

/**
   * The chat a card came from: id and name, only while the topic exists (a
   * deleted chat would open a ghost tab). Display only.
   */
  let openerNameQuery: ReturnType<typeof db.prepare> | null = null;

function topicBrief(id: string): { name: string | null; kind: ChannelKind | null; agent: string | null } | null {
    try {
      // Prepared once: a list of thousands of cards would otherwise compile one statement per row.
      openerNameQuery ??= db.prepare("SELECT name, icon, project_path FROM topics WHERE id = ?");
      const t = openerNameQuery.get(id) as { name?: string | null; icon?: string | null; project_path?: string | null } | null;
      return t ? { name: t.name ?? null, kind: channelKindOfIcon(t.icon), agent: agentOfPath(t.project_path) } : null;
    } catch { return null; }
  }

function openerOf(r: { origin_topic_id?: string | null; created_by_topic_id?: string | null }): { openerTopicId?: string; openerName?: string; openerAgent?: string } {
    const id = r.origin_topic_id ?? r.created_by_topic_id;
    if (!id) return {};
    const t = topicBrief(id);
    // The always-on agent whose chat opened the card (its home folder says which): the card is that agent's work.
    return t ? { openerTopicId: id, ...(t.name ? { openerName: t.name } : {}), ...(t.agent ? { openerAgent: t.agent } : {}) } : {};
  }

  /**
   * The Jarvis channel a card's work came from: the chat linked on purpose
   * (`channel_topic_id`) wins, else the opener chat when it is itself a channel
   * chat. Only while that chat exists and wears a channel mark: a deleted chat
   * would open a ghost tab, and an ordinary chat is not a channel. Display only.
   */
  function channelOf(r: { channel_topic_id?: string | null; origin_topic_id?: string | null; created_by_topic_id?: string | null }): { channel?: { topicId: string; name: string; kind: ChannelKind; place?: ChannelPlace; agent?: string } } {
    for (const id of [r.channel_topic_id, r.origin_topic_id, r.created_by_topic_id]) {
      if (!id) continue;
      const t = topicBrief(id);
      if (t?.kind) {
        let place: ChannelPlace | null = null;
        try { place = channelPlaceOf(t.name ?? ""); } catch { /* the bridge database is optional */ }
        // The agent that answers in that channel (Jarvis, Visione...): read from the chat's home folder.
        return { channel: { topicId: id, name: t.name ?? "", kind: t.kind, ...(place ? { place } : {}), ...(t.agent ? { agent: t.agent } : {}) } };
      }
      // An explicit link names the channel: when it is gone the card is NOT re-attributed to another chat.
      if (id === r.channel_topic_id) return {};
    }
    return {};
  }

function rowToTask(r: any): Task {
    return rowsToTasks([r])[0]!;
  }

/**
   * Fill board-badge counters onto already-built tasks: direct-children
   * progress, the human interaction count (user 'comment' messages), and —
   * since `collaborator-activity` — the most recent collaborator identity
   * (`lastActorPersonName`/`lastActorDeviceName`).
   *
   * Tutte e tre le aggregazioni sono LEGATE AGLI ID IN MANO. Erano due scansioni
   * intere e senza filtro, su ogni lista e su ogni opening di task: quella su
   * `task_comments` (11.994 lines il 15/08, la tabella che cresce più in fretta)
   * non aveva nemmeno un indice utilizzabile — `idx_task_comments_task` è su
   * `task_id` soltanto, quindi il filtro su autore e tipo era comunque una
   * scansione. L'indice che la copre è
   * `idx_task_comments_task_author_kind`.
   */
  let stageColumn: boolean | null = null;

/** Does `tasks` have the workflow column? Read once: a reduced test schema may not. */
  function tasksHaveStage(): boolean {
    if (stageColumn !== null) return stageColumn;
    try { stageColumn = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some((c) => c.name === "stage"); } catch { stageColumn = false; }
    return stageColumn;
  }

function withSubtaskCounts(tasks: Task[]): Task[] {
    if (tasks.length === 0) return tasks;
    const ids = idParam(tasks.map((t) => t.id));
    const byParent = new Map<string, { total: number; done: number }>();
    const rows = db.query(
      `SELECT parent_task_id AS pid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks
        WHERE parent_task_id IN (SELECT value FROM json_each(?)) AND archived = 0
        GROUP BY parent_task_id`,
    ).all(ids) as Array<{ pid: string; total: number; done: number }>;
    for (const r of rows) byParent.set(r.pid, { total: r.total, done: r.done ?? 0 });
    // Steps at ANY depth that wait on a person (`awaitsHuman`): the columns
    // hold roots only, so a parent sitting in backlog is where a step in review
    // says it, and the Review count adds it to the roots (Kanban equals Plan).
    const reviewByParent = new Map<string, number>();
    try {
      const reviewRows = db.query(
        `WITH RECURSIVE d(root, id) AS (
           SELECT parent_task_id, id FROM tasks
            WHERE parent_task_id IN (SELECT value FROM json_each(?)) AND archived = 0
           UNION
           SELECT d.root, t.id FROM tasks t JOIN d ON t.parent_task_id = d.id WHERE t.archived = 0
         )
         SELECT d.root AS pid, COUNT(*) AS n FROM d JOIN tasks t ON t.id = d.id
          WHERE ${awaitsHumanSql(tasksHaveStage(), "t")}
          GROUP BY d.root`,
      ).all(ids) as Array<{ pid: string; n: number }>;
      for (const r of reviewRows) reviewByParent.set(r.pid, r.n);
    } catch { /* a reduced schema: no step counts as waiting */ }
    // Human message count per task: comments the user sent (kind='comment'),
    // excluding the AI/agent, system notes and auto status events.
    const byTask = new Map<string, number>();
    const mrows = db.query(
      `SELECT task_id AS tid, COUNT(*) AS n
         FROM task_comments
        WHERE task_id IN (SELECT value FROM json_each(?))
          AND author = 'user' AND kind = 'comment'
        GROUP BY task_id`,
    ).all(ids) as Array<{ tid: string; n: number }>;
    for (const r of mrows) byTask.set(r.tid, r.n);
    // The most recent collaborator write per task, one row each via MAX() +
    // GROUP BY rather than a correlated subquery per task — the same shape as
    // the two aggregates above, and for the same reason: this runs on every
    // list/get, so it has to stay a bounded batch, not an N+1.
    const byActor = new Map<string, { personName: string | null; deviceName: string | null }>();
    try {
      const arows = db.query(
        `SELECT c.task_id AS tid, d.name AS device_name, p.display_name AS person_name
           FROM task_comments c
           JOIN devices d ON d.id = substr(c.author, 7)
           LEFT JOIN people p ON p.id = d.person_id
          WHERE c.task_id IN (SELECT value FROM json_each(?))
            AND c.author LIKE 'guest:%'
            AND c.id IN (
              SELECT c2.id FROM task_comments c2
               WHERE c2.task_id = c.task_id AND c2.author LIKE 'guest:%'
               ORDER BY c2.created_at DESC LIMIT 1
            )`,
      ).all(ids) as Array<{ tid: string; device_name?: string; person_name?: string }>;
      for (const r of arows) byActor.set(r.tid, { personName: r.person_name ?? null, deviceName: r.device_name ?? null });
    } catch {
      // Schema older than devices/people (pre-084): no collaborator identity
      // to resolve — every task keeps `lastActorPersonName/DeviceName` null.
    }
    for (const t of tasks) {
      const c = byParent.get(t.id);
      if (c) { t.subtaskCount = c.total; t.subtaskDoneCount = c.done; }
      const inReview = reviewByParent.get(t.id);
      if (inReview) t.subtaskReviewCount = inReview;
      t.userCommentCount = byTask.get(t.id) ?? 0;
      const actor = byActor.get(t.id);
      t.lastActorPersonName = actor?.personName ?? null;
      t.lastActorDeviceName = actor?.deviceName ?? null;
    }
    return tasks;
  }

/**
   * Quanti figli diretti aperti (non chiusi, non archiviati) ha il task.
   *
   * È il predicato del cancello su `done`, e la card in review lo legge per dire
   * PERCHÉ approvarla non la chiuderebbe. Uno solo, non due: se il conto e il
   * cancello divergessero, la card direbbe «pronta» su un `done` che il server
   * rifiuta — cioè esattamente la bugia che quel chip esiste per togliere.
   */
  function countOpenChildren(taskId: string): number {
    const r = db.query(
      "SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'",
    ).get(taskId) as any;
    return r?.c ?? 0;
  }

/** True when the task has non-done, non-archived direct children. */
  function hasActiveChildren(taskId: string): boolean {
    return countOpenChildren(taskId) > 0;
  }

/**
   * Figli che qualcuno sta davvero lavorando o sta per lavorare.
   *
   * LA DOMANDA È «ARRIVA UN TURNO CHE MUOVA QUESTO FIGLIO?», e la risposta non è
   * la colonna in cui sta. Uno step non lo dispaccia MAI nessuno da solo (il
   * tick lista `rootsOnly`): la checklist la muove soltanto l'agente del padre
   * dentro il proprio turno. Quindi un figlio in **todo** sotto un padre senza
   * turno è fermo esattamente quanto uno in **backlog** — e contarlo «in volo»
   * mandava il padre ad aspettarlo per sempre, dieci minuti alla volta.
   * Misurato il 13/08: sette padri, ventuno card ferme sotto la soglia, e
   * nessuna colonna che lo dicesse.
   *
   * In volo restano `in_progress` e `review` (lì una mossa c'è, ed è visibile) e
   * qualunque figlio col PROPRIO chip di dispatch attivo, che si muove da sé.
   *
   * NON è la definizione dei cancelli su `done` e sull'approvazione: là un
   * sottotask fermo blocca eccome, ed è voluto (un epic non è finito perché un
   * pezzo è stato rimandato). Serve solo a distinguere «aspetta» da «non
   * aspetterà mai nessuno».
   */
  function hasChildrenInFlight(taskId: string): boolean {
    const r = db.prepare(
      "SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'" +
        `   AND (status IN ('in_progress','review') OR COALESCE(dispatch_state, '') IN (${CHILD_AGENT_COMING}))`,
    ).get(taskId) as any;
    return (r?.c ?? 0) > 0;
  }

/**
   * LO STEP HA LAVORO SUO, o e' solo una riga del titolo del padre?
   *
   * E' la differenza che decide fra le due uscite giuste, e il dato c'e' gia'
   * addosso alla riga: una sessione assegnata, dei tentativi spesi, del tempo
   * d'agente, un commit consegnato, oppure un commento che non sia una nota di
   * sistema. Uno step con una di queste tracce e' lavoro cominciato o descritto
   * da qualcuno, e buttarlo perde la lista di cio' che restava da fare; uno
   * step nudo, creato e mai toccato, e' la decomposizione del titolo e
   * archiviarlo non toglie niente a nessuno.
   *
   * Serve a SUGGERIRE, non a decidere: la board ordina i bottoni e lo scrive
   * nella domanda, la scelta resta di chi rivede.
   */
  const CHILD_OWN_WORK_SQL =
    "(CASE WHEN t.assigned_topic_id IS NOT NULL OR t.dispatch_attempts > 0 OR t.agent_ms > 0" +
    "        OR COALESCE(t.delivery_commit, '') <> ''" +
    "        OR EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.author <> 'system')" +
    "      THEN 1 ELSE 0 END)";

function parkedChildren(taskId: string): Array<{ id: string; text: string; status: string; own_work: number }> {
    return db.prepare(
      `SELECT t.id, t.text, t.status, ${CHILD_OWN_WORK_SQL} AS own_work FROM tasks t` +
        "  WHERE t.parent_task_id = ? AND t.archived = 0" +
        `   AND t.status IN ('backlog','todo') AND COALESCE(t.dispatch_state, '') NOT IN (${CHILD_AGENT_COMING})` +
        "  ORDER BY t.created_at",
    ).all(taskId) as any;
  }

/**
   * La domanda sui parcheggiati è GIÀ sulla card, e ancora senza risposta?
   *
   * Serve solo al padre che sta in review, dove la domanda si posa nel thread
   * senza muovere la card: lì non c'è nessun `delivered_reason` a fare da
   * marchio, e senza questo controllo la stessa domanda tornerebbe a ogni
   * figlio che chiude.
   *
   * Il confronto è con l'ultimo movimento dei figli parcheggiati, non con
   * l'orologio: una domanda più vecchia del parcheggio più recente parla di
   * una configurazione che non c'è più, e va rifatta. Rispondere ai due
   * bottoni muove i figli, quindi la risposta si vede da qui senza bisogno di
   * registrarla altrove.
   */
  function parkedQuestionStillStanding(parentId: string): boolean {
    const r = db.prepare(
      `SELECT 1 FROM task_comments
        WHERE task_id = ? AND author = 'system' AND content LIKE ?
          AND created_at >= COALESCE(
            (SELECT MAX(updated_at) FROM tasks
              WHERE parent_task_id = ? AND archived = 0 AND status = 'backlog'), '')
        LIMIT 1`,
    ).get(parentId, `%${REQUEUE_PARKED_LABEL}%`, parentId);
    return !!r;
  }

/**
   * IL VERSO OPPOSTO, che mancava. `parkedChildRaisedStall` guarda il padre
   * quando un figlio ENTRA in backlog; qui lo si guarda quando un figlio ne
   * ESCE per sempre, chiuso o archiviato. Nessuna porta lo faceva, e la
   * conseguenza si misura: il 13/08 tre padri fermi con `probe:stalls`, due
   * dei quali erano consegne vere dell'agente dell'11/08 che portavano ancora
   * addosso il chip «in attesa» dei figli, e una finestra di rinvio scaduta da
   * due giorni. Chiudere l'ultimo figlio non ridava un turno a nessuno.
   *
   * Si fa qualcosa solo quando al padre non resta NIENTE in volo: finché un
   * figlio si muove, il padre non è fermo e non è affar nostro.
   *
   * Quattro esiti, e la differenza è cosa resta e dove sta il padre:
   *  - checklist finita, padre fermo in `todo` con la finestra dei sottotask:
   *    la finestra si azzera e il tick lo riprende al giro dopo invece che
   *    dieci minuti più tardi. È il turno restituito.
   *  - checklist finita, padre in `review`: lo stato NON si tocca, perché lì
   *    c'è una decisione umana in attesa e adesso approvare funziona davvero.
   *    Si toglie solo il chip stantio, che dice di aspettare figli che non
   *    esistono più.
   *  - restano solo parcheggiati e il padre non è in review: `askParkedChildren`,
   *    che fa già tutto (domanda, review, due bottoni).
   *  - restano solo parcheggiati e il padre è GIÀ in review: la domanda si posa
   *    nel thread e basta. Muoverlo scriverebbe `delivered_by = 'system'` sopra
   *    una consegna vera, e sulla card quella è la riga che dice al reviewer se
   *    sotto c'è un deliverable.
   */
  function childLeftFlight(parentId: string, by: string, svc: TaskService): void {
    try {
      const parent = getTaskRow(parentId);
      if (!parent || parent.archived === 1 || parent.status === "done") return;
      if (hasChildrenInFlight(parentId)) return;
      const ts = now();
      // Il chip «in attesa» va tolto solo se non sta aspettando qualcos'ALTRO.
      // `wait_reason` è l'attesa dichiarata dall'agente (`deferForWait`): quella
      // resta. La finestra invece si azzera anche se è ancora aperta, ed è tutto
      // il punto: erano dieci minuti presi per aspettare i figli, i figli non ci
      // sono più, e aspettarli ancora sono turni pagati per niente.
      const staleWaitChip = parent.dispatch_state === "waiting" && !parent.wait_reason;
      const clearWaitChip = () => {
        db.prepare(
          `UPDATE tasks SET dispatch_state = NULL, dispatch_error = NULL,
              dispatch_deferred_until = NULL, updated_at = ? WHERE id = ?`,
        ).run(ts, parentId);
      };

      if (!hasActiveChildren(parentId)) {
        if (staleWaitChip) clearWaitChip();
        return;
      }

      if (parent.status !== "review") { svc.askParkedChildren({ taskId: parentId, by }); return; }
      // Una card che porta già una domanda viva non ne riceve una seconda: due
      // domande sulla stessa card non sono più informazione, sono rumore, e il
      // reviewer non sa a quale delle due sta rispondendo.
      if (parent.dispatch_state === "needs_input") return;
      if (parkedQuestionStillStanding(parentId)) return;
      const parked = parkedChildren(parentId);
      if (parked.length === 0) return;
      const elenco = parked.map((c) => `«${c.text.length > 60 ? `${c.text.slice(0, 59)}…` : c.text}»`).join(", ");
      // Stesso suggerimento di `askParkedChildren`, e per la stessa ragione: la
      // domanda si posa in un thread, non su una card che si muove, ma chi la
      // legge ha lo stesso bisogno di sapere quali step hanno lavoro sotto.
      const withWork = parked.filter((c) => c.own_work === 1).length;
      svc.addComment({
        taskId: parentId, author: "system",
        content:
          `Chiuso l'ultimo sottotask in lavorazione, e restano ${parked.length} passi parcheggiati in backlog (${elenco}): ` +
          `nessun dispatcher li prende da solo, e con un sottotask aperto questa card non si può approvare. ` +
          (withWork > 0
            ? `${withWork} hanno lavoro proprio: promuoverli a task li rende servibili dalla coda. `
            : `Nessuno ha lavoro proprio: sono la decomposizione del titolo. `) +
          `Li promuovo a task, li rimetto in coda, o archivio ciò che non serve più?`,
        questionOptions: withWork > 0
          ? [PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL]
          : [ARCHIVE_PARKED_LABEL, PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL],
      });
      if (staleWaitChip) clearWaitChip();
    } catch { /* un avviso non fa mai fallire la chiusura di una card */ }
  }

/**
   * `guest:<deviceId>` → the person and device that actually wrote the row, or
   * null when nothing resolves (revoked device, deleted person, non-guest
   * author). Never touches `task_comments`: the identity is looked up fresh
   * every read, the same choice `shared/comment-author.ts` documents for the
   * `agent:` prefix — the row is not worth a migration, the label is derived.
   */
  function resolveGuestActor(author: string | null | undefined): { personName: string | null; deviceName: string | null } | null {
    if (typeof author !== "string" || !author.startsWith("guest:")) return null;
    const deviceId = author.slice("guest:".length).trim();
    if (!deviceId) return null;
    try {
      const row = db.prepare(`
        SELECT d.name AS device_name, p.display_name AS person_name
          FROM devices d
          LEFT JOIN people p ON p.id = d.person_id
         WHERE d.id = ?`).get(deviceId) as { device_name?: string; person_name?: string } | undefined;
      if (!row) return null;
      return { personName: row.person_name ?? null, deviceName: row.device_name ?? null };
    } catch {
      // Schema older than the devices/people tables: no identity to resolve.
      return null;
    }
  }

function rowToComment(r: any): TaskComment {
    let mentions: string[] = [];
    if (r.mentions) { try { mentions = JSON.parse(r.mentions); } catch { mentions = []; } }
    let media: string[] = [];
    if (r.media) { try { media = JSON.parse(r.media); } catch { media = []; } }
    // Every kind the client can act on has to survive the round-trip. A kind
    // missing from this list is written to disk and read back as a plain
    // comment, which is silent: the row still renders, just without whatever
    // the mark was for. That is exactly how 'service' - the dispatcher's own
    // bookkeeping, marked at the source so the thread can fold it - came back
    // unmarked from both `addComment` and `get()`, leaving the fold with
    // nothing to fold. Unknown values still fall back to 'comment', so a typo
    // at a call site costs a visible row rather than a hidden one.
    const kind: TaskComment["kind"] =
      r.kind === "status" ? "status"
        : r.kind === "review-note" ? "review-note"
          : r.kind === "service" ? "service"
            : r.kind === "delivery" ? "delivery"
              : "comment";
    const guestActor = resolveGuestActor(r.author);
    return {
      id: r.id, taskId: r.task_id, author: r.author, content: r.content, mentions, media, createdAt: r.created_at, kind,
      messageId: r.message_id ?? null, origin: r.origin ?? null, quiet: r.quiet === 1 ? true : null,
      actorPersonName: guestActor?.personName ?? null,
      actorDeviceName: guestActor?.deviceName ?? null,
    };
  }

let commentOriginColumn: boolean | null = null;

function supportsCommentOrigin(): boolean {
    if (commentOriginColumn === null) {
      const columns = db.prepare("PRAGMA table_info(task_comments)").all() as Array<{ name?: string }>;
      commentOriginColumn = columns.some((column) => column.name === "origin");
    }
    return commentOriginColumn;
  }

/**
   * Append a status-transition event to the thread (kind='status'). Direct
   * INSERT — no dedupe, no question composing: transitions are deliberate
   * writes and each one IS the history entry ("chi l'ha spostato e quando").
   * The task's own status write already bumped updated_at (change signal).
   *
   * `reason` risponde alla terza domanda, quella che mancava: PERCHÉ. Una card
   * che esce da `done` perché il land è andato in conflitto era indistinguibile
   * da un umano che l'ha ritirata a mano — stessa riga, stesso autore. Il
   * formato lo scrive `formatStatusEvent`, e nessuno lo compone a mano.
   */
  function logStatus(taskId: string, from: string, to: string, by: string, reason?: string | null, origin?: TaskActionOrigin): void {
    try {
      const recordedOrigin = origin ?? ((by === "system" || by === "dispatcher" || by === "verifier") ? "system" : null);
      if (supportsCommentOrigin()) {
        db.prepare(
          "INSERT INTO task_comments (id, task_id, author, content, kind, created_at, origin) VALUES (?, ?, ?, ?, 'status', ?, ?)",
        ).run(uuid(), taskId, by || "system", formatStatusEvent(from, to, reason), now(), recordedOrigin);
      } else {
        db.prepare(
          "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, ?, ?, 'status', ?)",
        ).run(uuid(), taskId, by || "system", formatStatusEvent(from, to, reason), now());
      }
    } catch { /* history is best-effort — never fail the transition itself */ }
  }

/**
   * Quando è iniziato il turno corrente = l'evento `…→in_progress` più recente.
   * Lo leggono `annotateDeliveryClaims` (le rivendicazioni di QUESTO turno) e
   * `hasFreshAgentComment` (la porta di sistema).
   *
   * NON è una `LIKE '%in_progress'`: da quando una transizione può portare la
   * sua ragione (`done→in_progress · il land…`), il contenuto non finisce più
   * con lo stato — e la LIKE avrebbe pescato un turno PRECEDENTE, spostando
   * indietro il confine: rivendicazioni vecchie riaccusate sotto una consegna
   * nuova, e la porta di sistema aperta da una parola di ieri. Le lines di
   * stato di un task sono poche:
   * si leggono e si spacchettano con l'unico parser.
   */
  function lastTurnStart(taskId: string): string | null {
    const rows = db.prepare(
      "SELECT content, created_at FROM task_comments WHERE task_id = ? AND kind = 'status'",
    ).all(taskId) as Array<{ content: string; created_at: string }>;
    let latest: string | null = null;
    for (const r of rows) {
      if (!statusEventEnters(r.content, "in_progress")) continue;
      if (latest === null || r.created_at > latest) latest = r.created_at;
    }
    return latest;
  }

/**
   * Il predicato del gate `review_needs_summary`, estratto per essere chiamato
   * anche dalle porte di sistema (`deliverToReviewBySystem`, `askParkedChildren`)
   * che non passano da `update()`.
   *
   * Dentro `update()` il predicato BLOCCA (l'agente può riprovare). Dalle porte
   * di sistema NON blocca — il turno e' gia' finito, la card deve andare da
   * qualche parte — ma il fatto si ANNOTA: chi rivede sa subito che l'agente non
   * ha dichiarato nulla, e non deve scoprirlo aprendo il worktree.
   *
   * `true` = il turno ha prodotto almeno un commento dell'agente = consegna non
   * muta. `false` = nessuna parola fresca = annotare.
   */
  /**
   * ANNOTATES a delivery with whichever of its claims do not hold up.
   *
   * IT DOES NOT BLOCK, and that is a choice rather than a lack of nerve. An
   * audit of `done` tasks found 14 cards closed with no work behind them, and
   * the four mechanical checks (`deliveryReportChecks.ts`) catch them. But the
   * check can be wrong: in its first hour of life it accused 20 paths that all
   * existed, because reports cite files by short name. A gate that blocks an
   * honest delivery gets switched off, and then it is not there for the
   * dishonest one either.
   *
   * So: it writes a review note the human reads before approving. `replaces`
   * keeps it in ONE slot rather than a pile, because this runs on every
   * transition into review.
   *
   * Best-effort throughout: any error here is swallowed. A missing note must
   * never stop a finished turn from delivering.
   */
  function annotateDeliveryClaims(
    taskId: string,
    projectId: string | undefined,
    /** The service's `addComment`: passed in rather than reached, because this
     *  function lives outside the object that exposes it. */
    emit: (a: { taskId: string; author: string; content: string; kind: "review-note"; projectId?: string; replaces?: string }) => unknown,
  ): void {
    try {
      // THE SLOT IS EMPTIED HERE, not by the note that fills it.
      //
      // `replaces` only deletes when something new gets written, so a card
      // annotated in turn 1 and delivered clean in turn 2 kept the turn-1
      // accusation on it: the reviewer read a "commit 0000000deadbee1 does not
      // exist" note under a delivery that mentioned no commit at all. Each
      // delivery answers for itself — the previous one's note goes away with
      // the previous one.
      db.prepare(
        "DELETE FROM task_comments WHERE task_id = ? AND kind = 'review-note' AND content LIKE ?",
      ).run(taskId, `${DELIVERY_CLAIM_SLOT}%`);
      // And a note still on its way for the previous delivery must not land
      // after this: see `late` below.
      const generation = (deliveryGeneration.get(taskId) ?? 0) + 1;
      deliveryGeneration.set(taskId, generation);

      const turnStart = lastTurnStart(taskId);
      // 'delivery' belongs here, and is in fact the FIRST thing to check: it is
      // the declared report, the one the reviewer reads. Leaving it out would
      // have made this check blind to exactly the sentence it exists for.
      const rows = db.prepare(
        `SELECT content FROM task_comments
          WHERE task_id = ? AND ${agentAuthorSql()}
            AND COALESCE(kind, 'comment') IN ('comment', 'delivery')
            AND (? IS NULL OR created_at >= ?)
          ORDER BY created_at DESC LIMIT 3`,
      ).all(taskId, turnStart, turnStart) as Array<{ content: string }>;
      if (rows.length === 0) return;

      let probe: RepoProbe = repoProbe;
      let knownRoots: string[] = [];
      try {
        const row = getTaskRow(taskId);
        const root = opts.repoRootFor?.({ taskId, projectId, assignedTopicId: (row?.assigned_topic_id as string | null) ?? null }) ?? null;
        if (root) probe = (opts.probeFor ?? probeForRoot)(root);
        try { knownRoots = opts.listRepoRoots?.() ?? []; } catch { /* best-effort */ }
        if (knownRoots.length === 0) {
          try { knownRoots = opts.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
        }
        if (root) knownRoots.unshift(root);
      } catch { /* the server's own checkout, as before */ }
      const reports = rows.map((r) => r.content ?? "");
      /** True when a note was written. */
      const writeNote = (answers: RepoProbe): boolean => {
        const findings = reports.flatMap((r) => checkDeliveryReport(r, answers));
        // "Nothing to check" is not a finding worth showing: that is a report
        // written in prose, which is legitimate. Only what was LOOKED UP and not
        // found gets annotated.
        const real = findings.filter((f) => f.code !== "nothing-to-check");
        if (real.length === 0) return false;

        const lines = [...new Set(real.map((f) => `- ${f.detail}`))].slice(0, 8);
        emit({
          taskId,
          author: "verifier",
          kind: "review-note",
          ...(projectId ? { projectId } : {}),
          replaces: DELIVERY_CLAIM_SLOT,
          content:
            `${DELIVERY_CLAIM_SLOT} ${lines.length} rivendicazione/i del rapporto non si verificano:\n` +
            lines.join("\n") +
            "\n\nNon blocca l'approvazione: e' un controllo meccanico e puo' sbagliare. " +
            "Ma ognuna di queste si controlla in due secondi, ed e' esattamente cio' che nessuno " +
            "faceva sulle 14 carte chiuse senza lavoro.",
        });
        return true;
      };
      // Git is never asked inside this update (`git log -S` took up to 20 s
      // here, with the whole server standing still): the probe asks off the
      // loop, and the note follows its answers. A report that asks git nothing
      // is written now, and so is anything checked by a probe that answers
      // inline, as the injected ones in the tests do.
      const asksGit = reports.some((r) => {
        const q = gitQuestions(r);
        return q.shas.length > 0 || q.citesFiles || q.symbols.length > 0;
      });
      if (!probe.prepare || !asksGit) { writeNote(probe); return; }
      const late = (answers: RepoProbe): void => {
        // THE NOTE ANSWERS FOR ITS OWN DELIVERY. If the card was delivered
        // again meanwhile, that delivery emptied the slot and this report is
        // no longer the one under review: written now, an old accusation
        // would sit under a clean delivery (PR #147, second review).
        if (deliveryGeneration.get(taskId) !== generation) return;
        try {
          if (writeNote(answers)) opts.onLateDeliveryNote?.(taskId, projectId);
        } catch { /* as below */ }
      };
      trackDeliveryNote(probe.prepare(reports, { knownRoots }).then(late, () => {}));
    } catch {
      // See the docblock: a missing note is not a delivery failure.
    }
  }

/** Slot prefix: `replaces` uses it to empty before filling. */
  const DELIVERY_CLAIM_SLOT = "[consegna]";

/** Per card, how many times it has been annotated: a late note checks it is
   *  still the latest before writing. */
  const deliveryGeneration = new Map<string, number>();

function hasFreshAgentComment(taskId: string): boolean {
    const turnStart = lastTurnStart(taskId);
    const c = (db.prepare(
      `SELECT COUNT(*) AS c FROM task_comments
        WHERE task_id = ? AND ${agentAuthorSql()} AND kind IN ('comment', 'delivery')
          AND (? IS NULL OR created_at >= ?)`,
    ).get(taskId, turnStart, turnStart) as any).c as number;
    return c > 0;
  }

/**
   * Segna che una card è USCITA da `done` o da `review`, per le porte che
   * scrivono lo status a SQL grezzo (release, deferForWait,
   * deliverToReviewBySystem, il rifiuto in review). `update()` scrive le stesse
   * colonne dentro la sua unica UPDATE — qui non passa.
   *
   * Le due partenze valgono uguale: chi tira una card fuori dalla consegna sta
   * chiedendo un SEGUITO, e il segno non può dipendere da quale colonna ha
   * attraversato. No-op su tutto il resto, sull'arrivo in `done` (lì il ciclo si
   * chiude e il segno cade, non si accende) e sulla transizione che non muove
   * niente — una consegna forzata su una card GIÀ in review non è un'uscita.
   */
  function markReopened(taskId: string, from: string, to: string, actor: "human" | "agent" | "system", by: string): void {
    if (from !== "done" && from !== "review") return;
    if (to === "done" || to === from) return;
    try {
      // `done_actor` si spegne solo uscendo da `done`: una card in review non ne
      // ha uno, e cancellarlo da qui riscriverebbe una decisione che questo
      // salto non tocca.
      const spegniDone = from === "done" ? "done_actor = NULL, " : "";
      // Il marchio dell'umano non lo cancella la macchina passandoci sopra: una
      // card già segnata «riaperta da Attilio» può riconsegnare e poi rientrare
      // in coda da una porta di sistema, e riscriverla `system` spegnerebbe il
      // cancello che protegge la sua richiesta.
      const nonScavalcare = actor === "human" ? "" : " AND (reopened_actor IS NULL OR reopened_actor <> 'human')";
      db.prepare(
        `UPDATE tasks SET ${spegniDone}reopened_at = ?, reopened_by = ?, reopened_actor = ? WHERE id = ?${nonScavalcare}`,
      ).run(now(), by || "system", actor, taskId);
    } catch { /* la traccia è best-effort — non fa fallire la transizione */ }
  }

/**
   * LA RICHIESTA DI APPROVAZIONE SI CHIUDE CON LA CARD, da qualunque porta esca.
   *
   * Era scritta a mano in due punti e mancava negli altri due. Misurate il 13/08:
   * 13 lines `pending` su 48 appese, 9 delle quali su card già `done` — la
   * migration 068 aveva già dovuto ripulire esattamente questa perdita. Landare e
   * archiviare sono le due strade che restavano scoperte: la prima chiude la card
   * a SQL grezzo (`settleLanded`), la seconda la toglie dalla board senza passare
   * da `update`.
   *
   * L'ESITO non è sempre lo stesso, ed è la parte che non si può accorpare:
   * arrivare a `done` è ciò che l'approvazione chiedeva, quindi `approved`; ogni
   * altra destinazione la rende priva di oggetto — `expired`, non `rejected`,
   * perché nessuno ha detto di no. Il `rejected` lo scrive solo chi ha davvero
   * ricevuto un no da una persona.
   *
   * Best-effort: la riga è contabilità, e non deve poter far fallire la
   * transizione che la chiude.
   */
  function settleReviewApproval(
    taskId: string,
    outcome: "approved" | "rejected" | "expired",
    by: string,
    ts: string,
    comment?: string | null,
  ): void {
    try {
      db.query(
        `UPDATE approvals SET status = ?, reviewed_by = ?,
            review_comment = COALESCE(?, review_comment), reviewed_at = ?
          WHERE task_id = ? AND approval_type = 'review' AND status = 'pending'`,
      ).run(outcome, by, comment ?? null, ts, taskId);
    } catch { /* contabilità: non fa fallire la transizione */ }
  }

function getTaskRow(taskId: string): any {
    return db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
  }

/**
   * Validate a blocked-by edge `taskId → blockerId`. The blocker must exist
   * and be alive; self-blocks and cycles (walking the blockers' own chain)
   * are rejected — a cycle would deadlock the whole dispatch queue.
   */
  function assertBlockerValid(taskId: string, blockerId: string): void {
    const blocker = getTaskRow(blockerId);
    if (!blocker || blocker.archived) {
      throw new TaskServiceError("not_found", `blocker task ${blockerId} not found`);
    }
    if (blockerId === taskId) {
      throw new TaskServiceError("invalid_input", "a task cannot be blocked by itself");
    }
    let cur: string | null = blocker.blocked_by_task_id ?? null;
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur === taskId) throw new TaskServiceError("invalid_input", "blocked-by chain would form a cycle");
      cur = (getTaskRow(cur)?.blocked_by_task_id ?? null) as string | null;
    }
  }

/**
   * Un padre può ancora ADOTTARE?
   *
   * Archiviato no, e questo si guardava già. CHIUSO nemmeno, e questo mancava:
   * annidare uno step sotto una card in Done costruisce un vicolo cieco con una
   * chiamata perfettamente legittima. Nessun dispatcher prende gli step, il
   * padre è chiuso quindi nessuno ne apre più l'albero, e la sonda dei figli
   * parcheggiati esce subito su un padre `done`. Il cancello su `done` impedisce
   * di CHIUDERE un padre con figli aperti; senza questo, la stessa coppia si
   * otteneva dall'altro verso — prima chiudi, poi attacca.
   */
  function isParentAlive(parent: any): boolean {
    return !parent.archived && parent.status !== "done";
  }

/**
   * Archiviazione a cascata: archiviare un padre archivia TUTTO il sottoalbero
   * (soft-delete voluto: un sottotask orfano di un padre archiviato sarebbe una
   * riga irraggiungibile, che la board non può più mostrare in contesto).
   * Unica implementazione, condivisa da `archive()` e da `merge()`: due copie
   * significherebbero due semantiche che divergono al primo ritocco.
   */
  function archiveSubtree(taskId: string, ts: string): void {
    db.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
       )
       UPDATE tasks SET archived = 1, updated_at = ?,
         dispatch_state = CASE WHEN dispatch_state = 'queued' THEN NULL ELSE dispatch_state END
       WHERE id IN (SELECT id FROM subtree)`,
    ).run(taskId, ts);
    // The dispatcher skips archived cards: leaving 'queued' made them look like
    // a stuck queue (10/11, 11 cards "queued" for the PC for weeks).
  }

/** `checkStage` (board-workflow.ts), its refusal as the service's error. */
  function checkedStage(columns: readonly WorkflowColumn[], stage: string, status: TaskStatus | undefined): string | null {
    const r = checkStage(columns, stage, status);
    if ("error" in r) throw new TaskServiceError("invalid_input", r.error);
    return r.stage;
  }

/**
   * The question a card carries into review when nobody wrote one: the
   * «aspetta: attilio — …» line of its description, else the move the
   * delivery itself names (a branch to look at, the system's next move).
   * Without it the card sat in review asking nothing, and nobody knew what to
   * decide (10/11: e9a68aa7 had the line, 887341aa and cd972f2f a node delivery).
   */
  // Never an invented question: a card with no line and no declared move stays without one, so the auto-land
  // (which refuses a card that asks something) still takes a green invisible delivery.
  function reviewAskFallback(row: { description?: string | null }, hint?: string | null, description?: string | null): string | null {
    const line = waitsLineAsk(description ?? row.description);
    if (line) return line;
    if (hint && hint.trim()) return hint.trim().split("\n")[0]!.slice(0, 240);
    return null;
  }

/** `agentAskInThread` (shared/workflow.ts) on this card's thread. */
  function agentAskOnThread(taskId: string): string | null {
    try { return agentAskInThread(serviceRef!.get(taskId)?.comments ?? []); } catch { return null; }
  }

/**
   * The question a delivery the SYSTEM makes carries (the turn ended without
   * one, the parked-children question): `humanAsk` is what the thread or the
   * system asks the person, else the fallback above. Written only when it
   * changes something, like `update()`; the stage goes back to the plain
   * Review column.
   */
  function writeSystemDeliveryAsk(taskId: string, humanAsk: string | null, fallback?: string | null): void {
    const row = getTaskRow(taskId);
    if (!row || row.parent_task_id) return;
    // A card that reaches the person says what it asks (10/11, `solido`: three cards in review with no question)
    if (!humanAsk) humanAsk = reviewAskFallback(row, fallback);
    if (row.stage == null && row.human_ask == null && !humanAsk) return;
    db.prepare("UPDATE tasks SET stage = NULL, human_ask = ? WHERE id = ?").run(humanAsk, taskId);
  }
  return {
    bindService,
    CARD_COMMENTS_DEPTH,
    CARD_COMMENT_CHARS,
    CARD_CONTEXT_CHARS,
    CHILD_OWN_WORK_SQL,
    DELIVERY_CLAIM_SLOT,
    DESCRIPTION_PREVIEW_CHARS,
    FENCE,
    MAX_ANCESTOR_DEPTH,
    PREVIEWABLE_MEDIA,
    PREVIEW_SLIDES_MAX,
    QUESTION_FENCE,
    SQL_IS_DELIVERY,
    SQL_MIA,
    SQL_PAROLA,
    VIDEO_MEDIA,
    agentAskOnThread,
    annotateDeliveryClaims,
    anteprimaUtile,
    archiveSubtree,
    assertBlockerValid,
    awaitingAnswerFor,
    baseName,
    buildBatch,
    cardCommentContent,
    cardCommentsFor,
    checkedStage,
    childLeftFlight,
    commentOriginColumn,
    countOpenChildren,
    deliveryGeneration,
    digestCache,
    drawsCardComments,
    duplicatePreviewOf,
    ensureDeliverySheet,
    fileDigest,
    fileExists,
    getTaskRow,
    hasActiveChildren,
    hasChildrenInFlight,
    hasFreshAgentComment,
    heavyInFlight,
    idParam,
    isParentAlive,
    labelsFor,
    lastTurnStart,
    lastWordOfThread,
    liveCardGaps,
    logStatus,
    mapRow,
    markReopened,
    noteDuplicatePreview,
    now,
    openerNameQuery,
    openerOf,
    topicBrief,
    parkedChildren,
    parkedQuestionStillStanding,
    previewImagesFor,
    previewOf,
    promoteReviewPreview,
    queueReasonOf,
    rankQueue,
    readGlobalDispatch,
    rejectedPaths,
    releaseContainerFromCardContract,
    resolveGuestActor,
    resolveSubtaskWork,
    reviewAskFallback,
    reviewNote,
    writeSystemDeliveryAsk,
    rowToComment,
    rowToTask,
    rowsToTasks,
    settleReviewApproval,
    stageColumn,
    supportsCommentOrigin,
    tasksHaveStage,
    tooTallForCard,
    topicsCols,
    topicsColumns,
    topicsHasEffort,
    topicsHasModel,
    uuid,
    withSubtaskCounts,
    writeDeliverySheet,
  };
}
