import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { OutboundMessage } from "../shared/ws-outbound";

// Re-export so existing imports `from "./types"` keep resolving.
export type { AskUserQuestionItem, UserInputSchema } from "../shared/types";

/**
 * Cosa può raggiungere un ospite. DUE domande, perché le fan-out sono di due
 * forme diverse e una sola risposta non le copre entrambe.
 *
 * `mayReceiveFrame` serve a `broadcastToAll`, che manda a tutti un frame che
 * porta con sé (a volte) l'entità di cui parla: lì si guarda prima il TIPO e poi
 * l'entità dichiarata dentro il frame.
 *
 * `mayReadTopic` serve alle fan-out per topic, dove l'entità NON sta nel frame
 * ma è l'argomento della chiamata. Chiederlo al frame lì sarebbe sbagliato due
 * volte: molti di quei frame non nominano il topic, e quello vero lo conosce
 * solo chi chiama.
 */
export interface GuestBroadcastFilter {
  mayReceiveFrame: (deviceId: string, message: OutboundMessage) => boolean;
  mayReadTopic: (deviceId: string, topicId: string) => boolean;
}

export interface WSData {
  id: string;
  /**
   * Il dispositivo a cui appartiene questa socket, quando la connessione arriva
   * da fuori loopback. Timbrato all'upgrade — l'unico momento in cui gli header
   * (e quindi il cookie di sessione) sono ancora leggibili: dopo, un WebSocket è
   * solo un tubo. Serve a dire nell'elenco quali dispositivi sono connessi
   * ADESSO, che è un fatto diverso da «autorizzato».
   * `null` = loopback, cioe' il computer stesso.
   */
  deviceId?: string | null;
  /**
   * Il RUOLO di quel dispositivo, timbrato insieme all'id e per lo stesso
   * motivo: dopo l'upgrade il cookie non è più leggibile.
   *
   * Esiste perché senza di esso «ha un deviceId» finiva per voler dire «è un
   * ospite», e non è vero: l'upgrade timbra l'id di QUALUNQUE dispositivo
   * appaiato, proprietari compresi. Il filtro degli ospiti si applicava quindi
   * anche al telefono del proprietario — che non ha concessioni, perché non gli
   * servono — e gli faceva cadere ogni frame. Solo il loopback ne usciva, per
   * il motivo sbagliato: `deviceId` nullo, non ruolo.
   */
  deviceRole?: 'owner' | 'guest' | null;
  /**
   * Is there a network between this socket and its peer? Stamped at upgrade,
   * the only moment the peer address is still available: after that a WebSocket
   * is just a pipe.
   *
   * It exists to decide whether a frame goes out compressed
   * (`server/lib/ws-compression.ts`). It is NOT `deviceId == null`, which would
   * look like the same question and is not: the terminal and browser upgrades
   * never stamp a device, so that field is null for a LAN peer too. And it is
   * not `isLocalTransport` either, which asks who we trust and counts the
   * tunnel as remote: here the tunnel is local, because the socket on the other
   * end belongs to `relay-client.ts` on this very machine.
   *
   * Absent means "not stamped", which is read as local: a socket nobody has
   * classified pays nothing.
   */
  remote?: boolean;
  focusedTopicId: string | null;
  /** P6: topics this connection currently has open; streaming deltas are routed
   *  only to clients that include the streaming topic. `undefined` until the
   *  client sends its first `subscribe` frame (such clients receive all deltas). */
  openTopicIds?: Set<string>;
  lastPong: number;
  terminalId?: string;
  _termHandler?: { message: (data: string | Buffer | ArrayBuffer) => void; close: () => void };
  /** Phase 30 BROWSER-CHAT-02 — set when WS upgraded on /ws/browser/:contextId. */
  browserContextId?: string;
  /** Phase 30 BROWSER-CHAT-02 — per-WS cleanup for screencast + CDP session. Called from websocket.close. */
  _browserCleanup?: () => Promise<void>;
  /** Task 052f53ef — pause/resume THIS viewer's screencast without dropping the
   *  WS. The web pane calls set_stream(false) when it renders a native <iframe>
   *  (no need for server frames) so the headless Chromium stops rendering, and
   *  set_stream(true) when it switches back to the stream (agent attaches / frame
   *  not framable). Keeps the WS open so agent_active still reaches the pane. */
  _browserSetStream?: (active: boolean) => void;
  /** Is this viewer's pane ON SCREEN (`set_watching`)? This — and NOT the
   *  screencast pause — is what the cross-device viewer count
   *  (GET /api/browsers/:id/viewers) counts, so a phone with the tab in the
   *  background stops keeping the desktop's 'auto' pane in the shared session.
   *
   *  It used to be `_streamActive`, a mirror of set_stream that NOTHING ever
   *  wrote (declared, read by the count, never assigned — so the count silently
   *  included every socket). Wiring it to set_stream would have been worse than
   *  the dead field: WebRTC is the default transport and pauses the screencast
   *  while very much watching, which would have made a phone invisible and the
   *  auto-share never fire. Absent = watching (older client, or an agent
   *  socket). */
  _watching?: boolean;
  /** T1 DOM co-browse — true while THIS viewer renders the pane as a native rrweb
   *  DOM reconstruction (set_render:'dom') instead of the pixel stream. Used to
   *  ref-count DOM viewers per context so `dom_event` emission stops once the last
   *  one leaves (on close or set_render:'video'). Absent = video (the default). */
  _domRender?: boolean;
  /** Set when this WS registered as a Tauri native-executor (register_native_executor):
   *  a native pane that runs ops itself and NEVER views the server session. Excluded
   *  from the cross-device viewer count (GET /api/browsers/:id/viewers) so a solo
   *  native pane reads 0 other viewers — otherwise its own delegate connection would
   *  make 'auto' oscillate native↔shared every poll ("il browser si resetta"). */
  _nativeDelegate?: boolean;
  /** WebRTC shared-session transport — the set of webrtc-bridge peer ids this WS
   *  opened (one per RTCPeerConnection). Used on close to tell the sidecar to tear
   *  each peer down. Absent until the pane sends its first `webrtc_offer`. */
  _webrtcPeers?: Set<string>;
  /** Cross-window presence (WS-ephemeral, never persisted). Populated from the
   *  `hello` / `presence:announce` frames so the server can broadcast a full
   *  list of open windows + the topics each holds. `windowId` is the client's
   *  own stable id for this browser context; `windowLabel` is the Tauri window
   *  label (`detach-*`) when detached so peers can call `window_focus_label`. */
  windowId?: string;
  windowLabel?: string;
  detached?: boolean;
  /** Lo Spazio (gruppo) che questa finestra ospita da sola (`?space=`). */
  presenceSpaceId?: string;
  presenceTopicIds?: string[];
  presenceFocusedTopicId?: string;
  /** Every tab this window holds (chats, terminals, projects, browsers), as it
   *  describes them. `presenceTopicIds` stays the chat-only set that drives
   *  delta routing; this is what the sidebar groups under each window. */
  presenceTabs?: { id: string; type: string; title?: string }[];
}

