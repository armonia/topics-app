/**
 * Shared types — the source of truth for type definitions used by BOTH
 * client and server. Imported as `import type { ... }` from each side
 * so there's no runtime dependency (and no Vite fs.allow tweak needed:
 * type-only imports are erased before bundling).
 *
 * What belongs here:
 *   - Union literals that appear in WS payloads or REST shapes
 *     (e.g. ToolCallStatus, ProviderStatus).
 *   - Interfaces that are emitted by the server and consumed by the
 *     client unchanged (ProviderSnapshotEntry, ProvidersSnapshot,
 *     ProviderRequirement).
 *   - User input / form-response envelopes shared by both halves
 *     (AskUserQuestionItem, UserInputSchema, ToolUserResponse).
 *
 * What does NOT belong here:
 *   - Client-only render-state types (e.g. UI-flavour fields on Topic).
 *   - Server-only internal types (DB row shapes, sqlite handles, …).
 *
 * Re-exports: client/src/types/index.ts and server/types.ts (or its
 * sub-files) re-export from this module so every existing import path
 * stays valid. Don't reach in here from random call sites; go through
 * the re-export.
 */

// ─── Language (the interface AND the model's answers) ──────────────────

/**
 * The language the user chose. ONE single preference, governing together the
 * interface strings (`client/src/lib/i18n.ts`) and the language the model
 * answers in (`languageDirective` in `server/lib/topics-agent-prompt.ts`).
 *
 * They are one thing on purpose: two nearly identical selectors — "UI
 * language" and "answer language" — would be two preferences to explain, and
 * nobody would know why the first does not move the second. That is exactly
 * the defect that was there: the selector moved the UI strings and stopped.
 *
 * `auto` is NOT a language: it is the absence of a choice. The UI follows the
 * browser, and NO directive reaches the model — that is, it answers the way it
 * always has. A language is not invented when the user has not asked for one.
 *
 * The type DERIVES from the array, as `shared/effort.ts` already does: whoever
 * validates (the route), whoever resolves (the server) and whoever draws the
 * selector read the same set, so it cannot exist in three copies destined to
 * diverge.
 */
export const OUTPUT_LANGUAGES = ['auto', 'it', 'en'] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];

// ─── Discord Rich Presence: QUANTO si vede ─────────────────────────────

/**
 * Quanto della tua giornata finisce sul profilo Discord (migration 102).
 *
 * È un controllo di PRIVACY, non un gusto: la presence la vede chiunque
 * condivida un server con te, quindi ogni gradino va letto come «cosa sto
 * dicendo a degli sconosciuti».
 *
 *   • `minimal`  — che Topics è aperto. Nessun numero, nessun nome.
 *   • `activity` — i CONTEGGI: quante sessioni hai aperte, quante stanno
 *                  lavorando adesso. Numeri, che non nominano nessun cliente.
 *   • `detailed` — anche il NOME del progetto in cima. È l'unico gradino che
 *                  può far uscire di qui una parola che non hai scelto per
 *                  quel pubblico, quindi non è il default e non lo diventa.
 *
 * Il default vive nel codice ed è `activity`, ma vale solo a interruttore
 * ACCESO: la presence parte spenta (vedi 102), perché pubblicare cosa stai
 * facendo non è una cosa che si accende per conto di qualcuno.
 *
 * Come per le lingue, il tipo DERIVA dall'array: chi valida (la rotta), chi
 * costruisce l'attività e chi disegna il selettore leggono lo stesso insieme.
 */
export const DISCORD_DETAIL_LEVELS = ['minimal', 'activity', 'detailed'] as const;
export type DiscordDetailLevel = (typeof DISCORD_DETAIL_LEVELS)[number];

/**
 * Con quale MECCANICA si esegue un agente. Non è «chi risponde» — quello è il
 * provider, e resta scelto per topic e per task — è quanta macchina costa
 * tenerne uno vivo.
 *
 *   • `cli`   — una CLI per sessione, in una PTY: `claude`, `codex`. È il
 *               sistema storico. Fedele fino all'ultimo carattere, perché è
 *               letteralmente il programma che gira in un terminale, ma è un
 *               processo Node INTERO per sessione.
 *   • `jcode` — le sessioni passano da `jcode acp`, un adattatore sottile
 *               davanti a un demone Rust condiviso. Sempre un binario di
 *               TERZI: la sua riga di comando, i suoi metodi, il suo catalogo
 *               di modelli, che possono cambiare sotto di noi.
 *   • `topics`— il runtime DI CASA: nessun processo, nessun binario esterno.
 *               Topics parla direttamente col modello e tiene la sessione in
 *               memoria propria (`server/providers/native/`).
 *
 * Il numero che separa i gradini, misurato su questa macchina il
 * 2026-08-15 e non stimato: un agente dispatchato costa ~206 MB marginali
 * (bench/results/memory-latest.json), due `claude` vivi ne pesavano 1.580 in
 * due. Ventiquattro sessioni ACP concorrenti su un solo peer jcode sono
 * costate 0,58 MB l'una. È lo stesso lavoro con due ordini di grandezza di
 * differenza, ed è tutta la ragione per cui questo interruttore esiste.
 *
 * `topics` è il DEFAULT dal 2026-08-16, e ha lo stesso vantaggio di memoria di
 * `jcode` senza la sua dipendenza: una sessione è un array di messaggi dentro
 * il server che è già acceso. Il costo della CLI non è una preferenza di stile,
 * è una macchina che fa pageout con otto agenti in volo; e un default che
 * bisogna sapere di dover cambiare è un default sbagliato.
 *
 * `jcode` resta per confronto e per chi lo ha già configurato. Chi vuole la CLI
 * vera (riprodurre un comportamento, un dubbio sul runtime nuovo) ci torna in
 * un gesto: è la stessa riga in Impostazioni.
 *
 * IL RIPIEGO NON È QUESTA COSTANTE. Un valore illeggibile cade su `cli` (vedi
 * `resolveAgentRuntime`): sono due domande diverse — cosa vuole chi non ha
 * scelto, e cosa si fa quando la scelta è incomprensibile. La prima merita il
 * gradino buono, la seconda il sistema che c'è sempre stato.
 */
