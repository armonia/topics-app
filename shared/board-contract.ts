import type { GlobalDispatchCapExtras } from './dispatch-pressure';
import { TaskStatus } from './board-base';


export const TASK_ACTION_ORIGINS = ['interface', 'mcp', 'api', 'system'] as const;
export type TaskActionOrigin = (typeof TASK_ACTION_ORIGINS)[number];

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  mentions: string[];
  /** File allegati: path assoluti da /api/upload, serviti via /api/media. */
  media: string[];
  createdAt: string;
  /**
   * 'comment' = un messaggio umano/agente. 'status' = un evento di transizione
   * scritto dal servizio a ogni scrittura di stato (contenuto "from→to", autore
   * = chi l'ha mosso): il thread fa anche da storico. Gli eventi 'status' non
   * contano mai come "l'ultima parola dell'agente" (gate di review, chip
   * delivered/needs_input).
   * 'review-note' = evidenza di review scritta dalla macchina (es. l'esito dei
   * check, lo screenshot di anteprima). Come 'status' non è l'ultima parola
   * dell'agente e — cosa che conta — non passa mai dal path umano POST
   * /comments, quindi non innesca reject+resume: informa il reviewer senza
   * svegliare l'agente.
   *
   * 'service' = the dispatcher's own bookkeeping (a retry, a server restart, a
   * queue hold). Set AT THE SOURCE by the writer, which already knows it is not
   * speaking for the agent, so the thread can fold a run of it into one line
   * without matching on wording. Like 'status' it is never the agent's last
   * word. See `shared/task-comment-service.ts` for how the fold reads it, and
   * why rows written before the mark are classified separately.
   *
   * 'delivery' = THE DELIVERY STATEMENT, the one the reviewer opened the card
   * for. It is a plain word like 'comment' (it travels, it is thread speech, it
   * is never folded), with one difference: it is DECLARED, so the card can
   * prefer it over recency instead of guessing which of the turn's comments was
   * the summary. The guessing is what failed — the last thing an agent writes
   * before delivering is usually git plumbing, and that is what a review card
   * showed as the delivery:
   * "terzo commit: il rosso di check:security chiuso alla fonte". allow-italian: verbatim from a real card
   * Written by ONE writer: `update({status:'review'})` from the
   * summary the agent hands over. Nothing else may set it.
   */
  kind: 'comment' | 'status' | 'review-note' | 'service' | 'delivery';
  /**
   * THE ASSISTANT MESSAGE THIS ROW WAS SAID IN, when a session said it.
   *
   * A comment an agent writes (`comment_task`, a delivery summary, a routed
   * question) happens DURING a message of its own transcript, and the id of
   * that message is what lets a reader draw the words once instead of twice:
   * the card thread and the session are two lists of the same turn, and
   * without the anchor the only thing relating them is the clock.
   *
   * Absent is not an error and never was one: everything written before the
   * column existed, and everything a person writes, carries nothing here. A
   * reader treats it as "no anchor" and draws both rows.
   */
  messageId?: string | null;
  /**
   * The surface that actually produced this row. Missing means the historical
   * writer did not record it, so readers must not guess from the author.
   * Presentation only: authorization continues to use the verified request
   * session and the service's Actor argument.
   */
  origin?: TaskActionOrigin | null;
  /**
   * THIS ROW IS A NOTE, NOT A REPLY.
   *
   * The writer said so: `POST /tasks/:id/comments` takes `quiet: true`, the
   * gesture for «I am leaving a trace, I am not answering». It has always
   * stopped the row from waking the agent; what it did NOT do was survive the
   * write, so a reader could not tell a note from an answer afterwards.
   *
   * That gap cost a card on 2026-09-12: a quiet note posted under an open
   * question took the question's option buttons away, because
   * `pendingQuestionComment` walks backwards and stops at the first human word.
   * The note stayed readable, the three choices stayed written, and there was
   * no longer anything to click.
   *
   * A MACHINE writes it too, and for the same sentence. The outbound trace
   * («Mail inviata…», «Invio NON partito…») is a fact of the card that can land
   * under a confirmation another request is still waiting on, and unmarked it
   * took that question's buttons away exactly as the note above did - with
   * them, the `answerTo` the drawer sends, so the yes stopped naming anything.
   * See `trace` in `server/routes/outbound.ts`.
   *
   * Absent means NOT QUIET — everything written before the column existed, and
   * every ordinary reply. The unknown must never read as quiet: that would
   * revive questions a real answer had closed.
   */
  quiet?: boolean | null;
  /**
   * Resolved at READ time from `author` (`guest:<deviceId>`), never stored:
   * the person's display name and the device's own name (`devices.name`, e.g.
   * "iPhone di Attilio"), so `commentAuthorLabel`'s generic 'guest' placeholder
   * becomes a name a reader recognises. Null for every row that is not a
   * collaborator's own write, or whose device/person no longer resolves
   * (revoked, deleted) — the caller falls back to the placeholder then.
   */
  actorPersonName?: string | null;
  actorDeviceName?: string | null;
}