// ─── Tipi del messaggio: dichiarati in shared/, non qui ────────────────
//
// ToolCallDetail, ToolCall e ContentBlock viaggiano sul filo TALI E QUALI e
// il client li ridichiarava riga per riga (identici a meno dei commenti).
// Una sola dichiarazione, in `shared/types.ts`.
export type { ToolCallDetail, ToolCall, ContentBlock } from "../shared/types";
// Solo i due che servono in scope qui sotto: `ToolCallDetail` lo consumano
// altri moduli via il re-export sopra, non questo file.
import type { ToolCall, ContentBlock } from "../shared/types";

/**
 * La riga su cui un turno RIADOTTATO continuerà a scrivere, più la sola cosa
 * che il chiamante non può dedurre da solo: se quella riga porta già un corpo
 * scritto prima del riavvio (`reusedBody`) o è nata adesso. È il flag che
 * decide se il client deve svuotare la BOLLA prima che il replay la ricostruisca
 * — perché il RECORD non viene più svuotato. Vedi
 * `reuseOrCreatePartialForReattach`.
 */
export interface ReattachedPartial extends StoredMessage {
  reusedBody: boolean;
}

/**
 * How much of a message the caller loading a thread actually needs.
 *
 * The two fat columns of the `messages` table are `blocks` and `tool_calls`:
 * 98% of the bytes (353 MB and 220 MB against 13 MB of text, on this machine as
 * of 2026-08-14). A caller that reads only role/content/partial/id, such as
 * context assembly which runs on EVERY turn, says `false` to both, and then
 * those columns are never even requested from SQLite. Both default to loaded.
 */