export const AGENT_RUNTIMES = ['cli', 'jcode', 'topics'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

/**
 * Il runtime di chi non ha scelto. Sta qui, in una costante sola, perché il
 * server (`resolveAgentRuntime`) e la scheda Impostazioni devono dire la STESSA
 * cosa: erano due `?? 'cli'` a mano in due file, e il modo in cui una UI mente
 * è esattamente questo, un ripiego aggiornato da una parte sola.
 */
export const DEFAULT_AGENT_RUNTIME: AgentRuntime = 'topics';

/**
 * L'attività come Discord la vuole in `SET_ACTIVITY.args.activity`.
 *
 * Sta qui e non nel servizio perché la card in Impostazioni ne disegna
 * l'ANTEPRIMA: server e client leggono la stessa forma, e il giorno in cui si
 * aggiunge un campo lo vedono tutti e due. Un tipo ricopiato di là sarebbe
 * l'ennesimo «KEEP IN SYNC» che non ha mai tenuto in sync niente.
 */
export interface DiscordActivity {
  details: string;
  state?: string;
  timestamps?: { start: number };
  assets?: { large_image: string; large_text: string };
}

/**
 * Com'è messo il filo con Discord.
 *
 * `no_discord` ed `error` sono separati di proposito: hanno lo stesso aspetto
 * (niente presence) e due rimedi opposti — il primo si apre, il secondo si
 * configura — e un'interfaccia che li fonde in «non funziona» manda a
 * indovinare.
 *
 * Il nome è `DiscordConnectionState` e non `ConnectionState` di proposito: il
 * client ha già un `ConnectionState` suo — quello del browser remoto — che è
 * un'altra cosa. Due concetti diversi non devono contendersi un nome generico.
 * Chi ne ha bisogno lo importa DA QUI: i moduli che lo usano non lo
 * ri-esportano, o la stessa forma avrebbe due porte e knip conterebbe la
 * seconda come morta (è già successo, ed è ciò che ha rimandato questa card).
 */
export type DiscordConnectionState =
  | 'off'
  | 'connecting'
  | 'connected'
  | 'no_discord'
  | 'error';

export interface DiscordPresenceStatus {
  enabled: boolean;
  level: DiscordDetailLevel;
  connection: DiscordConnectionState;
  /** Chi sei per Discord, quando il filo è aperto: l'unica conferma che la
   *  presence stia finendo sul profilo giusto se sulla macchina ci sono due
   *  account. */
  user: { id?: string; username?: string; global_name?: string } | null;
  lastError: string | null;
  lastPublishedAt: number | null;
  /**
   * Il nome dell'APPLICAZIONE Discord, cioe' la riga in cima alla card.
   *
   * Non e' un dettaglio decorativo: quel nome lo decide il portale
   * sviluppatori, non noi, e non c'e' modo di indovinarlo dal codice. Il
   * pannello scriveva «Topics» a mano mentre Discord mostrava «Jarvis», e chi
   * guardava l'anteprima per capire cosa vedono gli altri leggeva una cosa
   * falsa. `null` finche' il filo non e' aperto: prima di collegarsi non lo
   * sappiamo, e inventarlo sarebbe tornare al punto di partenza.
   */
  applicationName: string | null;
  /** Ciò che gli altri vedono ADESSO — la struttura scritta sul filo, non una
   *  sua descrizione. `null` = presence pulita. */
  activity: DiscordActivity | null;
}

// ─── Le statistiche del profilo ────────────────────────────────────────────

/**
 * Quanto lavoro è passato di qui, misurato su tabelle che qualcuno SCRIVE
 * (`messages`/`tasks`/`topics`/`projects`) — non su `usage_records` e
 * `agent_sessions`, che non hanno un solo INSERT in tutto il server e
 * darebbero zeri per sempre. La storia sta in cima a
 * `server/services/profile-stats.ts`.
 *
 * Attraversa il filo intera (`GET /api/profile/stats`), quindi vive qui: il
 * pannello del profilo e il banner SVG la leggono dalla stessa dichiarazione.
 */
export interface ProfileStats {
  sessions: { total: number; open: number };
  messages: { total: number; assistant: number };
  /** Token, cache inclusa. `chat` = i messaggi, `agents` = il lavoro della
   *  board: due fonti diverse, e sommarle è il punto. */
  tokens: { total: number; chat: number; agents: number };
  /** Il costo MISURATO, e quante righe sono state escluse perché il loro costo
   *  non è attendibile. Le due cose si mostrano insieme: un totale che
   *  inghiotte in silenzio le righe dubbie è una bugia. */
  cost: { measuredUsd: number; uncertainRows: number };
  tasks: { total: number; done: number; inProgress: number };
  projects: number;
  /** Ore di esecuzione degli agenti sulla board (`tasks.agent_ms`). */
  agentHours: number;
  activity: {
    firstSeen: string | null;
    activeDays: number;
    /** Giorni consecutivi fino a oggi; si interrompe solo dopo aver saltato un
     *  giorno INTERO, così la mattina presto non azzera la serie di ieri. */
    streakDays: number;
    /** Gli ultimi 30 giorni, zeri compresi: una curva che salta i giorni vuoti
     *  comprime il tempo e disegna una costanza che non c'è. */
    last30: Array<{ date: string; tokens: number }>;
  };
}

// ─── ToolCall status (chat message → tool call lifecycle) ──────────────

/**
 * 6-state lifecycle of a tool call attached to a chat message. Emitted
 * by the provider boundary on stream events and read by both the
 * persisted message store (server) and the renderer (client).
 *
 *   pending             — sent to provider, not started yet
 *   running             — provider invoked the tool
 *   waiting_for_input   — tool emitted a user-input form; stream is
 *                         suspended until the user submits via
 *                         POST /api/chat/tool-response
 *   awaiting_permission — lo strumento non è ancora partito: la modalità di
 *                         permessi della CLI chiede se può. Si risponde con
 *                         POST /api/sessions/:key/permission-response
 *   success             — terminal, result available
 *   error               — terminal, with an error field
 */
export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_input'
  | 'awaiting_permission'
  | 'success'
  | 'error';

/**
 * La palla è dell'UMANO su questa riga?
 *
 * Due stati diversi, un fatto solo: `waiting_for_input` (una domanda a schermo)
 * e `awaiting_permission` (un permesso da premere) sono cose distinte per chi
 * deve rispondere, e la STESSA cosa per tutti gli altri — la riga resta aperta,
 * il cronometro non scorre, il turno è vivo ma zitto, lo Stop resta disponibile,
 * e un turno che finisce sotto uno dei due deve chiuderlo invece di lasciare a
 * schermo un pannello che invita un click che non arriverà a nessuno.
 *
 * Esiste come funzione, e non come `x === 'a' || x === 'b'` sparso in sei posti,
 * per la stessa ragione di `server/lib/human-hold.ts`: quando è arrivata la
 * seconda sorgente, sei confronti scritti a mano sarebbero stati sei occasioni
 * di dimenticarne uno — e il ramo dimenticato non dà un errore di compilazione,
 * dà un pannello che gira per sempre.
 */
export function isAwaitingHuman(status: ToolCallStatus | undefined | null): boolean {
  return status === 'waiting_for_input' || status === 'awaiting_permission';
}

/**
 * PERCHÉ `awaiting_permission` è uno stato suo e non una domanda travestita.
 *
 * Il primo taglio riusava il pannello di `AskUserQuestion` (`kind: 'questions'`)
 * per ereditare form inline, ambra della tab e sopravvivenza al reload. Ha
 * funzionato, e ha lasciato la firma di una cosa messa nel posto sbagliato:
 * dentro il form delle domande sono servite TRE eccezioni — spegnere «Altro»
 * (il testo libero qui vale NEGA), cambiare l'etichetta del tasto, cambiare
 * l'occhiello. Tre eccezioni sono il segnale che non è una domanda.
 *
 * E il contratto era PROSA: la decisione viaggiava come valore di una mappa
 * `{ "Permesso richiesto — <tool>": "Consenti sempre" }`, riconosciuta per
 * prefisso di stringa. Funziona finché nessuno tocca un'etichetta.
 *
 * Una domanda ha risposte aperte e le legge un modello. Un permesso ha esiti
 * ESATTI, li legge il server, e alcuni di loro cambiano il regime di ciò che
 * verrà dopo. Sono due cose diverse e ora hanno due stati diversi.
 *
 * ── Le quattro, e perché non sono tre ───────────────────────────────────────
 * `allow`/`allow_always`/`deny` sono le tre che la CLI capisce. `allow_free` è
 * una decisione dell'INTERFACCIA: consente QUESTA richiesta — verso la CLI
 * viaggia come `allow`, vedi `cliDecisionFor` in `shared/permission-decision.ts`
 * — e nello stesso gesto porta la sessione in modalità libera, cioè smette di
 * chiedere. È qui, nell'enum, e non come flag accanto a `allow`, per la stessa
 * ragione per cui l'enum esiste: la decisione presa si RILEGGE dalla riga di
 * tool, e «consentito» e «consentito, e da qui in poi non chiedo più» non sono
 * la stessa cosa da rileggere sei mesi dopo.
 */
export type PermissionDecision = 'allow' | 'allow_always' | 'deny' | 'allow_free';

/** Cosa la CLI sta chiedendo di poter fare. Tipato: niente chiavi in prosa. */
export interface ToolPermissionRequest {
  /** Lo strumento per cui si chiede — `Write`, `mcp__gateway__kiwi__search-flight`. */
  toolName: string;
  /** Gli argomenti con cui verrebbe eseguito: un permesso senza il COSA è un pulsante. */
  input?: Record<string, unknown>;
  /** Quando è stata aperta (epoch ms) — la riga mostra da quanto aspetta. */
  requestedAt: number;
}

/** La decisione presa, persistita sulla riga: chi ha risposto cosa, e quando. */
export interface ToolPermissionOutcome {
  decision: PermissionDecision;
  decidedAt: string;
  /**
   * CHI ha deciso, in una parola leggibile (`etichettaAutore`).
   *
   * Scritto solo dove serve saperlo: `allow_free` cambia il regime della
   * sessione, e un cambio di regime senza un nome accanto è un cambio di regime
   * di cui nessuno risponde. Sulle altre tre resta assente — un «Consenti» è la
   * risposta di chi ha la chat aperta, e non c'è niente da attribuire.
   */
  actor?: string;
}

// ─── User-input request / response envelopes ───────────────────────────
//
// Emitted when a tool needs human input (`status === 'waiting_for_input'`).
// The dispatcher persists `userResponse` and re-injects it into the
// provider stream verbatim, so these are on-wire payloads — any change
// must keep both halves compatible in the same commit.

/**
 * Una tab di una finestra, come quella finestra l'ha descritta — chat, terminali,
 * progetti e browser allo stesso modo: la sidebar «Finestre» raggruppa queste.
 *
 * Stava scritta due volte, identica, su `server/presence.ts` e
 * `client/src/types/index.ts`. Due copie della stessa forma sul filo sono due
 * occasioni di divergere in silenzio, ed è esattamente quello che il test
 * `no-type-mirrors` esiste per impedire. Qui è dichiarata una volta; i due lati
 * la ri-esportano, quindi nessun import esistente cambia.
 */
export interface PresenceTab {
  /** Id della pane, quello che usano `focusPane` e i link alle tab. */
  id: string;
  /**
   * Tipo della pane (`chat`, `terminal`, `project`, `browser`, …) — libero sul
   * filo, così un peer con una build più vecchia non butta via una tab solo
   * perché non sa nominarla.
   */
  type: string;
  /** Il titolo che la finestra proprietaria mostra sulla tab. */
  title?: string;
}

/** One question emitted by the AskUserQuestion tool. */
/**
 * Una regola di «Consenti sempre» su uno strumento: la scrive il pannello dei
 * permessi in chat, la legge la scheda Impostazioni → Permessi. Vive qui perché
 * la vedono ENTRAMBI i lati, e due dichiarazioni dello stesso contratto
 * divergono in silenzio.
 */
export interface ToolGrant {
  /** Nome esatto (`Write`) o prefisso (`mcp__gateway__*`). Mai un `*` nudo. */
  pattern: string;
  createdAt: string;
  /** Da quale chat è uscito il sì. Provenienza, non politica: la regola è globale. */
  createdBySession: string | null;
}

export interface AskUserQuestionItem {
  question: string;
  /** Short label, ≤ 12 chars by SDK convention. */
  header: string;
  options: {
    label: string;
    description?: string;
    /**
     * L'opzione che chi ha fatto la domanda CONSIGLIA.
     *
     * Chi propone tre strade ha quasi sempre un'idea di quale sia la migliore,
     * e nasconderla non rende la scelta più libera: la rende più lenta. Il
     * pannello la marca in chiaro; non la preseleziona, perché una scelta fatta
     * per inerzia non è una scelta.
     *
     * Al massimo UNA per domanda. Se il modello ne marca più d'una, il pannello
     * onora la prima e ignora le altre — meglio un consiglio solo che tre.
     */
    recommended?: boolean;
  }[];
  multiSelect?: boolean;
}

/**
 * The input form a tool requests from the user. Persisted on the
 * tool-call row so re-renders / scroll-back show the original prompt
 * next to `userResponse`.
 */
export type UserInputSchema =
  | { kind: 'questions'; questions: AskUserQuestionItem[] }
  | {
      kind: 'elicitation';
      requestedSchema: unknown; // JSON Schema — opaque here, narrowed by form runtime
      message?: string;
    }
  | { kind: 'raw'; rawInput: unknown };

/**
 * The answer the user submitted via `POST /api/chat/tool-response`.
 * Persisted onto the message blob so the exchange survives session
 * restart and is auditable in scroll-back.
 */
export type ToolUserResponse =
  | {
      kind: 'questions';
      /** Keyed by `question` text; values are the selected label or free text. */
      answers: Record<string, string>;
      metadata?: Record<string, unknown>;
      submittedAt: string;
    }
  | { kind: 'elicitation'; value: unknown; submittedAt: string }
  | { kind: 'raw'; text: string; submittedAt: string };

// ─── Provider snapshot (REST + WS broadcasts) ──────────────────────────

/** 4-state provider availability surface. Pattern from Paseo. */
export type ProviderStatus = 'ready' | 'loading' | 'error' | 'unavailable';

/**
 * Single requirement a provider needs satisfied to be `ready`
 * (env var, CLI binary, etc.). Surfaced in the settings page when a
 * provider is `unavailable` or `error`.
 */
export interface ProviderRequirement {
  /** Stable id, e.g. "GATEWAY_URL", "ANTHROPIC_API_KEY", "claude-cli". */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Whether this requirement is currently satisfied. */
  present: boolean;
  /** Optional copy-paste hint (shell command, env var line, etc.). */
  hint?: string;
}

/**
 * One row in the provider snapshot. Combines the diagnostic surface
 * (status, requirements, version) with the model list, so clients have
 * a single payload to subscribe to.
 */
export interface ProviderSnapshotEntry {
  name: string;
  /** Pretty label for UI; falls back to `name` when absent. */
  label?: string;
  status: ProviderStatus;
  isDefault: boolean;
  binaryPath?: string;
  version?: string;
  models: string[];
  /**
   * Il modello che questo provider usa quando la sessione non ne sceglie uno.
   * NON è `models[0]`: la lista guida con l'id nudo mentre il default può essere
   * la sua variante a finestra lunga. Assente se il provider non lo dichiara.
   */
  defaultModel?: string;
  requirements: ProviderRequirement[];
  lastError?: string;
  /**
   * Effort/reasoning tier Topics forces on this provider's sessions
   * (claude-code `--effort`, codex `-c model_reasoning_effort`). Read-only
   * server policy surfaced for the picker badge; absent when the provider
   * has no such concept or the override is disabled.
   */
  effortTier?: string;
  /**
   * Lo stato della fast mode COME LO DICE la CLI (`fast_mode_state` +
   * `fast_mode_disabled_reason`, che arrivano in ogni `system/init` e in ogni
   * `result`), non come lo deduciamo noi. Assente = nessuna sessione ne ha
   * ancora parlato — e «non lo so» non è «non si può»: il bottone resta vivo.
   *
   * `reason` presente = qualcosa la blocca adesso, ed è quello che il tooltip
   * deve dire invece di far finta di niente (oggi, nelle chat, è sempre
   * `sdk_opt_in_required`: la fast mode non esiste nella via Agent SDK).
   */
  fastMode?: {
    state: 'off' | 'on' | 'cooldown';
    reason: string | null;
    /** Quanto costa la fast mode rispetto allo stesso modello a velocità
     *  normale: 2 = il doppio (10$/50$ contro 5$/25$ per 1M, listino scritto
     *  dalla CLI). `null` se su questo modello la fast mode non esiste. */
    costMultiplier: number | null;
  };
  /**
   * Le lingue che questo motore sostiene, COME LE DICHIARA lui — non come le
   * indovina una tabella qui dentro.
   *
   * La tentazione ovvia era `{ 'claude-opus-5': ['it','en'], … }`, ed è
   * l'errore che questo repo ha già pagato due volte (i commenti in
   * `claude-models.ts` e `task-model-picker.ts` raccontano com'è finita): una
   * lista scritta a mano invecchia da sola e nessuno se ne accorge. E il caso
   * che conta davvero — un llama locale che arriva domani — è proprio quello
   * che una tabella non può conoscere.
   *
   * REGOLA DI ONESTÀ, la stessa di `fastMode`: assente, oppure
   * `source: 'unknown'`, significa «non lo so» — e non lo so NON è un no.
   * Nessun blocco, nessun controllo disabilitato, al massimo un badge grigio.
   * Altrimenti il giorno che arriva il motore che non risponde al probe la
   * funzione lo dichiara rotto senza averne motivo.
   *
   * `supported: null` con `source: 'declared'` è il caso del motore che dice
   * «tutte»: una dichiarazione vera, non un'assenza.
   */
  languages?: {
    supported: string[] | null;
    source: 'declared' | 'probed' | 'unknown';
    /** ISO 8601. Quando il segnale è stato raccolto — serve a non ripetere il
     *  probe a ogni giro (vedi `snapshot-manager.ts`). */
    checkedAt?: string;
  };
  /** ISO 8601 timestamp of when this entry was last refreshed. */
  fetchedAt: string;
}

/** Full snapshot broadcast over WS / served from REST. */
export interface ProvidersSnapshot {
  providers: ProviderSnapshotEntry[];
  /** Default provider name as resolved server-side; null if none configured. */
  defaultProvider: string | null;
  /** ISO 8601 timestamp marking when this snapshot was assembled. */
  generatedAt: string;
}

// ─── Stato della sessione Claude (broadcast `session:state`) ───────────

/**
 * Fase della sessione. Vive qui perché è il discriminante che il client usa
 * per decidere aura, chip e badge: due elenchi di fasi che divergono sono due
 * macchine a stati diverse sullo stesso oggetto. Le funzioni pure che ci
 * ragionano restano in `server/lib/claude-session-state.ts`.
 */
export type ClaudeSessionPhase =
  | 'starting'
  | 'running'
  | 'tool-running'
  | 'awaiting-user'
  | 'awaiting-approval'
  | 'paused'
  | 'completed'
  | 'error'
  | 'dormant'
  | 'watching';

/** Ultimo errore di sessione, allegato allo stato quando `phase === 'error'`. */
export interface ClaudeSessionError {
  code: string;
  message: string;
  failedAt: number;
}

// ─── Contatore di contesto (forma ACP) ─────────────────────────────────

/** Costo cumulato della sessione, se il provider lo sa. Forma ACP. */
export interface UsageCost {
  amount: number;
  /** Codice valuta ISO 4217. I provider che conosciamo riportano USD. */
  currency: string;
}

/**
 * Il blocco ACP, verbatim. `sessionUpdate` è il discriminante richiesto dallo
 * standard: lo teniamo anche se il nostro envelope ha già `type`, perché è
 * quello che rende il blocco inoltrabile senza riscriverlo.
 */
export interface AcpUsageUpdate {
  sessionUpdate: 'usage_update';
  /** Token attualmente in contesto. */
  used: number;
  /** Dimensione totale della finestra, in token. */
  size: number;
  /** Costo cumulato della sessione. Opzionale in ACP e oggi mai valorizzato:
   *  il costo lo conosciamo solo a fine turno (evento `result`), mentre questo
   *  aggiornamento parte a ogni chiamata. Sta nel tipo perché è lì che va
   *  quando lo avremo, non in un campo inventato altrove. */
  cost?: UsageCost;
}

// ─── La sonda del costo: contesto × chiamate ───────────────────────────

/**
 * Il consuntivo di un turno, col suo moltiplicatore. Vedi
 * `server/usage/cost-probe.ts` per il perché di ogni campo.
 */
export interface TurnCostProbe {
  /** Chiamate a tool del turno: quante volte il contesto è ripartito. */
  toolCalls: number;
  /** Contesto all'ultima chiamata misurata del turno. */
  contextTokens: number;
  /** `contextTokens × toolCalls`: il costo del turno a contesto costante. */
  projectedTokens: number;
  /** Quello che è stato spedito davvero. */
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * La risposta di `GET /api/context/cost`: i due fattori e il loro prodotto.
 *
 * `projectedTokens` è una PREVISIONE (contesto di adesso × chiamate),
 * `promptTokens` un CONSUNTIVO (quanto è partito davvero). Il primo è più
 * grande del secondo perché il contesto cresceva: vanno letti insieme, o uno
 * dei due diventa una bugia.
 */
export interface SessionCostProbe {
  /** Il contesto di ADESSO: quanto rilegge la PROSSIMA chiamata a un tool. */
  contextTokens: number;
  windowTokens: number;
  /** Costo in dollari di una sola chiamata in più, a questo contesto. */
  perCallUsd: number;
  toolCalls: number;
  projectedTokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  messages: number;
  model: string | null;
  lastTurn: TurnCostProbe | null;
  /**
   * THE AGENT'S SPEND on this session, in dollars, when the session is the one of
   * a board card.
   *
   * It belongs here because without it the probe was BLIND precisely on the
   * agent: it sums `messages.cost_cents`, which is the chat ledger, while a
   * dispatched agent writes on the card (`tasks.agent_cost_cents`). Two ledgers
   * that do not add up on their own, and the second one appeared in no dollar
   * figure at all. `0` = no card behind this session (or nothing spent).
   */
  agentUsd: number;
  /** The card's equivalent consumption that could NOT be priced (model with no
   *  price list), in tokens. Shown next to the number: a total that stays quiet
   *  about the part it cannot price makes itself look complete. */
  agentUnpricedCostTokens: number;
}

/** Forma del broadcast WS `providers:snapshot`. */
export interface WSProvidersSnapshotMessage {
  type: 'providers:snapshot';
  snapshot: ProvidersSnapshot;
}

// ─── Payload del messaggio (chat, WS, persistenza) ─────────────────────
//
// ToolCallDetail / ToolCall / ContentBlock viaggiano identici in entrambe le
// direzioni: il server li persiste sulla riga del messaggio e li emette in
// `message:new`, il client li renderizza. Erano dichiarati due volte, riga per
// riga uguali a meno dei commenti — cioè la deriva non era ancora avvenuta,
// non che fosse impossibile.

/**
 * Per-tool typed detail. Built at the provider boundary so the UI doesn't
 * have to JSON-grovel `args` to figure out what to render. Inspired by
 * Paseo's `ToolCallDetail` taxonomy: every Claude/Codex/MCP tool maps to one
 * of these shapes (with `unknown` as the catch-all).
 *
 * Renderer contract: branch on `detail.type` to pick the per-kind component
 * (Shell terminal, Read code-with-line-numbers, Edit diff, Sub-agent log…).
 * Absent for older messages and stateless providers — the renderer falls
 * back to the generic args/result row.
 */
export type ToolCallDetail =
  | { type: 'shell'; command: string; cwd?: string; output?: string; exitCode?: number | null; background?: boolean }
  | { type: 'read'; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: 'edit'; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: 'write'; filePath: string; content?: string }
  | { type: 'search'; query: string; toolName?: 'search' | 'grep' | 'glob' | 'web_search' | 'tool_search'; content?: string; filePaths?: string[]; numFiles?: number; numMatches?: number; mode?: 'content' | 'files_with_matches' | 'count' }
  | { type: 'fetch'; url: string; prompt?: string; result?: string; statusCode?: number; bytes?: number }
  | { type: 'todo'; items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }> }
  | {
      type: 'sub_agent';
      subAgentType?: string;
      description?: string;
      /**
       * Flattened, growing log of the sub-agent's activity. Each entry is one
       * tool/text emission from the child. Cap at 200 entries / 160 chars per
       * summary to keep UI performant (Paseo's heuristic).
       */
      actions: Array<{ index: number; toolName: string; summary?: string; status?: 'running' | 'success' | 'error' }>;
      /** Final result text (set when sub-agent completes). */
      result?: string;
    }
  | { type: 'plan'; text: string }
  | { type: 'mcp'; server: string; tool: string; args?: Record<string, unknown>; result?: string }
  // Long-lived / background / harness tools that previously fell through to
  // `unknown`. Typed so the chat shows a real row instead of a raw JSON blob.
  | { type: 'monitor'; description: string; command?: string; wsUrl?: string; persistent?: boolean; result?: string }
  /** `wait_for_process`: l'attesa di un processo, con l'id per ritrovarlo vivo
   *  nel registro dei processi mentre la riga e' ancora aperta. */
  | { type: 'wait'; processId: string; until?: string; timeoutMs?: number; result?: string }
  | { type: 'bash_output'; shellId: string; filter?: string; output?: string }
  | { type: 'kill_shell'; shellId: string; result?: string }
  | { type: 'notebook_edit'; notebookPath: string; cellId?: string; editMode?: string; cellType?: string }
  | { type: 'skill'; skill: string; args?: string; result?: string }
  | { type: 'slash_command'; command: string; result?: string }
  | { type: 'lsp'; operation: string; filePath?: string; symbol?: string; result?: string }
  // Harness tools of the AGENT FLEET. Same reason as the block above: measured
  // 2026-08-25 on 40 real transcripts, these were emitted by the CLI and every
  // one of them rendered as a raw JSON blob. `Agent` alone appeared 58 times.
  /** `SendMessage`: one agent writing to another. The summary is what the row
   *  shows; the body is behind the disclosure. */
  | { type: 'agent_message'; to: string; summary?: string; message?: string; result?: string }
  /** `ListAgents` / `TaskOutput` / `TaskStop`: three ways of asking the fleet
   *  about itself. One type because the row says the same shape of thing -
   *  which operation, on whom, and what came back. */
  | { type: 'agent_control'; op: 'list' | 'output' | 'stop'; target?: string; result?: string }
  /** `Artifact`: publishing a page is neither a write nor a fetch. It has an
   *  action, and usually a URL that the reader wants to click. */
  | { type: 'artifact'; action: string; title?: string; url?: string; filePath?: string; result?: string }
  /** `AskUserQuestion`: a question put TO the person reading. Rendering it as
   *  JSON hid the one tool whose whole purpose is to be read by a human. */
  | { type: 'ask_user'; questions: Array<{ question: string; header?: string; options?: string[] }>; result?: string }
  | { type: 'unknown'; raw: { args?: Record<string, unknown>; result?: string } };

export interface ToolCall {
  id: string;
  name: string;
  /**
   * Tool arguments as parsed from the provider stream. Keys are field names,
   * values are arbitrary JSON — consumers JSON.stringify before persistence.
   * `unknown` over `any` so callers must narrow before use.
   */
  args: Record<string, unknown>;
  /** Lifecycle status — see ToolCallStatus in shared/types.ts. */
  status?: ToolCallStatus;
  /**
   * Presente quando `status === 'awaiting_permission'`: cosa la CLI chiede di
   * poter fare. Sostituisce l'uso di `userInputSchema` per i permessi — vedi
   * la nota su `ToolPermissionRequest`.
   */
  permissionRequest?: ToolPermissionRequest;
  /** La decisione presa. Resta sulla riga anche dopo, così si rilegge chi ha detto cosa. */
  permissionOutcome?: ToolPermissionOutcome;
  result?: string;
  error?: string;
  contentOffset?: number;
  /**
   * Wall-clock bounds of the tool's real usage window (epoch ms), stamped by
   * the route handler: `startedAt` at announce (which, with partial-message
   * streaming, is when the model STARTS writing the input — not when the
   * input is complete), `endedAt` when the result lands. UI shows
   * `endedAt - startedAt` as the call's duration.
   */
  startedAt?: number;
  endedAt?: number;
  /**
   * Costo di QUESTA azione in centesimi di dollaro — la quota della chiamata al
   * modello che l'ha decisa (vedi `StreamHandler.onToolUsage`). È il costo
   * dell'azione, non del turno: la riga del tool lo mostra accanto alla durata.
   * Assente per i messaggi vecchi e quando il modello è sconosciuto (in quel
   * caso resta `tokens`). La somma delle azioni di un turno non supera il
   * totale del turno mostrato in fondo al messaggio.
   */
  costCents?: number;
  /**
   * Token totali attribuiti a questa azione (letti + prodotti), il fallback
   * quando il prezzo del modello non è noto e `costCents` manca — così la riga
   * dice comunque "quanto ha pesato".
   */
  tokens?: number;
  /**
   * Optional typed detail built at the provider boundary. Renderers branch on
   * `detail.type` for per-tool UI. When absent, fall back to generic rendering
   * via `args` + `result`. Sub-agents (Task) accumulate child activity in
   * `detail.actions[]` rather than emitting separate timeline items.
   */
  detail?: ToolCallDetail;
  /**
   * How many characters the history payload REMOVED from `detail`.
   *
   * `GET /api/history/:sessionKey` blanks the three big text fields inside
   * `detail` (`output`, `content`, `result`) before putting the thread on the
   * wire: a closed tool row never reads them, and they are most of the weight
   * of opening a chat. This counter is what the row has left to know that a
   * body EXISTED, since the strings it would have measured are now empty.
   *
   * Set by `stripDetailText` (shared/lean-tool-call.ts). Absent when nothing
   * was stripped, which is also the shape every other route ships: only the
   * history route strips, so a message read from the DB or from
   * `/api/topics/:id/messages` carries the full text and no counter.
   *
   * It lives HERE and not inside `detail` on purpose: `parseToolCallDetail`
   * runs a Zod schema over `detail` and drops unknown keys, so a counter put
   * in there would have to be added to all 20+ variants of the union to
   * survive the trip.
   *
   * The text is not lost. The row fetches it on first expand from
   * `GET /api/messages/:messageId/tool/:toolCallId/detail`.
   */
  detailBytes?: number;
  /** See client mirror for full semantics. Populated for tools that
   *  request human input; lives on the row so re-renders + scrollback
   *  show the original prompt. */
  userInputSchema?: UserInputSchema;
  /** Persisted user answer; absent until submitted via
   *  `POST /api/chat/tool-response`. */
  userResponse?: ToolUserResponse;
}

// User-input shapes (AskUserQuestionItem, UserInputSchema, ToolUserResponse)
// live in `shared/types.ts` — single wire-contract source for both halves.
// Re-exported at the top of this file.

/**
 * One element in a message's chronological content timeline.
 *
 * Captures the actual order in which the provider emitted each piece of
 * content during streaming — text, reasoning, and tool calls all coexist on
 * the same array, instead of the legacy thinking/content/toolCalls bucket
 * split that lost ordering. Consecutive same-kind deltas are coalesced into
 * a single block while streaming.
 */
export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCall: ToolCall }
  /**
   * Perché il turno è finito male.
   *
   * NON è un momento della cronologia come gli altri: è il verdetto sul turno,
   * e infatti si rende in cima alla bolla, non nel punto in cui è capitato.
   * Vive qui — e non in una colonna nuova — perché `blocks` è già la cosa che
   * il client rende, che si persiste, che torna dopo un ricaricamento e che
   * viaggia intera nella cronologia: un campo in più avrebbe voluto una
   * migration su un DB da 192 MB e cinque punti di impianto, per portare lo
   * stesso dato nello stesso posto.
   *
   * Prima il cartello viveva DENTRO `content` con un ⚠️ davanti, e il client lo
   * riconosceva da quel prefisso. Bastava a colorare la bolla, non a mostrarlo:
   * quando `blocks` c'è, `content` non viene stampato — quindi 45 righe in
   * produzione erano turni interi incorniciati di giallo senza una parola che
   * dicesse perché.
   */
  | { kind: 'error'; text: string }
  /**
   * QUESTA RISPOSTA NON L'HAI CHIESTA TU.
   *
   * Un `Monitor` armato consegna il suo evento risvegliando la sessione: la
   * risposta arriva in chat minuti dopo, sotto un messaggio che non c'entra,
   * e senza niente che dica da dove viene. Osservato sulla chat 205d1fbb il
   * 20/08 — «Risveglio arrivato: …» comparso da solo, indistinguibile da una
   * risposta qualunque, con l'utente che ha dovuto chiedere cos'era.
   *
   * `label` è la `description` che l'agente ha dato al Monitor quando l'ha
   * armato («esito build», «deploy in produzione»): è la cosa che risponde a
   * «arrivato COSA», e il modello la sceglie già oggi perché la CLI la mostra
   * in ogni notifica. Assente quando non la conosciamo — allora il cartello
   * dice solo che il turno è nato da sé, che è comunque l'informazione
   * mancante.
   *
   * Vive nei blocchi per la stessa ragione di `error` qui sopra: `blocks` è
   * già ciò che il client rende, che si persiste e che torna dopo un
   * ricaricamento. Una colonna nuova avrebbe voluto una migration per portare
   * lo stesso dato nello stesso posto.
   */
  | { kind: 'woken'; label?: string }
  /**
   * QUESTO TURNO L'HA RIPRESO IL SERVER, non tu.
   *
   * Un turno del runtime nativo muore col processo: quando il server si
   * riavvia sotto una risposta non resta nessun figlio da riadottare, e la chat
   * si ferma a metà frase. Il bottone «Riprova» non copre il caso frequente
   * (`turnIsOnlyError` lo mostra solo su un turno SENZA lavoro), e chiedere
   * all'utente un gesto per un guasto nostro era la parte sbagliata: «al più ci
   * dovrebbe essere Riprendi, ma dovrebbe riprendere da solo» (20/08).
   *
   * Il blocco vive DUE vite, ed è voluto. Sul turno NUOVO è il cartello che
   * dice da dove viene questa risposta — altrimenti sembrerebbe che l'agente
   * abbia risposto due volte alla stessa domanda. Sul turno VECCHIO è la
   * traccia che impedisce di riprenderlo una seconda volta: sta nel DB e non in
   * memoria, perché due riavvii di fila lo riprenderebbero due volte.
   *
   * `attempt` is the resend number in the CHAIN (1 = the first resume), the
   * same on the old turn and on the new one. The chain cap (`ripresa-boot.ts`)
   * needs it: counting the blocks of a single row was not enough, because every
   * resend cut by the next restart is a new row starting from zero. Rows
   * written before this field carry no number: they count as 1.
   */
  | { kind: 'ripreso'; attempt?: number };

