import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { OutboundMessage } from "../shared/ws-outbound";

// Re-export so existing imports `from "./types"` keep resolving.
export type { AskUserQuestionItem, UserInputSchema } from "../shared/types";

/**
 * What a guest can reach. TWO questions, because the fan-outs come in two
 * different shapes and a single answer does not cover both.
 *
 * `mayReceiveFrame` serves `broadcastToAll`, which sends everyone a frame that
 * carries (sometimes) the entity it talks about: there we look at the TYPE
 * first and then at the entity declared inside the frame.
 *
 * `mayReadTopic` serves the per-topic fan-outs, where the entity is NOT in the
 * frame but is the argument of the call. Asking the frame there would be wrong
 * twice over: many of those frames do not name the topic, and only the caller
 * knows the real one.
 */
export interface GuestBroadcastFilter {
  mayReceiveFrame: (deviceId: string, message: OutboundMessage) => boolean;
  mayReadTopic: (deviceId: string, topicId: string) => boolean;
}

export interface WSData {
  id: string;
  /**
   * The device this socket belongs to, when the connection arrives from outside
   * loopback. Stamped at upgrade - the only moment the headers (and therefore
   * the session cookie) are still readable: after that, a WebSocket is just a
   * pipe. It is used to say in the list which devices are connected RIGHT NOW,
   * which is a different fact from "authorised".
   * `null` = loopback, that is, the computer itself.
   */
  deviceId?: string | null;
  /**
   * The ROLE of that device, stamped together with the id and for the same
   * reason: after the upgrade the cookie is no longer readable.
   *
   * It exists because without it "has a deviceId" ended up meaning "is a
   * guest", and that is not true: the upgrade stamps the id of ANY paired
   * device, owners included. The guest filter therefore applied to the owner's
   * phone too - which has no grants, because it does not need any - and made
   * every frame drop for it. Only loopback escaped, for the wrong reason: a
   * null `deviceId`, not a role.
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
  /** The Space (group) this window hosts on its own (`?space=`). */
  presenceSpaceId?: string;
  presenceTopicIds?: string[];
  presenceFocusedTopicId?: string;
  /** Every tab this window holds (chats, terminals, projects, browsers), as it
   *  describes them. `presenceTopicIds` stays the chat-only set that drives
   *  delta routing; this is what the sidebar groups under each window. */
  presenceTabs?: { id: string; type: string; title?: string }[];
}

// ─── Message types: declared in shared/, not here ──────────────────────
//
// ToolCallDetail, ToolCall and ContentBlock travel the wire AS THEY ARE and the
// client used to redeclare them line by line (identical but for the comments).
// One single declaration, in `shared/types.ts`.
export type { ToolCallDetail, ToolCall, ContentBlock } from "../shared/types";
// Only the two that are needed in scope below: `ToolCallDetail` is consumed by
// other modules via the re-export above, not by this file.
import type { ToolCall, ContentBlock } from "../shared/types";

/**
 * The row a RE-ADOPTED turn will keep writing to, plus the only thing the
 * caller cannot work out on its own: whether that row already carries a body
 * written before the restart (`reusedBody`) or was born just now. It is the
 * flag that decides whether the client has to empty the BUBBLE before the
 * replay rebuilds it - because the RECORD is no longer emptied. See
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
   * The model that produced the turn (`claude-opus-5`, `gpt-4o`, …).
   *
   * The server knows it at the instant it computes `costCents` and used to
   * throw it away: what was left was the result of the price, not the input
   * that determined it. The day the price is wrong - and it happened, every
   * Opus billed at triple for months - without this field you cannot even know
   * which row needs correcting and by how much: remediation 077 had to DEDUCE
   * the rate by dividing the cost by the weighted shares, and that only holds
   * as long as no two models share the same price.
   *
   * `undefined` on rows older than migration 076: it cannot be reconstructed
   * from anywhere, and making it up would be worse than not knowing.
   */
  model?: string;
  /**
   * The BREAKDOWN of `usagePromptTokens`: how much of it was cache.
   *
   * It matters because the total on its own teaches nothing. In a long agentic
   * turn the same prompt gets re-read at every call to the model and the cache
   * becomes the overwhelming item: without breaking it out you see how much the
   * message cost, not what made it expensive. The provider sends the shares
   * separately - the server already computed them for the price and threw them
   * away.
   *
   * DISJOINT shares, same convention as `usage/pricing.ts`:
   * `usagePromptTokens = fresh + cacheRead + cacheCreation + cacheCreation1h`.
   * `cacheCreationTokens` does NOT include `cacheCreation1hTokens`.
   *
   * `undefined` ≠ 0: absent means "we do not know" (old row, a provider that
   * does not report usage, a turn aborted before the `result`), 0 means
   * "measured, no cache". Confusing the two would make it look as if millions of
   * cache tokens had never existed.
   */
  cacheReadTokens?: number;
  /** Five-minute cache writes (1.25x fresh input). */
  cacheCreationTokens?: number;
  /** ONE-HOUR cache writes (2x), a share disjoint from the previous one. */
  cacheCreation1hTokens?: number;
  /**
   * WHO wrote this message (migration 095).
   *
   * The person is the subject, the device is the credential the message came in
   * through: `server/lib/message-author.ts` derives them together from the
   * request's identity.
   *
   * `undefined` ≠ "nobody's": it means WE DO NOT KNOW - an assistant reply (the
   * author is a model), a turn imported from a CLI transcript, a row written
   * before 095. A profile that counts a person's prompts has to skip them, not
   * attribute them to itself.
   */
  authorPersonId?: string | null;
  authorDeviceId?: string | null;
}