export interface ThreadLoadOpts {
  withBlocks?: boolean;
  withToolCalls?: boolean;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  /**
   * Unified chronological timeline of content blocks. Populated for new
   * assistant messages produced by the streaming pipeline; absent on legacy
   * rows (the client falls back to bucket-rendering when missing).
   */
  blocks?: ContentBlock[];
  media?: string[];
  partial?: boolean;
  streamedAt?: string;
  planStatus?: 'approved' | 'rejected';
  parentId?: string | null;
  branchIndex?: number;
  siblingCount?: number;
  activeBranchIndex?: number;
  // Per-message footer metadata. Populated when a provider reports usage in
  // its final stream event (claude-code/codex/openclaw). All optional —
  // older rows render no footer. Mirrors `client/src/types:ChatMessage`.
  /** Total stream wall-clock duration in milliseconds. */
  latencyMs?: number;
  /** Prompt/input tokens reported by the provider. */
  usagePromptTokens?: number;
  /** Completion/output tokens reported by the provider. */
  usageCompletionTokens?: number;
  /** Best-effort cost in USD cents (`Math.round(usd * 100)`). */
  costCents?: number;
  /**
   * Il modello che ha prodotto il turno (`claude-opus-5`, `gpt-4o`, …).
   *
   * Il server lo conosce nell'istante in cui calcola `costCents` e lo buttava:
   * restava il risultato del prezzo, non l'input che lo aveva determinato. Il
   * giorno in cui il prezzo è sbagliato — ed è successo, ogni Opus tariffato al
   * triplo per mesi — senza questo campo non si può nemmeno sapere quale riga
   * vada corretta e di quanto: la bonifica 077 ha dovuto DEDURRE la tariffa
   * dividendo il costo per le quote pesate, e regge solo finché due modelli non
   * condividono lo stesso prezzo.
   *
   * `undefined` sulle righe anteriori alla migration 076: non è ricostruibile da
   * nessuna parte, e inventarlo sarebbe peggio del non saperlo.
   */
  model?: string;
  /**
   * Lo SCORPORO di `usagePromptTokens`: quanta parte era cache.
   *
   * Serve perché il totale da solo non insegna niente. In un turno agentico lungo
   * lo stesso prompt viene riletto a ogni chiamata al modello e la cache diventa
   * la voce schiacciante: senza scorporarla si vede quanto è costato il messaggio,
   * non cosa l'ha reso costoso. Il provider manda le quote separate — il server le
   * calcolava già per il prezzo e le buttava.
   *
   * Quote DISGIUNTE, stessa convenzione di `usage/pricing.ts`:
   * `usagePromptTokens = fresh + cacheRead + cacheCreation + cacheCreation1h`.
   * `cacheCreationTokens` NON include `cacheCreation1hTokens`.
   *
   * `undefined` ≠ 0: assente vuol dire "non lo sappiamo" (riga vecchia, provider
   * che non riporta l'usage, turno abortito prima del `result`), 0 vuol dire
   * "misurato, nessuna cache". Confonderli farebbe sembrare che milioni di token
   * di cache non siano mai esistiti.
   */
  cacheReadTokens?: number;
  /** Scritture in cache a cinque minuti (1.25× l'input fresco). */
  cacheCreationTokens?: number;
  /** Scritture in cache a UN'ORA (2×), quota disgiunta dalla precedente. */
  cacheCreation1hTokens?: number;
  /**
   * CHI ha scritto questo messaggio (migration 095).
   *
   * La persona è il soggetto, il dispositivo è il credenziale da cui il
   * messaggio è entrato: `server/lib/message-author.ts` li ricava insieme
   * dall'identità della richiesta.
   *
   * `undefined` ≠ «di nessuno»: vuol dire NON LO SAPPIAMO — una risposta
   * dell'assistente (l'autore è un modello), un turno importato da un
   * transcript della CLI, una riga scritta prima della 095. Un profilo che
   * conta i prompt di una persona deve saltarle, non attribuirsele.
   */
  authorPersonId?: string | null;
  authorDeviceId?: string | null;
}

