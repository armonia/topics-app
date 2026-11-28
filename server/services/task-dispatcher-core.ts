/**
 * task-dispatcher-core.ts: the state every part of the dispatcher shares.
 * 
 * Built from `deps` alone, before any other part runs: the maps and sets that
 * record what is in flight, held or waiting, the mutable counters gathered in
 * `state`, and the small config helpers (retry cap, backoff, delegated policy).
 * Other parts read these members from the shared context.
 */
import { type Task } from "./tasks";
import { type AdmissionVerdict, type BudgetGateState } from "../../shared/board";
import { decideNight, deadlineFrom } from "./night-mode";
import { type ResourceFloorKind } from "./dispatch-capacity";
import { NoCheckExemptionLedger } from "./dispatch-no-check-exemption";
import type { DelegatedRunPolicy } from "../lib/delegated-agent-start";
import type { DispatcherDeps } from "./task-dispatcher-types";
import { DEFAULT_RETRY_CAP, dispatcherLogLine } from "./task-dispatcher-support";
import type { RunSlot, TaskLedger, LiveTurn } from "./task-dispatcher-context";

export function createDispatcherCore(deps: DispatcherDeps) {

  /**
   * Lo STATO della modalità notturna per una board, calcolato una volta sola.
   *
   * Esiste perché l'interfaccia deve poter dire «non parte niente, ed ecco
   * perché» — e se lo calcolasse per conto suo potrebbe dire una cosa diversa da
   * quella che il dispatcher fa davvero. Qui il gate del `tick` e la card delle
   * impostazioni leggono LA STESSA riga di codice: l'unico modo perché non
   * possano contraddirsi.
   *
   * Puro rispetto al mondo: legge orologio, carico e sessioni vive, non scrive
   * niente. Lo spegnimento allo scadere resta del `tick`, che è l'unico che ha
   * il diritto di cambiare le impostazioni.
   */
  function evaluateNight(settings: { nightMode?: boolean; nightModeUntil?: string | null; nightModeStartedAt?: string | null }): {
    decision: ReturnType<typeof decideNight>;
    load1: number;
    cores: number;
    busySessions: number;
    /** Millisecondi mancanti alla fine, o null se non c'è un orario di fine. */
    endsInMs: number | null;
  } {
    const cap = deps.capacity?.();
    const load1 = cap?.load1 ?? 0;
    const cores = cap?.cores ?? 1;
    // Le sessioni umane vive: è il «sono via» del turno. Assente ⇒ 0, cioè
    // si guarda solo il carico — meno preciso, mai più permissivo del
    // dovuto perché il carico resta comunque un gate.
    const busySessions = deps.humanSessionsLive?.() ?? 0;
    const now = new Date();
    const startedAt = settings.nightModeStartedAt ? new Date(settings.nightModeStartedAt) : null;
    const untilHHMM = settings.nightModeUntil || null;
    const decision = decideNight({
      enabled: !!settings.nightMode,
      untilHHMM,
      startedAt,
      now,
      load1,
      cores,
      busySessions,
    });
    const dl = untilHHMM ? deadlineFrom(startedAt ?? now, untilHHMM) : null;
    return {
      decision,
      load1,
      cores,
      busySessions,
      endsInMs: dl ? Math.max(0, dl.getTime() - now.getTime()) : null,
    };
  }

  const graceMs = deps.graceMs ?? 6000;
  const log =
    deps.log ??
    ((m: string, e?: unknown) => (e ? console.error(dispatcherLogLine(m), e) : console.log(dispatcherLogLine(m))));

  // Per-board retry economy (migration 050). A test override on
  // deps.retryBackoffMs wins so harness turns stay instant; otherwise both come
  // from board_settings, with a safe fallback if the read throws.
  function retryCap(projectId: string): number {
    try { return deps.svc.getBoardSettings(projectId).dispatchRetryCap; } catch { return DEFAULT_RETRY_CAP; }
  }
  function backoffMs(projectId: string): number {
    if (deps.retryBackoffMs !== undefined) return deps.retryBackoffMs;
    try { return deps.svc.getBoardSettings(projectId).dispatchRetryBackoffS * 1000; } catch { return 60_000; }
  }

  /** `undefined` is an ordinary owner run; `null` is a marked run that failed closed. */
  function delegatedPolicy(task: Task): DelegatedRunPolicy | null | undefined {
    const policy = deps.delegatedPolicyForTask?.(task.id) ?? null;
    if (policy) {
      if (task.delegatedStartCapabilityId && policy.id !== task.delegatedStartCapabilityId) return null;
      return policy;
    }
    const boundOnNode = (() => {
      try { return deps.isDelegatedTask?.(task.id) === true; } catch { return true; }
    })();
    return task.delegatedStartCapabilityId || boundOnNode ? null : undefined;
  }

  function attemptCap(task: Task): number {
    return delegatedPolicy(task) ? 1 : retryCap(task.projectId);
  }

  function recordDelegated(taskId: string, phase: Parameters<NonNullable<DispatcherDeps["recordDelegatedPhase"]>>[0]["phase"], input: {
    executionSessionId?: string | null;
    outcome?: string | null;
  } = {}): void {
    try { deps.recordDelegatedPhase?.({ taskId, phase, ...input }); } catch { /* audit never opens authority */ }
  }

  function beginDelegated(
    task: Task,
    phase: "dispatch" | "resume",
    executionSessionId?: string,
  ): number | undefined {
    const policy = delegatedPolicy(task);
    if (policy === undefined) return undefined;
    if (policy === null) throw new Error("delegated_authority_invalid");
    if (!deps.recordDelegatedPhase) throw new Error("delegated_begin_unavailable");
    const deadlineAt = deps.recordDelegatedPhase({ taskId: task.id, phase, executionSessionId });
    if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
      throw new Error("delegated_begin_not_persisted");
    }
    return deadlineAt;
  }

  const livenessGraceMs = deps.livenessGraceMs ?? 60_000;

  // Pending debounced launches, keyed by taskId (the grace window).
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Chi ha già detto nel thread che sta aspettando uno slot, e per QUALE attesa
   *  (`holdKey`): una volta basta finché l'attesa è la stessa. */
  const waitingForSlot = new Map<string, string>();
  /** What each held resume last wrote on its chip, and when (clock ms): see `HELD_RESUME_REFRESH_MS`. */
  const heldWritten = new Map<string, { at: number; key: string; reason: string | null }>();
  const admissionCountingSince = Date.now();
  /**
   * Errori del PROVIDER di fila su un task, per non fargli pagare i tentativi.
   *
   * `consumesAttempt` dice `true` per ogni `error`, e il tetto è 2: due
   * singhiozzi del provider uccidono una card che non ha ancora scritto una
   * riga. Misurato il 10/08: durante una raffica di dispatch paralleli, VENTI
   * task sono finiti in review a mano vuote — «Errore del provider: riprovo tra
   * 60s (tentativo 2/2)» e poi consegna forzata. Lavoro zero, review sporca, e
   * i token dello spawn pagati due volte per niente.
   *
   * Non è gratis all'infinito, o un'interruzione lunga girerebbe per sempre: i
   * primi `FREE_PROVIDER_ERRORS` non contano (col backoff che c'è già), dal
   * successivo si torna a pagare. Il contatore si azzera al primo turno che NON
   * muore per errore — è una raffica che si perdona, non un guasto cronico.
   * Sta in memoria di proposito: un riavvio ri-pianifica comunque.
   */
  const providerErrors = new Map<string, number>();
  // In-flight launches, keyed by taskId — presence means "a turn is running or
  // being set up for this task"; keeps reconcile/tick from double-launching.
  const inFlight = new Map<string, RunSlot>();
  const noCheckExemptions = new NoCheckExemptionLedger();

  /**
   * Le attese di uno slot VIVE in questo processo: taskId → timer del ritentativo.
   *
   * Un resume rinviato a tetto pieno non ha un turno, quindi non lascia traccia
   * in `inFlight`: la card resta `in_progress` col chip `queued` e l'unica cosa
   * che la tiene in piedi è un `setTimeout` in memoria. Il recupero orfani di
   * `reconcile` recupera anche `queued` (per le attese che un riavvio si è
   * portato via), e senza questo registro non saprebbe distinguere le due: si
   * mangerebbe anche quelle vive, buttando via il messaggio dell'umano che quel
   * timer ha in mano e facendo ripartire la card su un topic nuovo.
   *
   * Sta in memoria ACCANTO a `inFlight` e per la stessa ragione: un riavvio
   * perde il timer e il registro INSIEME: e a quel punto la card è orfana
   * davvero, ed è giusto che `reconcile` la rimetta in coda.
   *
   * Invariante: un'attesa sola per task (chi arriva mentre una è in corso
   * imbuca il messaggio in `pendingResume`), così la voce del registro c'è
   * esattamente finché c'è un timer pendente.
   */
  const slotWaits = new Map<string, { timer: ReturnType<typeof setTimeout>; message: string; commentIds?: string[] }>();
  /** Cards already told "dispatch off, session kept": one note per hold, not per poll. */
  const heldOffNoted = new Set<string>();

  /**
   * LE ATTESE DI BACKOFF, per la stessa ragione esatta di `slotWaits`.
   *
   * Quando un turno cade su un guasto ricuperabile, `onTurnEnd` programma il
   * ritentativo con un `setTimeout(backoff)` e lo annuncia sulla card («riprovo
   * tra 60s»). Ma quel timer non TRATTIENE niente: il `finally` del chiamante
   * libera lo slot `inFlight` subito dopo, e da quel momento la card e' una riga
   * `in_progress` con chip `working` e nessun turno vivo — cioe' indistinguibile
   * da un orfano di riavvio per il giro di `reconcile`, che gira ogni
   * `DISPATCH_POLL_MS` (10 secondi).
   *
   * Risultato misurato il 18/08 sul DB vivo: 504 note «La sessione stava gia'
   * rispondendo: turno non avviato: riprovo tra 60s» su 12 card. Gli istanti di
   * quattro consecutive su `d636cfbf`: 12:43:46, 12:43:59, 12:44:09, 12:44:19 —
   * 13, 10, 10 secondi, cioe' il POLL, non il backoff. Ogni giro sveglia una
   * sessione che sta davvero rispondendo, si prende un 409, scrive la nota e
   * programma un ALTRO timer: le catene si accumulano finche' il turno vero non
   * finisce.
   *
   * Non e' solo rumore nel thread: ogni giro e' una chiamata alla front-door
   * pagata per farsi dire di no, e il conto sale col numero di agenti.
   *
   * Come `slotWaits`: vive in memoria ACCANTO a `inFlight`, e un riavvio perde
   * il timer e il registro insieme — a quel punto la card e' orfana davvero ed e'
   * giusto che `reconcile` la riprenda.
   */
  const retryWaits = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * THE CARDS WAITING FOR A COMMAND'S WAKE.
   *
   * `run_command` wakes the topic when the command ends
   * (`lib/process-exit-wake.ts`). A board agent is told to wait for it inside
   * its turn (`longCommandsRule`); this is the net for one that ends the turn
   * on it anyway. Read as an interrupted turn, that end got a nudge over the
   * running command and cost an attempt: with the default cap of 2 the card
   * was parked «failed» before the command ended (both verifiers of 28/09 at
   * 0252f6ea5). The wait is the
   * one the goal loop keeps for the same wake (`backgroundOfTurn`), bounded
   * like the CLI's own background work. `since` is when the session last went
   * quiet; the poll ends the wait (`pollCommandWaits`).
   *
   * In memory like `retryWaits`: after a restart `reconcile` finds the card
   * still owed a wake and waits again (`awaitCommandWake`), from the session's
   * last chat row. From the boot, the cap never fired on this machine, whose
   * server reloads at every save in server/.
   */
  const commandWaits = new Map<string, { sessionKey: string; since: number }>();
  // Tasks already told "il repo è occupato da una sessione esterna" during the
  // CURRENT hold episode — cleared when the repo frees, so a later hold can
  // note again without spamming one comment per 10s reconcile poll.
  const externallyHeldNoted = new Set<string>();
  // Task a cui si è già detto "aspetti perché la macchina è impegnata da un
  // task pesante / è troppo carica". Stessa disciplina dell'insieme qui sopra:
  // una nota per EPISODIO, non una per poll — si svuota appena l'attesa finisce.
  const heavyHeldNoted = new Set<string>();
  // Task a cui si è già detto "aspetti perché il tetto di concorrenza è pieno".
  // Stessa disciplina: una nota per EPISODIO. Si svuota nel giro in cui il tetto
  // torna a lasciar passare quella card, così la prossima pienezza lo ridice.
  const capHeldNoted = new Set<string>();
  // Tasks already told "you are over the spend cap". Same discipline as the sets
  // above, with one difference that matters: this wait does not end by itself.
  // The cap is raised (or the card is closed) by a person, so the note is
  // forgotten only when the card really starts again, and in the meantime it is
  // not repeated at every poll.
  const spendHeldNoted = new Set<string>();
  // Same discipline, for the project quota brake (limiti-consumo-progetto, USAGE-29). allow-italian: openspec change name
  // The pause is lifted by a person's own choice, not by this process on its
  // own, so the note stays until the card really starts.
  const projectPauseHeldNoted = new Set<string>();
  // Tasks already logged "remote claim declined". Same discipline: ONE line per
  // episode, not one per tick. The remote claim is a plain `log`, not a thread
  // comment (it is for an operator reading the server log, not the card), but
  // the dispatcher ticks every ten seconds and a silent CAS refusal otherwise
  // repeats forever for a card held by `blocked_by` or a deferral.
  const remoteClaimDeclinedNoted = new Set<string>();
  // Tasks already told "the machine is under the floor" / "the daily spend cap
  // is reached", and WHICH wait they were told about (`holdKey`). Same
  // discipline as the sets above: one line per EPISODE, not one per 10s poll - a
  // full disk would otherwise write a thousand rows in the thread. Emptied in
  // the round the block lifts, and the entry decays when the wait CHANGES: a
  // card noted under the 120 s warm-up used to get nothing when the real floor
  // sentence replaced it, so the reason never arrived.
  const floorHeldNoted = new Map<string, string>();
  // The machine block each held Todo card was last SENT with (its `holdKey`, its
  // sentence, when), so the tick re-sends the card only when that changes, and
  // once more when the block lifts. See the floor branch of `tick`.
  const floorBlockSent = new Map<string, { key: string; reason: string; at: number }>();
  // Tasks already told "the provider's wall is days away, this is a spent plan".
  // Same discipline as `spendHeldNoted`, and for the same reason: this wait does
  // not end by itself inside any horizon a person would wait through, so the
  // note is forgotten only when that card's hold really lifts.
  //
  // WITHIN THIS PROCESS ONLY, which is why this note also carries a thread slot
  // (`noteHold`'s `slot`): the wait it describes is measured in DAYS and the
  // process restarts every 35 minutes on this machine, so the set is empty
  // again long before the condition is.
  const planHeldNoted = new Set<string>();
  // Da QUANDO un task pesante è trattenuto dal carico (ms). Serve al tetto
  // dell'attesa (`HEAVY_HOLD_MAX_MS`): senza un istante di inizio «trattenuto da
  // troppo» non è una condizione misurabile, è un'impressione. Si azzera appena
  // il task parte o smette di essere trattenuto, così una prossima attesa
  // riparte dal suo inizio invece di ereditare quella di ieri.
  const heavyHoldSince = new Map<string, number>();
  /** L'orologio del freno, iniettabile per i test (vedi `DispatcherDeps.now`). */
  const clock = (): number => deps.now?.() ?? Date.now();
  // The local Todo cards this machine's memory floor is holding right now, and
  // the board round that last marked each of them held. The overflow no longer
  // waits out a hold (a free seat elsewhere is taken at once), so no duration
  // is kept: what is left of the record is which cards are held, which keeps
  // the carried-branch answers (`overflowBranch`) alive only for them.
  const memoryHeldCards = new Map<string, { projectId: string; round: number }>();
  /** Per board: how many dispatch rounds have begun. Bumped first thing, before any early return. */
  const overflowRounds = new Map<string, number>();
  // Per project: does it have the git origin the remote lane finds it by (a card
  // moved without one would be parked over there), and is that origin on GitHub
  // (the only host Cloud Claude clones from: elsewhere it refuses the run and the
  // card lands in review with `cloud_refused`)? Read asynchronously, so the first
  // tick that asks only starts the lookup; re-read every ten minutes.
  const overflowOrigin = new Map<string, { ok: boolean; github: boolean; at: number }>();
  const overflowOriginPending = new Set<string>();
  // Per card: is its own delivery branch on origin (pushed now if this checkout
  // is ahead)? A card that already has a branch runs over there FROM it
  // (`CreateRunBody.baseBranch`), so a branch origin cannot get keeps the card
  // here. Asked once the two minutes are up, re-asked after a minute.
  const overflowBranch = new Map<string, { branch: string; ok: boolean; reason: string; at: number }>();
  const overflowBranchPending = new Set<string>();
  // Board a cui si è già detto "il fan-out qui non si applica" (worktree off).
  // È una configurazione, non un evento: ripeterlo a ogni dispatch sarebbe rumore.
  const fanOutBlockedNoted = new Set<string>();
  // Human input that arrived while a turn was still winding down (the window
  // between the agent's →review and the actual turn end). Buffered here and
  // delivered on the SAME tab at turn end — dropping it would strand the task
  // in_progress and the reconciler would respawn a fresh agent without context.
  //
  // ONLY WORDS SOMEBODY WROTE GO IN HERE. The buffer carries the moment they
  // were written because it is what the note has to say when the message is
  // handed over much later: on 2026-09-04 a card was reopened at 04:36 for a
  // sentence typed at 03:52, and without the hour the reopen reads as a verdict
  // on the delivery instead of the delayed hand-over it is.
  //
  // The buffer also carries the ids of the CARD COMMENTS the words came from,
  // when they came from some. Those ids ride the envelope to the row
  // (`commentIds`) so a reader can tell that these words are already in the
  // thread, and draw them once instead of twice.
  //
  // ALL OF THEM, NOT THE FIRST. A review rejection hands `resume` every comment
  // it is delivering, and the buffer used to keep `commentIds[0]`. The ids are
  // what `pendingHumanReopen` reads to answer "has the agent ever seen these
  // words": with only the first one recorded, objections two and three stayed
  // "never delivered" forever, so every later re-adoption of the card started
  // by re-delivering text the agent had already read.
  const pendingResume = new Map<string, { text: string; at: number; commentIds: string[] }[]>();
  const usageLedgers = new Map<string, TaskLedger>();
  const liveTurns = new Map<string, LiveTurn>();

  /**
   * Turns that ended in the last minute. The poll reconcile runs every 10 s
   * and looks for in_progress cards nobody owns; a card whose turn JUST ended
   * is between `onTurnEnd` and the `resume` that re-registers it (slot wait,
   * retry wait, or a fresh run), and that gap is a few awaits wide. Read on
   * 2026-09-04: fourteen recycled cards got a "server restarted mid-turn"
   * note and a second resume from the poll, with no restart anywhere.
   */
  const recentlyEnded = new Map<string, number>();
  const RECONCILE_GRACE_MS = 60_000;
  const shared = {

  /** Da quale board comincia il prossimo giro: vedi `reconcile` (turnazione). */
    boardCursor: 0,

    resumeStagger: 0,

  /**
   * THE RAMP OF THE "BY RESOURCES" MODE, one clock for the whole dispatcher.
   *
   * It used to be a counter local to `tick(projectId)`, and three doors went
   * around it: every board has its own tick (three boards with todos admitted
   * three in one round), `reconcile` had no guard against itself (three
   * overlapping passes claimed three), and `resume` was left out on purpose
   * (a boot with sixteen cut turns started twelve at the same instant). The
   * instant of the last start is what every door reads now, a dispatch and a
   * resume alike (`ADMISSION_SPACING_MS`).
   */
    lastAdmissionAt: Number.NEGATIVE_INFINITY,

  /**
   * Il PAVIMENTO, letto ADESSO. Vive accanto al tetto e non dentro, perché sono
   * due risposte diverse: il tetto dice quanti se ne vogliono (e può dire
   * «quanti ne capitano»), questo dice quando la macchina non ne regge un altro
   * comunque. Da quando il tetto si può togliere, senza questo la coda si
   * fermerebbe solo a disco pieno — cioè quando il DB non scrive più.
   */
  /** L'ultimo esito del pavimento già annunciato, per non ripeterlo a ogni tick.
   *  `"exempt"` is a state of its own and not the absence of one: the reading is
   *  still under the line, and saying "le risorse sono rientrate" there is a lie
   *  on the one line the board's history is read from. */
    lastAdmissionBlock: null as ResourceFloorKind | "exempt" | null,

  /** The floor and the budget have each offered a derogation that no launch has used yet. */
    floorExemptPending: false,

    budgetExemptPending: false,

  /**
   * HOW LONG THE QUEUE WAS HELD, so it can be said with a number. It MEASURES
   * and nothing else: under the floor no card starts and `dispatchFanOut`
   * stays what it is. Until now a held queue left a log line, so telling a
   * one-minute stop from an hour-long one meant reading the log by hand, and
   * an SLO written without that number is a promise made by feel.
   *
   * EPISODES, not ticks, off the same transition that decides whether to log:
   * the floor is re-read every ten seconds, and counting readings would say
   * how often we look. The derogation (`exempt`) lets a card through, so it
   * closes the episode. In memory, zeroed by a restart - hence `since`.
   *
   * THE FIRST EPISODE OF EVERY BOOT IS THE WARM-UP: the memory window starts
   * empty, so the floor holds until it has readings. A real hold, but free at
   * every boot: pinned by the test rather than quietly subtracted, since
   * removing it means telling apart two states the floor itself does not.
   */
    admissionHoldEpisodes: 0,

    admissionHeldMs: 0,

    admissionHoldSince: null as number | null,

  /**
   * WHEN THE FLOOR WAS LAST ACTUALLY READ: an episode in flight is measured up
   * to here, never to `Date.now()`. The floor is only consulted while the
   * queue is worked, so auto-dispatch off or a paused board mid-episode means
   * nobody asks again and it never closes - wall-clock time would then report
   * hours of "held" that nobody looked at once. `lastSeenAt` is what tells a
   * live stop from an abandoned one.
   */
    admissionLastSeenAt: admissionCountingSince,

  /**
   * THE FLOOR, read with what the reading cannot see, and without saying it
   * (`admissionBlock` is the one that logs).
   *
   * The reading is the lowest of a 2-minute window (`mem-signal.ts`), which is
   * the hysteresis: a bare `avail < 6` flapped 30 times in eleven minutes on
   * 14/09/2026, and a warm-up reservation plus a holding margin still reopened
   * on single readings three times on 15/09.
   *
   * THE LIFE-OF-TURN RESERVATION IS CHARGED ONCE. An agent's first memory burst
   * comes a median 160 s after its start, and a turn waiting on a human or on
   * the checks waiter still owns what it will spend. In resources mode the
   * budget axis already reserves the price of every local turn for its whole
   * life (`reservedCost().memGB`), so the floor charges nothing more: charged
   * on both axes, one turn in flight put the line at 6 + 4 + 4 = 14 GB, above
   * anything this Mac reads. In count mode the floor is the only memory brake,
   * so it charges N x price itself.
   */
    lastMemoryStartGB: null as number | null,

  /**
   * THE CAP "BY RESOURCES", read NOW: why Topics is over the budget it was
   * given, or `null` when it is under it, when the mode is off, or when nothing
   * can be measured.
   *
   * It sits next to the floor and not inside it because they answer different
   * questions and end differently. The floor is a fixed line under which the
   * machine breaks (a full disk fails the DB's writes) and it is not a setting;
   * this is a preference, on a knob the person moves, and it lifts by itself as
   * soon as the use drops. That difference is why the two publish as two
   * different kinds and why the floor wins when both hold.
   *
   * The one exception (`firstAgentExempt`) is decided in
   * `shared/machine-budget.ts`: with no agent running the first one starts even
   * on a loaded machine, or a developer who keeps their own Mac busy would own
   * a board that never starts and looks broken.
   *
   * Said once per EPISODE in the log, like the floor: the numbers change at
   * every reading, so the comparison is on which axis said no, not on the text.
   */
    lastPressureAxis: null as AdmissionVerdict["blockedBy"] | "frozen",

    firstAgentExemptNoted: false,

  /**
   * THE HYSTERESIS STATE, and it has to live across ticks or it is not one.
   *
   * The gate does not resume where it stopped: once holding, it admits again
   * only under 80% of the budget (`ADMIT_RESUME_FRACTION`). The gap is the time
   * a `ps` sample needs to catch up with agents that have already started, and
   * without it the queue drains against one stale reading: eight cards in one
   * tick, measured on 2026-09-07.
   */
    budgetGate: "admitting" as BudgetGateState,

  /** The `sinceMs` of the provider hold already logged by `tick`: once per hold. */
    holdAnnounced: 0,

  /** The reset instant of the plan window already logged by `tick`: once per window. */
    planWindowAnnounced: 0,

    memorySeatTaskId: null as string | null,

    nextRunId: 1,

  /**
   * Slot di concorrenza invisibili al CAS di `claim`. Un fan-out è UNA riga
   * `in_progress` ma N agenti veri: senza questo contatore una board con fan-out
   * 3 e cap 3 farebbe girare 3 task × 3 agenti = 9. Vive in memoria come
   * `inFlight` — un riavvio lo azzera, e a quel punto non c'è più nemmeno un
   * agente vivo da contare.
   */
    reservedSlots: 0,

  /** Set once a planned restart is waiting on us: no new turn starts (see `drain`). */
    draining: null as string | null,

    usageTicker: null as ReturnType<typeof setInterval> | null,

  /**
   * ONE PASS AT A TIME. The poll fires every ten seconds without waiting for the
   * previous pass, and a pass awaits the broker once per orphan: with the event
   * loop stalled for 25 s at the boot of 14/09/2026 four passes ran together,
   * each resumed the same cards, and the log printed 13, 15, 14 and 2
   * «riprese» for 16 cut turns. A caller arriving mid-pass gets that pass.
   */
    reconciling: null as Promise<void> | null,
  };

  return { RECONCILE_GRACE_MS, admissionCountingSince, attemptCap, backoffMs, beginDelegated, capHeldNoted, clock, commandWaits, delegatedPolicy, deps, evaluateNight, externallyHeldNoted, fanOutBlockedNoted, floorBlockSent, floorHeldNoted, graceMs, graceTimers, heavyHeldNoted, heavyHoldSince, heldOffNoted, heldWritten, inFlight, liveTurns, livenessGraceMs, log, memoryHeldCards, noCheckExemptions, overflowBranch, overflowBranchPending, overflowOrigin, overflowOriginPending, overflowRounds, pendingResume, planHeldNoted, projectPauseHeldNoted, providerErrors, recentlyEnded, recordDelegated, remoteClaimDeclinedNoted, retryWaits, shared, slotWaits, spendHeldNoted, usageLedgers, waitingForSlot };
}
