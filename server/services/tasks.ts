/**
 * tasks.ts — the single task service (Phase 0 of kanban-agent-authoring).
 *
 * Single writer for the `tasks` + `task_comments` + `approvals` tables. It exists
 * to collapse three divergent write paths (the inline INSERT in `routes/chat.ts`,
 * the `claude-tasks-sync.ts` file-watcher, and the MCP/board routes) onto ONE
 * point that enforces the invariants.
 *
 * Hard invariant (KANBAN-05): an `actor: "agent"` may NEVER move a task to
 * `done`. It hands off to `review`, opening an `approvals(approval_type='review')`
 * row; only an `actor: "human"` closes `review → done`. The gate holds even when
 * `board_settings.require_approval_for_done` is off — it is a property of the
 * actor, not a board setting.
 *
 * Idempotency (KANBAN-03): `create({ idempotencyKey })` writes the key into
 * `tasks.claude_task_id` (UNIQUE, partial index — migration 026), the same
 * key-space the file-watcher uses, so a task created via MCP and the same task
 * seen by the watcher never split into two.
 *
 * The module is environment-pure: it takes the `Database` (bun:sqlite) plus
 * optional injectable `now`/`uuid`, so tests run on a deterministic `:memory:`
 * DB without booting the server.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseReviewChecks, serializeReviewChecks, type CheckRun } from "./review-checks";
import { imageShape } from "./image-shape";
import { readGlobalCap } from "./dispatch-capacity";
import { liveAgentCount } from "./agent-census";

// Stati e forma del thread stanno in `shared/board.ts`: il client li legge
// dalla stessa dichiarazione invece di riscriverli. `export type … from`
// ri-esporta ma NON porta i nomi in scope locale, e qui sotto servono — da cui
// l'import separato. Della lista `TASK_STATUSES` questo modulo non è una porta:
// chi la vuole la prende da `shared/board`.
export type { TaskStatus, TaskComment, CardComment, BoardSettings, BoardSettingsPatch, BlockerRef, SubtaskWork, QueueReason } from "../../shared/board";
import {
  ACTIVE_DISPATCH_STATES, ARCHIVE_PARKED_LABEL, DISPATCH_CHIP_QUEUED, clampGlobalCap,
  MAX_FANOUT, PARKED_STOPPED, PARKED_WAITED_OUT, PREVIEW_CARD_MAX_RATIO, QUEUE_REASON_UNKNOWN,
  PARKED_REQUEUE_NOTE_LIKE, REQUEUE_PARKED_LABEL, TAKE_OVER_PARKED_LABEL, TASK_STATUSES,
  WAIT_SERIES_MAX_MS, WAIT_STREAK_CAP,
  deriveQueueReason, deriveSubtaskWork, formatStatusEvent, hasPlanApproveOption, isAgentWorking,
  isUnattributedSubtask, noteParkedChildrenResolved, parseQuestionBlock, questionAsksHuman,
  readTaskWeight, statusEventEnters, waitReasonKey,
} from "../../shared/board";
import { EFFORT_TIERS } from "../../shared/effort";
// Il vocabolario delle etichette e la regola che le deriva: una sola
// dichiarazione, letta anche dal client e dalla derivazione alla consegna.
import { CLOSER_LABELS, KIND_LABELS, deriveCloser, deriveKind, isCloserLabel, isKindLabel, isTaskLabel, normalizeLabels, type LabelSource, type TaskFile, type TaskLabel, type TaskLabelRow } from "../../shared/task-labels";
import { findNeighbours, type Neighbour } from "../../shared/task-similarity";
import type { TaskStatus, TaskComment, CardComment, BoardSettings, BoardSettingsPatch, BlockerRef, QueueReason, SubtaskWork, TaskWeight } from "../../shared/board";

export type Actor = "human" | "agent";


const STATUSES: readonly TaskStatus[] = TASK_STATUSES;

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
 * The reserved quick-reply vocabulary now lives in `shared/board.ts`, because
 * the same verdict has to be reached in the CLIENT too (the in-app review
 * banner picks its title from it) and the client cannot import from `server/`.
 * Re-exported here so the ~20 call sites that read it from the task service
 * keep one import, and so there is still exactly one definition.
 *
 * - LAND_ACTION_LABEL: the agent is prompted to offer it at delivery when its
 *   work is landable; the review route matches a human's pick and runs the land
 *   instead of resuming the agent. Keep in sync with task-dispatcher.ts (both
 *   import this constant).
 * - PUBLISH_ACTION_LABEL: land AND publish (push → deploy CI). "Going online"
 *   stays a human pick; the agent never pushes.
 * - REQUEUE/ARCHIVE_PARKED_LABEL: the two answers to the PARKED SUBTASK STALL.
 *   Measured on 12/08 across five cards: a child in backlog is dispatched by
 *   nobody (deliberate, `hasChildrenInFlight`), the parent waiting on it gets
 *   stopped so it does not spin (deliberate too), and it ended up parked in
 *   backlog — where "still" is a card's NORMAL look. The stall was
 *   indistinguishable from rest, and only a human could unstick it.
 */
export {
  ARCHIVE_PARKED_LABEL, LAND_ACTION_LABEL, PUBLISH_ACTION_LABEL, REQUEUE_PARKED_LABEL,
  isArchiveParkedLabel, isLandActionLabel, isPublishActionLabel, isRequeueParkedLabel, isTakeOverParkedLabel,
} from "../../shared/board";

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

export interface Task {
  id: string;
  projectId: string;
  text: string;
  description: string | null;
  /**
   * I primi caratteri di `description`, ed è ciò che la CARD disegna: il
   * riquadro la taglia a due righe, e il feed ne spediva 470 KB interi (su
   * 1,4 MB) perché il client la ricevesse per accorciarla.
   *
   * Sempre presente, anche quando `description` c'è: il percorso `list` lo
   * calcola con un `substr` in SQL, i percorsi a riga singola tagliando la
   * stringa. Chi disegna una card legge QUESTO; chi apre il dettaglio legge
   * `description`, che `svc.get` porta intera.
   */
  descriptionPreview: string | null;
  status: TaskStatus;
  priority: number;
  kanbanOrder: number;
  assignedTo: string | null;
  dueDate: string | null;
  chatId: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  claudeTaskId: string | null;
  assignedTopicId: string | null;
  /** null = never dispatched; queued | starting | working | needs_input. */
  dispatchState: string | null;
  dispatchAttempts: number;
  dispatchError: string | null;
  /** Agent-declared external-condition wait: while this timestamp is in the
   *  future the task sits in `todo` (chip `waiting`) and is NOT dispatch-eligible;
   *  the tick re-claims it once the window passes. null = no wait. */
  dispatchDeferredUntil: string | null;
  /**
   * Le attese dichiarate contate su una grandezza LORO, non sui tentativi.
   *
   * `waitStreak` sono le attese consecutive per la stessa ragione, `waitReason`
   * è quella ragione normalizzata (cambia ⇒ la serie riparte da uno) e
   * `waitSince` è l'istante in cui la serie è cominciata. Sfondato uno dei due
   * tetti (`WAIT_STREAK_CAP`, `WAIT_SERIES_MAX_MS`) il task si parcheggia con
   * chip `waited_out`: fermo sì, fallito no.
   */
  waitStreak: number;
  waitReason: string | null;
  waitSince: string | null;
  /**
   * Quanto questo task morde la MACCHINA quando gira (migration 090), come
   * l'ha letto il classificatore l'ultima volta che è stato dispacciato.
   * `null` = mai classificato, e ogni gate lo tratta come `light` — cioè come
   * si comportava il dispatcher prima che il peso esistesse.
   */
  dispatchWeight: TaskWeight | null;
  /** Parent task (nested subtask, unlimited depth). Set at creation only. */
  parentTaskId: string | null;
  /** Reviewable output (http/https URL) shown in the task's review panel. */
  outputUrl: string | null;
  /** Screenshot della consegna (path assoluto allowlistato, servito da
   *  /api/media) — thumbnail sulla card Kanban. */
  previewImage: string | null;
  /**
   * L'anteprima è stata RITIRATA perché non era evidenza (duplicata, un
   * placeholder, un errore). È uno stato della card, non un messaggio nel
   * thread: si spegne da solo appena arriva un'anteprima nuova, cosa che una
   * nota scritta una volta non può fare. `null` = non è mai successo.
   */
  previewRetiredAt: string | null;
  previewRetiredReason: string | null;
  /** Dispatch contract: deliver a PLAN to review before implementing. */
  planFirst: boolean;
  /** IL commento che È il piano (la tab "Piano" rende questo, non l'ultimo
   *  commento che capita). Lo scrive `addComment` riconoscendo il contratto
   *  piano-prima; `null` sui task nati prima di questo puntatore. */
  planCommentId: string | null;
  /** When the current claim started (dispatcher CAS) — the live "ci sta
   *  mettendo" ticker anchors here while a turn runs. */
  inProgressAt: string | null;
  /** Cumulative agent effort: wall-clock ms + tokens across every turn.
   *  agentTokens = input+output+cacheWrite (dedup); cache READS ride separately
   *  — they dominate real consumption but aren't "work" tokens. */
  agentMs: number;
  agentTokens: number;
  agentCacheReadTokens: number;
  /** Nobody chose a priority: the dispatched agent evaluates and sets one. */
  priorityAuto: boolean;
  /** Model override for the agent topic. null = auto (provider default). */
  model: string | null;
  /** Lo sforzo con cui il task ha girato davvero (dal topic dell'agente). Sola
   *  lettura: con la board su `auto` è l'unico posto in cui la scelta si vede. */
  effort: string | null;
  /** Dependency: not dispatch-eligible until this task is done/archived. */
  blockedByTaskId: string | null;
  /**
   * Lo stesso bloccante, RISOLTO dal DB. Il chip «in attesa di» sul client si
   * disegna da qui: la lista della board (un progetto, `rootsOnly`, non
   * archiviati) non è una fonte affidabile per il titolo del bloccante, quindi
   * lo risolve chi ha il DB sotto mano. `null` = nessun link, oppure la riga
   * puntata non esiste più (edge orfano).
   */
  blockedBy: BlockerRef | null;
  /**
   * Chi lavora questo sottotask quando non ha un agente suo — DERIVATO dalla
   * catena dei padri, non da una colonna. `null` = la domanda non si pone (non
   * è un sottotask, non è in corso, o ha già topic/chip).
   *
   * Distingue le due facce di una card `in_progress` senza topic né chip: la
   * lavora un antenato dentro il proprio turno (`parent-turn`, il flusso voluto
   * e la norma), oppure non la lavora nessuno (`unattended`, raro ma reale — e
   * fin qui invisibile, perché il recupero orfani filtra sul chip di dispatch
   * che in questa forma non c'è).
   */
  subtaskWork: SubtaskWork | null;
  /**
   * L'altra metà del legame: quanti task stanno aspettando QUESTO, contati sul
   * DB. Il chip «N in attesa» sulla card si disegna da qui, per lo stesso
   * motivo di `blockedBy`: la lista della board è un progetto solo, `rootsOnly`,
   * non archiviati — un dipendente che è un sottotask o sta in un altro
   * progetto non ci compare, e contando quella lista il legame spariva proprio
   * dalla card da cui si decide se chiudere il lavoro.
   *
   * Conta i dipendenti VIVI: non archiviati e non `done` — cioè quelli che il
   * gate di dispatch tiene ancora fermi e che ripartono quando questo chiude.
   */
  waitingOnCount: number;
  /**
   * PERCHÉ questa card è ferma in `todo`, in una frase già scritta. `null` fuori
   * da `todo` o con un agente già in volo (lì parla il chip di dispatch).
   *
   * Arriva RISOLTA dal server per la stessa ragione di `blockedBy` e
   * `waitingOnCount`, più una che è solo sua: la decisione di non dispacciare la
   * prende il dispatcher, e un client che la deducesse dai campi direbbe con la
   * faccia sicura la regola di ieri il giorno che quella cambia. Due dei tre
   * ingredienti non stanno nemmeno sulla riga — l'interruttore di dispatch e la
   * posizione in coda, che è machine-wide mentre la lista del client è un
   * progetto solo.
   *
   * NON ha niente a che vedere con le etichette `visibile`/`invisibile`/
   * `decisione`: quelle dicono CHI chiude la card e si derivano alla consegna.
   * Questa dice perché non è ancora partita.
   */
  queueReason: QueueReason | null;
  /** Branch the task delivered on, snapshotted at the transition into `review`. */
  deliveryBranch: string | null;
  /** Branch tip at delivery time — the handle that outlives the reaped branch. */
  deliveryCommit: string | null;
  reviewAt: string | null;
  deliveryFilesChanged: number | null;
  deliveryInsertions: number | null;
  deliveryDeletions: number | null;
  /** Landing audit verdict: is the delivered content actually on main?
   *  null = never audited (pre-audit task, or no delivery recorded). */
  landingState: "landed" | "unlanded" | "unverifiable" | null;
  landingCheckedAt: string | null;
  /**
   * Esito dei checks pre-review. null = mai girati (board senza check, task senza
   * worktree, task precedenti al gate) — che NON è un verde e non va disegnato come
   * tale. 'running' mentre il server li esegue.
   */
  checksState: "running" | "pass" | "fail" | "unknown" | null;
  checksAt: string | null;
  /** Il commit su cui sono girati: se il branch è avanzato, un 'pass' è scaduto. */
  checksCommit: string | null;
  /** Evidenza per il reviewer: comando per comando, esito, durata e coda dell'output. */
  checks: CheckRun[] | null;
  /**
   * Chi ha portato il task in review l'ultima volta. `'system'` è il caso che
   * cambia la domanda del reviewer: non è una consegna, è un turno finito male
   * (tentativi esauriti, modello che si rifiuta) che qualcuno deve guardare —
   * e può non esserci nessun deliverable sotto. null = mai passato di lì.
   */
  deliveredBy: "agent" | "human" | "system" | null;
  /** Perché, in forma leggibile da codice. Solo per `deliveredBy === 'system'`;
   *  la prosa completa resta nel commento di sistema del thread. */
  deliveredReason: "retries_exhausted" | "model_refused" | "fanout" | "parked_children" | null;
  /**
   * Chi ha portato la card a `done` l'ultima volta. `'human'` = una decisione di
   * Attilio (approvazione in review o trascinamento sulla board), e vale come
   * tale: un agente non la scavalca. `'agent'` = uno step di checklist che
   * l'agente ha chiuso da sé, mai passato da una review — quello resta suo e
   * può riaprirlo. null = mai chiusa, oppure storico senza approvazione (la
   * migration 097 riempie solo ciò che può provare).
   */
  doneActor: "human" | "agent" | "system" | null;
  /**
   * La card è USCITA da `done`: quando, per mano di chi e con che ruolo. Vive
   * finché non torna `done` (allora il ciclo si chiude e il segno si azzera).
   * È la traccia che mancava — il motivo di una riapertura stava nel thread, e
   * chi guardava la colonna vedeva solo un buco dove c'era una cosa fatta.
   */
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenedActor: "human" | "agent" | "system" | null;
  /** Dispatch in the BLOCKER agent's conversation instead of a fresh topic. */
  reuseBlockerContext: boolean;
  /** Direct-children counters (filled by list/get for board badges). */
  subtaskCount: number;
  subtaskDoneCount: number;
  /** Human interactions in the thread: comments authored by 'user' (kind
   *  'comment') — excludes the AI/agent, system notes and status events. Filled
   *  by list/get; the card shows it as a "quanti messaggi ho mandato" count. */
  userCommentCount: number;
  /**
   * Le etichette (migration 100), con CHI le ha scritte. `visibile`,
   * `decisione` e `invisibile` decidono chi chiude la card e si DERIVANO dal
   * diff alla consegna; il resto (`bugfix` `feature` `chore` `misura`) serve a
   * filtrare. Il vocabolario e la regola stanno in `shared/task-labels.ts` —
   * qui c'è solo la lettura.
   */
  labels: TaskLabelRow[];
  /**
   * Gli ultimi commenti PARLATI del thread (fino a tre), dal più vecchio al più
   * recente. `kind: 'status'` e `kind: 'service'` restano fuori: sono cronologia
   * delle transizioni e contabilità del dispatcher, non le parole di nessuno —
   * lo stesso taglio (`isThreadSpeech`) con cui il client sceglie quale coppia
   * mostrare sulla card.
   *
   * Esiste perché la board apriva un `GET /api/tasks/:id` pieno per OGNI card in
   * review solo per leggere il fondo del thread, e quel dettaglio carica
   * l'INTERO thread. Viaggia su ogni payload — anche sulle scritture che il
   * server ribalta sul WS — per la stessa ragione di `waitingOnCount`: un campo
   * riempito solo da `list`/`get` si spegnerebbe a ogni giro di WS fino al
   * fetch successivo.
   *
   * VUOTO fuori dalla review: è l'unica colonna che li disegna
   * (`drawsCardComments`). Vuoto perché non ce ne sono e vuoto perché nessuno
   * li guarda si leggono uguale — ed è giusto così: chi apre il thread lo
   * chiede a `svc.get`, che lo porta intero.
   */
  recentComments: CardComment[];
}

export interface CreateTaskInput {
  projectId: string;
  text: string;
  description?: string | null;
  priority?: number;
  assignedTo?: string | null;
  status?: TaskStatus;
  chatId?: string | null;
  /** Optional dedupe key → tasks.claude_task_id (UNIQUE). */
  idempotencyKey?: string | null;
  /**
   * Nest under this task (must exist, same project, not archived). Depth is
   * unbounded; cycles are impossible because the parent is set only here, at
   * creation — a fresh id can never be an ancestor of an existing row.
   */
  parentTaskId?: string | null;
  /** Dispatch contract: the agent delivers a PLAN to review before implementing. */
  planFirst?: boolean;
  /** Model override for the agent topic. Omit/null = auto. */
  model?: string | null;
  /** Wait for this task before dispatching (exists, not self, no cycle). */
  blockedByTaskId?: string | null;
  /** Reuse the blocker agent's conversation at dispatch. */
  reuseBlockerContext?: boolean;
  /**
   * PROVENIENZA: il topic che ha creato il task (migration 093). La scrive solo
   * la superficie di sessione, dal topic risolto server-side — un agent non può
   * dichiararla. Scritta una volta e mai riscritta: è ciò che rende chiudibili
   * i propri step anche dopo che il dispatcher ha rimescolato le assegnazioni
   * (vedi `isOwnStep`).
   */
  createdByTopicId?: string | null;
}

export interface UpdateTaskPatch {
  text?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: number;
  assignedTo?: string | null;
  dueDate?: string | null;
  kanbanOrder?: number;
  /** http(s) URL of the reviewable output; empty string / null clears it. */
  outputUrl?: string | null;
  /** Screenshot per la card (path assoluto); empty string / null clears it.
   *  Il gate sull'allowlist media sta nel layer route (come i media commenti). */
  previewImage?: string | null;
  /** Model override for the agent topic; null clears (= auto). */
  model?: string | null;
  /** Dependency; null clears. Validated: exists, not self, no cycle. */
  blockedByTaskId?: string | null;
  reuseBlockerContext?: boolean;
  /** Toggle "plan first" after creation (agent delivers a plan to approve before implementing). */
  planFirst?: boolean;
  /**
   * Re-nest under another task; null detaches back to a root card. Unlike at
   * creation, the id already exists and CAN be an ancestor of the new parent,
   * so the chain is walked (see `assertParentValid`). Refused while the task
   * has live work: a subtask is a step of the parent's checklist that the
   * dispatcher never claims on its own, so demoting a running card would leave
   * its agent turning with nobody watching it.
   */
  parentTaskId?: string | null;
}

export interface ListTasksInput {
  scope: "project" | "all";
  projectId?: string;
  status?: TaskStatus;
  /**
   * Only ROOT tasks (parent_task_id IS NULL). The board columns and the
   * dispatcher use this: subtasks are a parent's checklist — they live in the
   * detail tree and the "↳ n/m" counter, never as their own cards, and the
   * dispatcher must never claim a step as an independent task.
   */
  rootsOnly?: boolean;
  /**
   * Con `rootsOnly`: rimetti nel taglio gli step ORFANI — quelli il cui padre è
   * chiuso, archiviato o sparito.
   *
   * `rootsOnly` ha due consumatori con due bisogni diversi, e sotto un solo nome
   * ne serviva uno solo. Per il DISPATCHER è una regola di sicurezza («Steps are
   * never dispatch-eligible»): allargarla vuol dire un agente lanciato su uno
   * step. Per il FEED della board è una regola di lettura: uno step non è
   * arretrato, è la checklist di qualcuno — e quel «di qualcuno» smette di
   * essere vero appena il padre chiude.
   *
   * Uno step orfano non lo prende nessun dispatcher, il suo padre è in Done
   * quindi nessuno ne apre più l'albero, e `parkedChildRaisedStall` esce subito
   * su un padre chiuso. Tenerlo fuori dalle colonne non lo rimanda: lo perde.
   *
   * Default `false` — cioè `rootsOnly` puro, il comportamento di prima — e non
   * è prudenza cosmetica: sbagliare in questa direzione lascia un orfano
   * nascosto (lo stato di oggi), sbagliare nell'altra fa partire un agente su
   * uno step. Lo accende chi disegna colonne, mai chi dispaccia.
   */
  includeOrphanSubtasks?: boolean;
  /**
   * Filtro per etichetta, in AND: un task passa solo se le ha TUTTE. Il caso
   * d'uso che l'ha chiesto è «mostrami solo le visibili in review» — cioè la
   * lista che Attilio deve davvero guardare — e si combina con `status`, che è
   * la colonna. Vuoto/assente = nessun filtro.
   */
  labels?: readonly string[];
  /**
   * `true` = SOLO gli archiviati, `false`/assente = solo i vivi. Stesso modello
   * dei progetti (`project-store.list({ archived })`), non un terzo verbo: la
   * lista di default resta quella di prima, e chi vuole rivedere ciò che ha
   * archiviato lo chiede. Prima non esisteva alcun modo di chiederlo, quindi
   * archiviare un task era una porta a senso unico.
   */
  archived?: boolean;
  /**
   * SOLO questi id. Esiste per il feed dell'OSPITE, che può vedere le schede
   * condivise con lui e nient'altro: prima idratava ogni task del database per
   * poi tenerne due in JS, cioè pagava l'intera board per rispondere «due
   * card». Un insieme VUOTO vale «nessuna riga», non «nessun filtro».
   */
  ids?: readonly string[];
  /**
   * CON la `description` intera. Spento di default: la lista porta
   * `descriptionPreview` e basta, perché è quello che la card disegna (il
   * riquadro la taglia a due righe) — erano 470 KB sui 1,4 MB del feed.
   *
   * L'interruttore è rimasto perché due letture leggono davvero il testo
   * intero e non un'anteprima: la proposta di collegamento in ingresso
   * (`proposeLink`, che confronta le descrizioni) e la lista che vede un
   * agente, dove una descrizione tagliata a 240 caratteri senza dirlo è peggio
   * di una assente. Chi disegna card non lo accende mai.
   */
  withDescription?: boolean;
}


/**
 * Il patch è DERIVATO da `BoardSettings` in `shared/board.ts`: elencarne i campi
 * a mano voleva dire tenere allineate due liste (e il client ne teneva una terza,
 * già indietro di due campi).
 */
export type UpdateBoardSettingsPatch = BoardSettingsPatch;

/**
 * `tasks.checks_json` → `CheckRun[]`. Tollerante come il parser delle impostazioni:
 * un JSON storto (riga scritta a mano, formato di una versione precedente) vale
 * "nessuna evidenza", non un'eccezione che fa esplodere OGNI lettura del task.
 */
function parseChecksJson(raw: unknown): CheckRun[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? (parsed as CheckRun[]) : null;
  } catch { return null; }
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
const VALID_EFFORT = new Set<string>([...EFFORT_TIERS, "auto"]);
const VALID_DISPATCH_MCP = new Set(["bridge-only", "inherit"]);

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
const DELIVERY_SNAPSHOT_COLUMNS = [
  "delivery_branch",
  "delivery_commit",
  "delivery_files_changed",
  "delivery_insertions",
  "delivery_deletions",
  "checks_state",
  "checks_json",
  "checks_commit",
] as const;
const clampInt = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.trunc(Number.isFinite(n) ? n : lo)));

/** Recoverable, structured error — the route maps `.code` to an HTTP status. */
export class TaskServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "TaskServiceError";
  }
}

/**
 * Derive the board `project_id` from an absolute project path.
 *
 * La funzione vive in `shared/board.ts`, dichiarata UNA volta: questo modulo
 * resta la porta da cui il resto del server la importa (routes/tasks.ts,
 * lib/tab-resolver.ts, services/project-path-resolver.ts), ma non ne tiene più
 * una copia. Prima erano quarantanove, tenute insieme da un commento.
 */