// ─── Entità di dominio: dichiarate in shared/, non qui ─────────────────
//
// Topic, Project, Worktree, TopicsData e UnreadData vivevano qui e una
// SECONDA volta in `client/src/types/index.ts`, col commento "Mirrors
// server/types.ts:X" a fare da unica garanzia. Non bastava: `mcpPolicy` e
// `browserState` non sono mai arrivati dall'altra parte, e `workspaceProjects`
// — che è il SERVER a mettere nella risposta di GET /api/topics — mancava
// proprio qui. Ora la dichiarazione è una sola, in `shared/types.ts`, e questo
// re-export tiene valido ogni `import type { Topic } from "./types"` esistente.
export type { Topic, Project, Worktree, TopicsData, UnreadData } from "../shared/types";
// `export type { … } from` ri-esporta ma NON porta i nomi in scope locale, e
// qui sotto `AppContext` li usa. Import separato, non è una ridondanza.
import type { Topic, Project, TopicsData, UnreadData } from "../shared/types";
import type { ServizioLicenza } from "./lib/licenza";

export interface ActiveStream {
  sessionKey: string;
  startedAt: string;
  isThinking: boolean;
  lastActivity: string;
  content: string;
  thinking: string;
  messageId: string;
  abortController?: AbortController;
}

export interface ErrorResponseOptions {
  log?: boolean;
  details?: unknown;
}

export interface AppContext {
  // Gateway WebSocket client (optional — lazy init)
  gatewayWS?: import("./gateway-ws").GatewayWS;

  // Database
  db: Database;

  // Project + Worktree domain (Phase A · added at migration 016-018)
  projectStore: import("./services/project-store").ProjectStore;
  worktreeStore: import("./services/worktree-store").WorktreeStore;
  worktreeManager: import("./services/worktree-manager").WorktreeManager;
  /** Lazy closure: iniettato in server.ts dopo createProcessesRouter (task e3240a22). */
  worktreeGcDeps: import("./services/worktree-manager").WorktreeManagerGcDeps;
  // Multi-machine (Phase D · added at migration 020-021)
  machineStore: import("./services/machine-store").MachineStore;

  // Paths
  PORT: number;
  GATEWAY_URL: string;
  GATEWAY_TOKEN: string;
  refreshGatewayToken: () => string;
  TOPICS_FILE: string;
  UNREAD_FILE: string;
  PUBLIC_DIR: string;
  UPLOADS_DIR: string;
  CONTEXT_DIR: string;
  OPENCLAW_DIR: string;
  SESSIONS_DIR: string;
  MESSAGES_DIR: string;
  BASE_DIR: string;
  /** Writable root for mutable state. Equals BASE_DIR in dev / under the prod
   *  LaunchAgent; in a packaged app it is a writable per-user dir because
   *  BASE_DIR (inside the read-only .app bundle) cannot be written. */
  STATE_DIR: string;