/**
 * A card comment carries its displayed fields and, when present, the assistant
 * message anchor needed to relate a question to its delivery summary.
 *
 * È la forma con cui gli ultimi commenti viaggiano SULLA LISTA della board
 * (`Task.recentComments`), non nel thread: `id`, `taskId`, `createdAt`,
 * `mentions` e `media` la card non li tocca, e moltiplicati per tre commenti su
 * ogni scheda erano metà del peso di quel pezzo del feed (731 KB misurati il
 * 15/08/2026). Chi apre il thread riceve `TaskComment` interi, da `svc.get`.
 *
 * `Pick` e non una seconda interfaccia: il tipo dei campi deve restare
 * quello del thread, o `kind` diventa una `string` da una parte e un'unione
 * dall'altra senza che niente lo dica.
 */
export type CardComment = Pick<TaskComment, 'author' | 'content' | 'kind' | 'messageId' | 'origin' | 'actorPersonName' | 'actorDeviceName'>;

/**
 * Il bloccante di un task, RISOLTO dal server leggendolo dal DB.
 *
 * Esiste perché il chip «in attesa di» non può dipendere da chi c'è nella lista
 * che il client ha in mano: la board fetcha UN progetto, `rootsOnly`, non
 * archiviati — un bloccante fuori da quel taglio (un sottotask, un task di un
 * altro progetto, uno archiviato) non si trovava, e il chip spariva anche se il
 * legame c'era eccome. `status` e `archived` sono i due bit che decidono se il
 * chip va ancora disegnato: chiuso o archiviato = non blocca più (lo stesso
 * predicato del gate di dispatch, `isDispatchBlocked`).
 */
export interface BlockerRef {
  id: string;
  text: string;
  status: TaskStatus;
  archived: boolean;
}

/** Un comando del gate pre-review dichiarato nelle impostazioni della board. */
export interface ReviewCheck {
  name: string;
  cmd: string;
}

/**
 * The e2e evidence row (KANBAN-84): not a shell command. The delivery gate reads
 * the e2e jobs of the pull request CI for the delivered commit instead of running
 * Playwright here. Spelled as a command so the settings field, which rebuilds each
 * row as `{ name: cmd, cmd }`, keeps it intact.
 */
export const E2E_CI_CHECK: ReviewCheck = { name: "e2e-ci", cmd: "github-ci:e2e" };

/**
 * The unit evidence row: the step "Unit + integration tests" of the `check` job
 * in the same pull request CI run the e2e row reads. On 15/09/2026 one card
 * inside `test:unit:shards` held a 2.4-11 GB tree on the owner's Mac; the same
 * suite already runs on every pull request.
 */
export const UNIT_CI_CHECK: ReviewCheck = { name: "unit-ci", cmd: "github-ci:unit" };

/** The typecheck, lint and static guard-rail evidence row from the `gates` CI job. */
export const GATES_CI_CHECK: ReviewCheck = { name: "gates-ci", cmd: "github-ci:gates" };

export function isCiEvidenceCheck(check: { cmd: string }): boolean {
  const cmd = check.cmd.trim();
  return cmd === E2E_CI_CHECK.cmd || cmd === UNIT_CI_CHECK.cmd || cmd === GATES_CI_CHECK.cmd;
}

/**
 * How many check slots a board has. The reasoning for the NUMBER lives with the
 * code that enforces it (`server/services/review-checks.ts`, which re-exports
 * this); what lives here is the fact that the CARD AND THE PANEL read it too.
 *
 * It is here since 2026-09-19 because `BoardSettingsPanel` could not import it
 * from the server and wrote `{checks.length}/5` by hand. The cap became six on
 * 12/08/2026 and that literal did not: the live board declares six checks, so
 * the counter next to the field has been reading "6/5" ever since - a limit the
 * panel shows one BELOW the one actually enforced, on the exact field whose
 * silent truncation is why the cap is written down at all.
 */