export { projectIdForPath } from "../../shared/board";

/**
 * Per quanto una rivendicazione di interruzione tiene il campo.
 *
 * Tre minuti, e la misura viene dal disco: le quattro righe che hanno motivato
 * questo cancello stavano dentro tre minuti (tre «Server ripartito a metà
 * turno» a quindici secondi l'una dall'altra, poi «ripreso in diretta»), mentre
 * due interruzioni DAVVERO distinte sullo stesso task distano quanto il tetto a
 * orologio del turno — molto di più. La finestra separa le due cose senza
 * doverle distinguere, ed è il motivo per cui non è un lock permanente: un
 * secondo riavvio vero, un'ora dopo, ha ancora la sua riga.
 */
const INTERRUPT_CLAIM_MS = 3 * 60_000;

interface ServiceOpts {
  now?: () => string;
  uuid?: () => string;
  /** Window within which an identical comment (same task+author+content) is deduped. */
  commentDedupeMs?: number;
  /** Window within which a second interruption note on the same task stays silent. */
  interruptClaimMs?: number;
  /** Injectable for tests: whether a media path exists on disk (default node:fs existsSync). */
  fileExists?: (p: string) => boolean;
}

/** Cosa e' stato spostato da una fusione. I conti servono a chi la annuncia. */
export interface MergeOutcome {
  survivor: Task;
  /** La card assorbita, com'e' rimasta: archiviata, con la sua ricevuta. */
  merged: Task;
  movedComments: number;
  movedChildren: number;
  /** Quante card che aspettavano l'assorbita ora aspettano la superstite. */
  movedBlockers: number;
}

export interface TaskService {
  create(input: CreateTaskInput): Task;
  get(taskId: string, opts?: { projectId?: string }): { task: Task; comments: TaskComment[]; children: Task[] } | null;
  list(input: ListTasksInput): Task[];
  /**
   * Le board che hanno almeno una radice in coda: SOLO gli id, non i task.
   *
   * Il reconcile del dispatcher gira ogni 10 secondi e questa domanda era il suo
   * primo gesto — chiesta però idratando OGNI todo di OGNI board (payload
   * completo: etichette, bloccante, coda, commenti) per poi tenerne l'insieme
   * dei `projectId`. Era il pavimento di CPU che il freno del dispatch poi
   * misurava, cioè un freno che si frenava da solo.
   */
  boardsWithQueuedTodos(): string[];
  /**
   * `agentTopicId` (session surface only) identifies the calling agent's chat
   * topic: it unlocks the "own steps" carve-out — an agent MAY mark `done` a
   * strict descendant of the task bound to its topic (its own checklist),
   * while the KANBAN-05 gate keeps protecting the deliverable itself.
   */
  /**
   * `statusReason`: il PERCHÉ della transizione, che finisce nell'evento di
   * stato accanto a `from→to`. Serve a chi muove una card per conto della
   * macchina (il land in conflitto che la ritira da `done`): senza, la riga
   * dice solo chi e quando, e chi rivede legge un ritiro senza causa.
   */
  update(args: { taskId: string; actor: Actor; by: string; patch: UpdateTaskPatch; projectId?: string; agentTopicId?: string | null; statusReason?: string | null }): Task;
  /**
   * `questionOptions` turns the comment into a human-decision request: the
   * SERVER composes the canonical ```question``` block (question = content,
   * one `- option` per entry) so the board's quick-reply parser always gets a
   * well-formed block — an LLM caller passes structured options and never
   * reproduces markdown syntax by hand.
   */
  /**
   * `once` — questa riga descrive una CONDIZIONE, non un evento.
   *
   * La dedupe normale ha una finestra di 10 secondi e serve contro i retry. Non
   * morde su chi riscrive perche' la condizione dura: il GC dei worktree ripassa
   * ogni 30 minuti e, finche' un worktree resta sporco, riscrive la stessa frase
   * da 244 caratteri. Misurato il 18/08: 108 righe identiche su 12 card in
   * quattro ore, dieci-dodici copie byte-per-byte sulla stessa card, e il thread
   * cresce di una ogni mezz'ora finche' nessuno tocca quel worktree — cioe' per
   * giorni. `once` toglie la finestra: stesso autore, stesso testo, stessa card
   * ⇒ si scrive la prima volta e basta.
   */
  addComment(args: { taskId: string; author: string; content: string; mentions?: string[]; media?: string[]; projectId?: string; questionOptions?: string[]; kind?: "comment" | "review-note" | "service"; once?: boolean }): TaskComment;
  /**
   * Una interruzione, una riga.
   *
   * Un riavvio del server ha PIÙ scrittori che lo raccontano — il recupero del
   * fan-out, il riattacco in diretta, il resume sulla stessa sessione — e
   * ognuno scriveva la sua nota: il 13/08 il task ae61fb5a ne ha collezionate
   * quattro in tre minuti per una interruzione sola. La dedupe di `addComment`
   * non le vedeva perché guarda testo IDENTICO entro dieci secondi, e queste
   * dicono la stessa cosa con parole diverse.
   *
   * Vince il PRIMO che rivendica, perché è quello più vicino alla causa; gli
   * altri tacciono per la durata della finestra. La nota vinta è un normale
   * commento `kind: 'service'`, così cade nel raggruppamento che il thread già
   * fa (`groupServiceRuns`) invece di restare fuori dal fold.
   *
   * Ritorna la nota scritta, oppure `null` se il campo era già preso (o se il
   * task non esiste): chi chiama non deve distinguere i due casi, in entrambi
   * l'interruzione è già raccontata.
   */
  claimInterruption(args: { taskId: string; note: string; by?: string }): TaskComment | null;
  /** Human-only review decision on a task sitting in `review`. */
  reviewDecision(args: { taskId: string; by: string; decision: "approve" | "reject"; comment?: string; projectId?: string }): Task;
  /**
   * System hand-off to review after the dispatch retry budget is exhausted: the
   * agent WORKED (left a comment trail) but never moved the task to `review`
   * itself. Instead of parking it as `failed` (opaque, looks like an error), we
   * deliver it to the human — status `review`, chip `needs_input`, a `system`
   * note explaining what happened — keeping the topic binding so a rejection
   * resumes the same agent. Opens the pending review approval like a normal
   * hand-off. Reserved for the "did work, forgot to deliver" case; a task that
   * produced nothing still parks as `failed`.
   */
  /**
   * Il sistema porta in review un task che l'agente non ha consegnato da solo.
   * `cause` è la causa in forma leggibile da codice: la UI ci scrive sopra
   * l'avviso giusto senza dover interpretare la prosa di `reason`.
   */
  deliverToReviewBySystem(args: {
    taskId: string;
    reason: string;
    cause?: "retries_exhausted" | "model_refused" | "fanout";
      /**
     * La mossa che l'umano può fare, e che ha senso SOLO se la card gli arriva.
     * Chi chiude il turno sa PERCHE' è finito ma non DOVE finirà la card: le due
     * guardie qui sotto possono mandarla in coda. Separata, così la frase la
     * scrive chi sa dov'è atterrata — e non resta nel thread una promessa falsa.
     */
    nextMove?: string;
  }): Task;
  /**
   * Alza la DOMANDA dello stallo: il task va in review con chip `needs_input` e
   * un blocco ```question``` che porta le due risposte possibili come bottoni.
   *
   * Ritorna `null` quando non c'è niente da chiedere — nessun figlio aperto,
   * almeno un figlio in volo (lo aspetta davvero qualcuno), il task è chiuso o
   * archiviato, oppure sta GIÀ chiedendo (è in review: la domanda c'è).
   * Idempotente per costruzione: due giri di dispatch non fanno due domande.
   */
  askParkedChildren(args: { taskId: string; by?: string; evenIfLive?: boolean }): Task | null;
  /**
   * LO STESSO GIRO, SULLE CARD GIÀ FERME. `askParkedChildren` si arma su due
   * eventi — un figlio che si ferma, il turno del padre che finisce — e chi si
   * era fermato PRIMA non li vedrà mai più: nessun turno tornerà su quella card
   * a scoprirlo. Sono le sette misurate il 13/08, ferme da ore senza dirlo.
   *
   * Passa i padri fermi e alza la domanda su ognuno. Ritorna i task che ha
   * portato in review — vuoto quando non c'è niente da chiedere, che è il caso
   * normale. Idempotente: al giro dopo quei padri sono in review e la guardia
   * di `askParkedChildren` li salta.
   *
   * `eligible` decide board per board se il rastrello ci passa. Sta fuori di
   * qui perché l'interruttore di dispatch è roba del dispatcher: il servizio non
   * deve sapere che esiste, e chi chiama non deve poter dimenticare che una
   * board spenta non si tocca da sola.
   */
  sweepParkedChildren(args?: { by?: string; eligible?: (projectId: string) => boolean }): Task[];
  /**
   * Esegue la risposta umana allo stallo. `requeue` manda i figli parcheggiati
   * in `todo`; `archive` li archivia. In entrambi i casi il padre torna in coda
   * col chip `queued` e col budget dei tentativi azzerato — la risposta è un
   * mandato nuovo, come il trascinamento in Todo.
   *
   * Ritorna `null` quando la domanda non è più sulla card — è uscita da review,
   * o non ha più figli fermi — cioè quando qualcun altro ha già risposto: il
   * chiamante non deve inventarsi un esito.
   */
  resolveParkedChildren(args: {
    taskId: string;
    decision: "requeue" | "archive";
    by?: string;
  }): { task: Task; children: Task[] } | null;
  /**
   * Riscrive l'INTERO insieme di etichette di un task (PUT, non PATCH: la board
   * manda lo stato che vuole vedere). `actor: "agent"` passa dal cancello —
   * niente `invisibile`, e nessuna visibilità già scritta si può togliere.
   * `source` timbra chi sta scrivendo, e serve alla derivazione per sapere che
   * cosa può ricalcolare.
   */
  setLabels(args: {
    taskId: string;
    labels: readonly string[];
    actor: Actor;
    source: LabelSource;
    projectId?: string;
  }): Task;
  /**
   * La derivazione: dai file dei commit PROPRI del task alla sua visibilità.
   * Girata sull'edge verso `review`. `null` = non ha scritto niente — o il task
   * non esiste, o la visibilità è già quella, o l'ha messa a mano un umano e non
   * si tocca (una correzione che scade alla consegna dopo non è una correzione).
   */
  deriveLabelsFromDiff(args: { taskId: string; files: readonly TaskFile[] }): Task | null;
  /** Soft-delete (archive) — the row stays for history but drops off the board. */
  /**
   * Fonde `taskId` dentro `intoTaskId`: il thread e i sottotask passano alla
   * superstite, la card assorbita viene ARCHIVIATA (mai cancellata). Vedi
   * l'implementazione per la promessa esatta su cosa si perde e cosa no.
   */
  merge(args: { taskId: string; intoTaskId: string; by: string; projectId?: string }): MergeOutcome;

  /**
   * Le card VIVE di una board che dicono gia' quello che sta per essere creato.
   * Da chiamare prima di aprire la card, non dopo.
   */
  findDuplicates(args: {
    projectId: string;
    text: string;
    excludeTaskId?: string;
    limit?: number;
    /** Solo le card di primo livello: i passi ripetuti sotto padri diversi non sono doppioni. */
    rootsOnly?: boolean;
  }): Neighbour[];

  archive(args: { taskId: string; projectId?: string }): Task;
  /**
   * Il ritorno dall'archivio: `archived = 0` sul task, sul suo sottoalbero e
   * sulla catena dei genitori. Speculare ad `archive`, che scende; risalire
   * serve perché una card riportata sotto un genitore ancora archiviato
   * resterebbe invisibile quanto prima, e il ripristino non avrebbe ripristinato
   * niente. `null` = quell'id non esiste.
   */
  restore(args: { taskId: string; projectId?: string }): Task | null;
  /**
   * Nearest self-or-ancestor bound to an agent topic — the dispatch root of the
   * subtree. Lets the route answer "which agent owns this step?" when a human
   * replies on a subtask's own thread.
   */
  boundRootOf(taskId: string): Task | null;
  /**
   * The board project of the task dispatched to `topicId` (its `assigned_topic_id`).
   * This is the AUTHORITATIVE board for a dispatched agent's session — unlike the
   * topic's cwd, which for a catch-all task is a per-task private dir that maps to
   * no real board. Session task routes use this so the agent can find/comment its
   * own task even on the "generale" catch-all board. Null when the topic has no
   * bound task (a normal chat topic, not a dispatch session).
   */
  boardProjectForTopic(topicId: string): string | null;
  /**
   * The task dispatched to `topicId` (its `assigned_topic_id`) — the whole
   * handle the task-owned browser fork needs: id (→ the canonical
   * `task-<id8>-…` browser contextId), project, and text (→ the tab-inventory
   * label). Same resolution as boardProjectForTopic (prefer non-archived, most
   * recent). Null when the topic owns no task (a normal chat, not a dispatch).
   */
  taskForTopic(topicId: string): { id: string; projectId: string; text: string } | null;
  /**
   * Resolve a task from the 8-char id prefix embedded in a `task-<id8>-…`
   * browser contextId → { id, text }, so the tab inventory can label it
   * "Task: <text>". Prefers a non-archived, most-recent row if a prefix ever
   * collides (astronomically unlikely on 32 bits). Null when none matches.
   */
  taskByIdPrefix(id8: string): { id: string; text: string } | null;
  /**
   * Move a ROOT task (and its whole subtree) to another board. Subtasks never
   * move alone (same-board parent invariant) and a task with a live agent
   * stays put (its worktree/topic belong to the source project).
   */
  moveToProject(args: { taskId: string; toProjectId: string; projectId?: string }): Task;
  /**
   * Atomically claim a `todo` task for dispatch: move it to `in_progress` and
   * bump the attempt counter — but only if a slot is free (running < cap), it's
   * still `todo`, unclaimed, and under the retry cap. Returns the claimed Task,
   * or null if the claim didn't apply (no slot / lost the race / attempts
   * exhausted). The status CAS (`todo → in_progress`) IS the claim token; the
   * topic binding arrives later via bindTopic() once the real topic exists —
   * `assigned_topic_id` has a FK to topics(id) (migration 026), so a
   * placeholder id can never be written there.
   */
  claim(args: {
    taskId: string; cap: number; maxAttempts: number; agentId?: string | null; scope?: "board" | "global";
    /**
     * La macchina è SCARICA adesso? Vale solo per un task `heavy`, che parte
     * solo quando lo è (un task che compila su una macchina già piena è il caso
     * che il peso esiste per evitare). Il carico lo misura il chiamante — questo
     * modulo non deve leggere `os` — e `undefined` significa «nessuna sonda»:
     * niente gate, cioè il comportamento che c'era prima del peso.
     */
    machineIdle?: boolean;
  }): Task | null;
  /**
   * C'è un task `heavy` con un agente vivo su questa macchina adesso?
   *
   * Lo stesso predicato che il CAS di `claim` applica, esposto perché il filtro
   * del dispatcher possa fermarsi PRIMA di provare (e dirlo sulla card) invece
   * di scoprirlo da un `null` muto. Sempre globale: un task che compila si
   * prende la macchina, non la board.
   */
  hasHeavyInFlight(): boolean;
  /**
   * Quanti agenti sono VIVI adesso su questa macchina (`projectId: null`) o su
   * una board sola.
   *
   * Lo stesso conteggio che il CAS di `claim` fa valere in silenzio, esposto
   * perché il dispatcher possa DIRE sulla card «sei in coda perché il tetto è
   * pieno, e siamo N su M» invece di lasciarla ferma senza spiegazione. Non
   * decide niente: la decisione resta del CAS, che è l'unico punto atomico.
   */
  liveAgents(scope?: { projectId?: string | null }): number;
  /**
   * Bump the attempt counter of a LIVE claim (in_progress + bound topic) —
   * the dispatcher's resume-continuation after a timed-out turn. Returns the
   * updated Task, or null when the cap is hit or the claim is gone (caller
   * parks / drops).
   */
  bumpDispatchAttempt(args: { taskId: string; maxAttempts: number }): Task | null;
  /** Alive tasks whose blocked-by points at `taskId` (unblock fan-out when it completes). */
  listBlockedBy(taskId: string): Task[];
  /**
   * True when the task's blocker is still open — the SAME predicate the claim
   * CAS enforces (blocker not done and not archived), so the dispatcher's
   * eligibility filter can never diverge from the claim.
   */
  isDispatchBlocked(taskId: string): boolean;
  /**
   * Release a claimed task: clear the topic binding and requeue (`todo`) or park
   * (`backlog`), with a note.
   * - `parkState`: the dispatch_state to stamp on a PARK (requeue:false) — e.g.
   *   'failed' (genuine agent failure) vs 'blocked' (config the human must fix).
   *   Ignored on a requeue (which always shows 'queued'). Default null.
   * - `rollbackAttempt`: decrement dispatch_attempts by 1 (floored at 0). Used by
   *   the restart-orphan requeue so a server restart never erodes the retry budget.
   *
   * - `keepStatus`: il park scioglie il legame ma NON sposta la card di colonna
   *   (né stampa un timbro). Per chi ha accertato che non è successo niente di
   *   male — il GC che libera la riga fantasma di una card la cui consegna è già
   *   su main. Ignorato su un requeue.
   *
   * UNA CARD IN `review` NON SI PARCHEGGIA, `keepStatus` o meno. Il park le
   * scioglie comunque il legame col topic (l'unica cosa che serviva), ma la
   * lascia in review e senza timbro: in review non aspetta un agente, aspetta
   * una persona, e il backlog non lo dispaccia nessuno. Vedi il commento nel
   * corpo per il guasto del 12/08.
   */
  release(args: { taskId: string; requeue: boolean; reason?: string; by?: string; parkState?: string | null; rollbackAttempt?: boolean; keepStatus?: boolean }): Task;
  /**
   * Agent-declared external-condition wait: release the slot and put the task
   * back in `todo` with chip `waiting` and a `dispatch_deferred_until` window,
   * so it is NOT re-claimed until the window passes (then the tick re-dispatches
   * it fresh). Distinct from a review hand-off: it produced no deliverable, it is
   * just waiting — the note explains for what. `minutes` is clamped to [1, 1440].
   *
   * IL TENTATIVO SI RIMBORSA. Il turno che dichiara l'attesa l'ha già speso alla
   * claim, prima di poter sapere che avrebbe dovuto aspettare: senza rimborso,
   * un tetto pensato per i turni morti conta le attese e la card finisce
   * `failed` per aver fatto la cosa giusta. A limitarle c'è invece un contatore
   * LORO — attese consecutive per la stessa ragione (`WAIT_STREAK_CAP`) e durata
   * della serie (`WAIT_SERIES_MAX_MS`). Sfondato un tetto il task si parcheggia
   * in backlog con chip `waited_out`: fermo, non fallito.
   */
  deferForWait(args: { taskId: string; reason: string; minutes?: number; by?: string }): Task;
  /** Overwrite the topic binding of a claimed task (dispatcher: placeholder → real topic). */
  bindTopic(args: { taskId: string; topicId: string; freshSession?: boolean }): Task;
  /** Update just the dispatch state/error (queued|starting|working|needs_input). */
  setDispatchState(args: { taskId: string; state: string | null; error?: string | null }): Task;
  /** Persist the model actually resolved for a run (auto-pick → concrete id) so
   *  the card stops showing "auto" once the agent has run. */
  setModel(args: { taskId: string; model: string | null }): Task;
  /**
   * Ricorda il peso letto dal classificatore (migration 090). È il promemoria
   * che permette al CLAIM di decidere: il giudice parla al lancio, il gate serve
   * un passo prima, quindi la seconda volta il claim sa già con cosa ha a che
   * fare. `null` cancella (torna a «mai classificato» = leggero).
   */
  setDispatchWeight(args: { taskId: string; weight: TaskWeight | null }): Task;
  /** Toglie l'anteprima e scrive sulla card PERCHÉ (stato, non messaggio). */
  retirePreview(args: { taskId: string; reason: string }): Task;
  /** Accumulate agent effort on the task (dispatcher, at each turn end). */
  recordAgentUsage(args: { taskId: string; addMs: number; addTokens: number; addCacheReadTokens?: number }): Task;
  /**
   * Alza il conto dei token a un totale ASSOLUTO, senza mai abbassarlo.
   *
   * `recordAgentUsage` somma un delta per turno, e un delta si perde: il turno
   * che nessuno ha scritto — perché il run è stato sepolto a metà — non lo
   * scrive più nessuno, e il turno dopo riparte da una lettura più avanti.
   * Misurato su un task vero: 884 token in tabella contro 188.936 nel
   * transcript.
   *
   * Qui il chiamante porta il TOTALE che sa calcolare, e il pavimento `MAX`
   * fa il resto: un turno saltato lo recupera il turno dopo (il totale lo
   * contiene già), e una lettura che regredisce non può sottrarre. Il tempo
   * resta additivo e resta su `recordAgentUsage`: il wall-clock è per-turno e
   * non si ricava da una lettura di sessione.
   */
  raiseAgentUsage(args: { taskId: string; tokens: number; cacheReadTokens: number }): Task;
  /**
   * Snapshot what the agent delivered, at the moment it delivers it (→ review).
   * The branch is reaped once it lands, so the COMMIT is the only durable handle
   * the landing audit can hold onto. Re-recorded on every new delivery (a
   * reject→resume→review round trip delivers a new tip).
   */
  recordDelivery(args: {
    taskId: string; branch: string | null; commit: string | null;
    /** QUANTO lavoro c'è dentro. Facoltativo: assente ⇒ NULL, cioè «non
     *  misurato», che non è zero. Zero direbbe «misurato, non ha prodotto
     *  niente», ed è una frase che va detta solo quando è vera. */
    stat?: { filesChanged: number; insertions: number; deletions: number } | null;
  }): void;
  /**
   * Timbra SOLO il `delivery_branch`, senza toccare commit, diffstat o
   * landing_state. Usato dal GC (`stampDeliveryBranch`) prima di liberare la
   * cartella di un worktree: scrive l'unico pezzo che mancherebbe dopo la
   * rimozione, senza azzerare la testimonianza di una consegna precedente.
   *
   * `recordDelivery` con `commit: null` avrebbe azzerato anche il commit e il
   * diffstat (per progetto: un dato non aggiornato insieme al suo soggetto
   * mente). Questo setter esiste per il caso in cui non ci sono nuovi dati da
   * scrivere, solo un indirizzo da conservare.
   */
  /**
   * I soli NUMERI di una consegna già registrata, e solo se mancano.
   *
   * Non `recordDelivery`: quella azzera il verdetto di atterraggio (è il suo
   * mestiere, una consegna nuova invalida il verdetto vecchio) e con `stat`
   * assente scrive NULL. Per riempire un buco su una consegna che NON è
   * cambiata servono entrambe le cose al contrario. Torna `true` se ha scritto.
   */
  setDeliveryStat(args: { taskId: string; filesChanged: number; insertions: number; deletions: number }): boolean;
  setDeliveryBranch(taskId: string, branch: string): void;
  /** Esito dei checks pre-review sul task (evidenza per il reviewer). */
  recordChecks(args: {
    taskId: string;
    state: "running" | "pass" | "fail" | "unknown" | null;
    commit?: string | null;
    runs?: CheckRun[] | null;
  }): Task;
  /**
   * Spegne le spie «running» rimaste accese, e si chiama UNA VOLTA all'avvio.
   *
   * Una corsa di check vive nel processo (`services/checks-gate.ts`): se il
   * server muore mentre gira, nessuno scriverà mai il suo verdetto e la card
   * resta a filare per sempre. `running` non è uno stato che si eredita da un
   * processo morto, quindi al boot torna a «mai misurato»: chi riconsegna fa
   * ripartire i comandi, e nel frattempo la card non mente.
   *
   * Ritorna quante ne ha spente (la riga di log al boot, e i test).
   */
  clearStaleChecksRuns(): number;
  /**
   * Tasks worth auditing: alive, delivered (review/done), carrying a commit —
   * e SENZA un esito testimoniato. Un verdetto scritto dal land stesso è un
   * fatto osservato mentre il ramo esisteva ancora: la passata periodica non ha
   * niente da aggiungerci, e sovrascriverlo con la propria deduzione è
   * esattamente il modo in cui `landing_state` è finito a dire `unlanded` su
   * card dimostrabilmente dentro main.
   */
  listLandingAuditCandidates(): Array<{ id: string; projectId: string; deliveryBranch: string | null; deliveryCommit: string | null }>;
  /**
   * Persist a landing verdict. `witnessed` = lo scrive chi il land l'ha VISTO
   * (merge uscito zero, o fallito), non chi lo deduce dopo: quel verdetto
   * diventa definitivo finché la card non riconsegna.
   */
  recordLandingState(args: { taskId: string; state: "landed" | "unlanded" | "unverifiable"; checkedAt: string; witnessed?: boolean }): void;
  /**
   * Lo stato terminale che un land RIUSCITO impone alla card: `done`, chip di
   * dispatch spento, nessuna finestra di ri-tentativo. Idempotente — su una card
   * già chiusa e ferma non scrive niente e non lascia una riga di storico.
   *
   * Esiste perché il land può partire da QUALUNQUE stato (il bottone «Landa su
   * main» sulla card, `POST …/land`, il trascinamento in Done): promuoveva a
   * `done` solo passando da `review`, e una card landata da `in_progress`
   * restava in corso con un agente sopra. Misurato l'11/08 su `4ec47331`: il
   * lavoro era su main (`a5f83e0e`) e un agente ha speso un turno intero a
   * rifarlo.
   */
  settleLanded(args: { taskId: string; by?: string; reason: string }): Task | null;
  /** How many alive tasks are delivered but provably NOT on main (board badge). */
  countUnlanded(projectId?: string): number;
  /** Read the per-board dispatch config (defaults when no row exists). */
  getBoardSettings(projectId: string): BoardSettings;
  /** Upsert the per-board dispatch config. `autoDispatch` routes to the global switch. */
  updateBoardSettings(projectId: string, patch: UpdateBoardSettingsPatch): BoardSettings;
  /** Read the GLOBAL auto-dispatch switch (one for every board). */
  getGlobalAutoDispatch(): boolean;
  /** Flip the GLOBAL auto-dispatch switch; returns the new value. */
  setGlobalAutoDispatch(on: boolean): boolean;
  /** Read the GLOBAL concurrency cap (reserved row '*'): the ONE machine-wide
   *  budget the dispatcher enforces across ALL boards. `auto` → size it from live
   *  machine capacity; otherwise use the fixed `max`. Auto is the default until a
   *  manual number is explicitly chosen, so the machine is protected out of the box. */
  getGlobalCap(): { auto: boolean; max: number };
  /** Update the GLOBAL cap (row '*': max_agents_auto / max_agents). */
  setGlobalCap(patch: { auto?: boolean; max?: number }): { auto: boolean; max: number };
}