// ─── Domain entities: declared in shared/, not here ────────────────────
//
// Topic, Project, Worktree, TopicsData and UnreadData used to live here and a
// SECOND time in `client/src/types/index.ts`, with the comment "Mirrors
// server/types.ts:X" as the only guarantee. It was not enough: `mcpPolicy` and
// `browserState` never made it to the other side, and `workspaceProjects` -
// which the SERVER is the one to put in the GET /api/topics response - was
// missing right here. Now there is one single declaration, in
// `shared/types.ts`, and this re-export keeps every existing
// `import type { Topic } from "./types"` valid.
export type { Topic, Project, Worktree, TopicsData, UnreadData } from "../shared/types";
// `export type { … } from` re-exports but does NOT bring the names into local
// scope, and `AppContext` below uses them. A separate import, not redundancy.
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
  /**
   * Does this turn survive a server restart?
   *
   * `true` = it runs in a CHILD process (claude-code): the SIGTERM does not
   * touch it, the broker holds it, the re-adoption picks it back up. `false` =
   * it runs INSIDE this process (native `topics` runtime): when the process
   * dies, the turn dies. The `restart-when-idle` gate reads this field to decide
   * how long to wait - a turn nobody will pick back up deserves the long wait of
   * a card, not the minute granted to one that will be re-adopted.
   *
   * IT IS DECIDED HERE, when the stream opens, and not on every round of the
   * gate: a session's provider does not change for the duration of a turn, so
   * deriving it twice a second would be one query per tick for an answer that is
   * already known - and it would also be a second chance to answer differently
   * from the first.
   */
  survivesRestart: boolean;
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
  /** Lazy closure: injected in server.ts after createProcessesRouter (task e3240a22). */
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
  // `OutboundMessage` (not `object`) binds the `type` to the schema registry: a
  // broadcast with a type nobody has modelled does not compile.
  broadcast: (message: OutboundMessage, exclude?: ServerWebSocket<WSData>) => void;
  /** To ONE device only, all of its sockets. The opposite of a filtered
   *  broadcast: used when the recipient is known and the frame carries no
   *  entity to filter on (see `auth:shares-changed`). */
  sendToDevice: (deviceId: string, message: OutboundMessage) => void;
  /**
   * Where the relay lives, and this machine's two names. `baseUrl: null` = off,
   * and then the "share outside the network" gesture is not offered at all.
   *
   * `relayId` is the one that goes in the links; `installationId` is the one the
   * licence is tied to and must never end up in a URL. They are separate on
   * purpose: when they were the same value, showing one gave the other away
   * (`shared/relay-identita.ts`). The SECRET is not here, and must not get here
   * - this object is served by `/api/auth/relay`.
   */
  /**
   * How many Claude sessions are open OUTSIDE Topics - a terminal, another
   * harness. The census already keeps them cached (TTL 10s), so calling it on
   * every poll of the bar does not cost a scan.
   *
   * Absent in a reduced context: whoever uses it must fall back to 0, not make a
   * number up.
   */
  externalSessionsCount?: () => number;
  /** Of those, how many are working right now. Same cache, zero cost. */
  externalSessionsWorking?: () => number;
  relayConfig?: () => { baseUrl: string | null; installationId: string; relayId: string };
  /** The relay is connected RIGHT NOW. Different from "configured": it tells
   *  whoever creates a link whether that link will work immediately or only
   *  when the network comes back. */
  relayConnected?: () => boolean;
  /** WHAT IS GRANTED on this installation - the single door,
   *  `server/lib/licenza.ts`. Optional because a reduced context (the tests)
   *  does not graft it in: whoever reads falls back to the free plan, which is
   *  the right direction to be missing in. */
  licenza?: () => ServizioLicenza;
  /** Closes all of a device's sockets. A socket's identity is stamped at
   *  upgrade and never re-read, so without this a revocation held over HTTP and
   *  not over the already-open wire. Returns how many it closed. */
  closeDeviceSockets: (deviceId: string) => number;
  /** Grafts in the filter that decides what can reach a GUEST. It lives in
   *  `server.ts` because the grants DB is needed; `utils.ts` stays free of that
   *  dependency. */
  setGuestBroadcastFilter: (f: GuestBroadcastFilter | null) => void;
  /**
   * The peer address of a request. Assigned in `server.ts` AFTER `Bun.serve`,  allow-italian: `Bun.serve` is an API name, not Italian prose
   * because `requestIP` lives on the server instance and the context is born
   * before it. The routes that have to tell loopback from remote (the identity
   * axis, `lib/device-auth.ts`) go through here instead of receiving the whole
   * server.
   */
  requestIp?: (req: Request) => string | null;
  /**
   * The identity already resolved for THIS request: the gate computes it on
   * every call anyway, and recomputing it in the routes would mean two queries
   * and two possible truths. Populated in `server.ts` right after the gate.
   *
   * `null` = no identity resolved (exempt path, or kill switch). The routes that
   * filter by role must treat it as "owner": it is the same meaning loopback
   * has, and it is the previous behaviour.
   */
  requestIdentity?: (req: Request) => { role: 'owner' | 'guest'; deviceId: string | null } | null;
  broadcastToAll: (message: OutboundMessage) => void;
  /**
   * The three frames that carry a whole `projects` row. They do NOT go through
   * `broadcastToAll`: that payload is one and the same for every socket, and
   * these carry name and path - that is, exactly what `GET /api/projects`
   * filters by organisation and incognito. Here the row goes out only to whoever
   * `vedeProgetto` says, and everyone else gets the retraction
   * (`project:deleted`, the id alone). A real `project:deleted` stays on
   * `broadcastToAll`: it already carries only the id.
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
  /** Writes ONLY `topics.browser_state` (migration 075). `null` clears. See utils.ts. */
  setTopicBrowserState: (topicId: string, state: Topic['browserState'] | null) => void;
  /**
   * Writes ONLY `topics.updated_at` and re-reads the row. To be used for the
   * activity bump at the end of a turn: a `saveSingleTopic` with the object read
   * at the start of the turn would roll back every column changed in the
   * meantime. See utils.ts.
   */
  touchTopicActivity: (topicId: string, updatedAt: string) => Topic | null;
  loadUnread: () => UnreadData;
  saveUnread: (data: UnreadData) => void;
  loadLocalMessages: (sessionKey: string, opts?: ThreadLoadOpts) => StoredMessage[];
  /** Rows of the WHOLE session (dead branches included) - what a deletion
   *  actually hits. */
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
  /** A spontaneous turn picks up the «no answer» headstone before it, when
   *  there is one: see `lib/empty-turn-headstone.ts`. */
  reuseHeadstoneOrCreate: (sessionKey: string) => StoredMessage;
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
  /**
   * `survivesRestart`: does this turn withstand a server restart? The caller
   * knows, holding the resolved provider - see `ActiveStream`. The `false`
   * default is cautious on purpose: whoever does not declare counts as "does not
   * survive", and being wrong that way costs a slower restart instead of
   * somebody's work.
   */
  startStream: (sessionKey: string, messageId: string, abortController?: AbortController, survivesRestart?: boolean) => void;
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
   * The SHAPE of an image on disk, or `null` when it cannot be read (unknown
   * format, unreadable file). It serves the preview gate: an image taller than
   * it is wide takes over the card and pushes down the text that card is there
   * to make people read.
   *
   * `null` is not "too tall": whoever cannot measure lets it through, or a probe
   * defect would block good deliveries.
   */
  imageShapeOf?: (filepath: string) => { width: number; height: number; ratio: number } | null;
  /**
   * Checks whether a file exists on disk. Separate from `existsSync` so the
   * tests can inject a stub without touching the real filesystem. If absent, the
   * file is assumed to exist (compatibility with test contexts that do not set
   * the field).
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
  /** Deletes message + subtree and repairs the branch numbering. */
  deleteMessageSubtree: (sessionKey: string, messageId: string) => boolean;
  /** Discards the just-finalised turn if it produced NOTHING; returns the discarded id. */
  discardIfEmptyTurn: (sessionKey: string, msg: StoredMessage | null) => string | null;
  switchActiveBranch: (sessionKey: string, parentId: string, branchIndex: number) => void;
  getSiblingMessages: (parentId: string) => StoredMessage[];
  loadActiveThread: (sessionKey: string) => StoredMessage[];

  // Constants
  ALLOWED_UPLOAD_MIMES: Set<string>;
}

export type RouteHandler = (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
