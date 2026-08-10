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

// ─────────────────────────────────────────────────────────────────────────────
// Anteprima di consegna — la regola, in UN posto solo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La card mostra l'anteprima in un riquadro `max-h-36` (144px) con
 * `object-cover object-top` dentro una colonna da 268px: un'immagine più ALTA
 * di questo rapporto non viene rimpicciolita, viene TAGLIATA in basso. È la
 * soglia oltre la quale «ho messo l'anteprima» e «il reviewer vede la cosa»
 * smettono di coincidere. Vive qui perché la stessa cifra la cita il testo del
 * protocollo (`PREVIEW_RULE`) e la misura il gate di `promoteReviewPreview`.
 * @see client/src/components/Board/PreviewMedia.tsx
 */
export const PREVIEW_CARD_MAX_RATIO = 144 / 268;

/**
 * Il gate di PROMOZIONE è più largo della soglia della card (0.7 contro 0.537):
 * promuovere è un favore che il server fa a una consegna già valida, non un
 * cancello di review, quindi taglia solo ciò che è palesemente illeggibile in
 * una card — la pagina intera fotografata — e lascia passare il quasi-quadrato.
 */
export const PREVIEW_PROMOTE_MAX_RATIO = 0.7;

/**
 * Come si sceglie l'anteprima di una consegna. **Questa stringa è la copia
 * canonica**: la citano l'envelope di kickoff, quello di resume, la descrizione
 * di `preview_image` nello schema del tool MCP, il braccio `board-sim` del
 * benchmark e §4 di `docs/board-protocol.md`.
 *
 * Prima erano cinque testi liberi di divergere, e divergevano: due soli rami,
 * entrambi su UI («statica» → screenshot, «dinamica» → video). Una consegna che
 * non ha nessuna superficie renderizzata — un piano, un'architettura, una
 * migrazione — non sta in nessuno dei due, così cadeva nel ramo «statica» e
 * l'agente FOTOGRAFAVA il documento: la card del piano-amicizia aveva come
 * anteprima l'immagine dell'intero piano, illeggibile a 268px.
 *
 * Da qui i tre rami e, soprattutto, criteri che si possono MISURARE invece di
 * aggettivi ("statica", "dinamica") su cui due agenti danno due risposte.
 * `server/services/task-dispatcher.test.ts` verifica che le copie siano ancora
 * la stessa stringa.
 */
export const PREVIEW_RULE = [
  "EVIDENZA DI REVIEW = un'ANTEPRIMA durevole nel task — update_task(preview_image=<path assoluto sotto ~/.topics/media/ o nel workspace del task; stringa vuota = azzera>), che compare come card sulla board e nel drawer. Tre rami, e a scegliere è il criterio, non l'abitudine:",
  `· SCREENSHOT .png — la consegna HA una superficie renderizzata che entra in una schermata. Catturala a viewport ≤1440×900 e con altezza/larghezza ≤ ${PREVIEW_CARD_MAX_RATIO.toFixed(3)} (=144/268: oltre quella soglia la card TAGLIA invece di rimpicciolire). Mai un full-page.`,
  "· VIDEO .webm/.mp4 ≤20s — dimostrare la consegna richiede DUE O PIÙ STATI (appare, resta, sparisce; scroll, apri/chiudi, streaming, un flusso a più passi): uno screenshot statico non prova un comportamento. Clip Playwright breve (`recordVideo: { dir }` sul context) o, se il progetto ha spec-flow, il .webm dello scenario.",
  "· DIAGRAMMA .svg — la consegna NON ha una superficie renderizzata (un piano, un'architettura, un protocollo, una migrazione): si disegna la STRUTTURA — riquadri, frecce, cinque parole per nodo — non si fotografa il documento.",
  "Una TAB del task (open_browser_pane) NON sostituisce l'anteprima: la pagina viva muore col server che la serve, l'anteprima resta.",
  "Cancello unico, e vale per tutti e tre: a 268px di larghezza (`sips -Z 268 <file>`) devi ancora saper dire cosa mostra.",
].join("\n");