/** Reserved board_settings row that carries the global auto-dispatch switch. */
const GLOBAL_SETTINGS_KEY = "*";

export function createTaskService(db: Database, opts: ServiceOpts = {}): TaskService {
  const now = opts.now ?? (() => new Date().toISOString());
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const commentDedupeMs = opts.commentDedupeMs ?? 10_000;
  const interruptClaimMs = opts.interruptClaimMs ?? INTERRUPT_CLAIM_MS;
  const fileExists = opts.fileExists ?? existsSync;

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

  function promoteReviewPreview(taskId: string): void {
    try {
      const row = getTaskRow(taskId);
      if (!row || row.status !== "review" || (row.preview_image ?? "").trim()) return;
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
          if (!fileExists(f)) continue;
          const tall = tooTallForCard(f);
          if (tall) { rejected.push({ path: f, shape: tall }); continue; }
          // Anche l'adozione automatica supera il ritiro: la card ha di nuovo
          // un'evidenza, quindi il fatto «ritirata» ha smesso di valere.
          db.prepare(
            "UPDATE tasks SET preview_image = ?, preview_retired_at = NULL, preview_retired_reason = NULL, updated_at = ? WHERE id = ?",
          ).run(f, now(), taskId);
          noteDuplicatePreview(taskId, f);
          return;
        }
      }
      // Nessun candidato: la card resta cieca. Il riquadro vuoto lo dice gia'.
      // Le istruzioni su come allegare l'evidenza vivono nell'envelope
      // dell'agente (PREVIEW_RULE in buildKickoff e buildResume), non nel
      // thread di chi decide.
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
  function noteDuplicatePreview(taskId: string, path: string): void {
    try {
      const mine = fileDigest(path);
      if (!mine) return;
      const others = db.prepare(
        "SELECT id, text, preview_image FROM tasks WHERE preview_image IS NOT NULL AND preview_image != '' AND id != ? ORDER BY updated_at DESC LIMIT 200",
      ).all(taskId) as Array<{ id: string; text: string; preview_image: string }>;
      for (const o of others) {
        if (o.preview_image === path) continue; // stesso file, non un duplicato di contenuto
        if (fileDigest(o.preview_image) !== mine) continue;
        reviewNote(
          taskId,
          `Anteprima IDENTICA (md5 \`${mine.slice(0, 8)}\`) a quella del task \`${o.id}\`, «${(o.text ?? "").slice(0, 60)}». ` +
            "Non è un blocco: due task sullo stesso pannello possono avere davvero la stessa immagine. " +
            "Ma se è una svista, questa consegna non ha ancora un'evidenza sua.",
        );
        return;
      }
    } catch { /* best-effort: il segnale è un extra, non un invariante */ }
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
    // ragioni storiche. Finche' e' stata li', lo zero di default sulle righe
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
  const heavyInFlight = (): boolean =>
    !!db.query(
      `SELECT 1 AS h FROM tasks
        WHERE status = 'in_progress' AND dispatch_state IN ('starting','working')
          AND archived = 0 AND dispatch_weight = 'heavy' LIMIT 1`,
    ).get();

  // The model shown on a task must ALWAYS reflect what actually ran: task.model
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

    const rows = db.prepare(
      `WITH RECURSIVE chain(id, parent, depth) AS (
         SELECT id, parent_task_id, 0 FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_task_id, c.depth + 1
           FROM tasks t JOIN chain c ON t.id = c.parent
          WHERE c.depth < ?
       )
       SELECT t.id, t.text, t.status, t.dispatch_state, t.archived
         FROM chain c JOIN tasks t ON t.id = c.id
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
   * richiesta, e con due sole righe una risposta in due tempi («ci provo» +
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
   * Quanto testo di un commento viaggia sulla card, e sono DUE misure perché la
   * card ne disegna due in modo diverso.
   *
   * L'ULTIMA parola del thread la card la stampa intera, formattata, senza
   * clamp: quella tiene 1.200 caratteri (misurato il 15/08 sul DB di questa
   * macchina: 1.538 commenti idonei, 544 KB, il più lungo 4.020 caratteri —
   * sopra il tetto ci finisce il 6% di loro). Quelle PRIMA di lei possono
   * comparire solo come riga di contesto, che è una riga sola tagliata con
   * `truncate`: lì 200 caratteri sono già più di quanto entri nel riquadro.
   *
   * Il dettaglio del task porta il thread intero: qui basta ciò che si legge su
   * una scheda.
   */
  const CARD_COMMENT_CHARS = 1200;
  const CARD_CONTEXT_CHARS = 200;

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
  const drawsCardComments = (r: { status?: string }): boolean => r.status === "review";

  /** Quanti caratteri di `description` viaggiano nella lista (vedi `descriptionPreview`). */
  const DESCRIPTION_PREVIEW_CHARS = 240;

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
    Array.from(s).slice(0, DESCRIPTION_PREVIEW_CHARS).join("");

  /**
   * LA PROIEZIONE DELLA LISTA: tutte le colonne meno le due grasse.
   *
   * Misurato il 15/08 su `GET /api/all-boards/tasks` (467 radici, 1.435.735
   * byte): `description` pesava 470 KB e `checks_json` altri 217 KB, cioè metà
   * della risposta. La card taglia la descrizione a due righe e i `checks` li
   * disegna solo il dettaglio, che passa da `svc.get` e legge `SELECT *`.
   *
   * L'elenco si CHIEDE al DB invece di scriverlo a mano: una migration che
   * aggiunge una colonna la fa comparire nel payload da sola, mentre una lista
   * fissa lascerebbe `list` indietro rispetto a `get` in silenzio — due letture
   * dello stesso task con campi diversi. Se il PRAGMA non risponde si ricade su
   * `*`: una risposta grassa è meglio di una rotta.
   */
  const listColumnsCache = new Map<string, string>();
  function listColumns(withDescription: boolean): string {
    const key = withDescription ? "full" : "lean";
    const hit = listColumnsCache.get(key);
    if (hit) return hit;
    let sql: string;
    try {
      const cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
        .map((c) => c.name)
        .filter((n) => n !== "checks_json" && (withDescription || n !== "description"));
      if (!cols.length) throw new Error("no columns");
      sql = `${cols.join(", ")}, substr(description, 1, ${DESCRIPTION_PREVIEW_CHARS}) AS description_preview`;
    } catch {
      sql = `*, substr(description, 1, ${DESCRIPTION_PREVIEW_CHARS}) AS description_preview`;
    }
    listColumnsCache.set(key, sql);
    return sql;
  }

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
   * Le righe con la STESSA coppia (priorità, creazione) non sono né davanti né
   * dietro, come prima: `countBehind` chiedeva `created_at > ?`, quindi la
   * parità era già esclusa da entrambi i versi e l'`id != ?` era ridondante.
   */
  interface QueueRank {
    ahead(priority: number, createdAt: string): number;
    behind(priority: number, createdAt: string): number;
  }

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
          AND (t.blocked_by_task_id IS NULL OR EXISTS (
                 SELECT 1 FROM tasks bk
                  WHERE bk.id = t.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1)))
        ORDER BY t.priority DESC, t.created_at ASC`,
    ).all(UNASSIGNED_PROJECT_ID, nowIso) as Array<{ priority: number; created_at: string }>;
    // Il confronto in JS è lo stesso di SQLite: `created_at` è ISO-8601 ASCII e
    // la collazione di default è BINARY, quindi `<` sulle stringhe ordina come
    // l'`ORDER BY` che ha appena prodotto queste righe.
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

  /**
   * I fatti che `rowToTask` andava a chiedere UNA RIGA ALLA VOLTA, letti una
   * volta per lotto.
   *
   * Misurato il 15/08 su `GET /api/all-boards/tasks` (467 radici, DB da
   * 651 MB): da 4 a 7 statement per riga — etichette, bloccante, topic per
   * modello ed effort, dipendenti, stato del padre, impostazioni della board, e
   * per ogni `todo` i due COUNT della fila — cioè ~1.500 statement e 145 ms per
   * una lista sola. Qui sono ~10, indipendenti dal numero di righe.
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
    queue: QueueRank | null;
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

  /** Le etichette di UNA riga: il lotto da uno, per i due scrittori di etichette. */
  function labelsOf(taskId: string): TaskLabelRow[] {
    return labelsFor([taskId]).get(taskId) ?? [];
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
   * dettaglio si porta dietro l'INTERO thread (`svc.get`), non tre righe.
   *
   * Viaggiano su OGNI payload, non solo su `list`/`get`, per la stessa ragione
   * di `waitingOnCount` e `blockedBy`: le scritture escono sul WS come
   * `task:updated`, e un campo riempito solo in lettura si spegnerebbe a ogni
   * giro di WS fino al fetch successivo.
   *
   * Escono come `CardComment` — tre campi, testo tagliato — e non come righe
   * intere del thread: chiamati solo per le schede che li disegnano
   * (`drawsCardComments`) e ridotti a ciò che la card legge, sono 731 KB di
   * feed che non partono più.
   *
   * `kind` 'status' e 'service' restano fuori: sono cronologia delle transizioni
   * e contabilità del dispatcher, non le parole di nessuno — lo stesso taglio di
   * `isThreadSpeech`, che è il predicato con cui il client sceglie la coppia da
   * mostrare. `COALESCE` perché le righe scritte prima che `kind` esistesse lo
   * hanno NULL, e `NULL NOT IN (…)` è NULL: senza, sparivano tutte.
   *
   * L'ordine finale è `rn DESC`, non `created_at ASC`: dentro lo stesso secondo
   * (o dentro lo stesso istante di un orologio finto) due righe hanno lo STESSO
   * `created_at`, e ordinare su quello lascia decidere a SQLite. `rn` viene
   * dalla finestra, che il `rowid` lo usa già come spareggio: qui si legge al
   * contrario e la coda del thread esce sempre nello stesso ordine.
   */
  function cardCommentsFor(ids: readonly string[]): Map<string, CardComment[]> {
    const out = new Map<string, CardComment[]>();
    if (ids.length === 0) return out;
    let rows: any[];
    try {
      // LA FINESTRA NON BASTA: SERVE UNA GARANZIA.
      //
      // `rn <= DEPTH` prende le ultime tre righe parlate, e il client poi
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
                  ${SQL_PAROLA} AS parola
             FROM task_comments c
            WHERE c.task_id IN (SELECT value FROM json_each(?))
              AND COALESCE(c.kind, 'comment') NOT IN ('status', 'service')
         ) WHERE rn <= ${CARD_COMMENTS_DEPTH} OR (parola = 1 AND rn_parola = 1)
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
    // `typeof rows` e non un `any[]` nuovo: le righe sono le stesse, e il
    // cricchetto degli `any` conta ogni occorrenza scritta a mano.
    const perTask = new Map<string, typeof rows>();
    for (const r of rows) {
      const l = perTask.get(r.task_id);
      if (l) l.push(r); else perTask.set(r.task_id, [r]);
    }
    for (const [taskId, righe] of perTask) {
      // `rn` numera dal più recente, e le righe arrivano `ORDER BY rn DESC`:
      // la più recente è l'ultima. Fra quelle, la prima che non è una nota.
      const dalPiuRecente = [...righe].reverse();
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
      const scelta = dalPiuRecente.find((r) => !contorno(r)) ?? dalPiuRecente[0];
      for (const r of righe) {
        const full = rowToComment(r);
        // `rowToComment` normalizza `kind` (una riga scritta prima che la
        // colonna esistesse vale 'comment'): il taglio dei campi viene DOPO, o
        // la card riceverebbe il `kind` grezzo del disco.
        const c: CardComment = {
          author: full.author,
          content: cardCommentContent(full.content, r === scelta ? CARD_COMMENT_CHARS : CARD_CONTEXT_CHARS),
          kind: full.kind,
        };
        const list = out.get(taskId);
        if (list) list.push(c); else out.set(taskId, [c]);
      }
    }
    return out;
  }

  function buildBatch(rows: readonly any[]): TaskBatch {
    const ids = rows.map((r) => r.id as string);
    const b: TaskBatch = {
      nowIso: new Date().toISOString(),
      labels: labelsFor(ids),
      waitingOn: new Map(),
      topics: new Map(),
      blockers: new Map(),
      parentStatus: new Map(),
      retryCap: new Map(),
      openChildren: new Map(),
      comments: cardCommentsFor(rows.filter(drawsCardComments).map((r) => r.id as string)),
      queue: null,
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
    try {
      return deriveQueueReason(
        {
          status: r.status,
          parentTaskId: r.parent_task_id ?? null,
          dispatchState: r.dispatch_state ?? null,
          dispatchAttempts: r.dispatch_attempts ?? 0,
          dispatchDeferredUntil: r.dispatch_deferred_until ?? null,
          dispatchError: r.dispatch_error ?? null,
          deliveredReason: r.delivered_reason ?? null,
          blockedByTaskId: r.blocked_by_task_id ?? null,
          blockedBy: r.blocked_by_task_id ? (b.blockers.get(r.blocked_by_task_id) ?? null) : null,
          assignedTo: r.assigned_to ?? null,
        },
        {
          now: b.nowIso,
          autoDispatch: b.autoDispatch,
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
    const preview: string | null = r.description_preview !== undefined
      ? (r.description_preview ?? null)
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
      dueDate: r.due_date ?? null,
      chatId: r.chat_id ?? null,
      createdAt: r.created_at,
      completedAt: r.completed_at ?? null,
      updatedAt: r.updated_at,
      claudeTaskId: r.claude_task_id ?? null,
      assignedTopicId: r.assigned_topic_id ?? null,
      dispatchState: r.dispatch_state ?? null,
      dispatchAttempts: r.dispatch_attempts ?? 0,
      dispatchError: r.dispatch_error ?? null,
      dispatchDeferredUntil: r.dispatch_deferred_until ?? null,
      waitStreak: r.wait_streak ?? 0,
      waitReason: r.wait_reason ?? null,
      waitSince: r.wait_since ?? null,
      dispatchWeight: readTaskWeight(r.dispatch_weight),
      parentTaskId: r.parent_task_id ?? null,
      outputUrl: r.output_url ?? null,
      previewImage: r.preview_image ?? null,
      previewRetiredAt: r.preview_retired_at ?? null,
      previewRetiredReason: r.preview_retired_reason ?? null,
      planFirst: !!r.plan_first,
      planCommentId: r.plan_comment_id ?? null,
      inProgressAt: r.in_progress_at ?? null,
      agentMs: r.agent_ms ?? 0,
      agentTokens: r.agent_tokens ?? 0,
      agentCacheReadTokens: r.agent_cache_read_tokens ?? 0,
      priorityAuto: r.priority_auto == null ? true : !!r.priority_auto,
      // Il modello mostrato deve SEMPRE riflettere ciò che ha girato davvero:
      // `tasks.model` può essere nullo («auto») anche dopo il dispatch, ma il
      // TOPIC dell'agente è stato creato col modello risolto.
      model: r.model ?? topic?.model ?? null,
      // Non c'è una colonna `tasks.effort` e non serve: l'autorità è il TOPIC,
      // che è ciò che viene davvero passato allo spawn. Duplicarla su `tasks`
      // creerebbe due verità libere di divergere.
      effort: r.assigned_topic_id ? (topic?.effort ?? null) : null,
      blockedByTaskId: r.blocked_by_task_id ?? null,
      blockedBy: r.blocked_by_task_id ? (b.blockers.get(r.blocked_by_task_id) ?? null) : null,
      subtaskWork: resolveSubtaskWork(r),
      waitingOnCount: b.waitingOn.get(r.id) ?? 0,
      queueReason: queueReasonOf(r, b),
      deliveryBranch: r.delivery_branch ?? null,
      deliveryCommit: r.delivery_commit ?? null,
      // Da quando aspetta una risposta umana (migration 20260816214500).
      reviewAt: r.review_at ?? null,
      // L'ENTITÀ DEL LAVORO, sulla card e non dietro un clic: la colonna review
      // chiedeva «Approva» senza dire cosa si stesse approvando.
      deliveryFilesChanged: r.delivery_files_changed ?? null,
      deliveryInsertions: r.delivery_insertions ?? null,
      deliveryDeletions: r.delivery_deletions ?? null,
      landingState: r.landing_state ?? null,
      landingCheckedAt: r.landing_checked_at ?? null,
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

  function rowToTask(r: any): Task {
    return rowsToTasks([r])[0]!;
  }

  /**
   * Fill board-badge counters onto already-built tasks: direct-children
   * progress AND the human interaction count (user 'comment' messages).
   *
   * Entrambe le aggregazioni sono LEGATE AGLI ID IN MANO. Erano due scansioni
   * intere e senza filtro, su ogni lista e su ogni apertura di task: quella su
   * `task_comments` (11.994 righe il 15/08, la tabella che cresce più in fretta)
   * non aveva nemmeno un indice utilizzabile — `idx_task_comments_task` è su
   * `task_id` soltanto, quindi il filtro su autore e tipo era comunque una
   * scansione. L'indice che la copre è
   * `idx_task_comments_task_author_kind`.
   */
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
    for (const t of tasks) {
      const c = byParent.get(t.id);
      if (c) { t.subtaskCount = c.total; t.subtaskDoneCount = c.done; }
      t.userCommentCount = byTask.get(t.id) ?? 0;
    }
    return tasks;
  }

  /** Direct children of a task (drawer subtask list), board order. */
  function childrenOf(taskId: string): Task[] {
    const rows = db.query(
      "SELECT * FROM tasks WHERE parent_task_id = ? AND archived = 0 ORDER BY kanban_order ASC",
    ).all(taskId) as any[];
    return withSubtaskCounts(rowsToTasks(rows));
  }

  /**
   * True when `taskId` is one of the calling agent's own checklist steps. Two
   * strade, e servono entrambe:
   *
   *  a) DISCENDENTE STRETTO di un task assegnato a `topicId` — copre gli step
   *     che l'UMANO aggiunge sotto il task dell'agent (nessuna provenienza
   *     d'agent, ma sono comunque la sua checklist);
   *  b) TASK CON PADRE che `topicId` ha CREATO (`created_by_topic_id`, migration
   *     093) — copre il caso in cui il legame vivo non c'è più.
   *
   * Perché (b): (a) da sola misura la proprietà su `assigned_topic_id`, che è
   * stato di DISPATCH e vive quanto il dispatch, non quanto il turno. Il
   * dispatcher lo azzera a ogni requeue/park (`release`) e lo riscrive su un
   * ALTRO topic al ri-dispatch, mentre il turno dell'agent continua a girare:
   * misurato l'11/08, l'agent ha chiuso due step e poi ha preso 409 su tutti gli
   * altri, consegnando con la checklist aperta (e un task con figli aperti non è
   * approvabile). La provenienza invece è un fatto storico: non cambia mai.
   *
   * STRETTA in entrambe le strade: il task assegnato non fa match in (a), e (b)
   * richiede `parent_task_id IS NOT NULL` — l'agent non può chiudere né il
   * proprio deliverable né un task di primo livello che ha creato lui.
   */
  function isOwnStep(taskId: string, topicId: string): boolean {
    const own = db.prepare(
      "SELECT 1 FROM tasks WHERE id = ? AND parent_task_id IS NOT NULL AND created_by_topic_id = ?",
    ).get(taskId, topicId);
    if (own) return true;
    const r = db.prepare(
      `WITH RECURSIVE anc(id, parent, topic) AS (
         SELECT id, parent_task_id, assigned_topic_id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_task_id, t.assigned_topic_id
           FROM tasks t JOIN anc a ON t.id = a.parent
       )
       SELECT COUNT(*) AS c FROM anc WHERE topic = ? AND id != ?`,
    ).get(taskId, topicId, taskId) as any;
    return (r?.c ?? 0) > 0;
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
   * I tre chip che dicono «un agente è qui o sta arrivando». Dentro una stringa
   * SQL la lista canonica di `shared/board` non ci entra: si compone da lì, così
   * non può andare in deriva.
   */
  const CHILD_AGENT_COMING = ACTIVE_DISPATCH_STATES.map((s) => `'${s}'`).join(", ");

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
   * I sottotask fermi: non li aspetta nessuno, vanno DETTI.
   *
   * Lo specchio esatto di `hasChildrenInFlight` — `backlog` e `todo` senza un
   * chip attivo addosso — perché sono la stessa domanda e due predicati che
   * possono divergere darebbero un padre che chiede «ho 0 sottotask fermi».
   * Lo `status` viaggia perché la riga lo scrive: la domanda dice DOVE sono
   * fermi, e «in backlog» su un figlio in todo era una bugia.
   */
  /**
   * IL PADRE HA UN TURNO ADDOSSO ADESSO?
   *
   * Il predicato esisteva gia', ma solo dentro `parkedChildRaisedStall`, che e'
   * uno dei TRE punti che devono conoscerlo: il rastrello lo riscrive come
   * esclusione SQL (`status NOT IN (... 'in_progress')`), e `childLeftFlight`
   * non lo aveva affatto. Tre copie di cui una mancante e' il modo esatto in
   * cui il 18/08 tre card dispacciate sono finite in review al PRIMO turno:
   * l'agente creava la sua checklist, spuntava il primo passo, e nel momento in
   * cui quel figlio usciva dal volo `childLeftFlight` chiamava
   * `askParkedChildren` — che sposta la card — mentre il turno era vivo.
   * Sessione con DUE messaggi, zero commit, e una domanda di contabilita' in
   * cima alla colonna di review.
   *
   * Sta qui perche' qui lo legge chi SPOSTA la card, che e' la regola che il
   * rastrello dichiara gia' («questa query stringe il campo, poi
   * `askParkedChildren` applica le sue guardie una per una»).
   */
  function hasLiveTurn(row: { status: string; dispatch_state?: string | null }): boolean {
    return row.status === "in_progress"
      || row.dispatch_state === "working"
      || row.dispatch_state === "starting";
  }

  function parkedChildren(taskId: string): Array<{ id: string; text: string; status: string }> {
    return db.prepare(
      "SELECT id, text, status FROM tasks WHERE parent_task_id = ? AND archived = 0" +
        `   AND status IN ('backlog','todo') AND COALESCE(dispatch_state, '') NOT IN (${CHILD_AGENT_COMING})` +
        "  ORDER BY created_at",
    ).all(taskId) as any;
  }

  /**
   * Il figlio `childId` si è appena fermato — in `backlog` o in `todo`, che
   * sotto un padre senza turno sono la stessa cosa: se il padre resta senza
   * nessun figlio IN VOLO, da adesso è fermo su qualcosa che non arriverà.
   *
   * Due strade, e la differenza è se c'è un turno vivo:
   *  - padre AL LAVORO → solo l'avviso nel suo thread. Portarlo in review adesso
   *    gli taglierebbe il turno sotto i piedi; la domanda la farà lui a fine
   *    turno (`deliverToReviewBySystem`), che è fra minuti, non fra giorni.
   *  - padre fermo (backlog/todo) → la domanda si alza SUBITO: è il caso
   *    misurato il 12/08, in cui nessun turno sarebbe più arrivato ad accorgersi
   *    di niente e la card sarebbe rimasta ferma per sempre.
   */
  function parkedChildRaisedStall(parentId: string, childId: string, by: string, svc: TaskService): void {
    try {
      const parent = getTaskRow(parentId);
      if (!parent || parent.archived === 1 || parent.status === "done") return;
      if (!hasActiveChildren(parentId) || hasChildrenInFlight(parentId)) return;
      if (!hasLiveTurn(parent)) { svc.askParkedChildren({ taskId: parentId, by }); return; }
      const child = getTaskRow(childId);
      const titolo = child?.text ? `«${child.text}»` : "un sottotask";
      // La COLONNA non si nomina: un figlio in `todo` è fermo quanto uno in
      // `backlog`, e dire «parcheggiato in backlog» su uno step che sta in todo
      // manda a cercarlo dove non è.
      svc.addComment({
        taskId: parentId, author: "system",
        content:
          `Sottotask fermo: ${titolo}. Da qui in avanti non lo prende nessun dispatcher, ` +
          `e questo task non si può chiudere con un sottotask aperto: a fine turno ti chiedo se rimetterlo in coda o archiviarlo.`,
      });
    } catch { /* un avviso non fa mai fallire lo spostamento di una card */ }
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
      svc.addComment({
        taskId: parentId, author: "system",
        content:
          `Chiuso l'ultimo sottotask in lavorazione, e restano ${parked.length} passi parcheggiati in backlog (${elenco}): ` +
          `nessun dispatcher li prende da solo, e con un sottotask aperto questa card non si può approvare. ` +
          `Li rimetto in coda, o archivio ciò che non serve più?`,
        questionOptions: [REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL],
      });
      if (staleWaitChip) clearWaitChip();
    } catch { /* un avviso non fa mai fallire la chiusura di una card */ }
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
            : "comment";
    return { id: r.id, taskId: r.task_id, author: r.author, content: r.content, mentions, media, createdAt: r.created_at, kind };
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
  function logStatus(taskId: string, from: string, to: string, by: string, reason?: string | null): void {
    try {
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, ?, ?, 'status', ?)",
      ).run(uuid(), taskId, by || "system", formatStatusEvent(from, to, reason), now());
    } catch { /* history is best-effort — never fail the transition itself */ }
  }

  /**
   * Quando è iniziato il turno corrente = l'evento `…→in_progress` più recente.
   * Lo legge il gate della consegna muta (`review_needs_summary`).
   *
   * NON è una `LIKE '%in_progress'`: da quando una transizione può portare la
   * sua ragione (`done→in_progress · il land…`), il contenuto non finisce più
   * con lo stato — e la LIKE avrebbe pescato un turno PRECEDENTE, cioè avrebbe
   * riaperto in silenzio proprio il buco che quel gate chiude (una consegna muta
   * sbloccata da un commento vecchio). Le righe di stato di un task sono poche:
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
   * 13 righe `pending` su 48 appese, 9 delle quali su card già `done` — la
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
   * Nota della macchina nel thread (kind='review-note'): informa senza svegliare
   * l'agente e senza contare come sua ultima parola. INSERT diretto, come
   * `logStatus`: qui non servono dedupe, allegati o composizione di domande, e
   * passare dal path umano farebbe di una ricevuta un messaggio a cui
   * rispondere.
   */
  function addNote(taskId: string, author: string, content: string): void {
    try {
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, ?, ?, 'review-note', ?)",
      ).run(uuid(), taskId, author || "system", content, now());
    } catch { /* la ricevuta è un di più: non deve far fallire l'operazione */ }
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

  // Re-parenting. At creation the walk is unnecessary (a fresh id can never be
  // an ancestor of an existing row); MOVING an existing task can close a loop —
  // nest A under its own child and the pair disappears from the board, because
  // `rootsOnly` shows neither and the detail tree recurses forever.
  function assertParentValid(taskId: string, parentId: string): void {
    const self = getTaskRow(taskId);
    const parent = getTaskRow(parentId);
    if (!self) throw new TaskServiceError("not_found", `task ${taskId} not found`);
    if (!parent || parent.project_id !== self.project_id || !isParentAlive(parent)) {
      // Same not_found shape as the create-side guard: no cross-board probing.
      throw new TaskServiceError("not_found", `parent task ${parentId} not found`);
    }
    if (parentId === taskId) {
      throw new TaskServiceError("invalid_input", "a task cannot be its own parent");
    }
    let cur: string | null = parent.parent_task_id ?? null;
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur === taskId) throw new TaskServiceError("invalid_input", "parent chain would form a cycle");
      cur = (getTaskRow(cur)?.parent_task_id ?? null) as string | null;
    }
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
       UPDATE tasks SET archived = 1, updated_at = ? WHERE id IN (SELECT id FROM subtree)`,
    ).run(taskId, ts);
  }

  return {
    create(input: CreateTaskInput): Task {
      const text = (input.text ?? "").trim();
      if (!text) throw new TaskServiceError("invalid_input", "task text is required");
      if (!input.projectId) throw new TaskServiceError("invalid_input", "projectId is required");

      // Default `backlog`, NON `todo`. `todo` è la coda di esecuzione: un task
      // che ci nasce fa partire un agente entro pochi secondi su un board con
      // auto-dispatch. Chi crea un task senza dire dove (MCP, uno script, una
      // integrazione) sta ANNOTANDO, non dando un via — e il default lo
      // trasformava in un ordine di esecuzione. Misurato il 03/08: tre task
      // creati da chat, tre agenti dispacciati in meno di 20 secondi; due si
      // sono fermati solo perché quei progetti non erano repo git, cioè per
      // caso e non per una guardia.
      //
      // "Vai" ora si scrive: `status: "todo"` esplicito. L'interfaccia lo passa
      // già sempre (si crea trascinando nella colonna, che È lo status), quindi
      // il cambio tocca solo i chiamanti esterni — esattamente il caso da
      // correggere.
      const status = input.status ?? "backlog";
      if (!STATUSES.includes(status)) throw new TaskServiceError("invalid_input", `invalid status "${status}"`);
      if (status === "done") throw new TaskServiceError("invalid_transition", "cannot create a task already done");

      // Idempotency: same key → return the existing task, no duplicate.
      if (input.idempotencyKey) {
        const existing = db.prepare("SELECT * FROM tasks WHERE claude_task_id = ?").get(input.idempotencyKey);
        if (existing) return rowToTask(existing);
      }

      // Nesting: the parent must exist on the SAME board and be alive. Same
      // not_found shape as the projectId guard elsewhere (no cross-board probing).
      if (input.parentTaskId) {
        const parent = getTaskRow(input.parentTaskId);
        if (!parent || parent.project_id !== input.projectId || !isParentAlive(parent)) {
          throw new TaskServiceError("not_found", `parent task ${input.parentTaskId} not found`);
        }
      }

      const id = uuid();
      const ts = now();
      const priority = input.priority ?? 2;
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(input.projectId) as any;
      const order = (maxRow?.m ?? 0) + 1;

      // Dependency at creation: the blocker must exist (a fresh id can never
      // be inside an existing chain, so the cycle walk is trivially safe).
      if (input.blockedByTaskId) assertBlockerValid(id, input.blockedByTaskId);

      db.prepare(
        `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, chat_id, created_at, completed_at, updated_at, claude_task_id, parent_task_id, plan_first, model, blocked_by_task_id, reuse_blocker_context, created_by_topic_id, priority_auto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.projectId, text, input.description ?? null, status, priority, order,
        input.assignedTo ?? null, input.chatId ?? null, ts, ts, input.idempotencyKey ?? null,
        input.parentTaskId ?? null, input.planFirst ? 1 : 0,
        input.model ?? null, input.blockedByTaskId ?? null, input.reuseBlockerContext ? 1 : 0,
        input.createdByTopicId ?? null,
        // "Priorità automatica": no explicit choice at creation = the
        // dispatched agent evaluates and sets one at kickoff.
        input.priority === undefined ? 1 : 0,
      );
      return rowToTask(getTaskRow(id));
    },

    get(taskId, opts) {
      const row = getTaskRow(taskId);
      if (!row) return null;
      if (opts?.projectId && row.project_id !== opts.projectId) return null;
      const comments = db.query("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
      const [task] = withSubtaskCounts([rowToTask(row)]);
      return { task, comments: comments.map(rowToComment), children: childrenOf(taskId) };
    },

    list(input: ListTasksInput): Task[] {
      const clauses: string[] = [input.archived === true ? "archived = 1" : "archived = 0"];
      const params: any[] = [];
      if (input.scope === "project") {
        if (!input.projectId) throw new TaskServiceError("invalid_input", "scope=project requires projectId");
        clauses.push("project_id = ?");
        params.push(input.projectId);
      }
      // UNO STATO CHE NON ESISTE È UN ERRORE, NON UNA BOARD VUOTA. Le rotte
      // passavano `?status=` così com'era arrivato (`as any`), quindi
      // `?status=in-progress` finiva in SQL come un letterale che non matcha
      // niente e il client riceveva 200 con zero card: una board vuota è una
      // risposta plausibile, quindi il refuso non si vedeva. Il cancello sta
      // QUI, non sulle tre rotte, perché è l'unica porta che tutte attraversano.
      if (input.status !== undefined) {
        if (!STATUSES.includes(input.status)) {
          throw new TaskServiceError("invalid_input", `invalid status "${input.status}"`);
        }
        clauses.push("status = ?");
        params.push(input.status);
      }
      // L'AUTORIZZAZIONE ARRIVA FINO A SQL. Il feed dell'ospite idratava OGNI
      // task del DB per poi tenere i due condivisi: il predicato che decide cosa
      // può vedere stava in JS, a valle del lavoro. Insieme vuoto = nessuna riga,
      // e si esce senza nemmeno interrogare: `IN ()` non è SQL valido, e un
      // `WHERE 0` costerebbe comunque un giro.
      if (input.ids) {
        if (input.ids.length === 0) return [];
        clauses.push("id IN (SELECT value FROM json_each(?))");
        params.push(idParam(input.ids));
      }
      // «Radici» vuol dire tre cose diverse a seconda di chi chiede, e le tre
      // convivono qui perché il taglio è uno solo.
      //
      //  - ARCHIVIO: un task senza padre è una radice; ma anche uno step
      //    archiviato da solo, sotto un genitore ancora vivo, è la radice di ciò
      //    che è stato archiviato — e con il filtro letterale
      //    `parent_task_id IS NULL` sarebbe l'unica riga che nessuna lista
      //    mostra più, né la board né l'archivio. I figli di un archiviato
      //    restano fuori: li riporta indietro il ripristino del padre.
      //  - FEED della board (`includeOrphanSubtasks`): le radici PIÙ gli step
      //    che non sono più la checklist di nessuno. «Nessuno» è una sola
      //    condizione, letta sul padre diretto: chiuso, archiviato, o la riga
      //    non c'è più. Lo step già `done` resta fuori — un passo finito non è
      //    un vicolo cieco, è cronaca.
      //  - DISPATCHER: il filtro letterale, e resta letterale. Lì `rootsOnly` è
      //    una regola di sicurezza, non di lettura.
      //
      // L'archivio per primo perché è una VISTA diversa, non il feed: quando si
      // guardano le righe archiviate, un padre chiuso non è un orfano da
      // ripescare, è il contesto di ciò che si sta guardando.
      if (input.rootsOnly) {
        clauses.push(
          input.archived === true
            ? "(parent_task_id IS NULL OR parent_task_id IN (SELECT id FROM tasks WHERE archived = 0))"
            : input.includeOrphanSubtasks
            ? `(parent_task_id IS NULL OR (status != 'done' AND NOT EXISTS (
                 SELECT 1 FROM tasks p
                  WHERE p.id = tasks.parent_task_id AND p.archived = 0 AND p.status != 'done')))`
            : "parent_task_id IS NULL",
        );
      }
      // Etichette in AND. Un JOIN sull'indice `idx_task_labels_label`, non una
      // `LIKE '%bugfix%'` su una stringa: `bugfix-ui` non matcha `bugfix`, ed è
      // esattamente il motivo per cui le etichette sono righe e non una colonna.
      const wantedLabels = (input.labels ?? []).filter(isTaskLabel);
      if (wantedLabels.length) {
        clauses.push(
          `id IN (SELECT task_id FROM task_labels WHERE label IN (${wantedLabels.map(() => "?").join(", ")})
                   GROUP BY task_id HAVING COUNT(DISTINCT label) = ?)`,
        );
        params.push(...wantedLabels, wantedLabels.length);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      // project scope → board order (status then kanban_order); global feed → recency.
      const order = input.scope === "all" ? "updated_at DESC" : "kanban_order ASC";
      const rows = db.query(
        `SELECT ${listColumns(input.withDescription === true)} FROM tasks ${where} ORDER BY ${order}`,
      ).all(...params) as any[];
      return withSubtaskCounts(rowsToTasks(rows));
    },

    update({ taskId, actor, by, patch, projectId, agentTopicId, statusReason }): Task {
      const row = getTaskRow(taskId);
      // projectId guard: a session may only touch tasks on its own project.
      // A mismatch is reported as not_found (not 403) so cross-project ids stay
      // indistinguishable from non-existent ones.
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const current: TaskStatus = row.status;

      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw new TaskServiceError("invalid_input", `invalid status "${patch.status}"`);
        // Il task NON è più tuo: un agente a cui il dispatcher ha tolto il task
        // non può riprenderselo.
        //
        // `release()` azzera `assigned_topic_id` quando parcheggia o rimette in
        // coda — ma il TURNO dell'agente non muore con quella riga: continua a
        // girare, e la sua `update_task(status)` passava senza che nessuno
        // controllasse se quel task gli appartenesse ancora. Misurato: un task
        // parcheggiato alle 22:48 è tornato `in_progress` 79 secondi dopo ed è
        // rimasto lì SETTE GIORNI — nessun reaper lo guardava, perché per il DB
        // stava lavorando, e falsava anche la capacità di dispatch.
        //
        // La proprietà si misura come già fa il carve-out dei sottotask: o il
        // task è legato al tuo topic, o lo è un suo antenato (i passi della tua
        // checklist restano tuoi). Fuori da lì, rifiuto esplicito.
        //
        // Solo quando `agentTopicId` c'è: gli altri chiamanti (umano, sistema,
        // dispatcher) non hanno un topic con cui rivendicare niente, e questa
        // guardia non li riguarda.
        //
        // Due forme di "non è tuo", e servono entrambe:
        //  a) il task è legato a un ALTRO topic — è di un altro agente;
        //  b) il task non è legato a nessuno MA porta la firma di un rilascio
        //     del dispatcher (`queued` dopo un requeue, `failed`/`blocked` dopo
        //     un park). È il caso misurato: `release()` azzera il legame, e il
        //     turno che continua a girare tornava a prenderselo.
        //
        // Un task MAI dispacciato ha `assigned_topic_id` e `dispatch_state`
        // entrambi nulli: quello resta lavorabile: bloccarlo sarebbe impedire a
        // una sessione di lavorare su un task che nessuno le ha tolto.
        const releasedByDispatcher =
          row.assigned_topic_id == null
          && (row.dispatch_state === "queued" || row.dispatch_state === "failed"
            || row.dispatch_state === "blocked" || row.dispatch_state === PARKED_STOPPED);
        const boundElsewhere = row.assigned_topic_id != null && row.assigned_topic_id !== agentTopicId;
        if (
          actor === "agent" && agentTopicId
          && (boundElsewhere || releasedByDispatcher)
          && !isOwnStep(taskId, agentTopicId)
        ) {
          throw new TaskServiceError(
            "task_not_yours",
            "questo task non è più assegnato a te (rimesso in coda o parcheggiato dal dispatcher): non puoi cambiarne lo stato. Se hai lavoro da consegnare, scrivilo come commento.",
          );
        }
        // The gate: an agent may never mark done — it hands off to review.
        // ONE carve-out: its own checklist steps (strict descendants of the
        // task bound to its topic) close directly — they are the agent's plan,
        // not the deliverable the human reviews.
        if (patch.status === "done" && actor === "agent" && !(agentTopicId && isOwnStep(taskId, agentTopicId))) {
          throw new TaskServiceError(
            "agent_cannot_complete",
            "agents deliver to 'review' for human approval; only a human moves 'review' → 'done' (exception: subtask steps of YOUR assigned task). Set status to 'review' instead.",
          );
        }
        // Una card chiusa da un UMANO non la riapre un agente.
        //
        // Misurato l'11/08: undici card uscite da `done` in sei ore, quasi tutte
        // per mano di agenti. Nessuna persa, ma `done` è la colonna su cui ci si
        // fida: se una decisione presa da Attilio (approvare la review, o
        // trascinare la card) viene ribaltata da un turno che sta girando, la
        // fiducia va — e l'umano non l'ha nemmeno saputo.
        //
        // Il discrimine è CHI aveva chiuso, non che tipo di task sia: uno step
        // di checklist chiuso dall'agente stesso (`done_actor = 'agent'`, mai
        // passato da una review) resta suo e si riapre senza attriti; è il caso
        // legittimo e frequente — il padre che rifà un proprio sottotask.
        if (
          current === "done" && patch.status !== "done"
          && actor === "agent" && row.done_actor === "human"
        ) {
          throw new TaskServiceError(
            "reopen_needs_human",
            "questa card è stata chiusa da una decisione umana (approvazione in review o spostamento sulla board): non puoi riaprirla. Se il lavoro va rifatto, scrivi un commento con il motivo e chiedi la riapertura.",
          );
        }
        // A parent is not done while its subtasks are open — for ANY actor.
        // Complete or archive the children first (structural invariant, not a
        // board setting).
        if (patch.status === "done" && hasActiveChildren(taskId)) {
          throw new TaskServiceError(
            "open_subtasks",
            "task has open subtasks. Complete or archive them before marking it done.",
          );
        }
        // Agent entering review → open a pending review approval for the human.
        if (patch.status === "review" && actor === "agent" && current !== "review") {
          // A delivery must never be mute — AND the summary must be about THIS
          // turn, not a stale one from an earlier exchange. Checking "any agent
          // comment ever" let a steered task ("altro da fare?" → review) hand back
          // a mute delivery: an old comment satisfied the gate while the current
          // turn said nothing. So require a comment made AFTER this turn started
          // (the newest `…→in_progress` status event). Coach a retry — same
          // pattern as comment_too_long. kind='comment' only: an agent-authored
          // status flip must not satisfy the gate.
          const turnStart = lastTurnStart(taskId);
          const fresh = (db.prepare(
            `SELECT COUNT(*) AS c FROM task_comments
              WHERE task_id = ? AND author NOT IN ('user', 'system') AND kind = 'comment'
                AND (? IS NULL OR created_at >= ?)`,
          ).get(taskId, turnStart, turnStart) as any).c as number;
          if (fresh === 0) {
            throw new TaskServiceError(
              "review_needs_summary",
              "post a delivery summary for THIS turn first. Use comment_task with 1-2 sentences (what you did now, where to look; even \"nothing new\" with the reason), THEN set status='review'",
            );
          }
          db.prepare(
            `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
             VALUES (?, ?, ?, 'review', ?, 'done', 'pending', ?)`,
          ).run(uuid(), taskId, by, current, now());
        }
      }

      const sets: string[] = [];
      const params: any[] = [];
      const put = (col: string, val: any) => { sets.push(`${col} = ?`); params.push(val); };

      if (patch.text !== undefined) put("text", patch.text);
      if (patch.description !== undefined) put("description", patch.description);
      if (patch.priority !== undefined) {
        put("priority", patch.priority);
        // An explicit write (human OR the agent fulfilling "auto") settles it.
        put("priority_auto", 0);
      }
      if (patch.assignedTo !== undefined) put("assigned_to", patch.assignedTo);
      if (patch.dueDate !== undefined) put("due_date", patch.dueDate);
      if (patch.kanbanOrder !== undefined) put("kanban_order", patch.kanbanOrder);
      if (patch.outputUrl !== undefined) {
        const url = (patch.outputUrl ?? "").trim();
        // http(s) only: the review panel renders this in an iframe — never
        // file:// (LFI) or javascript: (XSS). Empty clears.
        if (url && !/^https?:\/\//i.test(url)) {
          throw new TaskServiceError("invalid_input", "output_url must be an http(s) URL");
        }
        put("output_url", url || null);
      }
      let explicitPreview: string | null = null;
      if (patch.previewImage !== undefined) {
        const p = (patch.previewImage ?? "").trim();
        // Path assoluto su disco, mai un URL: il client lo rende via
        // /api/media (allowlist-gated). Empty clears.
        if (p && !p.startsWith("/")) {
          throw new TaskServiceError("invalid_input", "preview_image must be an absolute file path");
        }
        put("preview_image", p || null);
        explicitPreview = p || null;
        // Un'anteprima NUOVA supera il ritiro: lo stato si spegne qui, che è la
        // cosa che una nota nel thread non sa fare. Il ritiro lo riaccende solo
        // chi ritira (`retirePreview`), mai un azzeramento qualsiasi.
        if (p) { put("preview_retired_at", null); put("preview_retired_reason", null); }
      }
      if (patch.model !== undefined) {
        const m = (patch.model ?? "").trim();
        put("model", m || null);
      }
      if (patch.blockedByTaskId !== undefined) {
        if (patch.blockedByTaskId) assertBlockerValid(taskId, patch.blockedByTaskId);
        put("blocked_by_task_id", patch.blockedByTaskId || null);
      }
      if (patch.parentTaskId !== undefined) {
        if (patch.parentTaskId) {
          assertParentValid(taskId, patch.parentTaskId);
          // NON `isAgentWorking`: quello include `queued`, che altrove ("zitto,
          // sta lavorando") è la risposta giusta ma qui è la sbagliata. Una card
          // in coda non ha ancora nessuna sessione — nidificarla la toglie
          // semplicemente dalla coda, che è esattamente ciò che si vuole
          // accorpando. Il rifiuto riguarda un turno che sta GIRANDO: quello sì
          // resterebbe orfano, perché un sottotask non lo dispaccia più nessuno.
          if (row.dispatch_state === "working" || row.dispatch_state === "starting" || row.status === "in_progress") {
            throw new TaskServiceError(
              "invalid_input",
              "task has live work: a subtask is never dispatched on its own, so stop the agent before nesting it under a parent",
            );
          }
          // Un sottotask non è in coda per niente: il chip 'queued' resterebbe
          // acceso su una card che il dispatcher non guarderà mai più.
          if (row.dispatch_state === "queued") put("dispatch_state", null);
        }
        put("parent_task_id", patch.parentTaskId || null);
      }
      if (patch.reuseBlockerContext !== undefined) put("reuse_blocker_context", patch.reuseBlockerContext ? 1 : 0);
      if (patch.planFirst !== undefined) put("plan_first", patch.planFirst ? 1 : 0);
      if (patch.status !== undefined) {
        put("status", patch.status);
        put("completed_at", patch.status === "done" ? now() : null);
        // Chi chiude, e chi riapre — i due fatti che la board deve poter dire da
        // sé (il thread non basta: chi guarda la colonna vede solo il buco).
        if (patch.status === "done") {
          put("done_actor", actor);
          // Ciclo chiuso: la card è di nuovo fatta, non è più «riaperta».
          put("reopened_at", null); put("reopened_by", null); put("reopened_actor", null);
        } else if (current === "done" || (current === "review" && patch.status !== "review")) {
          // USCIRE DA REVIEW È UNA RIAPERTURA QUANTO USCIRE DA DONE.
          //
          // Questo ramo si accendeva solo su `done`, e la chiusura automatica del
          // dispatcher legge proprio il campo che scrive qui («chi riapre una card
          // atterrata sta chiedendo un SEGUITO»). Il 12/08 alle 18:26 Attilio ha
          // chiesto un cambio di rotta nel thread e ha trascinato `d6baaf5e` da
          // `review` a `in corso`: per il campo nessuno aveva riaperto niente, e
          // il mattino dopo la card è stata chiusa sopra la consegna di cinque
          // giorni prima. Il segnale non può dipendere da quale casella ha
          // attraversato il dito.
          //
          // `done_actor` invece si spegne solo uscendo da `done`: una card in
          // review non ne ha uno, e azzerarlo qui vorrebbe dire cancellare la
          // decisione di chi l'aveva chiusa in un salto che non la tocca.
          if (current === "done") put("done_actor", null);
          // `actor` è l'asse dei PERMESSI, non quello dell'attribuzione: il land
          // andato in conflitto ritira la card da `done` con `actor: "human"`
          // proprio per poterlo fare (routes/tasks.ts, ramo "conflict"), ma la
          // firma vera è `by: "system"`. Leggendo l'attore, il chip avrebbe detto
          // «riaperta da te» di un ritiro che l'umano non ha deciso — cioè la
          // stessa bugia che questa card esiste per togliere, un livello più giù.
          const signature = by || "system";
          const reopenedActor = signature === "system" || signature === "dispatcher" ? "system" : actor;
          // Il marchio dell'umano non lo cancella la macchina passandoci sopra.
          // Da quando anche `review` è una partenza, una card già segnata «riaperta
          // da Attilio» può riconsegnare e poi rientrare in coda per mano del
          // sistema: sovrascrivere qui vorrebbe dire spegnere il cancello che
          // protegge la sua richiesta, con un UPDATE che nessuno ha deciso.
          if (reopenedActor === "human" || row.reopened_actor !== "human") {
            put("reopened_at", now()); put("reopened_by", signature); put("reopened_actor", reopenedActor);
          }
        }
        // Una card che RIENTRA in coda non porta con sé la consegna di prima.
        //
        // Lo scatto della consegna (`delivery_branch` / `delivery_commit`) e il
        // verdetto sull'atterraggio descrivono un lavoro CONSEGNATO. Da `done` o
        // da `review` verso la coda quel lavoro non è più ciò che la card sta
        // chiedendo: o è stato rifiutato, o l'umano l'ha riaperta per chiedere
        // dell'altro. Tenerlo vuol dire far parlare la card di un frutto che non
        // le appartiene più, e chi legge quel campo decide cose grosse — il
        // dispatcher ci CHIUDE sopra una card («è già su main, niente da
        // rifare»), e senza questa riga la richiesta nuova moriva sul commit
        // vecchio: chiusa a ogni tick, e senza via d'uscita, perché solo una
        // nuova consegna riscrive quel campo e per consegnare serve il dispatch
        // che il cancello blocca.
        //
        // Stessa lista che azzera `recordDelivery`: la TESTIMONIANZA cade col
        // suo commit, altrimenti il prossimo verdetto nascerebbe già «visto».
        if ((current === "done" || current === "review") && patch.status !== "done" && patch.status !== "review") {
          for (const col of DELIVERY_SNAPSHOT_COLUMNS) put(col, null);
          put("landing_state", null); put("landing_checked_at", null); put("landing_witnessed", 0);
        }
        // A card leaving the flow keeps no live chip: dragging review → done
        // used to strand "delivered"/"serve te" on a closed card (only
        // reviewDecision cleared it).
        if (patch.status === "done") put("dispatch_state", null);
        // A task arriving in review is a hand-off, not live work: settle a
        // lingering in-flight chip ('queued'/'starting'/'working') to
        // 'delivered' so a review card never shows the "agent al lavoro" UI
        // (which also double-renders the feedback input — steer + review). An
        // already-settled chip ('needs_input'/'delivered') is kept as-is; the
        // dispatcher's own delivery detection still refines it when it observes
        // a question (→ needs_input).
        if (patch.status === "review" && isAgentWorking(row.dispatch_state)) {
          put("dispatch_state", "delivered");
        }
        // Chi ha consegnato. Una card in review consegnata dall'agente e una
        // portata lì dal sistema pongono al reviewer due domande diverse, e oggi
        // hanno lo stesso aspetto. `deliverToReviewBySystem` scrive 'system' per
        // conto suo; qui passa solo chi ha spinto il bottone davvero.
        // `delivered_reason` si azzera: è la causa di QUESTA consegna, e questa
        // non è di sistema.
        if (patch.status === "review" && current !== "review") {
          put("delivered_by", actor);
          put("delivered_reason", null);
        }
        // A HUMAN dragging a task into todo is a fresh mandate: reset the
        // retry budget. Without this, a task parked at the cap could never be
        // re-dispatched — the claim filter skipped it and the card stranded
        // on "in coda" forever. Agents don't get to refresh their own retries.
        //
        // E IL BUDGET NON ERA L'UNICA COSA CHE TENEVA FERMA LA CARD. La finestra
        // di rinvio (`dispatch_deferred_until`) la scrive l'agente quando dichiara
        // un'attesa, e il CAS del claim la rifiuta finché non è passata: fino a 24
        // ore. Azzerare i tentativi e lasciare quella significava un bottone
        // «rimetti in Todo» che rimette la card in una colonna dove nessuno la
        // prende, senza dire perché — e il chip vecchio (`failed`, `blocked`,
        // `waiting`) rimasto sopra continuava a raccontare il parcheggio di prima.
        // Le tre colonne si azzerano INSIEME, come già fa `resolveParkedChildren`
        // sui figli che rimette in coda: sono un mandato nuovo, non un residuo.
        if (patch.status === "todo" && actor === "human") {
          put("dispatch_attempts", 0);
          put("dispatch_deferred_until", null);
          put("dispatch_state", null);
          put("dispatch_error", null);
        }
        // E con lo stesso gesto finisce la SERIE DI ATTESE. È la risposta alla
        // domanda che il park `waited_out` ha posto: l'umano ha guardato e ha
        // detto «riprova». Senza questo azzeramento il task ripartirebbe con la
        // serie già sfondata e si riparcheggerebbe alla prima attesa, cioè il
        // bottone «rimetti in Todo» non rimetterebbe in todo un bel niente.
        //
        // Vale anche su review e done, e non per simmetria: lì il task ha
        // SMESSO di aspettare (ha consegnato, o è chiuso). Una serie lasciata
        // aperta tornerebbe a mordere al primo riavvio del lavoro, contando
        // insieme attese separate da giorni.
        if ((patch.status === "todo" && actor === "human") || patch.status === "review" || patch.status === "done") {
          put("wait_streak", 0);
          put("wait_reason", null);
          put("wait_since", null);
        }
      }
      // DA QUANDO ASPETTA UNA RISPOSTA. `updated_at` non lo dice: si muove a
      // ogni commento, etichetta, ri-audit dell'atterraggio, quindi una card
      // ferma da tre giorni su cui qualcuno ha scritto una riga sembra appena
      // arrivata. Il timbro sta QUI accanto all'azzeramento dell'attesa perche'
      // e' la stessa transizione vista dall'altro lato: la card smette di
      // aspettare la macchina e comincia ad aspettare una persona.
      //
      // A OGNI ingresso, non solo al primo: una card respinta e riconsegnata
      // ricomincia ad aspettare da capo, e mostrare l'attesa precedente sarebbe
      // una misura vera di una domanda sbagliata.
      if (patch.status === "review" && current !== "review") put("review_at", now());
      put("updated_at", now());

      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, taskId);
      // Un task che ESCE da review si porta dietro la sua richiesta di
      // approvazione: va chiusa qui.
      //
      // `reviewDecision` era l'UNICO punto che la risolveva, ma non e' l'unica
      // strada per uscire da review — c'e' il trascinamento sulla board, c'e'
      // `update({status})` da MCP, c'e' l'archiviazione. Su ognuna di quelle la
      // riga restava 'pending' per sempre: misurate 13 approvazioni appese su
      // 48, di cui 9 su task gia' 'done'. Gonfiavano il conteggio dei "pending"
      // e nessuno le avrebbe mai chiuse, perche' il task non e' piu' in review e
      // `reviewDecision` lo rifiuta.
      //
      // L'esito NON e' sempre lo stesso: arrivare a 'done' e' cio' che
      // l'approvazione chiedeva, quindi 'approved'; ogni altra destinazione
      // rende la domanda priva di oggetto — 'expired', non 'rejected', perche'
      // nessun umano ha detto no. 'expired' e' gia' ammesso dal CHECK della
      // tabella e finora non lo usava nessuno.
      if (patch.status !== undefined && current === "review" && patch.status !== "review") {
        settleReviewApproval(taskId, patch.status === "done" ? "approved" : "expired", by, now());
      }
      // Status history: every applied transition lands in the thread with its
      // author — the timeline answers "chi l'ha spostato e quando".
      if (patch.status !== undefined && patch.status !== current) logStatus(taskId, current, patch.status, by, statusReason);
      // Hand-off into review without an explicit preview: promote the
      // delivery comment's evidence (comment-first delivery order).
      if (patch.status === "review") promoteReviewPreview(taskId);
      // Anteprima messa a mano: nessun gate (l'agente ha SCELTO quel file, e un
      // rifiuto qui sarebbe il quarto cancello di review che non vogliamo) —
      // ma il riciclo di un'evidenza altrui va almeno detto.
      if (explicitPreview) noteDuplicatePreview(taskId, explicitPreview);
      // PARCHEGGIARE UN FIGLIO CHE IL PADRE ASPETTA SI DICE SUBITO. Lo stallo
      // nasce qui, non dieci minuti dopo: da questo istante nessun dispatcher
      // prenderà più quel sottotask, e il padre che lo aspetta aspetta il nulla.
      // Prima lo scopriva solo il turno successivo del padre, e solo se ne aveva
      // uno.
      //
      // E VALE ANCHE PER `todo`, che è la porta da cui è entrato il guasto del
      // 13/08: uno step lasciato in todo SEMBRA in coda, ma la coda non lo
      // servirà mai (il tick lista `rootsOnly`). È fermo come uno in backlog, e
      // il momento in cui diventa fermo è questo.
      if ((patch.status === "backlog" || patch.status === "todo") && current !== patch.status && row.parent_task_id) {
        parkedChildRaisedStall(row.parent_task_id as string, taskId, by, this);
      }
      // E il verso opposto: un figlio che si chiude esce dagli aperti, e il
      // padre può essere rimasto senza niente in volo.
      if (patch.status === "done" && current !== "done" && row.parent_task_id) {
        childLeftFlight(row.parent_task_id as string, by, this);
      }
      return rowToTask(getTaskRow(taskId));
    },

    addComment({ taskId, author, content, mentions, media, projectId, questionOptions, kind, once }): TaskComment {
      // The kind is whitelisted, never passed through: an unknown value reads
      // as a plain comment, so a typo at a call site costs a visible row rather
      // than a hidden one. 'service' = the dispatcher's own bookkeeping, marked
      // at the source so the thread can fold it without matching on wording.
      const commentKind: "comment" | "review-note" | "service" =
        kind === "review-note" ? "review-note" : kind === "service" ? "service" : "comment";
      let body = (content ?? "").trim();
      // Attachments-only comments are legal (a screenshot IS the message).
      if (!body && (!media || media.length === 0)) throw new TaskServiceError("invalid_input", "comment content is required");
      if (!body) body = "(allegato)";
      // Absolute paths only (the /api/upload contract); cap the count.
      const files = (media ?? []).filter((p) => typeof p === "string" && p.startsWith("/")).slice(0, 8);
      // Canonical question block, composed HERE (single writer) — the caller
      // passes the question as plain content + structured options; the exact
      // fence/newline layout the quick-reply parser expects is never delegated
      // to an LLM. A question inside `content` that already carries fences
      // would nest ambiguously → reject as invalid input.
      let isPlanDelivery = false;
      if (questionOptions && questionOptions.length > 0) {
        const options = questionOptions.map((o) => String(o ?? "").trim()).filter(Boolean);
        if (options.length === 0) throw new TaskServiceError("invalid_input", "question options are empty");
        if (body.includes("```")) throw new TaskServiceError("invalid_input", "question content must not contain code fences");
        // IL LAYOUT DI QUESTO BLOCCO NON SI TOCCA. Non è formattazione: è il
        // contratto fra l'unico scrittore (qui) e il parser delle risposte
        // rapide del client — cambiarlo significa card senza bottoni, cioè
        // proprio la cosa che deve esserci SEMPRE su un task non chiuso.
        // L'a-capo del corpo resta appiattito perché in questa forma una riga
        // `- …` del corpo sarebbe indistinguibile da un'opzione. Un piano che
        // vuole tenersi l'impaginazione la tiene FUORI dalla fence (il testo
        // attorno al blocco viaggia intatto e viene reso come markdown): il
        // posto dove separare corpo e opzioni è il RENDER, non il salvato.
        body = ["```question", body.replace(/\r?\n/g, " ").trim(), ...options.map((o) => `- ${o}`), "```"].join("\n");
        isPlanDelivery = hasPlanApproveOption(options);
      }
      const row = getTaskRow(taskId);
      // Same projectId guard as update() — no cross-project commenting.
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }

      // Dedupe identical author+content within the window — retries don't double-post.
      // Window boundary derives from the injected clock so tests are deterministic.
      // `once` ⇒ nessuna finestra: la riga descrive una condizione che dura, e
      // riscriverla a ogni verifica e' il muro di paragrafi identici documentato
      // sull'interfaccia.
      const since = once
        ? "0000-01-01T00:00:00.000Z"
        : new Date(new Date(now()).getTime() - commentDedupeMs).toISOString();
      const dupe = db.prepare(
        "SELECT * FROM task_comments WHERE task_id = ? AND author = ? AND content = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
      ).get(taskId, author, body, since);
      if (dupe) return rowToComment(dupe);

      const id = uuid();
      const ts = now();
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, mentions, media, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, taskId, author, body, mentions && mentions.length ? JSON.stringify(mentions) : null, files.length ? JSON.stringify(files) : null, commentKind, ts);
      // The thread is part of the task: touch updated_at so live clients (open
      // drawer, review card) see a change signal and refetch — without this, a
      // new comment broadcasts task:updated but the payload looks identical.
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, taskId);
      // QUALE commento è il piano: lo si SCRIVE qui, non lo si indovina dopo.
      // Il segnale è il contratto piano-prima — un task `plan_first` + un blocco
      // question che offre l'approvazione del piano, scritto da un agente (mai
      // dall'umano). Un piano rifatto dopo «Da rivedere» porta le stesse opzioni
      // e quindi RIMPIAZZA il puntatore; una rettifica qualunque, o la consegna
      // con «Landa su main», non lo toccano.
      if (isPlanDelivery && row.plan_first && author !== "user" && author !== "system") {
        db.prepare("UPDATE tasks SET plan_comment_id = ? WHERE id = ?").run(id, taskId);
      }
      // Evidence attached AFTER the review transition (review-first delivery
      // order): fill the still-empty card preview from this attachment.
      if (files.length) promoteReviewPreview(taskId);
      return rowToComment(db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id));
    },

    claimInterruption({ taskId, note, by }): TaskComment | null {
      const body = (note ?? "").trim();
      if (!body) return null;
      const row = getTaskRow(taskId);
      if (!row) return null;
      // Il campo si legge sul TASK, non su un insieme in memoria: chi arriva
      // terzo è quasi sempre un processo NUOVO — è appena ripartito, ed è il
      // motivo per cui sta scrivendo. La RAM gli direbbe che il campo è libero.
      const since = new Date(new Date(now()).getTime() - interruptClaimMs).toISOString();
      const held = typeof row.interrupt_claimed_at === "string" ? row.interrupt_claimed_at : null;
      if (held && held >= since) return null;
      // La nota PRIMA del campo: se la scrittura fallisce, il campo resta
      // libero per chi viene dopo invece di zittirlo su una riga mai apparsa.
      const written = this.addComment({ taskId, author: by ?? "system", content: body, kind: "service" });
      db.prepare("UPDATE tasks SET interrupt_claimed_at = ? WHERE id = ?").run(now(), taskId);
      return written;
    },

    reviewDecision({ taskId, by, decision, comment, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      if (row.status !== "review") throw new TaskServiceError("invalid_transition", "task is not in review");
      // Same structural invariant as update(): approving must not close a
      // parent whose subtasks are still open.
      if (decision === "approve" && hasActiveChildren(taskId)) {
        throw new TaskServiceError(
          "open_subtasks",
          "task has open subtasks. Complete or archive them before approving it to done.",
        );
      }
      const ts = now();

      // Resolve the pending review approval, if any.
      settleReviewApproval(taskId, decision === "approve" ? "approved" : "rejected", by, ts, comment ?? null);

      if (comment && comment.trim()) {
        this.addComment({ taskId, author: by, content: comment });
      }

      const target: TaskStatus = decision === "approve" ? "done" : "in_progress";
      // Clear the dispatch chip on the human decision: an approved (done) card must
      // not keep a stale "working"/"serve te" chip, and a rejected one is about to
      // be re-kicked by the dispatcher (resume sets "working" itself).
      // A reject ALSO resets the attempt budget: it opens a new work cycle on the
      // same session, so the turn-end safety net (auto-continue with the "deliver
      // now" nudge) must be available again. Without this, attempts carried over
      // from the previous cycle arrive already exhausted and the first premature
      // turn-end skips the nudge — the system force-delivers instead of letting
      // the agent reach review on its own.
      if (decision === "reject") {
        // Il rifiuto è la quarta uscita umana da review, e per due volte diceva
        // il contrario di quel che era successo: nessun marchio di riapertura, e
        // lo scatto della consegna lasciato sulla card. Cioè esattamente lo
        // stato che il 13/08 ha fatto chiudere `d6baaf5e` sopra un commit di
        // cinque giorni prima — qui in attesa che la card rientrasse in coda.
        // Le stesse due colonne che `update()` scrive per lo stesso salto: qui
        // non ci passa, perché questa porta scrive lo status a SQL grezzo.
        db.prepare(
          "UPDATE tasks SET status = ?, completed_at = NULL, dispatch_state = NULL, dispatch_attempts = 0, " +
            DELIVERY_SNAPSHOT_COLUMNS.map((c) => `${c} = NULL`).join(", ") + ", " +
            "landing_state = NULL, landing_checked_at = NULL, landing_witnessed = 0, updated_at = ? WHERE id = ?",
        ).run(target, ts, taskId);
        markReopened(taskId, "review", target, "human", by);
      } else {
        // `done_actor = 'human'`: è LA decisione di Attilio, ed è ciò che il
        // cancello di riapertura legge (un agente non la ribalta). Il segno di
        // «riaperta» si azzera: il ciclo si è chiuso qui.
        db.prepare(
          "UPDATE tasks SET status = ?, completed_at = ?, dispatch_state = NULL, done_actor = 'human', " +
            "reopened_at = NULL, reopened_by = NULL, reopened_actor = NULL, updated_at = ? WHERE id = ?",
        ).run(target, ts, ts, taskId);
      }
      logStatus(taskId, "review", target, by);
      // L'approvazione è la porta per cui uno step passa a `done` più spesso di
      // ogni altra, e scrive lo stato a SQL grezzo: senza questa riga il padre
      // non se ne accorgerebbe proprio nel caso più comune.
      if (target === "done" && row.parent_task_id) {
        childLeftFlight(row.parent_task_id as string, by, this);
      }
      return rowToTask(getTaskRow(taskId));
    },

    /**
     * Fonde due card che dicono la stessa cosa.
     *
     * La promessa, scritta com'e' verificata in `task-merge.test.ts`: NIENTE
     * viene cancellato. La card assorbita resta come riga archiviata, il suo
     * thread, i suoi sottotask e chi la aspettava passano alla superstite, e le
     * due card si scrivono a vicenda dove e' finito il lavoro.
     *
     * L'ordine dentro la transazione non e' negoziabile, e si puo' falsificare:
     * l'archiviazione passa da `archiveSubtree`, la stessa cascata di
     * `archive()`, quindi i sottotask vanno staccati PRIMA. Spostare la riga
     * `archiveSubtree` sopra `moveChildren` fa diventare rosso «i sottotask
     * passano sotto la superstite, VIVI»: finirebbero sotto la superstite gia'
     * archiviati, cioe' invisibili.
     *
     * Il limite, detto chiaro: la fusione NON e' reversibile con un tasto. Non
     * si perde niente, ma per tornare indietro bisogna sapere quali commenti
     * erano di chi, e questo schema non ha dove scriverlo (servirebbe una
     * tabella, cioe' una migration). Per questo il verdetto lo propone la
     * macchina e il tasto lo preme una persona: vedi `shared/task-similarity.ts`,
     * dove c'e' anche il falso positivo noto.
     */
    merge({ taskId, intoTaskId, by, projectId }): MergeOutcome {
      const loser = getTaskRow(taskId);
      const winner = getTaskRow(intoTaskId);
      if (!loser || (projectId && loser.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      if (!winner || (projectId && winner.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${intoTaskId} not found`);
      }
      if (taskId === intoTaskId) {
        throw new TaskServiceError("invalid_input", "una card non si fonde con se stessa");
      }
      if (loser.archived || winner.archived) {
        throw new TaskServiceError("invalid_transition", "una card archiviata non si fonde");
      }
      if (loser.project_id !== winner.project_id) {
        throw new TaskServiceError("invalid_transition", "le due card stanno su board diverse");
      }
      // Stesso gate di moveToProject: un agente vivo lavora un worktree legato
      // a QUESTA card. Archiviarla sotto di lui lascia il worktree orfano.
      if (loser.assigned_topic_id || isAgentWorking(loser.dispatch_state)) {
        throw new TaskServiceError("invalid_transition", "la card ha un agente vivo: falla arrivare in review, o parcheggiala, prima di fonderla");
      }
      // La superstite non puo' stare nel sottoalbero della card che sparisce:
      // finirebbe genitore di se stessa, e il ciclo renderebbe irraggiungibile
      // tutto il ramo.
      const dentro = db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         )
         SELECT COUNT(*) AS c FROM subtree WHERE id = ?`,
      ).get(taskId, intoTaskId) as any;
      if ((dentro?.c ?? 0) > 0) {
        throw new TaskServiceError("invalid_transition", "la superstite e' un sottotask della card da fondere: fondi al contrario");
      }

      // Chi NON va ripuntato sulla superstite: la superstite stessa (si
      // bloccherebbe da sola) e chiunque stia già nella SUA catena di attesa
      // (survivor ← ponte ← assorbita: ripuntare il ponte chiuderebbe l'anello
      // survivor ← ponte ← survivor, e i due resterebbero fermi per sempre).
      // Chi resta escluso continua a puntare la card archiviata, cioè risulta
      // sbloccato: giusto, perché il suo prerequisito è diventato la superstite
      // che lo aspetta a sua volta.
      const noRipunta = new Set<string>([intoTaskId]);
      let risalita: string | null = winner.blocked_by_task_id ?? null;
      for (let hops = 0; risalita && hops < 100; hops++) {
        noRipunta.add(risalita);
        risalita = (getTaskRow(risalita)?.blocked_by_task_id ?? null) as string | null;
      }
      const esclusi = [...noRipunta];

      const ts = now();
      const run = db.transaction(() => {
        const moveChildren = db.prepare(
          "UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE parent_task_id = ?",
        ).run(intoTaskId, ts, taskId);
        // I commenti mantengono created_at: il thread della superstite resta in
        // ordine cronologico invece di avere un blocco appiccicato in fondo.
        const moveComments = db.prepare("UPDATE task_comments SET task_id = ? WHERE task_id = ?").run(intoTaskId, taskId);
        // Il puntatore `bloccata da` passa alla superstite. Senza questo, la
        // card assorbita risulta ARCHIVIATA, e `isDispatchBlocked` legge
        // `status='done' OR archived=1`: chi la aspettava crede che il
        // prerequisito sia finito e parte, mentre il lavoro è appena stato
        // spostato altrove e non l'ha ancora fatto nessuno.
        const moveBlockers = db.prepare(
          `UPDATE tasks SET blocked_by_task_id = ?, updated_at = ?
            WHERE blocked_by_task_id = ? AND archived = 0
              AND id NOT IN (${esclusi.map(() => "?").join(", ")})`,
        ).run(intoTaskId, ts, taskId, ...esclusi);
        // Caso a parte: la superstite aspettava proprio la card che assorbe. Il
        // prerequisito è diventato lei stessa, quindi non resta niente da
        // aspettare, e un puntatore a una riga archiviata è solo un rudere.
        db.prepare(
          "UPDATE tasks SET blocked_by_task_id = NULL, updated_at = ? WHERE id = ? AND blocked_by_task_id = ?",
        ).run(ts, intoTaskId, taskId);
        // L'archiviazione passa dalla stessa cascata di `archive()`, e per
        // questo l'ordine qui sopra NON è negoziabile: i sottotask si staccano
        // PRIMA, altrimenti la cascata li archivia e finiscono sotto la
        // superstite già invisibili. Invertire le due righe fa diventare rosso
        // «i sottotask passano sotto la superstite, VIVI».
        archiveSubtree(taskId, ts);
        // Il PERDENTE del merge esce dalla board: la sua richiesta di
        // approvazione non ha più oggetto. `expired`, non `rejected` — nessuno
        // ha detto di no.
        settleReviewApproval(taskId, "expired", "system", ts);
        db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, intoTaskId);
        return {
          children: Number(moveChildren.changes ?? 0),
          comments: Number(moveComments.changes ?? 0),
          blockers: Number(moveBlockers.changes ?? 0),
        };
      });
      const moved = run();

      // Le ricevute: kind 'review-note' perche' e' evidenza scritta dalla
      // macchina. Non conta come ultima parola dell'agente e non sveglia
      // nessuno, ma resta nel thread di entrambe le card.
      const short = (id: string) => id.slice(0, 8);
      // Il ripuntamento dei bloccanti cambia CHI aspetta questa card: senza
      // scriverlo, un umano lo scopre solo quando un dispatch parte prima del
      // previsto.
      const anche = moved.blockers === 1
        ? " Anche 1 card che aspettava quella ora aspetta questa."
        : moved.blockers > 1
          ? ` Anche ${moved.blockers} card che aspettavano quella ora aspettano questa.`
          : "";
      addNote(intoTaskId, by, `Assorbita la card ${short(taskId)}, «${loser.text}». Commenti e sottotask sono qui.${anche}`);
      addNote(taskId, by, `Fusa nella card ${short(intoTaskId)}, «${winner.text}».`);

      const [survivor] = withSubtaskCounts([rowToTask(getTaskRow(intoTaskId))]);
      return {
        survivor: survivor!,
        merged: rowToTask(getTaskRow(taskId)),
        movedComments: moved.comments,
        movedChildren: moved.children,
        movedBlockers: moved.blockers,
      };
    },

    findDuplicates({ projectId, text, excludeTaskId, limit, rootsOnly }): Neighbour[] {
      const body = (text ?? "").trim();
      if (!body || !projectId) return [];
      // Solo le card VIVE della propria board: una card archiviata e' gia'
      // fuori, e proporla come doppione riporterebbe in vita una decisione
      // che qualcuno ha gia' preso.
      const rows = db.prepare(
        `SELECT id, text, created_at FROM tasks
          WHERE project_id = ? AND archived = 0 AND id != ?
          ${rootsOnly ? "AND parent_task_id IS NULL" : ""}`,
      ).all(projectId, excludeTaskId ?? "") as Array<{ id: string; text: string; created_at: string }>;
      return findNeighbours(
        body,
        rows.map((r) => ({ id: r.id, text: r.text ?? "", createdAt: r.created_at })),
        { limit },
      );
    },

    archive({ taskId, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const ts = now();
      // `archiveSubtree` fa la stessa discesa ricorsiva che valiant-hill aveva
      // scritta inline: il ramo l'aveva estratta, e tenere due copie della stessa
      // query e' il modo in cui una delle due smette di essere aggiornata.
      archiveSubtree(taskId, ts);
      // Una card archiviata non ha più una domanda in sospeso, ed era la quarta
      // strada che restava scoperta: la richiesta restava `pending` per sempre,
      // perché il task non è più in review e `reviewDecision` la rifiuta.
      settleReviewApproval(taskId, "expired", "system", ts);
      // Archiviare uno step lo toglie dagli aperti esattamente come chiuderlo:
      // e' la risposta «archivia» ai due bottoni, ed e' anche il modo in cui si
      // sgombera una checklist a mano. Il padre va guardato in entrambi i casi.
      if (row.parent_task_id) childLeftFlight(row.parent_task_id as string, "system", this);
      return rowToTask(getTaskRow(taskId));
    },

    restore({ taskId, projectId }): Task | null {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) return null;
      const ts = now();
      // Due direzioni, e servono entrambe. GIÙ perché `archive` ha marcato tutto
      // il sottoalbero: un ripristino che lascia gli step archiviati riporta una
      // card senza la sua checklist. SU perché un task figlio di un genitore
      // ancora archiviato non lo vede nessuno, e il ripristino sarebbe stato
      // solo una scrittura.
      db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         ),
         chain(id, parent) AS (
           SELECT id, parent_task_id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.parent_task_id FROM tasks t JOIN chain c ON t.id = c.parent
         )
         UPDATE tasks SET archived = 0, updated_at = ?
          WHERE id IN (SELECT id FROM subtree) OR id IN (SELECT id FROM chain)`,
      ).run(taskId, taskId, ts);
      return rowToTask(getTaskRow(taskId));
    },

    boundRootOf(taskId) {
      const r = db.prepare(
        `WITH RECURSIVE chain(id, parent, topic, depth) AS (
           SELECT id, parent_task_id, assigned_topic_id, 0 FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.parent_task_id, t.assigned_topic_id, c.depth + 1
             FROM tasks t JOIN chain c ON t.id = c.parent
         )
         SELECT id FROM chain WHERE topic IS NOT NULL ORDER BY depth ASC LIMIT 1`,
      ).get(taskId) as any;
      return r ? rowToTask(getTaskRow(r.id)) : null;
    },

    boardProjectForTopic(topicId) {
      if (!topicId) return null;
      // A live dispatch binds exactly one task to the topic; prefer a non-archived
      // one and the most recent if history ever left more than one.
      const r = db.prepare(
        `SELECT project_id FROM tasks
          WHERE assigned_topic_id = ?
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(topicId) as any;
      return r?.project_id ?? null;
    },

    taskForTopic(topicId) {
      if (!topicId) return null;
      const r = db.prepare(
        `SELECT id, project_id, text FROM tasks
          WHERE assigned_topic_id = ?
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(topicId) as any;
      return r ? { id: r.id, projectId: r.project_id, text: r.text ?? "" } : null;
    },

    taskByIdPrefix(id8) {
      const p = (id8 ?? "").trim();
      // id8 is a hex slice of a uuid → no LIKE metacharacters to escape.
      if (!/^[0-9a-f]{1,32}$/i.test(p)) return null;
      const r = db.prepare(
        `SELECT id, text FROM tasks
          WHERE id LIKE ? || '%'
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(p) as any;
      return r ? { id: r.id, text: r.text ?? "" } : null;
    },

    moveToProject({ taskId, toProjectId, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const target = (toProjectId ?? "").trim();
      if (!target) throw new TaskServiceError("invalid_input", "toProjectId is required");
      if (row.project_id === target) return rowToTask(row);
      // Only the ROOT of a subtree moves: create() pins a subtask to its
      // parent's board, so the subtree travels together or not at all.
      if (row.parent_task_id) {
        throw new TaskServiceError("invalid_transition", "task is a subtask. Move its root task (the subtree moves together).");
      }
      // A dispatched agent works a worktree/topic of the SOURCE project; moving
      // the task under it would strand the binding. Finish or release it first.
      if (row.assigned_topic_id || isAgentWorking(row.dispatch_state)) {
        throw new TaskServiceError("invalid_transition", "task has a live agent. Let it reach review (or park it) before moving boards.");
      }
      const ts = now();
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(target) as any;
      // Clear any stale dispatch failure state: a 'failed'/'blocked' park (and its
      // dispatch_error) was about the SOURCE board's dispatch context — moving the
      // task to another board invalidates it, so it must not travel as a red
      // "fallito"/"da sistemare" chip. (Live dispatch states are already refused
      // above, so this only ever clears a settled park.)
      db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         )
         UPDATE tasks SET project_id = ?, dispatch_state = NULL, dispatch_error = NULL, updated_at = ? WHERE id IN (SELECT id FROM subtree)`,
      ).run(taskId, target, ts);
      // Re-append the root at the end of the target board; children keep their
      // relative order (kanban_order is just a per-board sort key).
      db.prepare("UPDATE tasks SET kanban_order = ? WHERE id = ?").run((maxRow?.m ?? 0) + 1, taskId);
      return rowToTask(getTaskRow(taskId));
    },

    hasHeavyInFlight(): boolean {
      return heavyInFlight();
    },

    liveAgents(scope): number {
      return liveAgentCount(db, scope?.projectId ?? null);
    },

    claim({ taskId, cap, maxAttempts, agentId, scope, machineIdle }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // PESO — due regole, entrambe dentro il claim perché è l'unico punto in cui
      // la decisione è atomica rispetto agli altri claim (bun:sqlite è sincrono e
      // monoprocesso, quindi read-then-CAS qui non ha corse).
      //
      //  1. Un heavy in volo blocca OGNI altro claim, non solo gli altri heavy:
      //     il senso del peso è che quel task si prenda la macchina da solo, e
      //     tre task leggeri che gli partono accanto sono esattamente ciò che
      //     rende lunga la compilazione. Vale a macchina intera, non per board.
      //  2. Un heavy parte solo a macchina scarica. Il carico non lo legge questo
      //     modulo (resta puro): lo passa il chiamante. `undefined` = nessuna
      //     sonda ⇒ nessun gate, il comportamento storico.
      //
      // Entrambe si applicano PRIMA del conteggio degli slot: un no del peso non
      // è «non c'è posto», è «non adesso», e il chiamante lo dice diversamente.
      if (heavyInFlight()) return null;
      if (readTaskWeight(row.dispatch_weight) === "heavy" && machineIdle === false) return null;
      // Concurrency cap: count the AGENTI VIVI, not the card. Per-board by
      // default; scope 'global' counts across EVERY board so a machine-wide cap
      // holds no matter how many boards dispatch at once. The task itself is
      // still `todo` here, so it is not in the count. bun:sqlite is synchronous
      // + single-process, so this read-then-CAS is atomic w.r.t. other claims.
      //
      // La popolazione contata sta in `agent-census.ts` e comprende le SESSIONI
      // FIGLIE dei task dispatchati. Contare solo le righe `tasks` reggeva
      // finché un task era un processo; col modello del coordinatore una card
      // vale N processi, e un tetto che non li vede lascia partire un altro
      // task su una macchina già piena. Il claim e la rotta di spawn leggono la
      // stessa funzione apposta: due query diverse sarebbero due tetti.
      const running = liveAgentCount(db, scope === "global" ? null : row.project_id);
      if (running >= cap) return null;
      const ts = now();
      const res = db.prepare(
        `UPDATE tasks
            SET assigned_agent_id = ?, status = 'in_progress',
                in_progress_at = ?, dispatch_state = 'starting',
                dispatch_attempts = dispatch_attempts + 1, dispatch_error = NULL,
                dispatch_deferred_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'todo' AND assigned_topic_id IS NULL AND dispatch_attempts < ?
            AND (dispatch_deferred_until IS NULL OR dispatch_deferred_until <= ?)
            AND (blocked_by_task_id IS NULL OR EXISTS (
                  SELECT 1 FROM tasks bk
                   WHERE bk.id = tasks.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1)))`,
      ).run(agentId ?? null, ts, ts, taskId, maxAttempts, ts);
      if (res.changes !== 1) return null; // lost the race / not todo / attempts exhausted
      logStatus(taskId, "todo", "in_progress", "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

    bumpDispatchAttempt({ taskId, maxAttempts }): Task | null {
      const res = db.prepare(
        `UPDATE tasks
            SET dispatch_attempts = dispatch_attempts + 1, updated_at = ?
          WHERE id = ? AND status = 'in_progress' AND assigned_topic_id IS NOT NULL AND dispatch_attempts < ?`,
      ).run(now(), taskId, maxAttempts);
      if (res.changes !== 1) return null; // cap hit, moved, or claim gone
      return rowToTask(getTaskRow(taskId));
    },

    listBlockedBy(taskId): Task[] {
      const rows = db.prepare(
        "SELECT * FROM tasks WHERE blocked_by_task_id = ? AND archived = 0",
      ).all(taskId) as any[];
      return rows.map(rowToTask);
    },

    isDispatchBlocked(taskId): boolean {
      const r = db.prepare(
        `SELECT 1 AS b FROM tasks t
          WHERE t.id = ? AND t.blocked_by_task_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tasks bk
                             WHERE bk.id = t.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1))`,
      ).get(taskId);
      return !!r;
    },

    release({ taskId, requeue, reason, by, parkState, rollbackAttempt, keepStatus }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // Note first (so the "worked in topic X" trail survives clearing the link).
      if (reason && reason.trim()) {
        try { this.addComment({ taskId, author: by ?? "system", content: reason }); } catch { /* dedupe/best-effort */ }
      }
      const ts = now();
      // IN REVIEW NON ASPETTA UN AGENTE, ASPETTA UNA PERSONA.
      //
      // Un park (`requeue: false`) scriveva `backlog` senza guardare da dove
      // veniva la card. Il 12/08 quattro card in `review` sono finite in backlog
      // marcate `failed` con la stessa riga — «il branch del worktree non esiste
      // più» — perché il loro lavoro ERA ATTERRATO: il land pota il ramo, il GC
      // trova la riga fantasma e parcheggia. Il backlog non lo dispaccia
      // nessuno, quindi la decisione umana non era rimandata: era sparita dalla
      // colonna dove l'umano la guarda, e proprio per le card chiuse bene.
      //
      // Il park continua a fare l'unica cosa che serviva davvero — sciogliere il
      // legame col topic, così niente riprende in una cartella che non c'è più —
      // ma lo stato resta `review`. Nemmeno il timbro `failed` ci va: non è
      // fallito niente, e dipingere di rosso una card in attesa dice il falso a
      // chi la guarda per decidere.
      //
      // `keepStatus` è la stessa risposta chiesta esplicitamente: il GC che
      // scioglie una riga fantasma di una card la cui consegna è GIÀ SU MAIN non
      // ha trovato un guasto, ha trovato la fine normale della storia — e quella
      // card può stare in qualunque colonna.
      const parkKeepsStatus = !requeue && (keepStatus === true || row.status === "review");
      const status: TaskStatus = requeue ? "todo" : parkKeepsStatus ? (row.status as TaskStatus) : "backlog";
      // Requeue shows the 'in coda' chip; a park carries an EXPLICIT state so the
      // board can tell a genuine FAILURE ('failed') from a config BLOCK ('blocked')
      // — both used to collapse to null and read as a manual "fermato".
      const state = requeue ? "queued" : parkKeepsStatus ? null : (parkState ?? null);
      // A restart-orphan requeue rolls back the interrupted attempt: the server
      // restarting is never the agent's fault, so it must not erode the retry
      // budget (that was the "il task torna in backlog per errore" after deploys).
      const rollbackSql = rollbackAttempt ? "dispatch_attempts = MAX(dispatch_attempts - 1, 0), " : "";
      // La ragione è già nel thread come commento, qui sopra. Su una card che
      // resta in review non va anche in `dispatch_error`: quel campo è il tooltip
      // di un chip che non c'è, e una card in attesa di una persona non porta
      // addosso un errore.
      const errText = parkKeepsStatus ? null : (reason ?? null);
      db.prepare(
        `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL, ${rollbackSql}
            status = ?, dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?`,
      ).run(status, state, errText, ts, taskId);
      if (row.status !== status) logStatus(taskId, row.status, status, by ?? "dispatcher");
      markReopened(taskId, row.status, status, "system", by ?? "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

    deferForWait({ taskId, reason, minutes, by }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const mins = clampInt(minutes ?? 15, 1, 1440);
      const ts = now();
      const detto = reason && reason.trim() ? reason.trim() : "";
      // La serie: stessa ragione ⇒ continua, ragione nuova ⇒ ricomincia da uno.
      // `waitReasonKey` normalizza, perché un turno nuovo riscrive a mano quasi
      // la stessa frase e «quasi» non deve valere come «un'altra attesa».
      const chiave = waitReasonKey(detto);
      const stessa = !!row.wait_streak && (row.wait_reason ?? "") === chiave;
      const streak = stessa ? (row.wait_streak as number) + 1 : 1;
      const since = stessa && row.wait_since ? (row.wait_since as string) : ts;
      const serieMs = Math.max(0, Date.parse(ts) - Date.parse(since));
      // IL TENTATIVO SI RIMBORSA, e questa è la riga che chiude il guasto.
      //
      // Il turno che dichiara l'attesa il tentativo l'ha già speso: l'ha preso
      // la claim, PRIMA che l'agent potesse sapere che avrebbe dovuto aspettare.
      // Lasciarglielo addosso significa che un tetto pensato per i turni morti
      // (default 2) conta le attese, e alla terza la spazzata dei tentativi
      // esauriti parcheggia la card come `failed`. Rimborsando, `dispatch_attempts`
      // torna al valore che aveva prima della claim: un'attesa dichiarata non
      // lascia traccia sul contatore dei fallimenti, perché non è un fallimento.
      // A limitare le attese ci pensano i loro tetti, qui sotto.
      const rimborso = "dispatch_attempts = MAX(dispatch_attempts - 1, 0),";

      if (streak > WAIT_STREAK_CAP || serieMs >= WAIT_SERIES_MAX_MS) {
        // Sfondato un tetto: il task si ferma, ma NON come un fallimento. Non
        // c'è niente da riparare nell'agent, c'è una condizione che non arriva.
        // La durata detta come sta: il tetto sul CONTEGGIO può scattare in pochi
        // minuti (attese corte una dietro l'altra), e scrivere «da un'ora» lì
        // sarebbe una bugia sulla sola cosa che l'umano userà per decidere.
        const ore = Math.round(serieMs / 3_600_000);
        const minuti = Math.round(serieMs / 60_000);
        const quanto = serieMs >= 3_600_000
          ? `da circa ${ore} ${ore === 1 ? "ora" : "ore"}`
          : minuti >= 1
            ? `da ${minuti} ${minuti === 1 ? "minuto" : "minuti"}`
            : "da meno di un minuto";
        // La parola «fallito» non compare, e non per delicatezza: qui non è
        // successa nessuna delle cose che quella parola descrive. Nemmeno
        // negata («non è un fallimento») ci va, perché nominarla la mette in
        // testa a chi legge la card. Si dice cosa è successo e cosa fare.
        const nota =
          `Sono ${streak} attese di fila per la stessa ragione, ${quanto}` +
          (detto ? `: ${detto}.` : ".") +
          " La condizione non sta arrivando da sola, quindi la decisione torna a te. " +
          "Rimetti il task in Todo per farlo riprovare, oppure sistema ciò che sta aspettando.";
        try { this.addComment({ taskId, author: "system", content: nota }); } catch { /* dedupe/best-effort */ }
        // Parcheggiato in backlog senza finestra: non deve ripartire da solo,
        // il punto è proprio che qualcuno lo guardi. I contatori restano scritti
        // (li azzera il rientro in Todo) perché sono la ragione del parcheggio.
        db.prepare(
          `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL, ${rimborso}
              status = 'backlog', dispatch_state = ?, dispatch_error = ?,
              dispatch_deferred_until = NULL,
              wait_streak = ?, wait_reason = ?, wait_since = ?, updated_at = ?
            WHERE id = ?`,
        ).run(PARKED_WAITED_OUT, nota, streak, chiave || null, since, ts, taskId);
        // Firma di SISTEMA, non dell'agent: l'agent ha chiesto di aspettare
        // ancora, il parcheggio è il tetto che glielo nega. Attribuirlo a lui
        // direbbe che ha deciso di fermarsi, che è il contrario di quello che
        // ha fatto. Stessa distinzione di `deliverToReviewBySystem`.
        if (row.status !== "backlog") logStatus(taskId, row.status, "backlog", "dispatcher");
        markReopened(taskId, row.status, "backlog", "system", "dispatcher");
        return rowToTask(getTaskRow(taskId));
      }

      const note =
        (detto ? `In attesa: ${detto}. ` : "In attesa di una condizione esterna. ") +
        `Rilascio lo slot, il task torna in coda e riprovo tra ~${mins} min` +
        (streak > 1 ? ` (attesa ${streak} di ${WAIT_STREAK_CAP}).` : ".");
      // Note first (author = the agent by default) so the "perché è fermo" trail
      // survives clearing the topic link.
      try { this.addComment({ taskId, author: by ?? "agent", content: note }); } catch { /* dedupe/best-effort */ }
      // Back to todo, slot freed (topic/agent cleared), chip `waiting`, and a
      // deferral window that keeps it out of the claim until it elapses.
      db.prepare(
        `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL, ${rimborso}
            status = 'todo', dispatch_state = 'waiting', dispatch_error = ?,
            dispatch_deferred_until = ?,
            wait_streak = ?, wait_reason = ?, wait_since = ?, updated_at = ?
          WHERE id = ?`,
      ).run(note, new Date(Date.parse(ts) + mins * 60_000).toISOString(), streak, chiave || null, since, ts, taskId);
      if (row.status !== "todo") logStatus(taskId, row.status, "todo", by ?? "agent");
      markReopened(taskId, row.status, "todo", "agent", by ?? "agent");
      return rowToTask(getTaskRow(taskId));
    },

    deliverToReviewBySystem({ taskId, reason, cause, nextMove }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ts = now();
      // LA RIGA SI SCRIVE DOPO LE GUARDIE, non prima. Stava in cima perché così
      // era «l'ultima parola sulla card» — ragione caduta con `ad1516aca`, che
      // garantisce il trasporto dell'ultima parola vera quale che sia la sua
      // posizione. Restava solo il costo: il testo dice «L'ho portato io in
      // review: valuta cosa ha prodotto», ma le due guardie qui sotto possono
      // mandare la card in `todo`. Misurato il 18/08 su `171b787d`: commento
      // alle 03:34:43.585, riga di stato `in_progress→todo` alle 03:34:43.587 —
      // due millisecondi dopo. Su tre giorni, 35 note di questa famiglia: 29
      // seguite da review e SEI da todo; sull'intero storico, 260 note e 87
      // verso todo o backlog.
      //
      // La riga resta nel thread per sempre, e quando la card arriva davvero in
      // review è quella che il reviewer trova: gli dice di valutare una consegna
      // in un momento in cui non ce n'era ancora una. Si scambia «sempre
      // presente, a volte falsa» con «a volte assente, mai falsa» — e solo sulla
      // seconda si può decidere.
      // Un padre con sottotask aperti NON è approvabile (il gate su `done` lo
      // rifiuta), quindi metterlo in review mette in coda all'umano una card su
      // cui non può decidere niente — e ci torna a ogni turno esaurito. Misurato
      // il 10/08: la stessa card rimbalzata in review quattro volte in un'ora,
      // con quattro figli aperti. Il posto giusto è la coda: il lavoro non è
      // finito, e il turno finito non lo rende finito.
      //
      // Ma «aperto» e «lo sta aspettando qualcuno» non sono la stessa cosa: se
      // gli unici figli aperti sono PARCHEGGIATI in backlog, nessun dispatcher
      // li prenderà e il padre aspetterebbe a vuoto per sempre.
      //
      // E quello non è nemmeno un blocco: è una DOMANDA con due risposte
      // (rimettili in coda / archiviali), e le domande si fanno dove l'umano
      // guarda. Parcheggiare il padre in backlog con la spiegazione dentro
      // `dispatch_error` la nascondeva nel drawer di una card in fondo alla
      // colonna del riposo: misurate il 12/08 cinque card ferme così, e nessuna
      // lo diceva a nessuno. `askParkedChildren` la porta in review coi bottoni.
      // `evenIfLive`: qui il turno E' finito — questa funzione la chiama chi lo
      // sta chiudendo — quindi la guardia sul padre vivo non deve mordere.
      const domanda = this.askParkedChildren({ taskId, by: "dispatcher", evenIfLive: true });
      if (domanda) return domanda;
      if (hasActiveChildren(taskId)) {
        // Il tentativo si RESTITUISCE: il turno non è finito per colpa del
        // padre, è finito mentre i figli lavoravano ancora — esattamente come
        // il riavvio del server non è colpa dell'agente. Senza questo, il padre
        // rientra in coda col budget già speso e non verrà reclamato MAI più:
        // niente chip, niente errore, una card che finge di essere in coda.
        // Diciannove così l'11/08, tutte da questo ramo.
        //
        // E il chip lo dice: `waiting` con la ragione, non il nulla che sul
        // board si legge come «fermato a mano».
        //
        // E non rientra SUBITO in coda: senza finestra, il tick lo riprende al
        // giro dopo, il turno finisce di nuovo coi figli ancora aperti, e sono
        // turni pagati per aspettare. Stessa meccanica di `deferForWait`.
        const note = "In attesa dei sottotask ancora aperti: torno in coda e riparto quando hanno finito.";
        const until = new Date(Date.parse(ts) + 10 * 60_000).toISOString();
        db.prepare(
          `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL,
              dispatch_attempts = MAX(dispatch_attempts - 1, 0),
              status = 'todo', dispatch_state = 'waiting', dispatch_error = ?,
              dispatch_deferred_until = ?, updated_at = ? WHERE id = ?`,
        ).run(note, until, ts, taskId);
        if (row.status !== "todo") logStatus(taskId, row.status, "todo", "dispatcher");
        // La ragione del turno resta scritta — sparire in silenzio sarebbe
        // peggio, e un test lo pinna — ma accompagnata dalla destinazione VERA:
        // questa card non è in review, e nessuno deve valutarla adesso. Servizio,
        // perché su una card in coda è contabilità: chi la riprende è il
        // dispatcher, non un umano.
        if (reason && reason.trim()) {
          try { this.addComment({ taskId, author: "system", kind: "service", content: `${reason}\n\n${note}` }); }
          catch { /* best-effort */ }
        }
        return rowToTask(getTaskRow(taskId));
      }
      // Qui, e solo qui, la card va DAVVERO in review: è il punto in cui «l'ho
      // portato io in review» smette di essere una previsione e diventa un fatto.
      if (reason && reason.trim()) {
        const testo = nextMove && nextMove.trim() ? `${reason}\n\n${nextMove.trim()}` : reason;
        try { this.addComment({ taskId, author: "system", content: testo }); } catch { /* best-effort */ }
      }
      // Hand to the human: keep assigned_topic_id (a rejection resumes this
      // agent), clear the stale error, chip = needs_input (a decision is wanted).
      // `delivered_by = 'system'`: la card in review deve dire da sé che non è una
      // consegna dell'agente — sotto può non esserci nessun deliverable.
      db.prepare(
        // La serie di attese si chiude qui come si chiude in `update()`: il task
        // è arrivato all'umano, non sta più aspettando niente. Questa porta è a
        // SQL grezzo e non passa da lì, quindi la riga va ripetuta o la serie
        // sopravviverebbe alla consegna.
        // `review_at` per la stessa ragione della serie d'attesa, ed e' lo
        // stesso avvertimento: questa porta non passa da `update()`, quindi
        // senza la riga qui la card arriverebbe in review senza sapere da
        // quando ci sta - e la colonna direbbe «ora» per sempre.
        "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', dispatch_error = NULL, " +
          "wait_streak = 0, wait_reason = NULL, wait_since = NULL, review_at = ?, " +
          "delivered_by = 'system', delivered_reason = ?, updated_at = ? WHERE id = ?",
      ).run(ts, cause ?? null, ts, taskId);
      if (row.status !== "review") logStatus(taskId, row.status, "review", "dispatcher");
      markReopened(taskId, row.status, "review", "system", "dispatcher");
      // Open the pending review approval so the review decision flow works, just
      // like an agent-initiated hand-off would.
      try {
        db.prepare(
          `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
           VALUES (?, ?, 'dispatcher', 'review', ?, 'done', 'pending', ?)`,
        ).run(uuid(), taskId, row.status, ts);
      } catch { /* an existing pending approval is fine */ }
      return rowToTask(getTaskRow(taskId));
    },

    askParkedChildren({ taskId, by, evenIfLive }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      // Una card chiusa o archiviata non ha domande da fare; una GIÀ in review la
      // sta già facendo, e rifarla a ogni giro sarebbe il rumore che spegne le
      // domande vere.
      if (row.archived === 1 || row.status === "done" || row.status === "review") return null;
      // IL PADRE STA LAVORANDO: la domanda non si fa adesso.
      //
      // Spostare in review una card con un turno vivo gli taglia il turno sotto
      // i piedi — lo dice gia' la docstring di `parkedChildRaisedStall`, che per
      // questo la guardia ce l'aveva. Mancava qui, cioe' nell'unico punto che la
      // card la MUOVE davvero, e `childLeftFlight` ci arrivava senza nessuna
      // protezione: bastava che l'agente spuntasse il primo passo della propria
      // checklist perche' la sua card finisse in review a turno in corso.
      // La domanda non si perde: la fa `deliverToReviewBySystem` a fine turno,
      // che passa `evenIfLive` proprio perche' li' il turno e' finito per
      // davvero. Fra minuti, non fra giorni.
      if (!evenIfLive && hasLiveTurn(row)) return null;
      if (!hasActiveChildren(taskId) || hasChildrenInFlight(taskId)) return null;
      const parked = parkedChildren(taskId);
      if (parked.length === 0) return null;
      const ts = now();
      const elenco = parked.map((c) => `«${c.text.length > 60 ? `${c.text.slice(0, 59)}…` : c.text}»`).join(", ");
      // La domanda sta su UNA riga: il blocco `question` appiattisce gli a capo
      // (contratto del parser delle risposte rapide), quindi l'elenco dei figli
      // viaggia in linea e non come lista.
      // «fermi», non «parcheggiati in backlog»: da quando il predicato conta
      // anche i figli in `todo`, la colonna non è più la notizia — lo è il fatto
      // che nessun turno li muoverà. Nominare una colonna sbagliata manderebbe a
      // cercarli dove non sono.
      // GIA' RIMESSI IN CODA UNA VOLTA? Allora quel bottone non si offre piu'.
      //
      // SI CONTA IL FATTO SCRITTO, non l'etichetta del bottone. Il confronto era
      // `content = REQUEUE_PARKED_LABEL`, e nessuno scrive mai un commento il cui
      // corpo INTERO sia quel testo: il conto era zero sempre, la terza uscita non
      // si offriva mai, e all'umano tornava per sempre lo stesso bottone circolare
      // — cioè esattamente l'anello che quell'uscita esiste per rompere. Il fatto
      // che viene davvero scritto è la nota di `resolveParkedChildren`, e il
      // pattern arriva da `shared/board.ts`, dalla stessa costante che la compone.
      //
      // L'ANELLO, visto tre volte in una notte sulle stesse card: «rimetti in
      // coda» porta i figli in `todo`, ma un figlio in `todo` conta come fermo
      // (nessun tick lo prende: il dispatcher lista `rootsOnly`), quindi alla
      // fine del turno successivo la domanda riparte identica. Chi risponde
      // ripremeva lo stesso bottone e tornava esattamente qui.
      //
      // Offrire due volte un'uscita che si e' gia' dimostrata circolare non e'
      // dare una scelta: e' far girare a vuoto chi decide. Alla seconda volta la
      // domanda lo DICE, e lascia le uscite che portano fuori davvero.
      const giaRimessi = (db.query(
        "SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND content LIKE ?",
      ).get(taskId, PARKED_REQUEUE_NOTE_LIKE) as { n: number } | undefined)?.n ?? 0;
      const question = giaRimessi > 0
        ? `Fermo di nuovo sugli stessi ${parked.length} sottotask (${elenco}), e rimetterli in coda l'ha gia' fatto: ` +
          `non basta, perche' uno step lo muove solo l'agente di questa card dentro il proprio turno e quel turno non li ha toccati. ` +
          `Archivio cio' che non serve piu', oppure la prendi in mano tu?`
        : `Fermo su ${parked.length} sottotask che non lavorerà nessuno (${elenco}): uno step lo muove solo l'agente di questa card ` +
          `dentro il proprio turno, e con un sottotask aperto questo task non si può chiudere. Li rimetto in coda, o archivio ciò che non serve più?`;
      try {
        this.addComment({
          taskId, author: "system", content: question,
          questionOptions: giaRimessi > 0
            ? [ARCHIVE_PARKED_LABEL, TAKE_OVER_PARKED_LABEL]
            : [REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL],
        });
      } catch { /* dedupe/best-effort: la domanda resta comunque nello stato */ }
      // Stessa forma di una consegna di sistema — review + `needs_input` + firma
      // `system` — perché è la stessa cosa: una card che aspetta una persona.
      // `delivered_reason` dice QUALE persona serve, e la card lo scrive da sé.
      db.prepare(
        "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', dispatch_error = ?, " +
          "dispatch_deferred_until = NULL, wait_streak = 0, wait_reason = NULL, wait_since = NULL, " +
          "review_at = ?, " +
          "delivered_by = 'system', delivered_reason = 'parked_children', updated_at = ? WHERE id = ?",
      ).run(question, ts, ts, taskId);
      if (row.status !== "review") logStatus(taskId, row.status, "review", by ?? "dispatcher");
      markReopened(taskId, row.status, "review", "system", by ?? "dispatcher");
      // L'approvazione pendente serve al flusso di review: la risposta rapida
      // arriva su quella porta, ed è anche ciò che la chiude quando il task esce.
      try {
        db.prepare(
          `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
           VALUES (?, ?, 'dispatcher', 'review', ?, 'done', 'pending', ?)`,
        ).run(uuid(), taskId, row.status, ts);
      } catch { /* un'approvazione già pendente va benissimo */ }
      return rowToTask(getTaskRow(taskId));
    },

    sweepParkedChildren({ by, eligible } = {}): Task[] {
      const ts = now();
      // I CANDIDATI, non la decisione: questa query stringe il campo, poi
      // `askParkedChildren` applica le sue guardie una per una. Due predicati
      // che decidono la stessa cosa in due punti divergono, e il modo in cui
      // divergerebbero è il peggiore possibile — una domanda alzata su una card
      // che non l'aveva, o taciuta su una che l'aveva.
      //
      // Fuori dal campo, e sono le stesse esclusioni della sonda
      // (`scripts/stalled-parents.ts`): un padre con un turno addosso o in
      // arrivo (se ne accorgerà a fine corsa), uno dentro la propria finestra di
      // rinvio (un turno è previsto, solo più tardi), e uno in review — lì la
      // guardia di `askParkedChildren` esce comunque, ma chiederlo al DB
      // risparmia il giro su ogni card consegnata della board.
      //
      // …E UN PADRE APPENA RIMESSO IN CODA, che è l'anello che questa riga
      // rompe. «Rimetti in coda» (o un umano che trascina la card in Todo)
      // azzera `dispatch_attempts` insieme al resto dello stato di dispatch
      // (vedi `update`, ramo `status === "todo" && actor === "human"`), e da quel
      // momento la card è un candidato pieno: il rastrello passa PRIMA che il
      // dispatcher le dia il turno e la riporta in review con la stessa domanda.
      // Misurato il 15/08 su `5505c6fa`, che di suo si intitola «review che non
      // rientra in coda»: rimessa in coda alle 20:32, di nuovo in review alle
      // 20:49, senza che nessun agente l'avesse toccata. Chi rispondeva vedeva
      // la card tornare indietro da sola e la domanda ricomparire identica.
      //
      // `todo` + zero tentativi vuol dire «in coda, turno mai partito»: quel
      // padre non è fermo, sta aspettando il suo giro, e la domanda giusta gliela
      // farà `deliverToReviewBySystem` alla FINE di quel turno se davvero non
      // avrà toccato i figli. Con un tentativo già speso invece è fermo per
      // davvero, e il rastrello lo prende come prima.
      let candidati: Array<{ id: string; project_id: string }> = [];
      try {
        candidati = db.prepare(
          `SELECT p.id, p.project_id FROM tasks p
            WHERE p.archived = 0
              AND p.status NOT IN ('done', 'review', 'in_progress')
              AND NOT (p.status = 'todo' AND p.dispatch_attempts = 0)
              AND COALESCE(p.dispatch_state, '') NOT IN (${CHILD_AGENT_COMING})
              AND COALESCE(p.dispatch_deferred_until, '') <= ?
              AND EXISTS (SELECT 1 FROM tasks c
                           WHERE c.parent_task_id = p.id AND c.archived = 0 AND c.status != 'done')
            ORDER BY p.updated_at`,
        ).all(ts) as Array<{ id: string; project_id: string }>;
      } catch { return []; }
      const chiesti: Task[] = [];
      const ammessa = new Map<string, boolean>();
      for (const c of candidati) {
        if (eligible) {
          let ok = ammessa.get(c.project_id);
          if (ok === undefined) { try { ok = eligible(c.project_id); } catch { ok = false; } ammessa.set(c.project_id, ok); }
          if (!ok) continue;
        }
        try {
          const t = this.askParkedChildren({ taskId: c.id, by: by ?? "dispatcher" });
          if (t) chiesti.push(t);
        } catch { /* una card può essersi mossa sotto: il giro dopo la ripesca */ }
      }
      return chiesti;
    },

    resolveParkedChildren({ taskId, decision, by }): { task: Task; children: Task[] } | null {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // SI RISPONDE A UNA DOMANDA CHE È ANCORA SULLA CARD. Prima bastava trovare
      // dei figli in backlog, e con i figli fermi in `todo` dentro il predicato
      // quella prova si è girata contro: «rimetti in coda» li porta proprio in
      // `todo`, quindi la seconda risposta li ritrovava tutti e li rimetteva in
      // coda una seconda volta, inventando un esito. La domanda vive in review e
      // muore quando la card ne esce: è lì che si legge se c'è ancora.
      if (row.status !== "review") return null;
      const parked = parkedChildren(taskId);
      if (parked.length === 0) return null;
      const firma = by || "system";
      const ts = now();
      const children: Task[] = [];
      for (const c of parked) {
        if (decision === "requeue") {
          // Budget azzerato: un sottotask parcheggiato può aver bruciato tentativi
          // prima di finire lì, e rimetterlo in coda senza budget sarebbe rimetterlo
          // in una coda che non lo serve.
          db.prepare(
            "UPDATE tasks SET status = 'todo', dispatch_state = NULL, dispatch_error = NULL, " +
              "dispatch_attempts = 0, dispatch_deferred_until = NULL, updated_at = ? WHERE id = ?",
          ).run(ts, c.id);
          // Da DOVE viene lo dice la riga, non una costante: un figlio fermo in
          // `todo` (fermo lo era comunque, nessun turno lo muoveva) non ha
          // cambiato colonna, e scrivere «backlog → todo» avrebbe messo nella
          // sua storia un passaggio che non è mai avvenuto.
          if (c.status !== "todo") logStatus(c.id, c.status, "todo", firma);
          const t = getTaskRow(c.id);
          if (t) children.push(rowToTask(t));
        } else {
          children.push(this.archive({ taskId: c.id }));
        }
      }
      // The copy lives in `shared/board.ts`, next to the predicate that has to
      // recognise it: this note is signed `user` (a person picked the option),
      // and the review card must not quote it back as the human's request.
      const nota = noteParkedChildrenResolved(decision, parked.length);
      // Il mandato è NUOVO — l'ha appena dato una persona — quindi il budget dei
      // tentativi riparte da zero, esattamente come per un trascinamento in Todo.
      // Senza, il padre tornerebbe in coda già esaurito e non lo reclamerebbe più
      // nessuno: la stessa card ferma di prima, con un chip diverso.
      db.prepare(
        "UPDATE tasks SET dispatch_attempts = 0, dispatch_deferred_until = NULL, " +
          "wait_streak = 0, wait_reason = NULL, wait_since = NULL, updated_at = ? WHERE id = ?",
      ).run(ts, taskId);
      const task = this.release({ taskId, requeue: true, reason: nota, by: firma });
      // La domanda ha avuto risposta: l'approvazione pendente non ha più oggetto
      // (il task non è in review e `reviewDecision` la rifiuterebbe per sempre).
      settleReviewApproval(taskId, "expired", firma, ts);
      return { task, children };
    },

    bindTopic({ taskId, topicId, freshSession }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // UNA SESSIONE NUOVA E' UN TENTATIVO NUOVO, e il budget riparte da zero.
      //
      // `dispatch_attempts` conta i turni di UN tentativo — e' il freno contro
      // un agente che gira in tondo dentro la stessa conversazione. Fra un
      // dispatch e l'altro, invece, il contatore restava: la card ripartiva su
      // una sessione VERGINE con il budget gia' speso, quindi moriva al primo
      // turno annunciando di averne fatti quattro.
      //
      // Misurato il 18/08 su `eef64e32`: tre dispatch, tre topic diversi
      // (`groovy-frond`, `stellar-weasel`, `stellar-geyser`), e al terzo la
      // sessione aveva DUE messaggi mentre la card scriveva «L'agent ha
      // lavorato 4 turni». Un ciclo che non poteva chiudersi: ogni giro
      // ricominciava il piano e non arrivava mai a lavorarlo.
      //
      // E' la stessa regola che le due uscite UMANE applicano gia', con la
      // stessa ragione scritta accanto (`reviewDecision` rifiuto,
      // `resolveParkedChildren`): «il mandato e' NUOVO, quindi il budget dei
      // tentativi riparte da zero. Senza, il padre tornerebbe in coda gia'
      // esaurito e non lo reclamerebbe piu' nessuno».
      //
      // Il freno NON si allenta: se la sessione e' la STESSA — una ripresa, una
      // continuazione — il contatore resta dov'e', ed e' li' che serve.
      // `freshSession` lo DICE chi lo sa: il dispatcher, che ha appena creato
      // il topic invece di riusarne uno. Dedurlo da «il topic e' cambiato» non
      // funziona — fra un tentativo e l'altro `release` azzera il legame, e il
      // primo attacco di OGNI tentativo sarebbe `null -> topic`, cioe' anche
      // quello che la rivendicazione ha appena contato.
      //
      // `1` e non `0`: questo turno e' il PRIMO della sessione nuova, e conta.

      // IL TENTATIVO MUORE, LA CHECKLIST NO: I `done` SI ARCHIVIANO, GLI APERTI
      // CAMBIANO PADRONE.
      //
      // Misurato il 18/08 su `eef64e32`: dopo il re-dispatch i quattro sottotask
      // del topic precedente (`groovy-frond`) erano ancora nella checklist del
      // padre, tre segnati `done` per lavoro che era stato buttato via e uno
      // `in_progress` che mandava il padre in attesa di nessuno (deadlock
      // silenzioso: la card restava in coda per sempre perche' uno step si muove
      // solo dall'agente di quella card, e quell'agente non esiste piu').
      //
      // I due guasti NON sono lo stesso guasto, e non hanno la stessa cura:
      //
      //  · un `done` e' una BUGIA. Descrive lavoro che il worktree nuovo non ha;
      //    l'agente che arriva lo legge come fatto e non lo rifa'. Si archivia.
      //  · un aperto e' un PIANO. Dice cosa restava da fare, ed e' l'unica cosa
      //    di buono che il tentativo morto lascia. Archiviarlo faceva ripartire
      //    il nuovo agente dal foglio bianco, a ricostruire la stessa lista.
      //
      // Quindi gli aperti restano, ma cambiano padrone: `status` torna a `todo`
      // (l'`in_progress` era di un turno che non gira piu') e
      // `created_by_topic_id` passa al topic NUOVO. Il secondo pezzo e' quello
      // che scioglie il deadlock, ed e' il motivo per cui `isOwnStep` guarda la
      // PROVENIENZA e non solo il legame di dispatch: `assigned_topic_id` lo
      // azzera `release` mentre il turno gira ancora, e senza la provenienza
      // aggiornata l'agente nuovo vedeva lo step e prendeva 409 nel chiuderlo.
      //
      // Ricorsivo sull'ALBERO, non sui figli diretti: uno step annidato del
      // tentativo morto avrebbe lo stesso problema un livello piu' sotto, e
      // sarebbe l'unico rimasto che nessuno puo' chiudere.
      //
      // Idempotente: se il topic e' lo stesso (ripresa) o non c'era (primo
      // dispatch), non si tocca niente.
      const oldTopicId = row.assigned_topic_id as string | null;
      if (freshSession && oldTopicId && oldTopicId !== topicId) {
        const ts = now();
        // L'albero INTERO sotto il task, filtrato sulla provenienza: quello che
        // ha creato un altro topic (un umano, un altro agente) non si tocca.
        // Il task stesso e' escluso: e' il deliverable, non uno step.
        const staleOf = (): Array<{ id: string; text: string; status: string }> =>
          db.prepare(
            `WITH RECURSIVE subtree(id) AS (
               SELECT id FROM tasks WHERE id = ?
               UNION ALL
               SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
             )
             SELECT t.id, t.text, t.status FROM tasks t
              WHERE t.id IN (SELECT id FROM subtree WHERE id != ?)
                AND t.created_by_topic_id = ?
                AND t.archived = 0
              ORDER BY t.kanban_order ASC`,
          ).all(taskId, taskId, oldTopicId) as Array<{ id: string; text: string; status: string }>;

        const archiviati = staleOf().filter((c) => c.status === "done");
        // Prima gli archiviati, e in cascata: un aperto che pendeva da uno step
        // `done` se ne va con lui invece di restare appeso a un padre sparito.
        for (const c of archiviati) archiveSubtree(c.id, ts);
        // Poi si rilegge: quello che e' ancora aperto DOPO la cascata e' quello
        // che il nuovo agente eredita davvero.
        const ereditati = staleOf().filter((c) => c.status !== "done");
        for (const c of ereditati) {
          // Le colonne sono ESATTAMENTE quelle che `resolveParkedChildren`
          // azzera quando rimette in coda un figlio, e per la stessa ragione:
          // e' un mandato NUOVO, non un residuo. Lasciare la finestra di rinvio
          // o il chip vecchio vuol dire uno step che dice «in coda» sopra una
          // coda che non lo serve, che e' il modo in cui una card si ferma
          // senza dirlo a nessuno.
          db.prepare(
            "UPDATE tasks SET status = 'todo', created_by_topic_id = ?, dispatch_state = NULL, " +
              "dispatch_error = NULL, dispatch_attempts = 0, dispatch_deferred_until = NULL, " +
              "updated_at = ? WHERE id = ?",
          ).run(topicId, ts, c.id);
          // La riga di stato la scrive CHI SPOSTA, sempre: senza, la storia
          // dello step mostra una colonna cambiata e nessuno che l'ha cambiata.
          // Il `from` e' quello vero e non una costante — uno step gia' in
          // `todo` non si e' mosso, e scrivergli «todo -> todo» sarebbe mettere
          // nella sua storia un passaggio mai avvenuto (stessa regola, e stessa
          // riga, di `resolveParkedChildren`).
          if (c.status !== "todo") logStatus(c.id, c.status, "todo", "system");
          // Uno step in `review` stava aspettando una decisione. Tirandolo
          // fuori, quella approvazione non ha piu' oggetto: se resta `pending`
          // non la chiude piu' niente, perche' `reviewDecision` rifiuta un task
          // che in review non c'e' piu'. E' la stessa chiusura che
          // `resolveParkedChildren` fa sul padre quando la domanda decade.
          if (c.status === "review") settleReviewApproval(c.id, "expired", "system", ts);
        }
        if (archiviati.length > 0 || ereditati.length > 0) {
          const righe: string[] = [`Sessione cambiata (topic \`${oldTopicId}\` -> \`${topicId}\`).`];
          if (archiviati.length > 0) {
            righe.push(
              `${archiviati.length} ${archiviati.length === 1 ? "sottotask completato archiviato" : "sottotask completati archiviati"}: ` +
                `segnavano lavoro del tentativo precedente, che non esiste piu'.`,
            );
          }
          if (ereditati.length > 0) {
            righe.push(
              `${ereditati.length} ${ereditati.length === 1 ? "sottotask incompleto ereditato" : "sottotask incompleti ereditati"} ` +
                `dal nuovo agente: rimessi in todo, sono il piano che il tentativo precedente lascia.`,
            );
            righe.push(ereditati.map((c) => `- ${c.text}`).join("\n"));
          }
          try {
            this.addComment({ taskId, author: "system", content: righe.join("\n") });
          } catch { /* best-effort: la nota non blocca il bind */ }
        }
      }

      db.prepare(
        "UPDATE tasks SET assigned_topic_id = ?, chat_id = ?" +
          (freshSession ? ", dispatch_attempts = 1" : "") +
          ", updated_at = ? WHERE id = ?",
      ).run(topicId, topicId, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    recordAgentUsage({ taskId, addMs, addTokens, addCacheReadTokens }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ms = Math.max(0, Math.trunc(addMs || 0));
      const tok = Math.max(0, Math.trunc(addTokens || 0));
      const cr = Math.max(0, Math.trunc(addCacheReadTokens || 0));
      db.prepare(
        "UPDATE tasks SET agent_ms = agent_ms + ?, agent_tokens = agent_tokens + ?, agent_cache_read_tokens = agent_cache_read_tokens + ?, updated_at = ? WHERE id = ?",
      ).run(ms, tok, cr, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    raiseAgentUsage({ taskId, tokens, cacheReadTokens }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const tok = Math.max(0, Math.trunc(tokens || 0));
      const cr = Math.max(0, Math.trunc(cacheReadTokens || 0));
      // `COALESCE` prima di `MAX`, e non è una cintura: lo `max()` scalare di
      // SQLite torna NULL se UNO degli argomenti è NULL, quindi su una card che
      // non ha mai contato niente (`agent_tokens` NULL) il pavimento avrebbe
      // CANCELLATO il numero invece di alzarlo. Visto in un test, non letto.
      db.prepare(
        "UPDATE tasks SET agent_tokens = MAX(COALESCE(agent_tokens, 0), ?), agent_cache_read_tokens = MAX(COALESCE(agent_cache_read_tokens, 0), ?), updated_at = ? WHERE id = ?",
      ).run(tok, cr, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    setDispatchState({ taskId, state, error }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?")
        .run(state, error ?? null, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    setModel({ taskId, model }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET model = ?, updated_at = ? WHERE id = ?")
        .run(model || null, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    /**
     * Ritira l'anteprima e SCRIVE il perché sulla card.
     *
     * Un solo gesto, perché il fatto è uno solo: l'immagine se ne va e la card
     * porta il motivo. Prima il motivo finiva solo in una nota del thread —
     * dove non invecchia, non si corregge e non sa di essere stata superata.
     * Qui si spegne da solo appena qualcuno allega un'anteprima nuova (vedi
     * `update`/`promoteReviewPreview`).
     */
    retirePreview({ taskId, reason }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare(
        "UPDATE tasks SET preview_image = NULL, preview_retired_at = ?, preview_retired_reason = ?, updated_at = ? WHERE id = ?",
      ).run(now(), reason.trim() || null, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    setDispatchWeight({ taskId, weight }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // `readTaskWeight` anche in scrittura: un valore che non è uno dei due
      // noti entra come NULL, cioè leggero. Una stringa storta non deve poter
      // diventare un `heavy` che ferma la coda della board.
      db.prepare("UPDATE tasks SET dispatch_weight = ?, updated_at = ? WHERE id = ?")
        .run(readTaskWeight(weight), now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    recordChecks({ taskId, state, commit, runs }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare(
        "UPDATE tasks SET checks_state = ?, checks_at = ?, checks_commit = ?, checks_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        state,
        // 'running' non ha un "quando è finito": scriverne uno direbbe una cosa
        // falsa alla riga "verdi alle 14:32".
        state === "running" ? null : now(),
        commit ?? null,
        runs && runs.length ? JSON.stringify(runs) : null,
        now(),
        taskId,
      );
      return rowToTask(getTaskRow(taskId));
    },

    clearStaleChecksRuns(): number {
      // `checks_at` resta com'era (una corsa senza verdetto non ha un "quando"),
      // e `checks_commit`/`checks_json` pure: sono la traccia dell'ultima misura
      // vera, e cancellarli qui butterebbe via un esito valido.
      const res = db.prepare(
        "UPDATE tasks SET checks_state = NULL, updated_at = ? WHERE checks_state = 'running'",
      ).run(now());
      return Number(res.changes ?? 0);
    },

    setLabels({ taskId, labels, actor, source, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const wanted = normalizeLabels(labels);
      const current = labelsOf(taskId);

      // IL CANCELLO. Un agente può alzare la mano, mai abbassarla. `visibile` e
      // `decisione` sì — sono due modi di passare la card a un umano, e passare
      // lavoro a una persona è sempre permesso. `invisibile` no: è l'unica che
      // TOGLIE la revisione umana, e sarebbe l'autorizzazione a chiudersi le
      // card da solo. E non può nemmeno TOGLIERE un'etichetta di chiusura già
      // scritta: sfilare un `visibile` è uscire dalla lista di Attilio per
      // un'altra strada.
      if (actor === "agent") {
        if (wanted.includes("invisibile")) {
          throw new TaskServiceError(
            "label_forbidden",
            "un agente non può marcare `invisibile` il proprio lavoro: chi chiude la card lo deriva il server dal diff (shared/task-labels.ts), o lo corregge un umano",
          );
        }
        const droppedCloser = current.find((c) => isCloserLabel(c.label) && !wanted.includes(c.label));
        if (droppedCloser) {
          throw new TaskServiceError(
            "label_forbidden",
            `un agente non può togliere l'etichetta \`${droppedCloser.label}\`: la revisione umana si chiede, non si revoca`,
          );
        }
      }

      const ts = now();
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(taskId);
        const ins = db.prepare("INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, ?, ?)");
        for (const label of wanted) {
          // Chi non tocca un'etichetta non ne riscrive la provenienza: una
          // `derived` che l'umano lascia dov'è resta `derived`, così la consegna
          // successiva può ricalcolarla.
          const keep = current.find((c) => c.label === label);
          ins.run(taskId, label, keep && keep.source === source ? keep.source : source, ts);
        }
      });
      tx();
      return rowToTask(getTaskRow(taskId));
    },

    deriveLabelsFromDiff({ taskId, files }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      const current = labelsOf(taskId);

      /**
       * Che cosa scrivere per UNA famiglia di etichette — `null` = niente.
       *
       * Una correzione a mano di Attilio NON si sovrascrive alla consegna
       * successiva, o la correzione durerebbe quanto il turno seguente: basta
       * UNA etichetta non `derived` nella famiglia perché la famiglia intera sia
       * di chi l'ha scritta. E ciò che è già uguale non si riscrive, o ogni
       * consegna rifarebbe il `created_at` di un dato immutato.
       */
      const pick = (belongs: (l: string) => boolean, wanted: TaskLabel | null): TaskLabel | null => {
        const held = current.filter((c) => belongs(c.label));
        if (held.some((h) => h.source !== "derived")) return null;
        if (!wanted) return null;
        if (held.length === 1 && held[0]!.label === wanted) return null;
        return wanted;
      };

      // Due domande INDIPENDENTI: chi chiude la card, e che genere di lavoro è.
      // Correggere a mano la prima non deve congelare la seconda — prima le due
      // stavano sotto lo stesso `return null` e un `visibile` scritto da Attilio
      // lasciava la card senza genere per sempre.
      const closer = pick(isCloserLabel, deriveCloser(files.map((f) => f.path)));
      const kind = pick(isKindLabel, deriveKind(files));
      if (!closer && !kind) return null;

      const ts = now();
      const tx = db.transaction(() => {
        const del = db.prepare("DELETE FROM task_labels WHERE task_id = ? AND label = ?");
        const ins = db.prepare(
          "INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, 'derived', ?)",
        );
        // Tutta la famiglia, non la sola gemella: una `decisione` rimasta addosso
        // accanto a una `visibile` nuova sarebbe una card con due risposte alla
        // stessa domanda, e vale identico per due generi insieme.
        if (closer) {
          for (const l of CLOSER_LABELS) del.run(taskId, l);
          ins.run(taskId, closer, ts);
        }
        if (kind) {
          for (const l of KIND_LABELS) del.run(taskId, l);
          ins.run(taskId, kind, ts);
        }
      });
      tx();
      return rowToTask(getTaskRow(taskId));
    },

    recordDelivery({ taskId, branch, commit, stat }): void {
      // A new delivery invalidates any previous verdict: re-audit from scratch
      // rather than leave a stale "landed" on top of fresh, unlanded commits.
      // La TESTIMONIANZA cade con lui: era su un'altra consegna.
      //
      // E CADE ANCHE LA MISURA. Il conteggio di file e righe descrive UNA
      // consegna: lasciarlo su una consegna nuova non misurata farebbe leggere
      // sulla card i numeri del lavoro di prima, che è peggio del non saperlo.
      // Per questo `stat` assente scrive NULL invece di lasciare il valore
      // vecchio: un dato che non si aggiorna insieme al suo soggetto mente.
      db.prepare(
        "UPDATE tasks SET delivery_branch = ?, delivery_commit = ?, landing_state = NULL, " +
        "landing_checked_at = NULL, landing_witnessed = 0, " +
        "delivery_files_changed = ?, delivery_insertions = ?, delivery_deletions = ? WHERE id = ?",
      ).run(
        branch || null, commit || null,
        stat?.filesChanged ?? null, stat?.insertions ?? null, stat?.deletions ?? null,
        taskId,
      );
    },

    setDeliveryStat({ taskId, filesChanged, insertions, deletions }): boolean {
      // SOLO I NUMERI, e SOLO se non ci sono. Stessa ragione di
      // `setDeliveryBranch`: l'invariante di `recordDelivery` («un dato che non
      // si aggiorna insieme al suo soggetto mente») serve a impedire che i
      // numeri di una consegna restino su quella dopo. Qui la consegna non
      // cambia — si sta solo misurando quella che c'è già — quindi passare da
      // `recordDelivery` sarebbe distruttivo per due motivi:
      //   · azzera `landing_state`, `landing_checked_at` e `landing_witnessed`,
      //     cioè butta via il verdetto testimoniato a ogni passata di backfill;
      //   · con `stat` non misurabile scrive NULL sopra numeri buoni.
      // La condizione `IS NULL` nella WHERE è la seconda cintura: anche chiamata
      // per sbaglio su una card già misurata, questa non la tocca.
      const r = db.prepare(
        "UPDATE tasks SET delivery_files_changed = ?, delivery_insertions = ?, delivery_deletions = ? " +
        "WHERE id = ? AND delivery_files_changed IS NULL",
      ).run(filesChanged, insertions, deletions, taskId);
      return r.changes > 0;
    },

    setDeliveryBranch(taskId: string, branch: string): void {
      // Scrive SOLO delivery_branch, senza toccare commit, diffstat o
      // landing_state. L'invariante di recordDelivery (un dato non aggiornato
      // insieme al suo soggetto mente) non si applica qui: non ci sono nuovi
      // dati da scrivere, solo un indirizzo da conservare prima che la cartella
      // sparisca. Toccare commit/diffstat/landing_state sarebbe distruttivo.
      db.prepare("UPDATE tasks SET delivery_branch = ? WHERE id = ?").run(branch, taskId);
    },

    listLandingAuditCandidates() {
      // La TESTIMONIANZA vale per «è atterrato», e solo per quello: il contenuto
      // che è su main ci resta, quindi ricontrollarlo sarebbe rimettere una
      // deduzione sopra un fatto. «NON è atterrato» invece è un fatto su un
      // ISTANTE — il land che non è riuscito — e nulla dice del giorno dopo, in
      // cui una persona può aver cherry-piccato quel lavoro a mano. Escluderlo
      // per sempre dall'audit congela l'accusa: misurate il 13/08 due card che
      // dicevano «non su main» col commit ANTENATO di main, e in Done da giorni.
      //
      // E POI C'È IL SECONDO INSIEME, che è l'opposto del primo: le card senza
      // consegna registrata che portano GIÀ un'accusa. Senza commit non c'è
      // niente da verificare, ed era il motivo del filtro; ma `markLandPending`
      // timbra `unlanded` appena il land viene CHIESTO, e conta su questa
      // passata per correggersi. Finché il filtro le teneva fuori, quel timbro
      // era definitivo: misurate il 18/08 su topics-app 13 card ferme su «non è
      // su main» senza consegna, la più vecchia da sei giorni, due delle quali
      // avevano il merge del land su main. Un'accusa che nessuno può più
      // sostenere si RITIRA, ed è lavoro dell'audit tanto quanto scriverla.
      return db.prepare(
        `SELECT id, project_id, delivery_branch, delivery_commit
           FROM tasks
          WHERE archived = 0
            AND (delivery_commit IS NOT NULL OR landing_state = 'unlanded')
            AND status IN ('review', 'done')
            AND NOT (COALESCE(landing_witnessed, 0) = 1 AND landing_state = 'landed')`,
      ).all().map((r: any) => ({
        id: r.id,
        projectId: r.project_id,
        deliveryBranch: r.delivery_branch ?? null,
        deliveryCommit: r.delivery_commit ?? null,
      }));
    },

    recordLandingState({ taskId, state, checkedAt, witnessed }): void {
      // `witnessed` si ALZA e non si abbassa da qui: solo una riconsegna lo
      // riporta a zero. Una passata periodica che scrivesse `0` sopra un
      // verdetto osservato lo declasserebbe a deduzione, cioè annullerebbe il
      // punto — quindi il parametro assente NON è «no».
      db.prepare(
        "UPDATE tasks SET landing_state = ?, landing_checked_at = ?" +
        (witnessed ? ", landing_witnessed = 1" : "") + " WHERE id = ?",
      ).run(state, checkedAt, taskId);
    },

    settleLanded({ taskId, by, reason }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      const live = row.status !== "done" || row.dispatch_state !== null || row.dispatch_deferred_until !== null;
      if (!live) return rowToTask(row); // già ferma e chiusa: niente da dire
      const ts = now();
      // IL CANCELLO SUI FIGLI APERTI VALE ANCHE QUI, ed era l'unica porta che lo
      // saltava. `update()` e `reviewDecision` rifiutano `done` su un padre con
      // step aperti perché è uno stato che la board non sa raccontare: la
      // checklist resta appesa sotto una card chiusa, fuori da ogni colonna
      // (il feed è `rootsOnly`), e quel lavoro non lo riprende più nessuno.
      // Questa porta scrive `done` a SQL grezzo, quindi il controllo non lo
      // incontrava: «Landa su main» chiudeva il padre e orfanava i suoi passi.
      //
      // Non chiudere però non vuol dire non fare niente: il merge È avvenuto.
      // Si spegne il chip e la finestra di ri-tentativo — è da lì che la card
      // torna claimabile, e un agente ripartirebbe a rifare ciò che sta già su
      // main — e la card resta dov'è. Il RESOCONTO è di chi ha chiesto il land
      // (`landTask` scrive nel thread quali passi la tengono aperta): qui non si
      // inventa una riga di storico per una transizione che non c'è stata.
      if (row.status !== "done" && hasActiveChildren(taskId)) {
        db.prepare(
          `UPDATE tasks SET dispatch_state = NULL, dispatch_error = NULL,
              dispatch_deferred_until = NULL, updated_at = ? WHERE id = ?`,
        ).run(ts, taskId);
        return rowToTask(getTaskRow(taskId));
      }
      // Il topic assegnato RESTA: è la chat in cui il lavoro è stato fatto, ed è
      // la stessa cosa che una card approvata in review si tiene. A fare danno
      // non era il legame, era il chip di dispatch vivo e la finestra di
      // ri-tentativo — da lì la card è claimabile e l'agente riparte.
      //
      // Chiudere è chiudere: questa porta scrive `done` a SQL grezzo, quindi le
      // due colonne che la board legge per raccontare la colonna vanno messe qui
      // a mano o restano quelle di prima. Una card ferma su `done` con
      // `reopened_actor` acceso e `done_actor` vuoto si legge «riaperta da
      // attilio» sopra una card chiusa: uno stato che `update()` non produce
      // mai, e che dice il contrario di quel che è successo.
      //
      // `COALESCE` e non un'assegnazione: se la card era già stata chiusa da una
      // persona, quel verdetto è suo e non lo si riscrive a nome del sistema.
      db.prepare(
        `UPDATE tasks SET status = 'done', completed_at = ?, dispatch_state = NULL,
            dispatch_error = NULL, dispatch_deferred_until = NULL,
            done_actor = COALESCE(done_actor, 'system'),
            reopened_at = NULL, reopened_by = NULL, reopened_actor = NULL,
            updated_at = ? WHERE id = ?`,
      ).run(row.completed_at ?? ts, ts, taskId);
      // La card è arrivata a `done`, che è ESATTAMENTE ciò che l'approvazione in
      // attesa chiedeva: `approved`. Senza questa riga il land lasciava una
      // richiesta `pending` su una card chiusa, che nessuno avrebbe più risolto
      // (il task non è più in review e `reviewDecision` lo rifiuta) — la stessa
      // perdita che la migration 068 ha dovuto ripulire.
      settleReviewApproval(taskId, "approved", by ?? "system", ts);
      if (row.status !== "done") logStatus(taskId, row.status, "done", by ?? "system", reason);
      return rowToTask(getTaskRow(taskId));
    },

    countUnlanded(projectId?: string): number {
      const sql =
        "SELECT COUNT(*) AS n FROM tasks WHERE archived = 0 AND landing_state = 'unlanded'" +
        (projectId ? " AND project_id = ?" : "");
      const r = (projectId ? db.prepare(sql).get(projectId) : db.prepare(sql).get()) as any;
      return r?.n ?? 0;
    },

    boardsWithQueuedTodos(): string[] {
      // Una `SELECT DISTINCT` sul taglio del tick — vive, in coda, radici — e
      // nient'altro. `rootsOnly` letterale come nel dispatcher: lì è una regola
      // di sicurezza (uno step non si dispaccia mai da solo), non di lettura.
      return (db.query(
        `SELECT DISTINCT project_id FROM tasks
          WHERE archived = 0 AND status = 'todo' AND parent_task_id IS NULL`,
      ).all() as Array<{ project_id: string }>).map((r) => r.project_id);
    },

    getGlobalAutoDispatch(): boolean {
      return readGlobalDispatch();
    },

    setGlobalAutoDispatch(on: boolean): boolean {
      try { db.prepare("UPDATE app_settings SET auto_dispatch = ?").run(on ? 1 : 0); } catch { /* schema minimo: vedi readGlobalDispatch */ }
      // Il tetto globale continua a vivere sulla riga '*': la si semina qui col
      // 2 esplicito, come prima, o accendere l'interruttore lo lascerebbe al
      // default 5 della colonna legacy.
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 2)").run(GLOBAL_SETTINGS_KEY);
      return readGlobalDispatch();
    },

    getGlobalCap(): { auto: boolean; max: number } {
      // Una lettura sola per due chiamanti: il tick del dispatcher e la quota di
      // core dello spawn (`agent-job-quota.ts`) devono leggere lo STESSO tetto,
      // NULL compreso — vedi `readGlobalCap`.
      return readGlobalCap(db);
    },

    setGlobalCap(patch: { auto?: boolean; max?: number }): { auto: boolean; max: number } {
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 3)").run(GLOBAL_SETTINGS_KEY);
      if (patch.auto !== undefined) {
        db.prepare("UPDATE board_settings SET max_agents_auto = ? WHERE project_id = ?").run(patch.auto ? 1 : 0, GLOBAL_SETTINGS_KEY);
      }
      if (patch.max !== undefined) {
        // `clampGlobalCap`, non `clampInt(…, 1, 20)`: lo zero di «nessun tetto»
        // deve arrivare al DB com'è. Il clamp a 1 lo trasformava nel tetto più
        // stretto possibile, cioè nell'impostazione opposta a quella chiesta.
        db.prepare("UPDATE board_settings SET max_agents = ? WHERE project_id = ?").run(clampGlobalCap(patch.max), GLOBAL_SETTINGS_KEY);
      }
      return this.getGlobalCap();
    },

    getBoardSettings(projectId: string): BoardSettings {
      const r = db.prepare("SELECT * FROM board_settings WHERE project_id = ?").get(projectId) as any;
      return {
        projectId,
        autoDispatch: readGlobalDispatch(),
        // Nessun tetto per board: quello vero è UNO solo e si legge con
        // `getGlobalCap()` (riga '*'). Vedi `BoardSettings` in shared/board.ts.
        dispatchEffort: r?.dispatch_effort ?? "medium",
        dispatchUseWorktree: r ? !!r.dispatch_use_worktree : true,
        dispatchAutoMerge: r ? !!r.dispatch_auto_merge : false,
        dispatchTimeoutMin: r?.dispatch_timeout_min ?? 20,
        dispatchMcp: r?.dispatch_mcp ?? "bridge-only",
        dispatchModel: r?.dispatch_model ?? "auto",
        language: r?.language ?? "inherit",
        // NULL = 1: una board che non ha mai sentito parlare di fan-out dispaccia
        // un agente per task, com'è sempre stato.
        dispatchFanOut: Math.max(1, r?.dispatch_fanout ?? 1),
        dispatchRetryCap: r?.dispatch_retry_cap ?? 2,
        dispatchRetryBackoffS: r?.dispatch_retry_backoff_s ?? 60,
        requireApprovalForDone: r ? !!r.require_approval_for_done : false,
        requireReviewBeforeDone: r ? !!r.require_review_before_done : false,
        reviewChecks: parseReviewChecks(r?.review_checks),
        // Assente o illeggibile = NON in pausa: e' il verso giusto in cui
        // sbagliare, perche' l'errore opposto fermerebbe in silenzio una coda
        // che nessuno ha chiesto di fermare.
        dispatchPaused: r ? !!r.dispatch_paused : false,
        nightMode: r ? !!r.night_mode : false,
        nightModeUntil: r?.night_mode_until ?? "",
        nightModeStartedAt: r?.night_mode_started_at ?? null,
      };
    },

    updateBoardSettings(projectId: string, patch: UpdateBoardSettingsPatch): BoardSettings {
      if (!projectId) throw new TaskServiceError("invalid_input", "projectId is required");
      if (patch.dispatchEffort !== undefined && !VALID_EFFORT.has(patch.dispatchEffort)) {
        throw new TaskServiceError("invalid_input", `invalid effort "${patch.dispatchEffort}"`);
      }
      if (patch.dispatchMcp !== undefined && !VALID_DISPATCH_MCP.has(patch.dispatchMcp)) {
        throw new TaskServiceError("invalid_input", `invalid dispatchMcp "${patch.dispatchMcp}"`);
      }
      // Ensure a row exists. `max_agents` is seeded, never patched: on a project
      // row the column is DEAD (no reader — the one cap lives on the '*' row),
      // and the explicit 2 only matters when `projectId` IS the reserved '*'
      // key, where it must land on the same global default as
      // `setGlobalAutoDispatch` instead of the legacy column default of 5.
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 2)").run(projectId);
      // autoDispatch e' l'interruttore GLOBALE: si scrive in `app_settings`, cosi'
      // ribaltarlo da una board qualsiasi (o dalla board globale) lo ribalta
      // ovunque. Prima finiva sulla riga riservata '*' di questa stessa tabella,
      // ed e' quella convivenza che rendeva credibile lo zero delle altre righe.
      if (patch.autoDispatch !== undefined) {
        try { db.prepare("UPDATE app_settings SET auto_dispatch = ?").run(patch.autoDispatch ? 1 : 0); } catch { /* schema minimo: vedi readGlobalDispatch */ }
        // La riga '*' si materializza lo stesso, e non e' un residuo: e' dove
        // vive il TETTO globale, e nasce col 2 esplicito. Senza, accendere
        // l'interruttore lascerebbe il tetto al default della colonna legacy
        // (5), cioe' un ON alzerebbe di sua iniziativa il numero di agenti che
        // la macchina si prende. L'auto-dispatch ha traslocato, il tetto no.
        db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 2)").run(GLOBAL_SETTINGS_KEY);
      }
      const sets: string[] = [];
      const params: any[] = [];
      // Nessun `max_agents` / `max_agents_auto` qui: il tetto si scrive con
      // `setGlobalCap` sulla riga '*', ed è l'unico che decide qualcosa.
      if (patch.dispatchEffort !== undefined) { sets.push("dispatch_effort = ?"); params.push(patch.dispatchEffort); }
      if (patch.dispatchUseWorktree !== undefined) { sets.push("dispatch_use_worktree = ?"); params.push(patch.dispatchUseWorktree ? 1 : 0); }
      if (patch.dispatchAutoMerge !== undefined) { sets.push("dispatch_auto_merge = ?"); params.push(patch.dispatchAutoMerge ? 1 : 0); }
      if (patch.dispatchTimeoutMin !== undefined) { sets.push("dispatch_timeout_min = ?"); params.push(clampInt(patch.dispatchTimeoutMin, 1, 120)); }
      if (patch.dispatchMcp !== undefined) { sets.push("dispatch_mcp = ?"); params.push(patch.dispatchMcp); }
      // 'auto' (or empty) collapses to NULL so the classifier keeps picking; any other
      // string pins the board to that model id. No allowlist here — the model set is
      // provider-driven (see /api/claude/models); an unknown id simply fails at spawn.
      if (patch.dispatchModel !== undefined) { sets.push("dispatch_model = ?"); params.push(patch.dispatchModel && patch.dispatchModel !== "auto" ? patch.dispatchModel : null); }
      if (patch.language !== undefined) { sets.push("language = ?"); params.push(patch.language && patch.language !== "inherit" ? patch.language : null); }
      // Tetto a 5: oltre, il fan-out non è più "confronto fra alternative" ma un
      // modo di saturare la macchina — e ogni tentativo è un agente vero che
      // occupa uno slot del tetto globale.
      if (patch.dispatchFanOut !== undefined) { sets.push("dispatch_fanout = ?"); params.push(clampInt(patch.dispatchFanOut, 1, MAX_FANOUT)); }
      // Accendere la modalità notturna STAMPA l'istante: senza, «fino alle
      // 10:00» non si sa se sia stamattina o domani mattina. Spegnendola si
      // cancella, così un riaccendere non eredita una scadenza vecchia.
      if (patch.dispatchPaused !== undefined) {
        sets.push("dispatch_paused = ?"); params.push(patch.dispatchPaused ? 1 : 0);
      }
      if (patch.nightMode !== undefined) {
        sets.push("night_mode = ?"); params.push(patch.nightMode ? 1 : 0);
        sets.push("night_mode_started_at = ?"); params.push(patch.nightMode ? now() : null);
      }
      if (patch.nightModeUntil !== undefined) {
        const v = String(patch.nightModeUntil ?? "").trim();
        sets.push("night_mode_until = ?"); params.push(v || null);
      }
      if (patch.dispatchRetryCap !== undefined) { sets.push("dispatch_retry_cap = ?"); params.push(clampInt(patch.dispatchRetryCap, 1, 5)); }
      if (patch.dispatchRetryBackoffS !== undefined) { sets.push("dispatch_retry_backoff_s = ?"); params.push(clampInt(patch.dispatchRetryBackoffS, 10, 600)); }
      // NULL, non `[]`: "gate spento" è UNO stato solo, e due modi di scriverlo
      // sono due modi di leggerlo sbagliato.
      if (patch.reviewChecks !== undefined) { sets.push("review_checks = ?"); params.push(serializeReviewChecks(patch.reviewChecks)); }
      if (sets.length) db.prepare(`UPDATE board_settings SET ${sets.join(", ")} WHERE project_id = ?`).run(...params, projectId);
      return this.getBoardSettings(projectId);
    },
  };
}
