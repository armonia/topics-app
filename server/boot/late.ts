/**
 * Bindings that are read by a stage BEFORE the stage that builds them has run.
 *
 * In one file this was free: a closure written near the top named a `const` or `let` declared a
 * thousand lines lower, and read it when it was called, long after the file had finished
 * evaluating. Across stage modules the earlier stage cannot name what a later one returns, so
 * those few bindings live here: typed up front, empty until the stage that owns them assigns them,
 * read through `late.<name>` only from code that runs after boot.
 *
 * Two kinds:
 *  - the hooks a later stage fills in (delivery capture, the checks gate, the preview manager, ...),
 *    which start empty exactly as their `let` did;
 *  - `taskDispatcher` and `resumeCtx`, built in their own stage and assigned right after.
 */
import type { ChatGoalLoop } from "../services/goal-continuation";
import type { AnswerRelay } from "../lib/answer-relay";
import type { PreviewManager } from "../services/preview-manager";
import type { DeliveryCapture } from "../services/task-delivery-capture";
import type { BootedExternalProxy } from "../services/external-proxy";
import type { CtxRipresa } from "../lib/ripresa-boot";
import type { createTaskDispatcher } from "../services/task-dispatcher";

export const late = {
  scheduledCardTestNow: null as Date | null,
  // Assigned just below (after worktreeOfTask is defined); the dispatcher only
  // calls it lazily at review-time, so the late binding is safe.
  previewManager: undefined as PreviewManager | undefined,
  /** The dispatcher's resource floor, for chat previews (lazy: read when one is about to start). */
  resourceBlock: undefined as (() => string | null) | undefined,
  /**
   * Assegnata piu' in basso, dov'e' possibile costruirla (servono gli sguardi sul
   * worktree). Il dispatcher nasce prima e la chiama solo a turno finito, quindi
   * il riferimento in avanti e' sicuro: prima di allora non c'e' nessun turno.
   */
  capturaConsegna: null as DeliveryCapture | null,
  /**
   * Assigned where the tasks router exists. The dispatcher's node lane calls it
   * once a delivery planted from another machine is in review (its bar is
   * measured on a throwaway checkout, then the card is offered to the automatic
   * land). Forward reference, same reasoning as `capturaConsegna`.
   */
  misuraConsegnaNodo: null as ((taskId: string) => Promise<void>) | null,
  /**
   * I file lasciati nel worktree e mai committati, per la consegna forzata.
   *
   * Tardiva come `capturaConsegna` e per la stessa ragione: `worktreeOfTask`
   * nasce piu' in basso di queste deps. La usa il dispatcher SOLO quando la
   * storia di git e' vuota, per non far dire alla card «nessun file toccato»
   * mentre il lavoro sta sul disco.
   */
  sondaLavoroNonCommittato: null as ((taskId: string) => Promise<string[] | null>) | null,
  /**
   * Quante corse di check pre-review stanno girando adesso.
   *
   * Il dispatcher viene costruito PRIMA della rotta dei task (che e' la closure
   * che tiene il `checksGate`). Il riferimento in avanti e' sicuro per lo stesso
   * motivo di `capturaConsegna`: il dispatcher chiama `checksRunning` solo dentro
   * il tick o il resume, che sono entrambi dopo la costruzione della rotta. Zero
   * finche' non esiste: un conteggio assente vale «nessuno», mai un'eccezione
   * dentro un tick.
   *
   * Questo e' il collegamento che chiude il freno: prima mancava, e sei card che
   * consegnavano nello stesso quarto d'ora lanciavano sei barre di check in
   * parallelo. Con `test:unit` da solo a 322s e piu' core, il loadavg andava a
   * 78,83 su 12 core.
   */
  checksGateRunningCount: null as (() => number) | null,
  /** `checksGate.isRunning(taskId)`: running OR queued behind another card's run. */
  checksGateIsRunning: null as ((taskId: string) => boolean) | null,
  /** `checksGate.isOffLane(taskId)`: the run only waits on the pull request CI (KANBAN-84). */
  checksGateIsOffLane: null as ((taskId: string) => boolean) | null,
  /** `settleDelivery` of the tasks route: re-issues the PATCH this process is
   *  still holding for a card. Null until the route is built. */
  resumeHeldDelivery: null as ((taskId: string) => void) | null,
  // The user's `turn-end` hook reaches the chat route from here (HOOKS-02).
  goalLoop: null as ChatGoalLoop | null,
  // Set by the router below, synchronously: `as` keeps TS from reading it as always null.
  answerRelay: null as AnswerRelay | null,
  externalProxy: null as BootedExternalProxy | null,
  // Set by gracefulShutdown: a boot that finishes after it must close itself.
  externalProxyStopped: false,
  // A re-armed timeout rather than a setInterval: the e2e bench shortens the pass
  // interval (`setBenchStaleTick`) and the change must take effect at once.
  staleStreamTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  /**
   * Some caller asked this restart "at zero turns" (a land: RGATE-09). Sticky for
   * the life of the process, and read on every lap of the ONE shared wait: an ask
   * that joins a wait already running must still be able to stop it from cutting
   * a chat, and nothing un-asks a land.
   */
  restartAtZeroTurns: false,
  // Built later than the closures that read them; the stage that owns each assigns it right after it is declared.
  taskDispatcher: undefined as unknown as ReturnType<typeof createTaskDispatcher>,
  resumeCtx: undefined as unknown as CtxRipresa,
};