// ─── Entità di dominio (payload REST + broadcast WS) ────────────────────
//
// Topic, Project, Worktree, Machine sono le righe che il server serve e il
// client renderizza. Fino al 29/07 erano dichiarate DUE volte — una in
// `server/types.ts`, una in `client/src/types/index.ts` con sopra un
// "Mirrors server/types.ts:X" — ed erano già divergenti:
//
//   · `Topic.mcpPolicy` e `Topic.browserState` esistevano solo lato server,
//     quindi per il client non erano nemmeno leggibili senza un cast;
//   · `TopicsData.workspaceProjects` esisteva solo lato client, benché sia
//     il server a metterlo nella risposta di GET /api/topics (topics.ts:1009):
//     il tipo del server descriveva male la propria risposta.
//
// Un commento "Mirrors" non è un vincolo: è una speranza. Qui la
// dichiarazione è una sola e i due lati la RI-ESPORTANO.

/** Livello di autonomia degli strumenti per una topic. */
export type AutonomyLevel = 'ask' | 'auto-apply' | 'yolo';

export interface Topic {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  links: string[];
  sessionKey: string;
  color: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  systemPrompt?: string;
  contextFiles?: string[];
  pinnedMessages?: string[];
  projectPath?: string;
  /**
   * Presentation-only: this topic keeps a `projectPath` for its working dir
   * (the agent's cwd) but must NOT surface as a project in the sidebar/layout.
   * Set for dispatcher agent sessions on the "generale" catch-all workspace —
   * a task without a real project is a standalone (ungrouped) tab, not filed
   * under a phantom "generale" project. buildSidebarItems treats it as if it
   * had no projectPath. Real-project sessions leave this unset (grouped).
   */
  standalone?: boolean;
  /**
   * MCP fleet scoping for this topic's Claude Code session (migration 049).
   * NULL/absent = inherit the user's full MCP fleet (interactive default).
   * 'bridge-only' = ONLY the per-session `topics` bridge, spawned with the
   * dispatch-reduced tool profile — set by the task dispatcher so board agents
   * don't pay the schema tokens of the whole global fleet on every API call.
   */
  mcpPolicy?: string | null;
  sortOrder?: number;
  autonomyLevel?: AutonomyLevel;
  disabledContextSources?: string[];
  provider?: string | null;
  /**
   * Last-used model for this topic. Persists across sessions so the picker
   * remembers your selection. NULL = use the provider's default.
   */
  model?: string | null;
  /**
   * Per-topic reasoning-effort tier override (migration 033). One of
   * low/medium/high/xhigh/max. NULL = no override → the spawn falls back to the
   * global env-resolved default (`resolveClaudeEffort()`). Applied as
   * `--effort <tier>` on the next claude-code CLI spawn for this session; the
   * chat route forces an idle respawn on change so it takes effect immediately.
   * Nel client è il badge `effortTier` del picker.
   */
  effort?: string | null;
  /**
   * Fast Mode toggle (migration 024). When `true`, the chat route asks the
   * provider to use its native "fast model" (e.g. claude-haiku, gpt-4o-mini)
   * for this topic's turns, unless a per-message or topic-persisted model
   * override is set. Persists across sessions and synchronises across windows
   * via the `topic:updated` WS broadcast. Defaults to `false`.
   */
  fastMode?: boolean;
  /**
   * Per-topic notification mute (migration 073). When `true`, agent-completion
   * banners + sound for THIS topic are suppressed in useCompletionNotifier —
   * the completion still counts toward the app badge (setAppBadge), it just
   * doesn't interrupt. NULL/absent = not muted (default). Persists server-side
   * and syncs across windows via the `topic:updated` WS broadcast, so the mute
   * holds on every client. A project-wide mute lives separately in
   * AppSettings.mutedProjects (keyed by projectPath).
   */
  muted?: boolean;
  /**
   * Phase A · TOPIC-WT-01 — optional binding to a Worktree (a specific git
   * working copy of a Project). NULL = legacy/default behaviour: chat, tools
   * and slash commands operate inside `projectPath`. NON-NULL = operations are
   * scoped to the worktree's `absPath` instead. ON DELETE SET NULL — deleting
   * the worktree gracefully degrades the topic back to its `projectPath`.
   * See migration 018.
   */
  worktreeId?: string | null;
  /**
   * Phase C · TOPIC-IM-01 — one-shot initial message queued at create time.
   * The renderer reads it on first session open, dispatches it as the user's
   * first prompt, then PATCHes it back to null.
   */
  initialMessage?: string | null;
  /**
   * Phase 30 BROWSER-CHAT-01 — last-known browser state for this topic.
   * Populated by BrowserService on every navigation. Restored on server
   * boot via browserService.restoreAllContexts(topics). NULL = topic has
   * never opened a browser context.
   */
  browserState?: {
    url: string;
    contextId: string;
    lastActiveAt: number;
    viewport?: { width: number; height: number };
  };
}