export const MAX_CHECKS = 6;

/**
 * THE EXIT CODE THAT SAYS "I DID NOT MEASURE", not "you got it wrong".
 *
 * The gates that cannot even start use it: `typecheck-server.ts` when `tsc` is
 * missing, `check-client-deps.ts` when `eslint` is. It happens in every dispatch
 * worktree, because `git worktree add` copies the TRACKED files and
 * `client/node_modules` is not one — measured on 18/08/2026: 95 worktrees out
 * of 103 without it. Without this number those gates exited 1, indistinguishable
 * from a real red, and the card wrote `checks_state = 'fail'` on branches that
 * often had no commit at all.
 *
 * Here and not in `review-checks.ts` because the CARD reads it too: a row stored
 * before `notMeasured` existed carries only this code, and drawn as `exit 97` it
 * sends whoever reviews looking for a failure that is not there.
 */
export const NOT_MEASURED_EXIT = 97;

/** Esito di UN comando. `tail` è la coda dell'output combinato (stdout+stderr). */
export interface CheckRun {
  name: string;
  cmd: string;
  ok: boolean;
  /** Exit code; null se è stato ucciso (timeout o abort) o mai partito. */
  code: number | null;
  ms: number;
  timedOut: boolean;
  /**
   * Il comando ha DICHIARATO di non aver misurato (uscita 97): `tsc` o `eslint`
   * non c'erano, cioè un worktree senza `bun install` in client/. Campo suo e
   * non `timedOut`, perché dire «fermato oltre il tempo massimo» di un binario
   * che non esiste sarebbe una bugia, e il testo del commento la ripeterebbe.
   */
  notMeasured?: boolean;
  /**
   * A CI evidence row with nothing of its own to measure: the delivery's
   * commit beyond `main` is zero, so there is no push and no pull request CI
   * to read. `ok: true` (it does not block a delivery), but distinct from a
   * real pass so the card never claims a verdict GitHub never gave — see
   * `ciSkipped` in `ci-evidence.ts`.
   */
  skipped?: boolean;
  /**
   * Time the command spent queueing for a gate slot before it started (read
   * from the line `slot.ts` prints, see shared/slot-acquired.ts). Not counted
   * against the check's cap; shown so a slow verdict names the queue, not the
   * code.
   */
  queuedMs?: number;
  /**
   * The slowdown the command DECLARED before starting (see
   * shared/gate-slowdown.ts): fewer shards on a loaded machine, so the cap was
   * multiplied by this much. Shown so a run that took 30 minutes says which
   * plan it was given, instead of looking like a cap that was never enforced.
   */
  slowdown?: number;
  tail: string;
  /** Valorizzato solo se il comando non è nemmeno partito (binario assente, cwd sparita). */
  spawnError?: string;
  /**
   * A CI evidence row (KANBAN-86) whose own reading was GREEN and whose run is
   * red somewhere no row looks at: the job and the step that failed. The row
   * keeps in `tail` what it measured and stops being a green, so the card's
   * verdict is not `pass` on a commit whose CI is red. It is here and not in
   * `ci-evidence.ts` because the comment of the card names the failure, and
   * "e2e red on the pull request CI" would be the wrong sentence for it.
   */
  ciRunRed?: string;
  /**
   * The head sha of the pull request CI run a CI evidence row was read from.
   * The gate compares it with the commit it is measuring, so a row that
   * describes an earlier head can never be written as a verdict of this one.
   */
  ciCommit?: string;
  /**
   * A NOT MEASURED CI row whose cause passes by itself: no verdict before the
   * deadline, GitHub reads failing, a push or a draft refused by the network.
   * The same commit measured again can give a verdict, so the delivery waits
   * again instead of going back to its agent (`ciRemeasurable` in ci-evidence.ts).
   */
  transient?: boolean;
}

