/** Dispatcher contract: the injected dependencies and the public surface, split out of task-dispatcher.ts (types only). */
import { type Task, type TaskService } from "./tasks";
import { type SessionUsage } from "./transcript-usage";
import { type ActivityLogEntry } from "../db/activity-log";
import type { TaskAttemptStore } from "./task-attempts";
import type { DispatchAdmission, DispatchMemoryQueueSnapshot, MachineBudgetSample } from "../../shared/board";
import { type MemoryFloorHold, type ResourceFloorVerdict } from "./dispatch-capacity";
import type { HeldMemory } from "./mem-signal";
import type { DispatchMemoryHistoryPoint } from "./dispatch-memory-history";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { type TurnEndInfo } from "../providers/stop-reason";
import { type NodeDeps } from "./task-dispatcher-remote-node";
import { type OverflowMachine } from "./dispatch-overflow";
import { type DispatchWork } from "../../shared/provider-hold";
import type { StopCause } from "../lib/abort-cause";
import type { DelegatedRunPolicy } from "../lib/delegated-agent-start";

interface SessionActivity { name: string; input?: unknown; since: number }

/** What the dispatcher needs from the outside world — all injected. */
export interface DispatcherDeps {
  /** False on a server that is not the primary: tick, resume, reconcile and the todo go-ahead act only on mirror cards (`node-run:`). */
  isActive?: () => boolean;
  svc: TaskService;
  /** Where `task:unowned` leaves its activity_log row (the real writer when unset). */
  recordActivity?: (entry: ActivityLogEntry) => void;
  /** Stop command process groups when an automated landing closes a card. */
  stopCardProcesses?: (cardId: string) => void | Promise<void>;
  /**
   * Resolve a board-hash projectId to its filesystem path and (if the project
   * is registered in the ProjectStore) the store UUID needed for worktrees.
   * Returns null when the board can't be mapped back to a project on disk.
   */
  resolveProject: (projectId: string) => { path: string; projectStoreId: string | null } | null;
  /**
   * The "generale" catch-all workspace path (a project-less task's dispatch
   * cwd). A session whose resolved path is this one is presented STANDALONE
   * (see createTopic `standalone`) — no phantom "generale" project. Absent in
   * tests / hosts without a workspace.
   */
  catchAllProjectPath?: string;
  /** Create a detached, project-bound chat topic (no focus steal). */
  createTopic: (opts: { name: string; projectPath: string; worktreeId?: string; systemPrompt: string; effort?: string; model?: string; provider?: string; /** AICTRL-01 routing switch */ topicsRouting?: boolean | null; standalone?: boolean; mcpPolicy?: string; autonomyLevel?: "ask" | "auto-apply" | "yolo" }) => {
    topicId: string;
    sessionKey: string;
  };
  /**
   * Create a git worktree for `projectStoreId` and resolve once it's ready to
   * the worktree id, or throw if creation failed. Absent = the host can't
   * provide worktrees at all (tests / degraded mode). `baseBranch` = a node's
   * mirror card born from the origin card's own branch (`Task.baseBranch`),
   * not from main.
   */
  createWorktree?: (projectStoreId: string, opts?: { baseBranch?: string }) => Promise<string>;
  /**
   * Scrive sulla card la fotografia della consegna (ramo, commit, diffstat) e le
   * etichette derivate, leggendo il worktree. Torna `true` se c'e' un ramo.
   *
   * SERVE QUI perche' la consegna forzata dal sistema decide cosa dire al
   * reviewer leggendo quelle colonne — e nel percorso del dispatcher nessuno le
   * scriveva mai. Vedi `services/task-delivery-capture.ts`.
   */
  captureDelivery?: (taskId: string) => Promise<boolean>;
  /** Measure a planted node delivery's bar and offer it to the automatic land (`services/node-delivery-meter.ts`). */
  measureDelivery?: (taskId: string) => Promise<void>;
  /** Land one of a node's own attachments under this machine's own media. See `RemoteNodeHost.saveNodeMedia`. */
  saveNodeMedia?: (input: { taskId: string; commentId: string; nodePath: string; bytes: Uint8Array }) => string | null;
  /**
   * I FILE LASCIATI NEL WORKTREE E MAI COMMITTATI, o `null` se non si sa.
   *
   * ── Perche' esiste ────────────────────────────────────────────────────────
   * La fotografia di consegna legge la STORIA di git: ramo, commit, diffstat.
   * Un turno che muore prima del commit non lascia storia, quindi la card
   * concludeva «nessun ramo e nessun file toccato» — e chi rivedeva chiudeva o
   * rilanciava una card il cui lavoro era li', sul disco, intatto.
   *
   * Misurato il 18/08/2026 su due card in colonna review, entrambe con zero
   * commit e la stessa frase addosso: `fervent-snow` aveva QUATTRO file
   * modificati (la regola sui sottotask del tentativo morto, 367 righe, test
   * verdi) e `bashful-wren` TRE. Le ultime parole dell'agente della seconda,
   * recuperate dalla sessione, erano letteralmente «Changes are staged but not
   * committed». Nessuno dei due l'avrebbe mai saputo dalla card.
   *
   * `null` = non misurabile (nessun worktree, git muto): resta il testo
   * storico, che e' un silenzio onesto. Un elenco vuoto invece e' una misura:
   * il worktree c'e' ed e' davvero pulito.
   */
  uncommittedInWorktree?: (taskId: string) => Promise<string[] | null>;
  /**
   * IL PAVIMENTO: perché la MACCHINA non regge un altro agente adesso, o `null`
   * se lo regge. Non è il tetto — il tetto è una preferenza e può valere
   * «nessun limite», questo no. Assente (test, host degradato) = non blocca
   * mai: una guardia che non si sa misurare non deve poter fermare la board.
   *
   * `hold` is what the reading cannot see, as separate facts: the price of one
   * card, the memory kept for the local turns in flight, and whether any of our
   * work is on the machine (see `floorVerdict`).
   *
   * A VERDICT and not a sentence: which floor spoke keys the wait (the 120 s
   * warm-up and the real floor share their first word), and the memory floor
   * standing down for the first card is a fact only this answer carries.
   */
  resourceBlock?: (hold: MemoryFloorHold) => ResourceFloorVerdict | null;
  /** The same two-minute low-memory window used by the normal resource floor. */
  heldMemory?: () => HeldMemory | null;
  /** Latest measured memory reading and timestamp from the existing probe. */
  memoryReading?: () => { freeGB: number | null; at: number | null };
  /** Process-local ring maintained by the existing memory sampling beat. */
  memoryHistory?: () => DispatchMemoryHistoryPoint[];
  /** Cached process owners; this callback must not start another probe. */
  memoryConsumers?: () => Array<{ label: string; gb: number }>;
  /** Whether the selected agent runtime is the CLI process runtime. */
  isCliRuntime?: () => boolean;
  /**
   * WHAT TOPICS IS TAKING OF THIS MACHINE, for the cap "by resources": our own
   * core-units and gigabytes, what the others are taking, and the agents
   * already in flight, read NOW. Only consulted when the '*' row says
   * `mode = resources`; in count mode it is never called.
   *
   * It is a dependency and not a call to `computeDispatchCapacity` because the
   * test that matters ("over the budget nothing starts, under it it does") has
   * to fix the measure, and a real reading would assert on whatever the suite
   * is running next to. `null` or absent = not measurable, and a gate that
   * cannot measure does not close: it reads as "admit".
   */
  budgetSample?: () => MachineBudgetSample | null;
  /**
   * What the last few agents actually cost, in core-units, gates included. The
   * median of these is the price of admission (`estimatedAgentCost`): a fixed
   * number would price a compiling agent like one waiting on the API. Absent =
   * no history, and the estimate falls back to its floor, never to zero.
   */
  agentCostSamples?: () => number[];
  /** The same price list in gigabytes: the peak footprint of each recent card's
   *  pre-review checks, one number per card. The median of these prices the
   *  memory of one more agent, and an empty list prices it at the floor (never
   *  at zero). */
  agentMemSamples?: () => number[];
  /** One card's pre-review check peak in GB, folded into its measured weight (`dispatch-card-weight.ts`). */
  cardCheckPeakGB?: (taskId: string) => number | null;
  /** What the card's own process tree holds now in GB (null: not measured). */
  cardLiveTreeGB?: (taskId: string) => number | null;
  /** Delete a worktree we created (called when its attempt is discarded — requeue/park/setup-fail). */
  deleteWorktree?: (worktreeId: string) => Promise<void>;
  /**
   * Il worktree contiene LAVORO che sparirebbe cancellandolo — commit non su
   * main, o modifiche non committate (junk escluso)?
   *
   * Serve per non buttare via una consegna quando un tentativo viene rimesso in
   * coda. Il cleanup dopo il turno presume che un tentativo requeued/parked non
   * abbia prodotto niente: è vero quasi sempre, ed è falso proprio nel caso che
   * fa danno — l'agente committa, POI il turno viene troncato
   * dall'infrastruttura, il task torna in `todo`/`backlog`, e il branch coi
   * commit viene cancellato con la cartella.
   *
   * Assente ⇒ si risponde `false` e il comportamento resta quello storico. È
   * una scelta consapevole: rendere obbligatoria la sonda spegnerebbe la
   * pulizia su ogni host che non la fornisce, e la pulizia esiste per un motivo
   * (senza, ogni ritentativo orfana un worktree). La sonda vera la fornisce
   * server.ts; qui il valore di default tiene in piedi i test.
   */
  worktreeHasWork?: (worktreeId: string) => Promise<boolean>;
  /** Capacità viva della macchina (`computeDispatchCapacity`). Serve alla
   *  modalità notturna per sapere se il carico è sceso.
   *
   *  `reason` è la stessa riga che la board mostra sotto il tetto automatico
   *  (core, RAM, quanta CPU si sta mangiando la flotta). Finisce sulla card di
   *  chi aspetta il tetto pieno, così il numero non arriva mai nudo. */
  capacity?: () => { load1: number; cores: number; reason?: string };
  /**
   * Il carico attribuibile a NOI: quanti core stanno bruciando i processi della
   * nostra flotta (agenti, pty-bridge, sidecar), da `getFleetUsage`.
   *
   * Esiste perché `capacity().load1` risponde a un'altra domanda. Il load
   * average è la coda di esecuzione dell'INTERA macchina, e il freno del peso
   * non decide se il Mac è occupato: decide se un task pesante può prendersi la
   * macchina senza pestare i piedi agli agenti già in volo. Sono due misure
   * diverse, e la notte del 12/08 hanno dato due risposte opposte sullo stesso
   * host: load1 fra 37 e 48, la nostra flotta a 0,75% su 1200% di CPU. Il
   * carico erano le app dell'umano, e il freno le ha scambiate per noi.
   *
   * `coreUnits` è in unità di core (1 = un core saturo), la stessa scala di
   * `load1`, così la soglia si legge allo stesso modo. Assente o `null` = host
   * senza sonda: si ricade su `load1`, che è il comportamento storico.
   */
  ownLoad?: () => { coreUnits: number; cores: number } | null;
  /**
   * Adesso, in ms. Iniettabile perché l'attesa del freno adesso ha una SCADENZA,
   * e un test su una scadenza che non può muovere l'orologio misurerebbe solo la
   * propria pazienza.
   */
  now?: () => number;
  /** Quante sessioni UMANE sono vive adesso. È il segnale «sono via» del turno
   *  notturno: finché c'è qualcuno al lavoro, non si dispaccia. */
  humanSessionsLive?: () => number;
  /**
   * A private per-task working dir for a CATCH-ALL task (creates it, returns the
   * path). Giving each project-less task its own cwd makes its topic's
   * `projectPath` unique, so the task's own splittable workspace claims the
   * agent's browser panes (projectPath-match) instead of them vanishing — the
   * "fuori progetto" gap. Absent = host without a workspace (tests / degraded):
   * the catch-all task then keeps the shared catch-all dir (old behaviour).
   */
  catchAllTaskDir?: (taskId: string) => string;
  /**
   * Choose a model for a task on "modello auto" (task.model === null), BEFORE
   * the agent spawns — a fast one-shot classifier (see task-model-picker.ts).
   * Returns the concrete model id (null = keep the provider default). Absent =
   * host without a classifier (tests / degraded); "auto" then keeps the default.
   * Classification failures fall back within the chosen provider. Missing
   * provider/catalog errors stay actionable and never cross to another provider.
   */
  /** The classifier selects model/provider, reasoning effort and independent machine weight. */
  pickAutoModel?: (task: Task, selection?: string, options?: { effort?: string; topicsRouting?: boolean }) => Promise<{ model: string | null; provider?: string; effort?: string | null; weight?: string | null }>;
  /** An unconstrained Auto task may choose a ready coding runtime that is not itself held right now. */
  automaticModelAvailable?: () => boolean;
  /** Live machine capacity (CPU/load) for the ONE machine-wide cap, used when
   *  the reserved `board_settings['*']` row says `auto`. Absent ⇒ auto falls
   *  back to that row's fixed number. There is no per-board cap: the field that
   *  suggested one was written by nobody's reader and has been removed. */
  recommendedCap?: () => number;
  /**
   * Quante barre di check pre-review stanno girando ADESSO (dal registro
   * `checksGate.runningCount()`).
   *
   * Ogni barra vale uno slot di capacita': `test:unit` da solo dura ~322s e
   * satura piu' core. Sei barre insieme il 18/08 hanno portato il loadavg a
   * 78,83 su 12 core. Il freno deve contarle accanto agli agenti in volo, cosi'
   * un dispatch nuovo aspetta finche' sia gli agenti che le barre stanno dentro
   * il tetto. Assente = non si contano (comportamento storico, mai zero-denial).
   */
  checksRunning?: () => number;
  /** The task's checks run gave its lane back and only waits on the pull request CI
   *  (KANBAN-84): its turn holds no memory here, so admission does not reserve any. */
  checksOffLane?: (taskId: string) => boolean;
  /** Drive ONE headless turn to completion; resolves when the turn ends. */
  /**
   * Drive ONE headless turn to completion; resolves when the turn ends.
   * `contextMode`: "full" (default) re-assembles the whole context envelope
   * (CLAUDE.md/README/awareness/memory…); "lean" sends only the role prompt +
   * cwd awareness. The dispatched session is persistent (the CLI keeps prior
   * turns), so a resume/continuation doesn't need the full envelope re-injected
   * into history — that only compounds cache write/read on every later call.
   */
  /**
   * `timeoutMs` is DECLASSED TO REPORTING ONLY: it no longer cuts a turn, it is
   * just what the host compares an over-long turn against and logs. The kill
   * mechanism is `idleMs` — the passive stall detector's silence threshold
   * (see `server/lib/stall-detector.ts`): once the session goes quiet for that
   * long, a cheap judge decides "alive" (rearm, keep going) or "stuck" (recycle
   * — abort + resume the SAME session). Absent `idleMs` ⇒ the host's own
   * default.
   */
  runTurn: (sessionKey: string, content: string, opts: { timeoutMs: number; idleMs?: number; contextMode?: "full" | "lean"; dispatchedFor?: string[] }) => Promise<TurnEndInfo | void>;
  /**
   * True if a still-running agent turn for this session survived a server
   * restart in the ai-bridge broker (provider.hasLiveSession). When present and
   * true, reconcile REATTACHES to the live turn (non-lossy) instead of RESUMING
   * from scratch. Absent (non-broker provider / flag off) ⇒ reconcile always
   * resumes, unchanged.
   */
  hasLiveSession?: (sessionKey: string) => Promise<boolean>;
  /** A question of this session still waits on its person (`sessionHasOpenQuestion`).
   *  A card cut on one is not an interrupted turn to repair: the restart leaves it
   *  waiting instead of nudging the agent to carry on without the answer. */
  hasOpenQuestion?: (sessionKey: string) => boolean;
  /** Drive a REATTACH turn to completion (adopt the surviving broker child and
   *  finish it). Injected alongside hasLiveSession. */
  reattach?: (sessionKey: string, opts: { timeoutMs: number; idleMs?: number }) => Promise<TurnEndInfo | void>;
  /**
   * Is the agent PROCESS behind this session still alive? (provider
   * `isTurnProcessAlive` — the same probe the stream watchdog trusts to tell a
   * thinking-but-mute child from a dead one.)
   *
   * The dispatcher's own "a turn is running" bookkeeping is `inFlight`, which is
   * pure memory: it clears when the turn's promise settles. If the child dies in
   * a way that never settles that promise, the task is invisible to every sweep
   * (`reconcile` skips whatever is inFlight) and the card sits on `working` until
   * the wall-clock timeout — 20 minutes in the best case, forever in the worst.
   * This probe is what closes that hole (see `sweepDeadTurns`).
   *
   * Three answers, on purpose:
   *   true  → alive (a long silence is NOT death: a thinking agent is alive)
   *   false → the process is gone
   *   null  → the host CAN'T TELL (no provider probe). Never buries anything —
   *           ignorance must not read as death.
   * Absent ⇒ the net is off entirely (tests/degraded keep the old behaviour).
   *
   * NB: deliberately NOT `hasLiveSession`, which answers false whenever the
   * ai-bridge broker is off — as a liveness signal that would bury every live
   * turn on a non-broker host.
   */
  isTurnAlive?: (sessionKey: string) => boolean | null;
  /**
   * Usage consumed so far by this session (from its transcript usage records,
   * deduplicated by API message id — see transcript-usage.ts). Best-effort —
   * absent/throwing = zeros. The dispatcher records the PER-TURN DELTA on the
   * task, so totals survive retries on fresh sessions.
   */
  getSessionUsage?: (sessionKey: string) => SessionUsage;
  /**
   * What the session is doing RIGHT NOW: the tool it is running, its input and
   * when it started; `null` when no tool is running or the host cannot tell.
   * The live ticker rides it on `task:usage-live` so the card can say
   * «Bash · bun run test:unit · 3m» instead of a bare stopwatch: a 14-minute
   * turn that is running the unit suite and one that is stuck looked the same,
   * and telling them apart meant opening the chat, which is what the board was
   * meant to spare. Best-effort, never persisted.
   */
  sessionActivity?: (sessionKey: string) => SessionActivity | null;
  /**
   * The agent's LAST assistant prose in the session (trimmed), or null. Used to
   * GUARANTEE a delivery carries the agent's own words: when a turn ends and the
   * agent never called comment_task, the dispatcher mirrors this text into a task
   * comment so the reviewer always reads "what I did" — instead of landing on a
   * bare system note (or losing a worked task to `failed`). Synchronous (reads
   * the local message store). Absent (tests/degraded) ⇒ no mirror, old behaviour.
   */
  getLastAgentText?: (sessionKey: string) => { text: string; id: string } | null;
  /**
   * A task just reached `review` (self-delivered or system-delivered): boot a
   * live preview server from its worktree, point output_url at the LOCAL
   * deep-link (never prod), and attach a screenshot as a `review-note`. Fired
   * best-effort (void) — the review chip is already set, the preview populates a
   * few seconds later. Absent (tests/degraded) ⇒ no preview, old behaviour.
   */
  preparePreview?: (taskId: string) => Promise<void>;
  /** Tear a task's preview server down (land / approve / close / reap). */
  teardownPreview?: (taskId: string) => Promise<void>;
  /**
   * La card è consegnata: butta dal suo worktree gli artefatti rigenerabili
   * (dipendenze, cache di build) tenendo cartella, branch e commit.
   *
   * Qui e non al land, perché la maggior parte delle card NON landa subito: sono
   * i giorni fra la consegna e l'ok umano a costare ~260 MB l'una, ed è lì che il
   * disco è passato da 30 a 64 GB in una notte. L'host è l'unico che sa se in
   * quel worktree c'è un'anteprima viva — la decisione su QUANDO farlo sta di là
   * (vedi `worktree-slim`), qui c'è solo il momento in cui ha senso chiederlo.
   * Assente (test/degradato) ⇒ nessuno snellimento, comportamento di prima.
   */
  slimWorktree?: (taskId: string) => Promise<void>;
  /**
   * True if the topic still exists. Used to SELF-HEAL a dead binding: a task
   * whose `assigned_topic_id` points at a topic that was later reaped (its agent
   * tab deleted) would be skipped forever by the eligibility filter (`!assignedTopicId`)
   * and sit in todo with no chip, never claimed. `tick` clears such dead links so
   * the task is dispatchable again. Absent (tests/degraded) ⇒ no heal, bindings
   * are trusted as-is (the pre-existing behaviour).
   */
  topicExists?: (topicId: string) => boolean;
  /** The actual binding inherited when a dependent reuses its blocker's session. */
  topicModelSelection?: (topicId: string) => { model?: string | null; provider?: string | null; topicsRouting?: boolean | null } | null;
  /** MSEL-06: writes the effective switch on a reused session that never had
   *  one (a card topic from before the column existed), before its turn, so
   *  the chat resolver does not read its `null` with the chat scope. */
  setTopicRouting?: (topicId: string, topicsRouting: boolean) => void;
  /** Same coding-provider resolution as createTopic, including the live default
   *  and the Topics switch (with ON every selection runs on the native engine). */
  resolveTaskProvider?: (model?: string | null, topicsRouting?: boolean) => string;
  /**
   * Il lavoro che questa card ha consegnato è già DENTRO il ramo d'integrazione
   * del suo repo?
   *
   * Serve al cancello che impedisce di rifare lavoro già atterrato. Il difetto è
   * misurato: 32 card ridispacciate in un giorno, e due sole (`4ec47331`,
   * `e54a9be6`) hanno bruciato 3,26M token per riprodurre codice che su main
   * c'era già. Il land ha il suo cancello, ma una card torna in coda anche per
   * altre strade — un trascinamento, un `done→todo`, un orfano recuperato — e da
   * lì nessuno riguardava il repo prima di far partire un agente.
   *
   * Due cose che la risposta deve fare, e nessuna delle due è ovvia:
   *  - chiedere del COMMIT, non del ramo: dopo il land il ramo è potato, e
   *    chiedere di lui risponderebbe «non c'è» su un lavoro atterrato;
   *  - guardare il CONTENUTO, non la sola discendenza: il land RICOPIA i commit
   *    (`cherry-pick -C <sha>`), quindi dopo un land riuscito il commit di
   *    consegna non è antenato di main. Un cancello basato sull'ancestry sarebbe
   *    quasi sempre inerte — proprio sul caso normale. L'ospite lo risolve con la
   *    stessa strada dell'audit degli atterraggi (`commitStatusFromRepo`).
   *
   * Tre valori: `true` dentro, `false` fuori, `null` non contabile. Solo il
   * `true` chiude la card — su «non lo so» si dispaccia come sempre, perché
   * chiudere una card sul dubbio significa buttare via il lavoro che manca.
   * Assente (test/host degradato) ⇒ cancello spento, comportamento storico.
   */
  deliveryLanded?: (repoPath: string, commit: string) => Promise<boolean | null>;
  /**
   * `deliveryLanded` above needs THIS machine's own checkout for a card's project — never a remote
   * node's, which runs its own repository and can carry a stale `main` of its own. Absent = the
   * empty-node-run guard that reads it is skipped.
   */
  repoPathOfTask?: (taskId: string) => string | null;
  /**
   * Is the CI of THIS machine's `main` still red? A card sent back by the post-land red keeps its "fix on top"
   * verdict only while that is true: once somebody repaired main elsewhere, "already in main" is right again.
   * Absent = treated as still red (the card stays in todo, never closed on a guess).
   */
  mainIsRed?: (repoPath: string) => Promise<boolean>;
  /**
   * Claude sessions running OUTSIDE Topics right now at/under a directory
   * (see services/external-sessions.ts). The dispatcher can only see its OWN
   * agents, so without this a task lands in a repo the human is editing by
   * hand in a terminal and the two fight over the working tree.
   *
   * Two outcomes, by dispatch mode (see the guard in `tick`):
   *  - in-place dispatch (worktree isolation OFF) → HOLD: same directory,
   *    guaranteed collision. The todos stay in `todo` with the 'queued' chip
   *    (one system note per hold episode), and the periodic reconcile re-ticks
   *    the board, so dispatch RESUMES BY ITSELF once the session goes quiet —
   *    no human intervention, no re-queue.
   *  - worktree dispatch → proceed (the agent gets its own tree) but WARN in
   *    the task thread, since the branch it lands on is the contended one.
   * Absent (tests/degraded) ⇒ no guard, the pre-existing behaviour.
   *
   * The census this reads keeps its previous answer when a scan throws (see
   * services/external-sessions.ts): a transient fs error never reads as "repo
   * free", so the guard never releases a hold on a lie.
   */
  externalSessionsAt?: (path: string) => Array<{ cwd: string; branch: string | null }>;
  /**
   * Registro dei tentativi di fan-out (migration 065). Presente ⇒ una board con
   * `dispatchFanOut > 1` lancia N agenti in parallelo, ognuno nel suo worktree,
   * e l'umano sceglie quale tenere. Assente (test/host degradato) ⇒ il fan-out è
   * semplicemente spento: `launch` resta l'unica strada, byte per byte.
   */
  attempts?: TaskAttemptStore;
  /**
   * Fotografia del lavoro di UN worktree rispetto al punto da cui è partito:
   * commit di testa e diffstat contro `merge-base`. Serve a mettere i tentativi
   * uno accanto all'altro senza chiedere all'umano di aprire N diff per capire
   * chi ha fatto qualcosa. Best-effort: null ⇒ "non lo so", che `attemptHasWork`
   * legge come "nessuna modifica" (mai come lavoro fantasma).
   */
  attemptStats?: (worktreeId: string) => Promise<{ commit: string | null; filesChanged: number; insertions: number; deletions: number } | null>;
  /** Il branch di un worktree (l'etichetta che l'umano riconosce nel confronto). */
  worktreeBranch?: (worktreeId: string) => string | null;
  /** Setup script outcome retained by WorktreeManager until the next restart. */
  worktreeSetupResult?: (worktreeId: string) => { status: "not-configured" | "succeeded" | "failed" | "timed-out"; exitCode: number | null; output: string[] } | null;
  /** Archivia il topic di un tentativo scartato (la sua chat esce dalle tab). */
  archiveTopic?: (topicId: string) => void;
  /** Broadcast a WS message so live boards reflect chip/state changes. */
  broadcast: (message: OutboundMessage) => void;
  log?: (msg: string, err?: unknown) => void;
  /** Grace window (ms) between the →todo signal and the claim. Default 6000. */
  graceMs?: number;
  /**
   * Pause before resuming a turn that died QUICKLY (< the backoff itself) —
   * an instant death is a provider outage (credit/limit/connection), not work
   * to redo: retrying immediately burns the whole retry budget in seconds.
   * Default 60000.
   */
  retryBackoffMs?: number;
  /**
   * How long a turn is IMMUNE to the liveness net after its session is bound.
   * The provider registers its child only once the turn actually spawns (context
   * assembly first), so a young run legitimately probes as "no process". Default
   * 60000 — with the 10s reconcile poll a dead session is buried in ~60-70s
   * instead of the 20-minute wall-clock, and a starting one is never touched.
   */
  livenessGraceMs?: number;
  /**
   * Ogni quanto ripassa l'anteprima viva della card (token, tempo, triage).
   * Default 4000. Esiste per i test: senza, provare che il chip del triage si
   * spegne quando l'agente lascia il primo segno vorrebbe dire aspettare
   * quattro secondi veri.
   */
  usageTickMs?: number;
  /**
   * THE REMOTE LANE: absent means no card can run anywhere but here.
   * Its shape and its whole behaviour live in `task-dispatcher-remote-node.ts`.
   */
  node?: NodeDeps;
  /**
   * THE OVERFLOW: the machines a card held by this Mac's memory floor can move
   * to (`dispatch-overflow.ts`), never this one. Absent = no card ever moves by
   * itself, the historical behaviour. Needs `node`: the move hands the card to
   * the remote lane.
   */
  overflowMachines?: () => OverflowMachine[];
  /** Does the Claude plan have credit for a cloud run? Absent = no Claude provider hold. */
  cloudCredit?: () => boolean;
  /** Is the project's origin a GitHub repository (the cloud clones nothing else)? Absent = no, Cloud is never chosen. */
  githubOriginOf?: (projectId: string) => Promise<boolean>;
  /** The cloud account is known to be refused access to this project's repository: the overflow does not pick the cloud for it. */
  cloudRefusesProject?: (projectId: string) => boolean;
  /** Live delegated authority. A marked task fails closed when this is absent. */
  delegatedPolicyForTask?: (taskId: string) => DelegatedRunPolicy | null;
  /** Node-local bindings stay delegated even after expiry makes their live policy disappear. */
  isDelegatedTask?: (taskId: string) => boolean;
  /** Persist a delegated phase. Dispatch/resume return the absolute persisted deadline. */
  recordDelegatedPhase?: (input: {
    taskId: string;
    phase: "dispatch" | "resume" | "cancelled" | "completed" | "failed";
    executionSessionId?: string | null;
    outcome?: string | null;
  }) => boolean | number;
  /** Stops a live local turn when its authorizing capability is revoked. */
  abortTurn?: (sessionKey: string, cause: StopCause) => Promise<void>;
  /**
   * A `run_command` of this session will wake it: it still runs, or it ended
   * and the turn its wake row opens is not over yet (`routes/processes.ts`
   * `commandWakeState`). A card whose turn ends on one waits for that wake
   * instead of being nudged. Absent: never.
   */
  awaitsCommandWake?: (sessionKey: string) => boolean;
  /**
   * A `spawn_agent` child of this session will wake it: a turn of it is open,
   * or its result waits for the chat (`lib/subagent-runtime.ts`
   * `subagentWakeOwed`). Read like `awaitsCommandWake`. Absent: never.
   */
  awaitsSubagentWake?: (sessionKey: string) => boolean;
  /** A turn in flight on the session that the dispatcher did not start: a command's wake, a person's message (`activeStreams`). */
  isSessionBusy?: (sessionKey: string) => boolean;
  /**
   * When the session's last chat row was written (ms), or null: where a
   * restart finds the start of the silence a command wait is bounded by.
   * Absent: the wait starts at the boot.
   */
  lastSessionRowAt?: (sessionKey: string) => number | null;
}