  // State
  activeStreams: Map<string, ActiveStream>;
  wsClients: Set<ServerWebSocket<WSData>>;

  // Utils
  // `OutboundMessage` (non `object`) vincola il `type` al registro degli schemi:
  // un broadcast con un tipo che nessuno ha modellato non compila.
  broadcast: (message: OutboundMessage, exclude?: ServerWebSocket<WSData>) => void;
  /** A UN dispositivo soltanto, tutte le sue socket. L'opposto di un broadcast
   *  filtrato: si usa quando il destinatario è noto e il frame non porta
   *  un'entità su cui filtrare (vedi `auth:shares-changed`). */
  sendToDevice: (deviceId: string, message: OutboundMessage) => void;
  /**
   * Dove vive il relay, e i due nomi di questa macchina. `baseUrl: null` =
   * spento, e allora il gesto «condividi fuori rete» non si offre affatto.
   *
   * `relayId` è quello che va nei link; `installationId` è quello a cui è
   * legata la licenza e non deve finire in un URL. Sono separati apposta:
   * quando erano lo stesso valore, mostrarne uno regalava l'altro
   * (`shared/relay-identita.ts`). Il SEGRETO non è qui, e non deve arrivarci —
   * questo oggetto viene servito da `/api/auth/relay`.
   */
  relayConfig?: () => { baseUrl: string | null; installationId: string; relayId: string };
  /** Il relay è collegato ADESSO. Diverso da «configurato»: serve a dire a chi
   *  crea un link se quel link funzionerà subito o solo quando torna la rete. */
  relayConnected?: () => boolean;
  /** COSA È CONCESSO su questa installazione — la porta unica, `server/lib/licenza.ts`.
   *  Opzionale perché un contesto ridotto (le prove) non la innesta: chi legge
   *  cade sul piano gratuito, che è il verso giusto in cui mancare. */
  licenza?: () => ServizioLicenza;
  /** Chiude tutte le socket di un dispositivo. L'identità di una socket è
   *  timbrata all'upgrade e non si rilegge, quindi senza questo una revoca
   *  valeva sull'HTTP e non sul filo già aperto. Torna quante ne ha chiuse. */
  closeDeviceSockets: (deviceId: string) => number;
  /** Innesta il filtro che decide cosa può raggiungere un OSPITE. Vive in
   *  `server.ts` perché serve il DB delle concessioni; `utils.ts` resta senza
   *  quella dipendenza. */
  setGuestBroadcastFilter: (f: GuestBroadcastFilter | null) => void;
  /**
   * L'indirizzo del peer di una richiesta. Assegnato in `server.ts` DOPO
   * `Bun.serve`, perche' `requestIP` vive sull'istanza del server e il contesto
   * nasce prima. Le rotte che devono distinguere loopback da remoto (l'asse
   * dell'identita', `lib/device-auth.ts`) passano di qui invece di ricevere il
   * server intero.
   */
  requestIp?: (req: Request) => string | null;
  /**
   * L'identita' gia' risolta per QUESTA richiesta: il gate la calcola comunque a
   * ogni chiamata, e ricalcolarla nelle rotte vorrebbe dire due query e due
   * verita' possibili. Popolata in `server.ts` subito dopo il gate.
   *
   * `null` = nessuna identita' risolta (percorso esente, o kill-switch). Le rotte
   * che filtrano per ruolo devono trattarlo come «proprietario»: e' lo stesso
   * significato che ha il loopback, ed e' il comportamento precedente.
   */
  requestIdentity?: (req: Request) => { role: 'owner' | 'guest'; deviceId: string | null } | null;
  broadcastToAll: (message: OutboundMessage) => void;
  /**
   * I tre frame che portano una riga di `projects` per intero. NON passano da
   * `broadcastToAll`: quel payload è uno solo per tutte le socket, e questi
   * portano nome e path — cioè proprio ciò che `GET /api/projects` filtra per
   * organizzazione e incognito. Qui la riga esce solo verso chi `vedeProgetto`
   * dice, e a tutti gli altri parte la ritratta (`project:deleted`, il solo id).
   * `project:deleted` vero resta su `broadcastToAll`: porta già solo l'id.
   */
  broadcastProject: (type: import("./lib/project-visibility").TipoFrameProgetto, project: Project) => void;
  broadcastToTopic: (topicId: string, message: OutboundMessage, exclude?: ServerWebSocket<WSData>) => void;
  broadcastToTopicSubscribers: (topicId: string, message: OutboundMessage, exclude?: ServerWebSocket<WSData>) => void;
  loadTopics: () => TopicsData;
  saveTopics: (data: TopicsData) => void;
  /**
   * Upsert a single topic without touching others. Prefer this over
   * `saveTopics(allTopics)` when you only need to mutate one topic — the
   * "save-all" path diffs against a stale in-memory snapshot and silently
   * deletes any topic missing from it (lost-update race).
   */
  saveSingleTopic: (topic: Topic) => void;
  /** Constant-time topic lookup by id. Returns null if missing. */
  getTopicById: (id: string) => Topic | null;
  /** Constant-time topic lookup by sessionKey (UNIQUE column). */
  getTopicBySessionKey: (sessionKey: string) => Topic | null;
  /** Scrive SOLO `topics.browser_state` (migration 075). `null` cancella. Vedi utils.ts. */
  setTopicBrowserState: (topicId: string, state: Topic['browserState'] | null) => void;
  loadUnread: () => UnreadData;
  saveUnread: (data: UnreadData) => void;
  loadLocalMessages: (sessionKey: string, opts?: ThreadLoadOpts) => StoredMessage[];
  /** Righe della sessione INTERA (rami morti compresi) — ciò che una
   *  cancellazione colpisce davvero. */
  countMessagesBySession: (sessionKey: string) => number;
  saveLocalMessages: (sessionKey: string, msgs: StoredMessage[]) => void;
  appendLocalMessage: (
    sessionKey: string,
    role: "user" | "assistant",
    content: string,
    autore?: { authorPersonId?: string | null; authorDeviceId?: string | null },
  ) => StoredMessage;
  /** Append pre-formed messages (id/parentId/toolCalls fixed by the caller) to
   *  the tail — the incremental-import complement to `saveLocalMessages`. */
  appendImportedMessages: (sessionKey: string, msgs: StoredMessage[]) => void;
  createPartialMessage: (sessionKey: string, role: "user" | "assistant") => StoredMessage;
  reuseOrCreatePartialForReattach: (sessionKey: string) => ReattachedPartial;
  updateLastMessage: (sessionKey: string, updates: Partial<StoredMessage>) => StoredMessage | null;
  appendToLastMessage: (sessionKey: string, contentDelta: string, thinkingDelta?: string) => StoredMessage | null;
  finalizeLastMessage: (sessionKey: string) => StoredMessage | null;
  addToolCallToLastMessage: (sessionKey: string, toolCall: ToolCall) => StoredMessage | null;
  updateToolCallResult: (sessionKey: string, toolCallId: string, result: string, error?: string, extra?: Partial<ToolCall>) => StoredMessage | null;
  /**
   * Patch arbitrary fields on a single ToolCall of the last assistant
   * message. Used by the user-input flow (status='waiting_for_input',
   * userInputSchema in; userResponse out) so the on-disk row reflects
   * non-terminal state — a client reloading mid-pause re-renders the
   * form instead of an open spinner.
   */
  updateToolCallFields: (sessionKey: string, toolCallId: string, patch: Partial<ToolCall>) => StoredMessage | null;
  startStream: (sessionKey: string, messageId: string, abortController?: AbortController) => void;
  updateStreamActivity: (sessionKey: string, isThinking?: boolean) => void;
  updateStreamContent: (sessionKey: string, content: string, thinking: string) => void;
  getStreamContent: (sessionKey: string) => { content: string; thinking: string; messageId: string } | null;
  endStream: (sessionKey: string) => ToolCall[];
  isStreaming: (sessionKey: string) => ActiveStream | undefined;
  readJSON: (req: Request) => Promise<any>;
  json: (data: any, status?: number) => Response;
  matchRoute: (pathname: string, pattern: string) => Record<string, string> | null;
  errorResponse: (status: number, message: string, options?: ErrorResponseOptions) => Response;
  slugify: (name: string) => string;
  resolveSafePath: (inputPath: string, allowedBases?: string[]) => string | null;
  resolveProjectPath: (inputPath: string) => string | null;
  /**
   * Resolve the working directory for a topic, honouring `topic.worktreeId`.
   * When the worktree is ready the worktree's `absPath` is returned;
   * otherwise falls back to `resolveProjectPath(topic.projectPath)`.
   * See `server/utils.ts:resolveTopicCwd` for the full precedence rule.
   */
  resolveTopicCwd: (topic: import("./types").Topic | null | undefined) => string | null;
  getMimeType: (filepath: string) => string;
  isPathAllowed: (filepath: string) => boolean;
  /**
   * La FORMA di un'immagine sul disco, o `null` quando non si riesce a leggerla
   * (formato ignoto, file illeggibile). Serve al cancello dell'anteprima: una
   * immagine piu' alta che larga occupa la card e spinge giu' il testo che
   * quella card deve far leggere.
   *
   * `null` non e' «troppo alta»: chi non sa misurare lascia passare, o un
   * difetto di sonda bloccherebbe consegne buone.
   */
  imageShapeOf?: (filepath: string) => { width: number; height: number; ratio: number } | null;
  /**
   * Controlla se un file esiste sul disco. Opzionale: in produzione usa
   * `existsSync` di Node; nei test si sostituisce con uno stub che restituisce
   * sempre `true`, cosi' i path fittizi non fanno fallire `acceptPreview`.
   */
  fileExistsSync?: (filepath: string) => boolean;
  findNewMediaFiles: (sinceMs: number) => Promise<string[]>;
  updateLastMessageWithMedia: (sessionKey: string, mediaPaths: string[]) => void;
  atomicWriteJSON: (filepath: string, data: object) => void;
  logRequest: (method: string, path: string, status: number, startTime: number) => void;
  searchTranscripts: (query: string, limit?: number) => any[];
  getMessagesPath: (sessionKey: string) => string;

  // Branching
  getMessageById: (id: string) => StoredMessage | null;
  getMessageSessionKey: (id: string) => string | null;
  createBranchMessage: (
    sessionKey: string,
    parentId: string,
    role: "user" | "assistant",
    content: string,
    autore?: { authorPersonId?: string | null; authorDeviceId?: string | null },
  ) => StoredMessage;
  createBranchPartialMessage: (sessionKey: string, parentId: string) => StoredMessage;
  /** Cancella messaggio + sottoalbero e ripara la numerazione dei rami. */
  deleteMessageSubtree: (sessionKey: string, messageId: string) => boolean;
  /** Scarta il turno appena finalizzato se non ha prodotto NIENTE; ritorna l'id scartato. */
  discardIfEmptyTurn: (sessionKey: string, msg: StoredMessage | null) => string | null;
  switchActiveBranch: (sessionKey: string, parentId: string, branchIndex: number) => void;
  getSiblingMessages: (parentId: string) => StoredMessage[];
  loadActiveThread: (sessionKey: string) => StoredMessage[];

  // Constants
  ALLOWED_UPLOAD_MIMES: Set<string>;
}

export type RouteHandler = (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