/** Config di dispatch per board (riga `board_settings`). */
export interface BoardSettings {
  projectId: string;
  /**
   * The GLOBAL switch (reserved row `project_id='*'`), surfaced here so every
   * per-board read keeps gating dispatch without having to know about the global
   * row. Writing it through updateBoardSettings flips it for EVERY board.
   */
  autoDispatch: boolean;
  //
  // NO per-board concurrency cap. There is ONE cap, machine-wide, living on the
  // reserved row `project_id='*'` (`readGlobalCap` -> `getGlobalCap`): the one
  // the dispatcher reads in `currentCap()` and the one the spawn core quota
  // divides. A per-board `maxAgents` existed here until 2026-08-13: the route
  // wrote it, the panel read it back, and it decided NOTHING. Measured on the
  // live DB that day: the topics-app row said 9 while the real cap (row '*') was
  // 8, so the panel showed a limit one higher than the one being enforced.
  // The `max_agents` column stays in the DB for boards (dropping a column needs
  // a migration): it stays, and nothing writes or reads it any more.
  //
  dispatchEffort: string;
  dispatchUseWorktree: boolean;
  /**
   * Merge automatico del branch del worktree nel checkout principale del progetto
   * quando un umano approva (review → done). Programmatico: un merge pulito landa
   * in LOCALE (MAI push); un conflitto restituisce il branch all'agente del task;
   * un checkout non pronto (sporco / non su main) viene saltato. Default OFF —
   * nessuna board esistente cambia comportamento finché non lo si accende. Ha
   * senso solo con `dispatchUseWorktree` acceso (un task in-place non ha branch).
   */
  dispatchAutoMerge: boolean;
  /**
   * The generic analogue of `dispatchAutoMerge` for a board whose "done" does
   * not mean "merge to main" but "run this deploy script" — an external
   * project (a static site, a worker) with its own `deploy` in package.json.
   * Empty string = OFF, the default: no existing board changes behaviour.
   *
   * The server NEVER runs it by itself. On approve, if this is set, it
   * PROPOSES the deploy (a comment + a "Deploya ora" button on the card) and
   * only runs it in the project's MAIN checkout when a human confirms — see
   * `server/services/task-deploy.ts` and `Task.deployState`.
   */
  deployCommand: string;
  /**
   * DECLASSED TO REPORTING ONLY: this used to be the wall-clock ceiling that
   * cut a turn dead. It no longer kills anything — see `dispatchIdleMin` for
   * what replaced it. Kept only as a signal a very long turn compares itself
   * against (never an action).
   */
  dispatchTimeoutMin: number;
  /**
   * Minutes of SILENCE on a session's transcript before the passive stall
   * detector asks its judge "alive or stuck?" (see `server/lib/stall-detector.ts`).
   * A silent session is NOT cut on this alone: only a judge verdict of "stuck"
   * recycles the turn (abort + resume the same session, with a system note).
   * Default 5.
   */
  dispatchIdleMin: number;
  /**
   * Fleet MCP per gli agenti dispatchati su questa board (migration 049).
   * 'bridge-only' (il default NULL) = solo il bridge topics, profilo tool di
   * dispatch — gli schemi dei tool del fleet globale non entrano mai nel contesto
   * dell'agente. 'inherit' = via di fuga: la sessione eredita il fleet MCP completo
   * dell'utente (per board i cui task hanno davvero bisogno di quei tool).
   */
  dispatchMcp: string;
  /**
   * Modello di default per gli agenti dispatchati su questa board.
   * 'auto' (il default NULL) → il classificatore sceglie un modello per task
   * (comportamento storico). Un id concreto (es. 'claude-opus-4-8') inchioda ogni
   * dispatch di questa board a quello. Un modello esplicito sul task vince comunque
   * sul default della board.
   */
  dispatchModel: string;
  /** AICTRL-05: default board dello switch, asse separato da `dispatchModel`, che non tocca mai. `null` = nessuna scelta qui: decide il task, o in ultimo il prefisso legacy. allow-italian: ordine di risoluzione del default */
  dispatchTopicsRouting: boolean | null;
  /**
   * Default execution machine of this board. `null` (the default) = no rule: a
   * card runs here unless it names a machine itself. A machine id = every card
   * CREATED on this board without an explicit `machineId` gets this one (a
   * paired node, or the local machine meaning "here"). Existing cards are not
   * touched. Written only for a paired node whose repository the node can find
   * by its git origin, see the PATCH route.
   */
  dispatchMachineId: string | null;
  /**
   * Overflow dispatch, ON by default: a card that would run here and has been
   * held by this machine's memory floor for more than two minutes moves to the
   * first online machine (Cloud Claude with credit, else a paired node). See
   * `server/services/dispatch-overflow.ts`.
   */
  dispatchOverflow: boolean;
  /**
   * Every card of this board touches this Mac itself (local processes,
   * Jarvis, sessions, macOS): the overflow never moves them. The same mark
   * a single card carries as `stayLocal`.
   */
  dispatchStayLocal: boolean;
  /**
   * Twice a day a cheap model sorts the backlog of this board: a card an agent
   * can do goes to todo, one that needs a person gets a question, one already
   * done closes only with a proof a second model confirmed, the rest stays with
   * a reason. Off by default.
   */
  backlogTriage: boolean;
  /**
   * Lingua in cui rispondono gli agenti dispatchati su questa board.
   * 'inherit' (il default NULL) → vale la preferenza globale
   * (`app_settings.output_language`), che e' anche quella di chat e terminale:
   * cosi' «uguali» significa LO STESSO VALORE EFFETTIVO, non due valori da
   * tenere allineati a mano. Un valore concreto ('it' | 'en') e' l'override —
   * una board di un cliente inglese non deve costringere il resto dell'app a
   * cambiare lingua.
   */
  language: string;
  /**
   * Fan-out: quanti agenti lavorano IN PARALLELO lo stesso task, ognuno nel
   * proprio worktree, prima che l'umano scelga quale tenere (migration 065).
   * 1 (il default) = un agente, il path storico byte per byte. >1 occupa N slot
   * del tetto globale di concorrenza, perché sono N agenti veri.
   * Ha senso solo con `dispatchUseWorktree` acceso: senza isolamento gli N
   * agenti si pesterebbero i piedi nella stessa cartella.
   */
  dispatchFanOut: number;
  /** Tentativi di lancio prima che un task venga parcheggiato (default 2). */
  dispatchRetryCap: number;
  /** Backoff (s) prima di riprendere un turno morto più in fretta di così (guardia outage, default 60). */
  dispatchRetryBackoffS: number;
  requireApprovalForDone: boolean;
  requireReviewBeforeDone: boolean;
  /**
   * Comandi che devono essere verdi perché una consegna entri in review, eseguiti
   * dal server nel worktree del task. Lista vuota = gate spento, che è il default:
   * niente si inferisce da package.json (`npm test` qui è la suite E2E, venti
   * minuti — un default così verrebbe spento il primo giorno).
   */
  reviewChecks: ReviewCheck[];
  /**
   * Modalità notturna: dispaccia la coda solo mentre la macchina è scarica, e
   * si ferma a `nightModeUntil`. La accende una PERSONA — il senso è «vado
   * via», e nessuna euristica lo sa. Default spento.
   */
  /**
   * Questa board e' in pausa: il tick la salta, le altre continuano.
   *
   * Puo' solo FERMARE, ed e' l'unico verso che regge: il dispatch parte se
   * l'interruttore globale e' acceso E questa board non e' in pausa. Una board
   * «non in pausa» con il globale spento non dispaccia niente. Due interruttori
   * che possono entrambi ACCENDERE si contraddicono, e chi guarda non sa quale
   * dei due sta leggendo.
   *
   * Diverso da `nightMode`, che e' condizionale (aspetta che la macchina sia
   * scarica) e si spegne da solo a un orario. Questo e' una scelta secca e
   * resta finche' qualcuno non la toglie.
   */
  dispatchPaused: boolean;
  nightMode: boolean;
  /** Quando smettere, `HH:MM` locale. Vuoto ⇒ nessuna fine (sconsigliato: un
   *  turno che non sa finire resta armato il giorno dopo). */
  nightModeUntil: string;
  /** Quando è stata accesa (ISO). Serve a capire se «fino alle 10:00» significa
   *  stamattina o domani mattina. */
  nightModeStartedAt: string | null;
}

