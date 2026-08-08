/**
 * Contratto della board: UNA dichiarazione, letta dai due lati del filo.
 *
 * Fino al 29/07 questi tipi esistevano due volte — `server/services/tasks.ts`
 * + `server/services/review-checks.ts` + `server/services/dispatch-capacity.ts`
 * da una parte, `client/src/lib/board.ts` dall'altra — e la copia del client
 * era già indietro: `BoardSettings` non conosceva `dispatchRetryCap` né
 * `dispatchRetryBackoffS`, campi che il server SCRIVE nella riga
 * `board_settings` e RIMANDA in ogni GET. Il client li riceveva e li buttava,
 * e una PATCH costruita dal suo tipo li avrebbe silenziosamente azzerati.
 *
 * Anche l'elenco degli stati era scritto tre volte (il tipo lato client, il
 * suo `TASK_STATUSES`, e la `const STATUSES` privata del server). Qui è UNO:
 * il tipo DERIVA dal valore, quindi aggiungere una colonna alla kanban senza
 * aggiornare la validazione non compila più.
 *
 * `shared/` è l'unica cartella che entrambi i progetti TS possono includere
 * senza violare il confine composite (TS6307) — vedi `shared/ws-outbound.ts`.
 */

/** L'elenco degli stati. Il tipo lo segue: una sola verità, non due gemelle. */
export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;

/**
 * Tetto al fan-out (agenti paralleli sullo stesso task). Cinque, non "quanti ne
 * vuoi": ogni tentativo è un agente vero, con il suo worktree e il suo costo, e
 * oltre questo numero il confronto smette di essere leggibile da un umano prima
 * ancora che la macchina si arrenda. Letto dal clamp del server, dal dispatcher
 * e dal selettore nel pannello impostazioni — una sola verità.
 */
export const MAX_FANOUT = 5;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Gli stati di `dispatch_state` in cui un agente sta LAVORANDO il task adesso:
 * è in coda per partire, sta partendo, o è dentro un turno. Fuori da questi tre
 * il task è fermo (`null`, `waiting`, `delivered`, `needs_input`, `exhausted`).
 *
 * Era una lista scritta a mano in cinque posti — due gate del server
 * (`services/tasks.ts`, review e spostamento di progetto) e tre della UI
 * (`TaskDetail` due volte, `Card`) — e ora anche il silenziatore delle notifiche
 * ne ha bisogno: "l'agente sta lavorando" è la stessa domanda, e va fatta una
 * volta sola. Il tipo DERIVA dal valore, così aggiungere uno stato senza
 * decidere da che parte sta non compila.
 */
export const ACTIVE_DISPATCH_STATES = ['queued', 'starting', 'working'] as const;

export type ActiveDispatchState = (typeof ACTIVE_DISPATCH_STATES)[number];

/**
 * True se su questo task c'è un agente al lavoro ADESSO (vedi ACTIVE_DISPATCH_STATES).
 *
 * È un type guard, non un `boolean`: così `ActiveDispatchState` ha un
 * consumatore vero invece di essere un export dichiarativo che nessuno annota,
 * e nel ramo `true` il chiamante ha in mano uno dei tre stati — non una stringa
 * qualunque. È questo che rende reale la garanzia promessa qui sopra.
 */
export function isAgentWorking(
  dispatchState: string | null | undefined,
): dispatchState is ActiveDispatchState {
  return (ACTIVE_DISPATCH_STATES as readonly string[]).includes(dispatchState ?? '');
}

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
   */
  kind: 'comment' | 'status' | 'review-note';
}

/** Un comando del gate pre-review dichiarato nelle impostazioni della board. */
export interface ReviewCheck {
  name: string;
  cmd: string;
}

/** Esito di UN comando. `tail` è la coda dell'output combinato (stdout+stderr). */
export interface CheckRun {
  name: string;
  cmd: string;
  ok: boolean;
  /** Exit code; null se è stato ucciso (timeout o abort) o mai partito. */
  code: number | null;
  ms: number;
  timedOut: boolean;
  tail: string;
  /** Valorizzato solo se il comando non è nemmeno partito (binario assente, cwd sparita). */
  spawnError?: string;
}

/** Config di dispatch per board (riga `board_settings`). */
export interface BoardSettings {
  projectId: string;
  /**
   * Interruttore GLOBALE (riga riservata `project_id='*'`), esposto qui perché
   * ogni lettura per-board continui a gattare il dispatch senza sapere della
   * riga globale. Scriverlo via updateBoardSettings lo ribalta per TUTTE le board.
   */
  autoDispatch: boolean;
  /** Tetto di concorrenza = quanti task possono avere un agente vivo su questa board. */
  maxAgents: number;
  /**
   * Se true il tetto è auto-dimensionato dalla capacità viva della macchina
   * (dispatch-capacity.ts) e `maxAgents` è ignorato dal dispatch (resta come
   * valore manuale di ripiego).
   */
  maxAgentsAuto: boolean;
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
  dispatchTimeoutMin: number;
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
  /** Load average a 1 minuto (vivo). */
  load1: number;
  /** Spiegazione in una riga di come `recommended` è stato derivato. */
  reason: string;
}