/**
 * Ritaglia il blocco `PREVIEW_RULE` da un envelope già composto, per STRUTTURA
 * (prima riga «EVIDENZA DI REVIEW…», ultima «Cancello unico…») e non
 * cercandovi la costante: un test che cerca la costante che ha appena
 * interpolato non può fallire, e questo invece deve fallire il giorno in cui
 * qualcuno riscrive il testo a mano dentro un envelope.
 */
export function extractPreviewRule(envelope: string): string | null {
  const lines = envelope.split('\n');
  const from = lines.findIndex((l) => l.startsWith('EVIDENZA DI REVIEW'));
  if (from < 0) return null;
  const to = lines.findIndex((l, i) => i >= from && l.startsWith('Cancello unico'));
  if (to < 0) return null;
  return lines.slice(from, to + 1).join('\n');
}

/**
 * Il PESO di un task: quanto MORDE LA MACCHINA mentre gira, non quanto è
 * difficile. Sono due assi diversi e vanno tenuti separati — un algoritmo
 * ambiguo è `fable` e non consuma niente; un `bun run build` è banale da
 * decidere e si prende tutti i core per due minuti. Il modello dice quanto
 * l'agente deve PENSARE; il peso dice quanto l'esecuzione COSTA alla macchina
 * su cui gira, che è la cosa che lo scheduler deve sapere.
 *
 * Due valori e non una scala: quello che serve allo scheduler è una domanda
 * binaria («questo task può stare accanto ad altri, sì o no?»), e ogni gradino
 * in mezzo sarebbe un valore che nessun gate legge.
 *
 * `light` è il DEFAULT in ogni senso: è il valore di ripiego quando il
 * classificatore non risponde, ed è come si legge un `null` in colonna (vedi
 * migration 090). Senza una risposta letta, niente cambia rispetto a prima.
 */
export const TASK_WEIGHTS = ['light', 'heavy'] as const;

export type TaskWeight = (typeof TASK_WEIGHTS)[number];

/**
 * Legge il peso da una colonna/valore libero. Tutto ciò che non è uno dei due
 * valori noti — `null`, stringa vuota, un valore vecchio o storto — torna
 * `null`, cioè «mai classificato», che ogni gate tratta come `light`.
 *
 * `null` NON viene normalizzato a `'light'` di proposito: distinguere «non l'ho
 * mai chiesto» da «ho chiesto e ha detto leggero» è l'unico modo per accorgersi
 * che il classificatore ha smesso di rispondere.
 */
export function readTaskWeight(raw: unknown): TaskWeight | null {
  return (TASK_WEIGHTS as readonly unknown[]).includes(raw) ? (raw as TaskWeight) : null;
}

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

/** Le due primitive di collegamento dell'intake. */
export type LinkKind = "subtask" | "chain";

/**
 * La PROPOSTA dell'intake: dove andrebbe un testo nuovo.
 * Vive qui perche' la calcola il server e la disegna il client — due copie
 * libere di divergere erano esattamente cio' che il cancello sui doppioni
 * di tipo esiste per impedire.
 */
export interface LinkProposal {
  targetTaskId: string;
  targetText: string;
  targetStatus: TaskStatus;
  /**
   * Quale delle due primitive il motore consiglia. NON è una decisione: la UI
   * evidenzia questa e lascia l'altra a un click di distanza.
   * - `chain` quando la card sta ancora girando (in_progress/review): il testo
   *   nuovo è un SEGUITO, e riparte dentro la conversazione del bloccante.
   * - `subtask` quando la card non è ancora partita (backlog/todo): il testo
   *   nuovo è un PEZZO di quel lavoro.
   */
  recommended: LinkKind;
  /** 0..1 — copertura pesata dei termini del testo nuovo sulla card. */
  score: number;
  /** Le parole che hanno fatto il punteggio, dalla più rara alla più comune. */
  sharedTerms: string[];
  /** Frase leggibile: va sotto al composer E nel thread delle due card. */
  reason: string;
}