/**
 * Cosa si può SCRIVERE nelle impostazioni. DERIVATO da `BoardSettings`, non
 * riscritto: un campo nuovo lassù o diventa patchabile da solo, o finisce
 * esplicitamente in questo `Omit` con il motivo scritto. (La copia a mano del
 * client — `BoardSettingsPatch` — aveva già perso i due `dispatchRetry*`.)
 *
 * Fuori: `projectId`, che è la chiave e sta nell'URL; e i due `require*`, che
 * nessun writer tocca — `updateBoardSettings` non li scrive, si leggono soltanto.
 */
export type BoardSettingsPatch = Partial<
  Omit<
    BoardSettings,
    // `nightModeStartedAt` lo TIMBRA il server quando l'interruttore si accende:
    // lasciarlo scrivere al client significherebbe poter datare l'accensione a
    // piacere e spostare la scadenza — cioè disarmare il turno dall'esterno.
    'projectId' | 'requireApprovalForDone' | 'requireReviewBeforeDone' | 'nightModeStartedAt'
  >
>;

/** Capacità viva della macchina per il tetto "Auto" (impostazioni board). */
export interface DispatchCapacity {
  /** Tetto di agenti concorrenti raccomandato per QUESTA macchina adesso. */
  recommended: number;
  cores: number;
  totalMemGB: number;
  /**
   * Load average a 1 minuto (vivo). NON è più il freno del tetto: è la coda di
   * esecuzione della macchina INTERA, quindi parla soprattutto delle app di chi
   * sta al computer. Resta perché la modalità notturna lo legge per un'altra
   * domanda («c'è movimento qui sopra?») e perché è il ripiego dove la sonda
   * della flotta non c'è.
   */
  load1: number;
  /**
   * Core-unità che la NOSTRA flotta sta bruciando adesso (1 = un core saturo),
   * e le core-unità che le sono concesse in tutto. `oursCores` a `null` vuol
   * dire NON MISURATO, che non è zero: senza sonda il freno vivo torna al load
   * average. Vedi `server/services/dispatch-capacity.ts`.
   */
  oursCores: number | null;
  budgetCores: number;
  /**
   * THE BUDGET, as the person set it: the share of this computer Topics may
   * use (0..1), and the same share turned into the two units the gate decides
   * in. `usableCoreUnits` is the budget capped by what the rest of the machine
   * leaves free, so the panel can say "budget 9.6, usable 4 right now" instead
   * of promising a number nobody can have.
   */
  budgetShare: number;
  budgetCoreUnits: number;
  usableCoreUnits: number;
  /** Core-units OUR whole tree is burning (agents and their gates included),
   *  and the gigabytes it holds. `null` = not measured, never zero. */
  usedCoreUnits: number | null;
  usedMemGB: number | null;
  /** Core-units everything that is not ours is burning, or `null`. */
  otherCoreUnits: number | null;
  /** How many runs are frozen right now: the budget governor's plus the swap freezer's. */
  frozen: number;
  frozenBy?: { governor: number; swapFreezer: number }; // who froze them
  /**
   * Memory REALLY available right now, in GB, or `null` where the probe has
   * nothing to say (outside macOS). It travels with the capacity because the
   * "by resources" mode draws it live next to the threshold: without it the UI
   * would show a memory threshold and be unable to say how close the machine
   * is to it, which is a slider that explains nothing. `null` is NOT MEASURED,
   * never zero.
   */
  availableMemGB: number | null;
  /** What one more agent is priced at in memory, and the share of the free
   *  memory it is compared with. `null` where memory is not measured. */
  agentCostMemGB: number;
  freeQuotaMemGB: number | null;
  /**
   * THE WHOLE MAC, as a percent of the machine (0-100): CPU busy over the last
   * interval between two readings (kernel tick counters, see
   * `server/lib/machine-cpu.ts`), and memory in use (`1 - availableMemGB /
   * totalMemGB`). They are what a person is shown as "the Mac is X% busy"
   * (the larger of the two, `machineBusyPct` on the client); the gate never
   * reads them. `null` = not measured, never 0%. Optional because an older
   * server does not send them: absent reads as not measured too.
   */
  machineCpuPct?: number | null;
  machineMemPct?: number | null;
  /** Spiegazione in una riga di come `recommended` è stato derivato. */
  reason: string;
  /**
   * Quanti agenti stanno girando ADESSO su questa macchina (i turni in volo del
   * dispatcher). È il termine che manca per trasformare `recommended` da numero
   * in consiglio: senza sapere quanti ne stanno girando, «max 2» non dice se
   * c'è qualcosa da fare o no. Zero anche quando il dispatcher non c'è (un
   * router montato senza, i test): un conteggio assente vale «nessuno».
   */
  running: number;
  /**
   * THE GATE'S OWN ANSWER to "would one more agent start right now", computed
   * by the dispatcher with the same sample, measured cost and hysteresis state
   * it admits with. The panel draws its verdict from this and from nothing
   * else: a client-side `used >= usable` ignored the cost of the agent to admit,
   * the 80% resume line and the memory axis, and said "would start" while the
   * gate was holding. In count mode it is present only while the floor or a
   * drain holds the queue. `null` or absent = nothing to say (count mode with
   * the door open), or no reading (an old server): no verdict is drawn then.
   */
  admission?: DispatchAdmission | null;
  /**
   * Every overflow-reachable machine (the cloud row and paired nodes), with
   * its declared seats and how many it is carrying now: lets a client tell
   * "the Mac is full" apart from "the Mac is full AND there is nowhere else
   * to send a card". Absent = no dispatcher, or an older server.
   */
  nodes?: { id: string; name: string; kind: "cloud" | "node"; online: boolean; slots: number; used: number }[];
}