export interface TaskDispatcher {
  /**
   * The card a session works for while its turn is in flight, or null: the
   * attention store puts a mid-turn wait of a board agent on its card, not
   * on its topic (notifications-redesign, `server/attention/wire.ts`).
   */
  taskForSession(sessionKey: string): string | null;
  /** The sessions of the cards in flight: their topics are board agents' (rule 2 of the attention state). */
  sessionsInFlight(): string[];
  /** Try to fill free slots on one board: claim + launch the oldest eligible todo(s). */
  tick(projectId: string): Promise<void>;
  /** Human moved a task INTO todo → schedule a debounced tick (shows `queued`). */
  onEnterTodo(projectId: string, taskId: string): void;
  /** Human moved a task OUT of todo before it claimed → cancel the pending launch. */
  onLeaveTodo(taskId: string): void;
  /**
   * The dispatched agent DECLARED an external-condition wait (wait_for_condition):
   * park the task back in todo with a `waiting` chip + note + deferral window so
   * it releases its slot instead of holding it. The live turn is still winding
   * down; onTurnEnd sees the `waiting` chip and leaves it be, and the periodic
   * tick re-dispatches once the window elapses. Returns the updated task.
   * `source: "machine"` is a wait no agent declared (a silent node): its retry
   * opens no turn, so it keeps the wide streak cap, while an agent's wait stops
   * at the second one (`AGENT_WAIT_STREAK_CAP`).
   */
  deferWait(taskId: string, reason: string, minutes?: number, source?: "agent" | "machine", mail?: { until: string; waitId: string }): Task;
  /**
   * Lo stato della modalità notturna della board, per l'interfaccia. Sola
   * lettura, e passa dallo STESSO calcolo del gate del `tick`: la card delle
   * impostazioni non può dire una cosa diversa da quella che il dispatcher fa.
   */
  /**
   * How many times the resource floor held the queue, and for how long in
   * total. Read-only and without effects: it states the invariant that already
   * holds ("under the floor no card starts") by making it measurable, it does
   * not change it. `heldMs` includes the episode in flight.
   *
   * The numbers belong to THIS process: `since` says when the count began,
   * because a restart zeroes them and a count without its window reads like a
   * time series it is not.
   */
  admissionHolds(): {
    episodes: number;
    heldMs: number;
    holding: boolean;
    /** When the floor was last really consulted (see `heldMs`). */
    lastSeenAt: string;
    since: string;
  };
  nightStatus(projectId: string): {
    enabled: boolean;
    until: string | null;
    startedAt: string | null;
    action: "off" | "dispatch" | "wait" | "expire";
    reason: string | null;
    load1: number;
    cores: number;
    busySessions: number;
    endsInMs: number | null;
  };
  /** A task reached `done` → nudge the todos it was blocking (they are now claimable). */
  onBlockerDone(taskId: string): void;
  /**
   * Re-kick the task's EXISTING topic with a human message (a "Serve te" answer
   * or a review rejection). The caller has already moved the task back to
   * `in_progress` (via reviewDecision); this resumes the same agent tab so the
   * conversation continues instead of spawning a fresh one.
   */
  resume(taskId: string, humanMessage: string, opts?: { commentIds?: string[] }): Promise<void>;
  /**
   * Boot + periodic sweep. Three passes:
   *  0. LIVENESS: a turn we still believe is running but whose agent process is
   *     gone (dead for two consecutive sweeps) is closed and recovered — the case
   *     "server alive, session dead", invisible to the orphan pass by definition.
   *  1. ORPHANS: a restart-orphaned in-progress task RESUMES on its own persisted
   *     session (topic/worktree/CLI --resume) when it still has one; only orphans
   *     without a resumable session are requeued.
   *  2. Then tick every board with queued todos.
   */
  reconcile(opts?: { reason?: "boot" | "poll" }): Promise<void>;
  /**
   * Lo spegnimento scrive un bit sulle card che stavano lavorando.
   *
   * Si chiama PRIMA di `shutdown()`, che svuota `inFlight`: dopo, la mappa e'
   * vuota e questa riga varrebbe zero. Ritorna quante card ha marcato.
   */
  markInterrupted(by: string): number;
  /**
   * What the budget gate WOULD answer for one more agent right now, without
   * moving its hysteresis state. `null` outside the budget mode or without a
   * sample. Read by GET /api/system/dispatch-capacity, so the panel's verdict
   * is the gate's and not a second opinion.
   */
  admissionPreview?(projectId?: string | null): DispatchAdmission | null;
  /** The same, priced for one sub-agent: what the spawn door asks in "by resources" mode. */
  childAdmissionPreview?(): DispatchAdmission | null;
  /** Read-only data for the dispatch memory dashboard. */
  memoryQueueSnapshot(): DispatchMemoryQueueSnapshot;
  /** The cards a provider's wall keeps in Todo, and the cards at work per runtime (HUBBR-20). */
  dispatchWork?(): DispatchWork;
  /** One reading of the server's process tree in GB, on the `[memsig]` minute: it weighs the local cards in flight. */
  sampleCardWeight(treeGB: number | null): void;
  /** Start one selected memory-waiting card, preserving all other admission gates. */
  startAnyway(projectId: string, taskId: string): Promise<{ ok: boolean; code?: string }>;
  /** Cancel all timers (test teardown / shutdown). */
  shutdown(): void;
  /** True while a launch for this task is in flight (test/introspection). */
  isInFlight(taskId: string): boolean;
  /** Moves a card pinned to a machine that cannot run it; true = it moved. The self-check's cure for a dead pin. */
  reassignFromForbidden(task: Task, settings: { dispatchModel?: string | null }): boolean;
  /** Publishes a changed card to the open views. */
  emitTask(task: Task): void;
  /**
   * How many task launches are in flight right now (setup + turn + teardown).
   * The quiescence signal a restart must wait on: a planned restart
   * (approve self-restart / graceful shutdown) blocks until this is 0 so it
   * never cuts an agent mid-turn. Backed by `inFlight`, not `liveTurns`
   * (the latter is only the turn window, missing setup/wind-down).
   */
  busyCount(): number;
  /** The task ids behind `busyCount()`: what a restart is actually waiting for. */
  busyIds(): string[];
  /**
   * Every overflow-reachable machine (cloud row and paired nodes), with the
   * seats it is declared to have and how many it is carrying now: what a
   * client needs to tell "the Mac is full" apart from "the Mac is full AND
   * there is nowhere else to send a card" (`/api/system/dispatch-capacity`).
   */
  nodeStatus(): { id: string; name: string; kind: "cloud" | "node"; online: boolean; slots: number; used: number }[];
  /**
   * The sessions those runs are bound to (setup slots, still without one, are
   * left out). A card turn streams through /api/chat, so the restart gate
   * needs these keys to tell a card's own stream from a person's chat.
   */
  busySessionKeys(): string[];
  /**
   * The turns behind `busyCount()`, each with the session it streams on.
   *
   * The restart gate needs the PAIR: it asks the checks gate, by task id,
   * whether that card's delivery is only waiting on our own checks, and then
   * has to take that card's own stream out of the chat sources too (a card
   * turn streams through /api/chat, so its session is also a stream key).
   */
  busyTurns(): Array<{ taskId: string; sessionKey: string }>;
  /** The card runs riding on one node (`busyTurns` leaves them out): what a switch to that node waits for. */
  nodeRunsOn(machineId: string): Array<{ taskId: string; sessionKey: string }>;
  /** The launches still on their way to any machine, before the node names the run: a switch parks every one. */
  nodeLaunchesInFlight(): Array<{ taskId: string; sessionKey: string }>;
  /** Cancel that node run and put its card back in the queue with the note; `node_run_id` is cleared. */
  parkNodeRun(taskId: string, note: string): Promise<boolean | null>;
  /**
   * A planned restart is on its way: from now until the process is replaced,
   * start NO new turn. Queue picks, slot wake-ups and resumes all park where
   * they are, bindings intact, and the boot reconcile of the next process
   * resumes them on their own sessions.
   *
   * Without this `restart-when-idle` never fired under a live fleet: the wait
   * looks for zero card turns, and with a queue behind a full cap a new turn
   * starts the second one ends. Measured on 2026-09-04: a restart requested
   * at 04:50 was still deferred 18,482 s later, three turns at a time, while
   * the landed server fixes and a migration sat on disk unapplied.
   */
  drain(reason: string): void;
  /**
   * Reopen the door closed by `drain` while the restart is still waiting: the
   * holder is a chat, not a card, and the wait has no bound of ours, so
   * refusing card turns would freeze the board for as long as that chat runs
   * (`lib/quiescence.ts`, `dispatchDoor`). The caller closes it again the
   * moment only cards hold.
   */
  undrain(reason: string): void;
  /** Cancel only queued or active work bound to one revoked capability. */
  revokeDelegatedCapability(capabilityId: string): Promise<number>;
}