/** First-class Project entity (Phase A · migration 016). */
export interface Project {
  id: string;
  name: string;
  /** Lowercase, hyphenated identifier — UNIQUE. Used in `~/.topics/worktrees/<slug>/`. */
  slug: string;
  /** Absolute filesystem path to the project's primary working directory. */
  path: string;
  color?: string | null;
  icon?: string | null;
  archived: boolean;
  /** L'organizzazione che lo vede (migration 092). NULL = solo chi possiede questa macchina. */
  orgId?: string | null;
  /** Chi l'ha messo qui. Serve al solo caso `incognito`, non è un permesso. */
  ownerPersonId?: string | null;
  /** Marcato incognito: fuori dall'elenco dei compagni d'organizzazione. */
  incognito?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** First-class Worktree entity (Phase A · migration 017). */
export interface Worktree {
  id: string;
  projectId: string;
  /** Display name. Default auto-generated `<adjective>-<noun>` from the naming generator. UNIQUE per project. */
  name: string;
  /** Git branch name. Null only when `mode === 'detached'`. */
  branchName: string | null;
  /** Base ref the branch was forked from (e.g. `main`). Null for `detached`. */
  baseRef: string | null;
  mode: 'branch' | 'reuse' | 'detached';
  /** Absolute filesystem path of the checked-out working tree. UNIQUE globally. */
  absPath: string;
  /** Whether the working branch has been pushed to a remote (set by the watcher). */
  isPushed: boolean;
  /** True once the user explicitly renames the underlying git branch (later phase). */
  branchRenamed: boolean;
  status: 'pending' | 'ready' | 'error';
  /** Captured stderr / message when `status === 'error'`. */
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** First-class Machine entity (Phase D · migration 020). */
export interface Machine {
  id: string;
  name: string;
  hostname: string;
  arch: string;
  platform: string;
  daemonVersion: string;
  status: 'online' | 'offline';
  lastHeartbeatAt: string;
  lastSeenAt: string;
  acknowledgedWarnings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** Corpo della risposta di `GET /api/topics`. */
export interface TopicsData {
  topics: Record<string, Topic>;
  /**
   * Percorsi dei progetti aperti nel workspace corrente. Lo aggiunge la route
   * (`server/routes/topics.ts`, `getWorkspaceProjects()`) sopra i topic: fa
   * parte della risposta, non del blob persistito.
   */
  workspaceProjects?: string[];
}

/** Stato "non letto" per topic — payload di `unread:init` e del suo REST. */
export interface UnreadData {
  [topicId: string]: {
    lastReadAt: string;
    unreadCount: number;
  };
}

/** Uno snapshot salvato di un topic (`server/routes/checkpoints.ts`). */
export interface Checkpoint {
  idx: number;
  messageCount: number;
  timestamp: string;
  description: string;
  gitHash?: string;
  gitBranch?: string;
}

// `BoardMemory` e `AgentActionLog` stavano qui: le forme client di
// `/api/boards/:projectId/memory`. Quella rotta non esiste — non c'è un
// handler, non c'è un lettore, e le tabelle `board_memory`/`agent_action_log`
// (migration 002) non hanno scrittori. I due tipi arrivavano fino al client solo
// attraverso un re-export in `client/src/lib/api.ts` che nessuno importava, e il
// cancello sul codice morto non poteva dirlo perché su quel file era cieco. Le
// tabelle restano dov'erano: cancellare SQL è un'altra decisione.

// ────────────────────────────────────────────────────────────────────────────
// Provider / context envelope
// ────────────────────────────────────────────────────────────────────────────

/**
 * Un turno di conversazione così come lo riceve un provider AI.
 *
 * Lato server si chiama `ChatMessage` (`server/providers/types.ts`, che lo
 * ri-esporta con quel nome per i suoi ~100 call site). Qui il nome è esteso
 * perché nel client `ChatMessage` è già preso — ed è tutt'altro: il messaggio
 * RICCO della UI, con id, blocchi, allegati, stato di streaming. Due cose
 * diverse con lo stesso nome erano metà del motivo per cui il client si era
 * riscritto a mano l'intera famiglia dell'envelope come cloni `Envelope*`.
 */
export interface ProviderChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Come un provider vuole ricevere il contesto — decide cosa fa `adaptEnvelope`.
 *
 * - `history-aware`     accetta un array di messaggi + messaggi di sistema
 *                       separati (Anthropic Messages API).
 * - `inline-system`     un solo turno utente: i blocchi di sistema vanno
 *                       concatenati in un preambolo (CLI claude-code). La
 *                       sessione vive nel processo.
 * - `gateway-stateful`  il gateway ha il suo stato di sessione ma accetta
 *                       ANCHE `history` come ripiego per la reidratazione dopo
 *                       un restart (gateway openclaw).
 *
 * Se un provider non dichiara `contextStrategy`, `getProviderStrategy()`
 * ripiega su: `capabilities.has("history") ? "history-aware" : "inline-system"`.
 */
export type ProviderContextStrategy =
  | "history-aware"
  | "inline-system"
  | "gateway-stateful";

/**
 * Una riga della tabella `compaction_markers`: dove la CLI ha compattato il
 * contesto, così il divider "contesto compattato" sopravvive al reload.
 *
 * Attraversa il filo: `GET /api/history` la restituisce in `compactionMarkers[]`
 * e `useChat` la consuma tale e quale. Il client se l'era però ritipata a mano
 * come `CompactionMarker` SENZA `topicId` né `sessionKey` — campi che riceve
 * comunque, e che quindi erano invisibili a chi leggeva solo il tipo.
 *
 * Da non confondere con il `CompactionMarker` di
 * `server/providers/claude/compaction.ts`: quello è il frame `compact_boundary`
 * appena parsato (tre campi, niente id, niente sessione), l'ingrediente da cui
 * `insertCompactionMarker` costruisce QUESTA riga.
 */
export interface StoredCompactionMarker {
  id: string;
  topicId: string | null;
  sessionKey: string;
  afterMessageId: string | null;
  trigger: 'auto' | 'manual' | 'unknown';
  preTokens?: number;
  postTokens?: number;
  createdAt: string;
}


/**
 * Un'approvazione in attesa dell'umano, come la annuncia il broadcast
 * `session:state`. Il client la ri-esporta come `ClaudeSessionPendingApproval`.
 */
export interface ClaudeSessionPendingApproval {
  kind: 'plan' | 'edit' | 'bash' | 'other';
  prompt: string;
  requestedAt: number;
}

/** Il tool attualmente in esecuzione nella sessione. */
export interface ClaudeSessionActiveTool {
  name: string;
  input?: unknown;
  startedAt: number;
}

/**
 * Lo stato canonico di una sessione Claude. La riga DB ne è una codifica (con
 * le colonne JSON appiattite) e il payload di `session:state` ne è una COPIA
 * INTEGRALE — motivo per cui vive qui e non solo lato server: il client ne
 * teneva una versione ridotta a mano, senza `jsonlPath`/`jsonlOffset`/
 * `createdAt`, campi che riceve comunque a ogni broadcast.
 */
export interface ClaudeSessionState {
  sessionKey: string | null;
  claudeSessionId: string;
  phase: ClaudeSessionPhase;
  phaseUpdatedAt: number;
  /**
   * Quando è cominciato il turno ATTUALMENTE in corso — l'istante in cui la
   * sessione è entrata in una fase di lavoro (`running`/`tool-running`/
   * `watching`) venendo da una fase che lavoro non era.
   *
   * Serve perché `phaseUpdatedAt` non risponde alla domanda «da quanto sta
   * lavorando?»: dentro un turno la fase rimbalza fra `running` e
   * `tool-running` a ogni tool, quindi `phaseUpdatedAt` si azzera di continuo e
   * misura l'ULTIMA azione, non il turno. Le due cose vanno tenute distinte
   * perché la UI le usa entrambe e per cose opposte: a turno finito conta
   * `phaseUpdatedAt` («ha finito 5 minuti fa»), a turno in corso conta questo
   * («sta lavorando da 12 minuti»).
   *
   * Deliberatamente NON persistito, come `monitorArmed`: ha senso solo per un
   * turno VIVO, e dopo un riavvio del server la UI ricade su `phaseUpdatedAt`
   * invece di mostrare una durata inventata.
   */
  turnStartedAt?: number;
  /** Transcript JSONL da cui il tracker legge; dettaglio del server, sul filo comunque. */
  jsonlPath?: string;
  /** Offset già consumato del transcript. Come sopra: server-side, ma copiato sul filo. */
  jsonlOffset: number;
  /**
   * Byte watermark del MESSAGE importer per una sessione ADOTTATA — quanti byte
   * del transcript sono già stati riflessi nelle righe `messages` del topic.
   * Distinto da `jsonlOffset` (che è del tracker delle fasi): due lettori dello
   * stesso file avanzano a ritmi diversi. `null`/assente = la sessione NON va
   * importata dal JSONL (ogni sessione nativa, i cui messaggi arrivano dallo
   * stream). Lo imposta solo `adopt-claude`. Server-side; sul filo per il debug.
   */
  importOffset?: number | null;
  pendingApproval?: ClaudeSessionPendingApproval;
  lastTool?: ClaudeSessionActiveTool;
  lastHookAt?: number;
  rev: number;
  error?: ClaudeSessionError;
  /**
   * True finché un Monitor/watch è armato in background per questa sessione.
   * Lo accende MonitorArmed, lo spengono MonitorClosed / SessionStart /
   * SessionEnd. Il suo unico mestiere è sopravvivere allo `Stop` che scatta a
   * fine turno DOPO che il monitor è stato armato: senza, Stop riporterebbe
   * `watching` ad `awaiting-user` (anello spento) mentre il monitor guarda
   * ancora. Disaccoppia "c'è un monitor armato" (fatto che attraversa i turni)
   * dalla fase (istantanea del momento).
   *
   * Deliberatamente NON persistito (niente colonna): conta solo per il
   * prossimo Stop di una sessione VIVA, e una sessione già in `watching`
   * ricarica come `watching` dalla colonna phase dopo un restart.
   */
  monitorArmed?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Goal della chat (3.4)
// ────────────────────────────────────────────────────────────────────────────

export const GOAL_STATUSES = ['active', 'achieved', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type GoalStepStatus = (typeof GOAL_STEP_STATUSES)[number];

/** Un passo del piano dichiarato dall'agente, nell'ordine in cui l'ha scritto. */
export interface GoalStep {
  id: string;
  goalId: string;
  position: number;
  content: string;
  status: GoalStepStatus;
  updatedAt: string;
}

/**
 * L'obiettivo di una conversazione: l'equivalente in chat di un task di board.
 *
 * Vive fuori dal transcript apposta — un messaggio verrebbe compattato, editato
 * e ramificato, e finirebbe per esistere in tre versioni. Da qui l'envelope lo
 * inietta come system block a ogni turno, quindi sopravvive alla compattazione:
 * è l'unico pezzo di contesto di cui il modello non perde mai il filo.
 */
export interface TopicGoal {
  id: string;
  topicId: string;
  content: string;
  status: GoalStatus;
  /** Chi l'ha scritto: 'human' (dettato) o 'agent' (proposto dal suo piano). */
  createdBy: 'human' | 'agent';
  createdAt: string;
  /** Quando è passato a uno stato finale; null finché è `active`. */
  closedAt: string | null;
  steps: GoalStep[];
}

/**
 * Forma del broadcast WS `goal:updated`.
 *
 * Porta il goal INTERO, non il solo id: è un oggetto piccolo che cambia di
 * rado, e mandare un puntatore costringerebbe ogni finestra aperta a una GET
 * per un dato che avevamo già in mano. `null` è lo stato legittimo «non c'è un
 * obiettivo attivo» — spegne la barra senza bisogno di un evento a parte.
 */
export interface WSGoalUpdatedMessage {
  type: 'goal:updated';
  topicId: string;
  goal: TopicGoal | null;
}
