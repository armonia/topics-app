import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { OutboundMessage } from "../shared/ws-outbound";

// Re-export so existing imports `from "./types"` keep resolving.
export type { AskUserQuestionItem, UserInputSchema } from "../shared/types";

export interface WSData {
  id: string;
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
  /** Mirror of this viewer's current stream state (set by _browserSetStream).
   *  A viewer that paused its stream (set_stream:false — e.g. its browser tab
   *  went off-screen) is NOT an active watcher, so it's excluded from the
   *  cross-device viewer count: a phone with the tab in the background must not
   *  keep the desktop's 'auto' pane in the shared session. Absent = active (a
   *  fresh viewer streams by default). */
  _streamActive?: boolean;
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
  presenceTopicIds?: string[];
  presenceFocusedTopicId?: string;
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
import type { Topic, TopicsData, UnreadData } from "../shared/types";

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
  broadcastToAll: (message: OutboundMessage) => void;
  broadcastToTopic: (topicId: string, message: OutboundMessage, exclude?: ServerWebSocket<WSData>) => void;
  broadcastToTopicSubscribers: (topicId: string, message: OutboundMessage, exclude?: ServerWebSocket<WSData>) => void;
  isTopicFocused: (topicId: string) => boolean;
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
  loadUnread: () => UnreadData;
  saveUnread: (data: UnreadData) => void;
  loadLocalMessages: (sessionKey: string) => StoredMessage[];
  saveLocalMessages: (sessionKey: string, msgs: StoredMessage[]) => void;
  appendLocalMessage: (sessionKey: string, role: "user" | "assistant", content: string) => StoredMessage;
  createPartialMessage: (sessionKey: string, role: "user" | "assistant") => StoredMessage;
  reuseOrCreatePartialForReattach: (sessionKey: string) => StoredMessage;
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
  findNewMediaFiles: (sinceMs: number) => Promise<string[]>;
  updateLastMessageWithMedia: (sessionKey: string, mediaPaths: string[]) => void;
  atomicWriteJSON: (filepath: string, data: object) => void;
  logRequest: (method: string, path: string, status: number, startTime: number) => void;
  searchTranscripts: (query: string, limit?: number) => any[];
  getMessagesPath: (sessionKey: string) => string;

  // Branching
  getMessageById: (id: string) => StoredMessage | null;
  getMessageSessionKey: (id: string) => string | null;
  createBranchMessage: (sessionKey: string, parentId: string, role: "user" | "assistant", content: string) => StoredMessage;
  createBranchPartialMessage: (sessionKey: string, parentId: string) => StoredMessage;
  switchActiveBranch: (sessionKey: string, parentId: string, branchIndex: number) => void;
  getSiblingMessages: (parentId: string) => StoredMessage[];
  loadActiveThread: (sessionKey: string) => StoredMessage[];

  // Constants
  ALLOWED_UPLOAD_MIMES: Set<string>;
}

export type RouteHandler = (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