/**
 * Read-only memory admission data returned by GET /api/dispatch/memory-queue.
 * `taskId` and `boardId` are reversible opaque references suitable for routing
 * back to task detail/actions without exposing UUID-shaped identifiers.
 * `position` follows the next round-robin dispatch pass and counts cards
 * already running ahead of this waiter, so a queue of four reads 2 of 4 after
 * the first card starts. `startGB` is the effective memory cutoff used by the
 * gate. `costGB` and `weightGB` use the dispatcher's live per-card memory cost
 * estimate, not a measured process footprint or the smaller first-card seat.
 * The same per-card state rides task:updated for dashboards and task details;
 * queue history and memory owners stay in process memory and are never stored.
 */
export type DispatchMemoryQueueReason = "waiting-memory";

export interface DispatchMemoryQueueCard {
  reason: DispatchMemoryQueueReason;
  position: number;
  total: number;
  costGB: number;
}

export interface DispatchMemoryQueueItem extends DispatchMemoryQueueCard {
  taskId: string;
  boardId: string;
}

export interface DispatchMemoryQueueSnapshot {
  reading: { freeGB: number | null; at: string | null };
  threshold: { startGB: number };
  queue: DispatchMemoryQueueItem[];
  running: Array<{ taskId: string; title: string; weightGB: number }>;
  consumers: Array<{ label: string; gb: number }>;
  history: Array<{ at: string; freeGB: number; running?: number }>;
}

