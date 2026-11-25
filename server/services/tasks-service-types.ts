/** The task service contract (options, merge outcome, the TaskService surface), split out of tasks.ts (types only). */
import type { Actor, UpdateBoardSettingsPatch } from "./tasks";
import type { RepoProbe } from "./deliveryReportChecks";
import { type CheckRun } from "./review-checks";
import { type LandingAuditCandidate } from "./landing-candidates";
import type { ParkedChildrenDecision } from "../../shared/board";
import { type LabelSource, type TaskFile } from "../../shared/task-labels";
import { type Neighbour } from "../../shared/task-similarity";
import type { TaskComment, BoardSettings, TaskWeight, GlobalDispatchCap, GlobalCapPatch, TaskActionOrigin } from "../../shared/board";
import type { Task, CreateTaskInput, UpdateTaskPatch, ListTasksInput } from "./task-shapes";

export interface ServiceOpts {
  now?: () => string;
  uuid?: () => string;
  /** Window within which an identical comment (same task+author+content) is deduped. */
  commentDedupeMs?: number;
  /** Window within which a second interruption note on the same task stays silent. */
  interruptClaimMs?: number;
  /** Window within which a repeated chat nudge on the same task collapses to one line. */
  nudgeClaimMs?: number;
  /** Injectable for tests: whether a media path exists on disk (default node:fs existsSync). */
  fileExists?: (p: string) => boolean;
  /**
   * Scrive la SCHEDA DI CONSEGNA su disco e torna il path (null se non si e'
   * potuto). Iniettata dall'host perche' questo servizio non conosce la media
   * dir e non deve toccare il filesystem: vedi `services/delivery-sheet.ts`.
   */
  writeDeliverySheet?: (taskId: string, svg: string) => string | null;
  /**
   * The repository a delivery report talks about: the agent's worktree first
   * (a cited file may exist only on the delivery branch), then the board's
   * project. `null` = this server's own checkout, which is right for exactly
   * one board. The server wires this; the service cannot know where projects
   * live.
   */
  repoRootFor?: (args: { taskId: string; projectId: string | undefined; assignedTopicId: string | null }) => string | null;
  /** Complete host-known repository roots, including registered and archived projects. */
  listRepoRoots?: () => string[];
  /** Visible project directories, used as a fallback by older hosts. */
  listProjectDirs?: () => string[];
  /**
   * The branch checked out in a worktree root when it has commits ahead of main
   * (`null` otherwise). Lets a card that declares a wait keep its work as `prior_branch`.
   */
  branchAheadOf?: (root: string) => string | null;
  /** How a root becomes a probe (tests pass a fake). */
  probeFor?: (root: string) => RepoProbe;
  /**
   * A delivery note that waited on git has just been written: after the update
   * that asked for it returned, so after its caller broadcast the card. The
   * host sends the card again, or an open board or drawer never shows the note.
   */
  onLateDeliveryNote?: (taskId: string, projectId: string | undefined) => void;
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
   * The card a chat topic belongs to, or `null`.
   *
   * Two links, in this order, and the second one is why this lives here instead
   * of being a filter over the board feed: `tasks.assigned_topic_id` is the
   * CURRENT binding, and it moves to a new topic the day a card is released and
   * re-claimed from scratch. `task_attempts.topic_id` is the HISTORY (every
   * launch writes its row), so a session whose card has already restarted
   * elsewhere can still say whose it was.
   */
  taskIdOfTopic(topicId: string): string | null;
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
  /**
   * `asCoordinator`: the caller is the global coordinator (registry-gated by
   * the route). It may write the question for the person on a card it did not
   * open (the card of a schedule or the board API has no chat to do it).
   */
  update(args: { taskId: string; actor: Actor; by: string; patch: UpdateTaskPatch; projectId?: string; agentTopicId?: string | null; statusReason?: string | null; messageId?: string | null; origin?: TaskActionOrigin; asCoordinator?: boolean }): Task;
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
   * da 244 caratteri. Misurato il 18/08: 108 lines identiche su 12 card in
   * quattro ore, dieci-dodici copie byte-per-byte sulla stessa card, e il thread
   * cresce di una ogni mezz'ora finche' nessuno tocca quel worktree — cioe' per
   * giorni. `once` toglie la finestra: stesso autore, stesso testo, stessa card
   * ⇒ si scrive la prima volta e basta.
   */
  /**
   * `replaces` — ONE SLOT, not a pile.
   *
   * A machine note describing the STATE of something (a card's preview, say) is
   * not an event to append: it is a current value. Written through plain
   * `addComment`, every review transition added another one, and since the
   * screenshot always lands in the same file the OLDER notes ended up showing
   * the NEWER image: the thread did not merely grow, it lied. Passing the
   * shared prefix of that slot's notes removes the previous ones by the same
   * author and the same `kind` before writing. `once` solves a different
   * problem (the identical text repeated); here the text changes on every run,
   * which is exactly why they piled up.
   */
  addComment(args: { taskId: string; author: string; content: string; mentions?: string[]; media?: string[]; projectId?: string; questionOptions?: string[]; kind?: "comment" | "review-note" | "service" | "delivery"; once?: boolean; replaces?: string | string[]; messageId?: string | null; origin?: TaskActionOrigin; quiet?: boolean }): TaskComment;
  /**
   * Checks again the claims of the agent deliveries still in review, touched
   * since `sinceIso`, that carry no delivery note. A note waiting on git dies
   * with the process that was asking, and nothing else asks again: the boot
   * calls this. Checking a clean delivery twice writes nothing.
   */
  recheckRecentDeliveries(sinceIso: string): number;
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
   *
   * `slot`: the claim window is three minutes and guards CONCURRENT writers,
   * not one boot against the next. A note that describes a STATE lasting
   * across boots (a card still waiting for a seat) passes the opening of its
   * sentence, and gets `replaces` + `once`: one row per card, whatever the
   * number of restarts. 89919742 carried 15 identical copies on 24/09/2026.
   */
  claimInterruption(args: { taskId: string; note: string; by?: string; slot?: string }): TaskComment | null;
  /**
   * THE HUMAN REJECTION NOBODY EVER HANDED TO THE AGENT.
   *
   * When a person rejects a delivery, the words that say WHY live in the
   * thread and the row records who reopened the card (`reopened_actor`). The
   * dispatcher used to keep the text in a Map in memory, so a restart lost it
   * and the card came back with "your turn was interrupted, carry on with the
   * work that is left" - the opposite of "a human rejected this delivery with
   * three objections". Measured 2026-09-17: 3 cards rejected on the 15th, still
   * stopped 45 hours later, each one through 44 restarts.
   *
   * Returns the words still undelivered and their ids, or null.
   *
   * TWO TRAPS, both measured on the live DB, and both fatal to the naive query:
   *
   *  1. THE WORDS ARE OLDER THAN THE REOPEN, by milliseconds. The comment is
   *     written first and the status row right after: on `f981f62c` they are
   *     13:49:31.716 and 13:49:31.732, 16 ms apart (2 ms and 1 ms on the other
   *     two cards). A `created_at > reopened_at` filter finds nothing at all
   *     and the fix looks done while doing nothing. Hence the slack backwards.
   *
   *  2. "ALREADY SEEN" IS NOT "A TURN HAS RUN". A resume envelope records the
   *     comments it carried (`dispatched-envelope` blocks on the message row),
   *     and that - not the clock - is the honest answer to "did the agent ever
   *     get these words". A turn that ran after the reopen with the WRONG text
   *     did not deliver them; re-asking the clock would call that delivered.
   */
  pendingHumanReopen(args: { taskId: string }): { text: string; commentIds: string[] } | null;
  /**
   * Una interruzione, un SOLLECITO.
   *
   * Il gemello di `claimInterruption` per l'altro canale: non il thread della
   * card, ma la CHAT del task, dove a ogni ripresa il dispatcher inietta il
   * sollecito come messaggio dell'utente. Su `topic:7d043b7e` ne sono finite
   * quattro copie identiche in novanta secondi (00:37:07, 00:38:01, 00:38:18,
   * 00:38:28): quattro paragrafi sopra la conversazione vera.
   *
   * Qui il cancello non può zittire chi arriva secondo: un turno si accende
   * con un messaggio, e senza messaggio la card non riparte. Quindi il
   * verdetto è sul TESTO. Ritorna quello da mandare davvero: il sollecito
   * intero la prima volta della finestra, una riga corta e numerata dopo. La
   * regola sta in `nudge-gate.ts`, la memoria sul task (colonne `nudge_*`),
   * e non in RAM: il terzo che sollecita è quasi sempre un processo NUOVO.
   *
   * Un task che non esiste ottiene il testo intero: un sollecito di troppo è
   * rumore, uno mancato è un turno che riparte cieco.
   */
  claimNudge(args: { taskId: string; text: string }): string;
  /**
   * LO SPEGNIMENTO SCRIVE UN BIT.
   *
   * Prima, `gracefulShutdown` fermava timer, provider e DB senza toccare una
   * riga di `tasks`: per tutta la finestra morta la board diceva «sta
   * lavorando» sopra un processo che non esisteva, e lo stato «interrotto»
   * veniva indovinato dal boot successivo guardando il chip rimasto li'.
   *
   * Qui si stampa il fatto sulle card che stavano DAVVERO lavorando (la mappa
   * `inFlight` del dispatcher, letta un istante prima di svuotarla). Solo le
   * `in_progress`: una card gia' passata in review nel frattempo non e' stata
   * tagliata a meta' turno. Ritorna quante ne ha marcate, che e' anche il
   * numero della riga di log.
   */
  markInterrupted(args: { taskIds: string[]; by: string }): number;
  /**
   * «Qui non verra' nessuno», detto una volta sola.
   *
   * Il cancello del recupero riprende solo i chip `working|starting|queued`:
   * una `in_progress` con chip `null` / `needs_input` / `delivered` viene
   * saltata a ogni giro PER SEMPRE, senza una riga, senza un commento. Questa
   * nota e' quella riga, e ha due guardie che la rendono onesta:
   *
   *  - esce solo se la card porta `interrupted_at`, cioe' solo se e' il server
   *    ad averla tagliata: una card trascinata a mano in In Progress da una
   *    persona non e' un'orfana e non riceve niente;
   *  - esce UNA volta per interruzione (`interrupted_notified_at`), perche' il
   *    reconcile ripassa ogni 10 secondi e ripeterla sarebbe rumore.
   *
   * Ritorna la nota scritta, oppure `null` se una delle due guardie ha chiuso.
   */
  noteStranded(args: { taskId: string; note: string }): TaskComment | null;
  /** Human-only review decision on a task sitting in `review`. */
  reviewDecision(args: { taskId: string; by: string; decision: "approve" | "reject"; comment?: string; projectId?: string; origin?: TaskActionOrigin }): Task;
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
    /**
     * The reason line is a quiet note: a hand-over written by the plumbing after
     * the agent spoke (the node lane) must not end the scan for the agent's
     * question, or its buttons vanish. System questions stay loud elsewhere.
     */
    quietReason?: boolean;
    /** The commit this turn hands in, when the caller knows it (node lane). Same as the one sent back + no summary = no review. */
    deliveredTip?: string | null;
    /**
     * How many files the worktree changed WITHOUT committing them, counted now.
     * `undefined`/`null` = nobody could measure it, which the sheet reads
     * differently from zero: zero is "there is nothing to save", null is "I do
     * not know". The caller (the dispatcher) already owns the probe.
     */
    uncommittedFiles?: number | null;
    /**
     * The assistant row the recovered words come from, when the note carries
     * any. Absent on a note that quotes nothing, which is most of them.
     */
    messageId?: string | null;
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
   * THE DURATION CAP ON A WAIT SERIES, judged from OUTSIDE a turn.
   *
   * `WAIT_SERIES_MAX_MS` (4 hours) had exactly one reader in the whole repo,
   * inside `deferForWait` — which runs only when another turn starts and
   * re-declares the same wait. If the dispatcher stops admitting anybody, the
   * series keeps growing and nothing looks at it: measured 2026-09-17 on the
   * live DB, 2 cards past the cap by 45 and 31 hours, zero `waited_out` parks
   * in the whole history, and `waited_out` is the only state that reaches a
   * push notification.
   *
   * Returns the parked task, or null when the series is still inside the cap
   * (the normal case). The STREAK cap stays where it is: it can only change
   * when a turn declares a new wait, so it has no blind window.
   *
   * TWO THINGS THIS JUDGE MUST NOT DO, and both are about a SINGLE long wait.
   * `deferForWait` clamps `minutes` to 1440, and production asks for a lot:
   * of the 78 retry notes on the live DB the top figures are 240, 180 and 120
   * minutes. So a lone wait can legitimately outlive the 4-hour cap, and
   * inside `deferForWait` it never tripped it — there `serieMs` is 0 on the
   * first declaration, and the cap only ever judged a SERIES. From outside,
   * reading `wait_since` alone, a single 8-hour wait gets parked after 4 hours
   * and the note it receives claims one wait in a row, four hours old —
   * neither a series nor an expired one. Hence: the wake-up the agent asked
   * for (`dispatch_deferred_until`) is never overtaken, and for a streak of
   * one the cap's clock starts at that wake-up instead of at the declaration.
   *
   * AND THE SERIES HAS TO BE STILL RUNNING. `deferForWait` writes the window
   * on every declaration, `claim` nulls it: with `wait_since` set, a NULL
   * window says a turn has already restarted and did not ask to wait again.
   * The series ended there, and no dispatcher requeue clears `wait_since` to
   * say so. Reading it the other way parked a card that `origin/main` starts.
   */
  waitedOutIfCapped(args: { taskId: string }): Task | null;
  /**
   * The same judgement over the whole board, for the pass that already walks
   * card by card. `eligible` decides board by board, for the same reason as
   * `sweepParkedChildren`; `busy` is the caller's own live-turn registry — a
   * card whose turn is running right now is not waiting on anything, and
   * parking it would cut that turn in half.
   */
  sweepWaitedOut(args?: { eligible?: (projectId: string) => boolean; busy?: (taskId: string) => boolean }): Task[];
  /** Cards parked `waited_out` by a MACHINE wait (node down, PC asleep), put back in todo after a doubling delay, up to `MACHINE_RETRY_CAP` times. */
  sweepMachineWaitedOut(args?: { eligible?: (projectId: string) => boolean }): Task[];
  /** Cards parked only because their board could not be mapped to a project directory, put back in todo once `resolvable(projectId)` says it maps again. */
  sweepUnresolvedProjectParked(args: { resolvable: (projectId: string) => boolean }): Task[];
  /**
   * Cards that sat in backlog past `UNOWNED_BACKLOG_MS` with nobody on them
   * (`UNOWNED_BACKLOG_SQL`). Each one is returned ONCE per round: the sweep
   * stamps `unowned_alerted_at` before returning it, without touching
   * `updated_at`, so the next pass skips it until somebody touches the card
   * again. It changes nothing else on the card: telling the coordinator is the
   * caller's job. No board filter: an unowned card is unowned whatever the
   * board's dispatch switch says.
   */
  sweepUnownedBacklog(): Task[];
  /**
   * Esegue la risposta umana allo stallo. `requeue` manda i figli parcheggiati
   * in `todo`; `archive` li archivia; `promote` toglie loro il padre e li mette
   * in coda come task indipendenti. In tutti i casi il padre torna in coda col
   * chip `queued` e col budget dei tentativi azzerato — la risposta è un
   * mandato nuovo, come il trascinamento in Todo.
   *
   * Perché `promote` esiste, in una riga: un figlio in `todo` resta fermo lo
   * stesso (il dispatcher lista `rootsOnly`), quindi `requeue` non lo muove;
   * senza il padre, invece, la coda lo serve come qualunque altra card. È il
   * gesto che l'envelope ordina già all'agente.
   *
   * Ritorna `null` quando la domanda non è più sulla card — è uscita da review,
   * o non ha più figli fermi — cioè quando qualcun altro ha già risposto: il
   * chiamante non deve inventarsi un esito.
   */
  resolveParkedChildren(args: {
    taskId: string;
    decision: ParkedChildrenDecision;
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
  /** True when the card is archived (soft-deleted). Optional so fakes need not implement it. */
  isArchived?(taskId: string): boolean;
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

  /**
   * The OPEN card (not done, not archived) of a board that already says this
   * very thing: same normalized title, or same idempotency key. Exact only; the
   * fuzzy neighbours stay with `findDuplicates`.
   */
  findOpenTwin(args: { projectId: string; text?: string; idempotencyKey?: string | null; rootsOnly?: boolean }): Task | null;

  archive(args: { taskId: string; projectId?: string }): Task;
  /**
   * Unhooks the open children (not archived, not done) of `taskId` so they
   * become root cards again, keeping their status. Called by the board DELETE
   * before `archive`, which would otherwise take them down with the parent.
   * Returns the ids it unhooked.
   */
  detachOpenChildren(args: { taskId: string; projectId?: string }): string[];
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
   * label), plus the delivery the chat's changed-files strip anchors a pruned
   * worktree's range on, how many files the review measured in it, and the
   * branch of the latest attempt launched in THIS topic (its worktree's, the
   * only name left of a pruned folder when no delivery was recorded). Same
   * resolution as boardProjectForTopic (prefer non-archived, most recent).
   * Null when the topic owns no task (a normal chat, not a dispatch).
   */
  taskForTopic(topicId: string): {
    id: string;
    projectId: string;
    text: string;
    deliveryBranch: string | null;
    deliveryCommit: string | null;
    deliveryFiles: number | null;
    attemptBranch: string | null;
  } | null;
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
    /** Only a validated light no-local-check exemption may share with a heavy turn. */
    noCheckExemption?: boolean;
    /**
     * The card runs on another machine (a paired node, Cloud Claude). The
     * weight rules and the cap measure THIS machine, so a remote claim skips
     * them: it is still the status CAS, with the same attempts, deferral and
     * blocker guards.
     */
    remote?: boolean;
  }): Task | null;
  /**
   * The overflow dispatch's move (`dispatch-overflow.ts`): the card goes to
   * `machineId` and is stamped `overflowed_at`, in ONE compare-and-set. It
   * applies only to a card still waiting here: in `todo`, unbound, not marked
   * "this Mac only", and running on this machine (`machine_id` NULL or
   * `localMachineId`). `null` = it did not apply (it moved, a person picked a
   * machine meanwhile), and the caller leaves it alone.
   */
  overflowToMachine(args: { taskId: string; machineId: string; localMachineId: string | null }): Task | null;
  /**
   * How many live cards name `machineId` (Todo or in progress, not archived),
   * across every board: what the overflow counts against a machine's slots.
   * A card waiting for a silent node is in Todo, so it counts.
   */
  countOnMachine(machineId: string): number;
  /** Cards already running on the machine (in progress), not counting `exceptTaskId`. */
  countRunningOnMachine(machineId: string, exceptTaskId?: string): number;
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
   *
   * THE COUNT DEPENDS ON WHO WAITS. An agent's wait costs a whole turn when
   * it restarts, and stops at the second one (`AGENT_WAIT_STREAK_CAP`); a
   * machine's wait (`source: "machine"`, the silent node) opens no turn and
   * keeps the wide cap (`WAIT_STREAK_CAP`).
   */
  deferForWait(args: { taskId: string; reason: string; minutes?: number; by?: string; source?: "agent" | "machine" }): Task;
  /** Overwrite the topic binding of a claimed task (dispatcher: placeholder → real topic). */
  bindTopic(args: { taskId: string; topicId: string; freshSession?: boolean }): Task;
  /** The run this card last created on a paired node (persisted, survives a restart), or null. */
  nodeRunOf(taskId: string): string | null;
  /** Remember (or forget, with null) the card's run on a paired node. */
  setNodeRun(taskId: string, runId: string | null): void;
  /** True while the card's run on a node is open (created and not yet landed or cancelled). */
  nodeRunIsOpen(taskId: string): boolean;
  /** The run came home (its delivery landed): the id stays for the next cancel, but nothing is running. */
  closeNodeRun(taskId: string): void;
  /**
   * Cards out of the cycle (done or archived) that still remember a node run: their mirror on the
   * node is still open. Optional so fakes need not implement it.
   */
  retiredNodeRuns?(): { taskId: string; runId: string; machineId: string | null; capabilityId: string | null }[];
  /** Update just the dispatch state/error (queued|starting|working|needs_input). */
  setDispatchState(args: { taskId: string; state: string | null; error?: string | null }): Task;
  /**
   * The CI phase (`integration-queue.ts`): `who` records that the work goes to
   * main and puts the card in the `ci` column when it is in review; `null`
   * clears both (a person's reject, a landed card).
   */
  setLandIntent(args: { taskId: string; who: "human" | "auto" | null; inCi?: boolean }): Task;
  /** Persist the model actually resolved for a run (auto-pick → concrete id) so
   *  the card stops showing "auto" once the agent has run. */
  setModel(args: { taskId: string; model: string | null; effort?: string | null }): Task;
  /**
   * Ricorda il peso letto dal classificatore (migration 090). È il promemoria
   * che permette al CLAIM di decidere: il giudice parla al lancio, il gate serve
   * un passo prima, quindi la seconda volta il claim sa già con cosa ha a che
   * fare. `null` cancella (torna a «mai classificato» = leggero).
   */
  setDispatchWeight(args: { taskId: string; weight: TaskWeight | null }): Task;
  /** Toglie l'anteprima e scrive sulla card PERCHÉ (stato, non messaggio). */
  retirePreview(args: { taskId: string; reason: string }): Task;
  /**
   * Disegna la SCHEDA DI CONSEGNA sulle card in review rimaste senza anteprima
   * e torna quante ne ha coperte. Serve all'avvio: le card gia' ferme in review
   * quando questo codice e' arrivato non passano piu' da nessuna transizione,
   * e sarebbero rimaste cieche per sempre.
   */
  sweepReviewPreviews(): number;
  /**
   * Scrive l'esito della sonda sull'output_url.
   * Chiamato dal background probe trigger dopo ogni sonda HTTP.
   */
  setUrlProbeStatus(args: { taskId: string; status: 'live' | 'dead' | 'unknown'; checkedAt: string }): Task;
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
  raiseAgentUsage(args: {
    taskId: string; tokens: number; cacheReadTokens: number;
    /**
     * The absolute spend in USD cents, same floor discipline as the tokens.
     * Optional because not every caller can price what it read: absent means
     * «I do not know», which must never lower a number somebody else knew.
     */
    costCents?: number;
    /** Cost-equivalent tokens whose model had NO price list, so the cents above
     *  do not contain them. Absolute, like the rest. */
    unpricedCostTokens?: number;
  }): Task;
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
    /** A che punto e' la corsa: quanti comandi FINITI su quanti dichiarati.
     *  Serve alla card, che diceva «check in corso» senza dire quanto manca —
     *  segnalato: «se c'e' qualcosa in corso, dovrebbe esserci un progress». */
    progress?: { done: number; total: number } | null;
    /** The pull request and the run a `github-ci:` row is waiting on, while it
     *  waits: they exist within seconds and used to reach the card only with the
     *  verdict, fifteen minutes later (run 35158365969, 22:34:48 → 22:49:48). */
    ci?: { prUrl: string; runUrl?: string } | null;
  }): Task;
  /**
   * Spegne le spie «running» rimaste accese.
   *
   * Una corsa di check vive nel processo (`services/checks-gate.ts`): se il
   * server muore mentre gira, nessuno scriverà mai il suo verdetto e la card
   * resta a filare per sempre. `running` non è uno stato che si eredita da un
   * processo morto, quindi al boot torna a «mai misurato»: chi riconsegna fa
   * ripartire i comandi, e nel frattempo la card non mente.
   *
   * WITHOUT `isLive` IT SWITCHES OFF EVERY LIGHT, which is the boot call: that
   * is the one instant when the gate's registry is empty by construction. With
   * `isLive` it only switches off the lights that registry does NOT know, which
   * is the periodic sweep - a boot was never the only way to leave one on. When
   * `measure()` (routes/tasks.ts) throws before the terminal record (the swap
   * brake, `throwIfStopping()`, any exception) the gate drops its key while the
   * row keeps saying "running" forever. Measured on 2026-09-17: 89 boots found
   * at least one light already lit (71 times 1, 16 times 2, once 4, once 6).
   *
   * Returns the ids switched off: the boot prints their number, the periodic
   * sweep needs the ids to refresh the boards that have those cards open.
   */
  clearStaleChecksRuns(isLive?: (taskId: string) => boolean): string[];
  /**
   * Take the commit away from a checks verdict, leaving its state, its time and
   * its command-by-command evidence exactly as they are.
   *
   * FOR THE LAND THAT REALIGNS. The delivery measures C, the local commands and
   * the pull request CI go green on C, the card then sits in review (1,93 h on
   * average) while main moves on - 32 lands in 7 days - and at the land
   * `tryMerge` merges C2 = merge(C, main). Nobody reads the CI of C2, and
   * `checks_commit` kept naming C as if it were what landed. Measured on 17/09:
   * 22 of those 32 lands carry the realign line and only 4 also warned that the
   * land differed from the delivery, so 18 went through silently. The verdict on
   * C stays true and stays readable; the claim that it describes the commit that
   * landed is the part that is no longer true, so it goes.
   *
   * Answers `true` when there was a commit to take away.
   */
  clearChecksCommit(taskId: string): boolean;
  /**
   * Tasks worth auditing: alive, delivered (review/done), carrying a commit —
   * e SENZA un esito testimoniato. Un verdetto scritto dal land stesso è un
   * fatto osservato mentre il ramo esisteva ancora: la passata periodica non ha
   * niente da aggiungerci, e sovrascriverlo con la propria deduzione è
   * esattamente il modo in cui `landing_state` è finito a dire `unlanded` su
   * card dimostrabilmente dentro main.
   */
  listLandingAuditCandidates(): LandingAuditCandidate[];
  /**
   * Persist a landing verdict. `witnessed` = lo scrive chi il land l'ha VISTO
   * (merge uscito zero, o fallito), non chi lo deduce dopo: quel verdetto
   * diventa definitivo finché la card non riconsegna.
   */
  recordLandingState(args: { taskId: string; state: "landed" | "unlanded" | "unverifiable" | "superseded" | "unpushed"; checkedAt: string; witnessed?: boolean }): void;
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
  /** OFFERS the deploy (comment + "Deploya ora"), never runs it: `deploy_state
   *  = 'proposed'`, command frozen. `null` if the task no longer exists. */
  proposeDeploy(args: { taskId: string; command: string }): Task | null;
  /** Human clicked "Deploya ora": CAS-claims the proposal (`proposed` →
   *  `running`) and returns the frozen command. `null` if already claimed. */
  beginDeploy(args: { taskId: string }): { command: string } | null;
  /** Records the run's outcome (`deployed`/`failed`) as a plain thread comment. */
  finishDeploy(args: { taskId: string; ok: boolean; detail: string }): Task;
  /** Read the GLOBAL auto-dispatch switch (one for every board). */
  getGlobalAutoDispatch(): boolean;
  /** Flip the GLOBAL auto-dispatch switch; returns the new value. */
  setGlobalAutoDispatch(on: boolean): boolean;
  /** Read the GLOBAL concurrency cap (reserved row '*'): the ONE machine-wide
   *  budget the dispatcher enforces across ALL boards. `auto` → size it from live
   *  machine capacity; otherwise use the fixed `max`. Auto is the default until a
   *  manual number is explicitly chosen, so the machine is protected out of the box. */
  getGlobalCap(): GlobalDispatchCap;
  /** Update the GLOBAL cap (row '*': max_agents_auto / max_agents, plus the
   *  "by resources" mode and its two thresholds). */
  setGlobalCap(patch: GlobalCapPatch): GlobalDispatchCap;
  /**
   * THE TWO SPEND CAPS, and they are born OFF: zero means unlimited, and zero is
   * what a fresh install carries. The lever exists; the behaviour does not until
   * a person writes a number. Same reserved row '*' as the concurrency cap: the
   * brake belongs to the machine, and one cap per board would multiply into no
   * cap at all.
   */
  getSpendCaps(): { perTaskCents: number; perDayCents: number };
  /** Write the caps (a PERSON does this, from the settings). Zero clears one. */
  setSpendCaps(patch: { perTaskCents?: number; perDayCents?: number }): { perTaskCents: number; perDayCents: number };
  /**
   * HOW MUCH FREE MEMORY A NEW CHECK COMMAND NEEDS, in whole GB, from the same
   * reserved row '*'. It used to be a constant borrowed from the agent admission
   * floor and three times the heaviest command it guards; it is a setting now so
   * that whoever measures a different load can move it instead of inheriting it.
   * `0` switches the brake off. Applied value, clamped and defaulted.
   */
  getChecksMemFloorGB(): number;
  /** Write the floor (a PERSON does this, from the settings). */
  setChecksMemFloorGB(gb: number): number;
  /**
   * Agent spend on this machine: the rolling 24h window and the whole book, with
   * the share that could NOT be priced beside each. The unpriced number travels
   * with the money on purpose: a cap that silently ignores part of the spend is
   * decorative, so whoever draws the figure can say how much of it is missing.
   */
  agentSpend(): { cents24h: number; centsTotal: number; unpricedCostTokens24h: number; unpricedCostTokensTotal: number };
  /** When the rolling 24h spend falls back under `capCents` if nothing new is spent (epoch ms); `null` = already under, or unreadable. */
  agentSpendClearsAt(capCents: number): number | null;
}