/**
 * The dispatcher's admission verdict as it travels on the wire, WITH THE
 * NUMBERS IT DECIDED ON.
 *
 * The numbers are the gate's own, not a second reading: `usedCoreUnits`
 * includes the reservation for the turns admitted in the last ninety seconds,
 * and `freeQuotaMemGB` has it deducted. Without them the panel printed the bare
 * probe ("2.0 of 6.6") next to a verdict taken on "6.5 of 6.6", and no surface
 * could say a single gigabyte while memory was the axis holding the queue.
 * Every number is optional: an older server sends only the verdict, and then
 * the surfaces fall back to the capacity reading and say no number at all.
 */
export interface DispatchAdmission {
  admit: boolean;
  /**
   * Which brake said no. `floor` is the hard RAM/disk floor
   * (`dispatchResourceBlock`) and `drain` a planned restart: both hold the
   * queue in EITHER brake mode, before the budget is even asked, so they are
   * the only verdicts a count-mode reading carries. `frozen`: the budget has
   * room but a frozen check has not restarted yet, and it restarts first.
   */
  blockedBy: "cpu" | "memory" | "floor" | "drain" | "frozen" | null;
  /** The pass is owed only to nothing running yet. */
  firstAgentExempt: boolean;
  /** What one more agent is priced at, in core-units (median of measured ones). */
  costCoreUnits: number;
  /** Core-units Topics holds as the gate counts them: measured plus reserved. */
  usedCoreUnits?: number;
  /** The share of the free cores the gate admits against. */
  usableCoreUnits?: number;
  /** Admissions still counted at their estimate (launched under 90 s ago). */
  pendingAdmissions?: number;
  /** What one more agent is priced at in memory, in GB. */
  costMemGB?: number;
  /** Our share of the free memory, reservation deducted; `null` = not measured. */
  freeQuotaMemGB?: number | null;
  /** Gigabytes our tree holds, and the ceiling the footprint is compared with. */
  ourMemGB?: number;
  usableMemGB?: number;
  /**
   * Which memory clause fired when `blockedBy` is `memory`: the next agent does
   * not fit in the free quota (`quota`), or our footprint is already over its
   * ceiling (`footprint`). The two need two sentences: printing the quota when
   * the footprint fired reads "needs 1.5 GB, 4.2 GB free" and contradicts itself.
   */
  memClause?: "quota" | "footprint" | null;
  /** The sentence the floor or the drain composed, numbers included. */
  reason?: string | null;
}

/** Il tetto globale come sta scritto: `auto` (dimensionato dalla macchina) o il
 *  numero fisso. Gemello della riga riservata `board_settings['*']`. */
export interface GlobalDispatchCap extends GlobalDispatchCapExtras {
  auto: boolean;
  max: number;
}

/** Bounds of the fixed number. The same ones `readGlobalCap` clamps what it
 *  reads from the DB with: a field that accepts 40 and saves 20 lies to whoever
 *  fills it in. */
export const GLOBAL_CAP_MIN = 1;
export const GLOBAL_CAP_MAX = 20;

/**
 * NO CEILING AT ALL, written as a fixed cap of zero.
 *
 * Zero rather than a new column because a column costs a migration, and because
 * "zero agents allowed" is a setting nobody can want — the value was free.
 *
 * It is admissible only because the expensive thing is fenced elsewhere.
 * Measured with 8 agents in flight: the agents summed to 5.7% CPU (they wait on
 * the API), while their gates — seven concurrent full test suites, eslint, three
 * tsc — took the machine to a load of 38 on 12 cores. Capping agents was
 * throttling the cheap side. `scripts/slot.ts` now bounds the expensive side,
 * machine-wide and across worktrees, so the number of agents can stop standing
 * in for it.
 */
export const GLOBAL_CAP_OFF = 0;

/** True when the human asked for no ceiling (a FIXED zero — `auto` is a
 *  different answer, and means "you decide"). */
export function isGlobalCapOff(cap: GlobalDispatchCap): boolean {
  return !cap.auto && cap.max === GLOBAL_CAP_OFF;
}

/**
 * The fixed number, inside the bounds and integral. NaN means the minimum: an
 * emptied number field must never be able to write "no agents at all".
 *
 * TRUNCATION, not rounding, and that is not a detail. Three places turn this
 * value into an integer and they have to agree: here (the optimistic value the
 * client shows), `clampInt` on the way into the DB (`server/services/tasks.ts`,
 * `Math.trunc`) and `Math.floor` on the way back out
 * (`server/services/dispatch-capacity.ts`). `<input type="number">` happily
 * hands over 3.6; rounding here showed 4 while the server stored 3, so the
 * field disagreed with itself until a reload. All three floor now, and for
 * values >= 1 trunc and floor are the same function.
 */
export function clampGlobalCap(n: number): number {
  if (!Number.isFinite(n)) return GLOBAL_CAP_MIN;
  // Zero passes through untouched: it is the "no ceiling" sentinel, not a small
  // number to be pulled up to the minimum. Clamping it to 1 would silently turn
  // "run as many as you like" into "run one", which is the opposite setting.
  if (Math.trunc(n) === GLOBAL_CAP_OFF) return GLOBAL_CAP_OFF;
  return Math.max(GLOBAL_CAP_MIN, Math.min(GLOBAL_CAP_MAX, Math.trunc(n)));
}

/**
 * Quanti agenti insieme, davvero, adesso: `auto` prende la raccomandazione
 * viva della macchina, il resto prende il numero fisso. Mai sotto 1 (un tetto
 * di zero non è una board prudente, è una board ferma).
 *
 * `recommended` a `null` significa «nessuna sonda»: si ricade sul numero fisso
 * anche in auto, che è il comportamento dei test e degli host degradati.
 *
 * STA QUI e non solo nel server perché ora ha due lettori: il dispatcher, che
 * lo applica, e il pannello impostazioni della board, che scrive «3 di 8» sotto
 * gli occhi di una persona. Due copie della stessa formula sono il modo in cui
 * il numero mostrato e il numero applicato iniziano a divergere.
 */
export function effectiveDispatchCap(cap: GlobalDispatchCap, recommended: number | null): number {
  if (isGlobalCapOff(cap)) return Infinity;
  return cap.auto && recommended != null ? Math.max(1, recommended) : Math.max(1, cap.max);
}

/**
 * THE OTHER QUESTION, and it is not the same one.
 *
 * `effectiveDispatchCap` answers "may one more agent start", so "no ceiling" is
 * a real answer there. This one answers "how much of the machine does each agent
 * get" — it is the DIVISOR of the core quota — and infinity is not an answer to
 * that: it would hand every agent a slice of zero. Nor is the raw zero, which
 * `Math.max(1, 0)` would turn into 1 and give each of them the whole machine,
 * which is the same inversion the reactive recommendation already caused once
 * (measured: `-j11` per agent under load 45).
 *
 * With no ceiling the sizing question falls back to the STRUCTURAL number: how
 * many this machine sustains in regime, which is exactly what the divisor wants
 * to know and the one number that does not move with the load the agents are
 * themselves making.
 */
export function sizingDispatchCap(cap: GlobalDispatchCap, structural: number | null): number {
  if (isGlobalCapOff(cap) || cap.auto) return Math.max(1, structural ?? 3);
  return Math.max(1, cap.max);
}
