// Shared types — canonical defs live in /shared/types.ts so server +
// client can't drift. Re-exported here so existing call sites that do
// `import type { X } from '@/types'` keep working unchanged.
export type {
  ToolCallStatus,
  ProviderStatus,
  ProviderRequirement,
  ProviderSnapshotEntry,
  ProvidersSnapshot,
  AskUserQuestionItem,
  UserInputSchema,
  ToolUserResponse,
} from '../../../shared/types';
// `export type { … } from` ri-esporta ma NON porta i nomi in scope locale, e i
// payload WS qui sotto li usano. Import separato, non è una ridondanza.
import type {
  UserInputSchema,
  AcpUsageUpdate,
  ClaudeSessionState,
  WSProvidersSnapshotMessage,
  WSGoalUpdatedMessage,
} from '../../../shared/types';

// ─── Entità di dominio: dichiarate in shared/, non qui ─────────────────
//
// Erano sei interfacce riscritte a mano con sopra "Mirrors server/types.ts:X".
// Il commento non ha impedito la deriva: `Topic.mcpPolicy` e
// `Topic.browserState` non sono mai arrivati fin qui, e il client si era
// costruito da solo `TopicsData.workspaceProjects` che il server manda davvero
// ma non dichiarava. Ora la dichiarazione è UNA, in `shared/types.ts`; questo
// re-export tiene valido ogni `import type { Topic } from '@/types'`.
export type {
  AutonomyLevel,
  Topic,
  Project,
  Machine,
  Worktree,
  TopicsData,
  UnreadData,
} from '../../../shared/types';
// `export type { … } from` ri-esporta ma NON porta i nomi in scope locale, e
// più sotto i payload WS li usano. Import separato, non è una ridondanza.
import type {
  AutonomyLevel,
  Topic,
  Project,
  Machine,
  Worktree,
} from '../../../shared/types';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

// ─── Payload del messaggio: dichiarati in shared/, non qui ─────────────
//
// ToolCallDetail, ToolCall e ContentBlock erano riscritti qui riga per riga,
// identici a `server/types.ts` a meno dei commenti, col solito "Mirrors" a
// fare da garanzia. Ora la dichiarazione è UNA, in `shared/types.ts`.
export type { ToolCallDetail, ToolCall, ContentBlock } from '../../../shared/types';
import type { ToolCall, ContentBlock } from '../../../shared/types';

export interface ChatMessage extends Message {
  id: string;
  timestamp: string;
  pinned?: boolean;
  // Enhanced message structure
  thinking?: string;              // AI thinking content (collapsible)
  toolCalls?: ToolCall[];         // Tool calls made in this message
  /**
   * Chronological timeline of content blocks. Populated during streaming
   * (built incrementally from WS events) and preserved on history reload.
   * Older messages may not have this; MessageContent falls back to the
   * thinking/content/toolCalls buckets in that case.
   */
  blocks?: ContentBlock[];
  media?: string[];               // Media file paths
  partial?: boolean;              // True if message is still streaming
  queued?: boolean;               // True if message is queued to send (offline)
  streamedAt?: string;            // When streaming started (for recovery)
  // Branching support
  parentId?: string | null;       // ID of parent message in tree
  branchIndex?: number;           // Index among siblings (0-based)
  siblingCount?: number;          // Total siblings at this branch point
  activeBranchIndex?: number;     // Currently active sibling index
  // Per-message metadata (footer). Populated for assistant messages when the
  // upstream provider reports usage/cost; nullable so old rows don't render
  // a footer. See `server/db/migrations/014-message-meta.sql`.
  /** Total stream wall-clock duration in milliseconds (server measured). */
  latencyMs?: number | null;
  /** Prompt/input tokens reported by the provider. */
  usagePromptTokens?: number | null;
  /** Completion/output tokens reported by the provider. */
  usageCompletionTokens?: number | null;
  /** Best-effort cost in USD cents. May be null even when token counts exist. */
  costCents?: number | null;
}

export interface CreateTopicRequest {
  name: string;
  parentId?: string;
  color?: string;
  icon?: string;
  systemPrompt?: string;
  projectPath?: string;
  /** Phase A · TOPIC-WT-01. Optional binding to a Worktree. */
  worktreeId?: string | null;
  /** Phase C · TOPIC-IM-01. Optional one-shot initial message. */
  initialMessage?: string;
}

export interface UpdateTopicRequest {
  name?: string;
  color?: string;
  icon?: string;
  parentId?: string;
  systemPrompt?: string;
  contextFiles?: string[];
  pinnedMessages?: string[];
  projectPath?: string;
  autonomyLevel?: AutonomyLevel;
  provider?: string | null;
  /** Set to a model id to persist as the topic's last-used model; null clears. */
  model?: string | null;
  /**
   * Set the per-topic reasoning-effort tier (migration 033). One of
   * low/medium/high/xhigh/max; null/""/"default" clears the override. The
   * server validates the tier, forces an idle CLI respawn so it applies on the
   * next turn, and broadcasts `topic:updated` for cross-window sync.
   */
  effort?: string | null;
  /**
   * Set Fast Mode for this topic. Persists; null/undefined leaves it unchanged.
   * The server broadcasts `topic:updated` so other open windows for the same
   * topic stay in sync. See `server/db/migrations/024-topic-fast-mode.sql`.
   */
  fastMode?: boolean | null;
  disabledContextSources?: string[];
  /** Phase A · TOPIC-WT-01. Pass `null` to clear the binding. */
  worktreeId?: string | null;
  /** Phase C · TOPIC-IM-01. Pass `null` (or "") to clear after dispatch. */
  initialMessage?: string | null;
}

export interface LinkTopicRequest {
  targetId: string;
}

export interface ChatRequest {
  sessionKey: string;
  messages: Message[];
  planMode?: boolean;
  /**
   * Fast Mode flag for this turn. When `true` AND no per-message `model`
   * override AND `topic.model` is null, the server resolves the effective
   * model via `getFastModelFor(provider.name)` (e.g. claude-haiku for
   * claude-code, gpt-4o-mini for openai/codex). Picker wins over fast.
   */
  fastMode?: boolean;
  /** Per-message provider override (e.g. "claude-code", "codex"). Falls back to topic.provider or global default. */
  provider?: string;
  /** Per-message model override. Ignored by providers without per-call model selection. */
  model?: string;
}

// ============ Providers ============
// ProviderStatus / ProviderRequirement / ProviderSnapshotEntry /
// ProvidersSnapshot now live in shared/types.ts. Re-exported at the
// top of this file for back-compat with existing imports.

export interface HistoryRequest {
  limit?: number;
  offset?: number;
}

export interface HistoryMessage extends Message {
  id?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  media?: string[];
  partial?: boolean;
}

export interface HistoryResponse {
  messages: HistoryMessage[];
  total?: number;
  hasOrphanedMessage?: boolean;
  isStreaming?: boolean;
  streamState?: {
    startedAt: string;
    isThinking: boolean;
  } | null;
}

export interface UploadResponse {
  path: string;
  filename: string;
  size: number;
}

export interface SearchResult {
  /** SQLite message id when the hit comes from the live messages table;
   *  null for legacy JSONL transcript hits (no stable id → open only). */
  messageId: string | null;
  sessionKey: string;
  topicId: string | null;
  topicName: string;
  topicIcon: string;
  role: string;
  content: string;
  timestamp: string | null;
}

// ---------------------------------------------------------------------------
// WebSocket message discriminated union
// ---------------------------------------------------------------------------
//
// `WSMessage` is the type emitted by `useWebSocket` and consumed by every
// handler the app registers. Variants below cover messages the client
// actively narrows on; everything else falls through to `WSUnknownMessage`
// (loose `[k: string]: unknown` — strictly better than `any` because reads
// require explicit narrowing).
//
// Adding a new typed variant: define an interface below, append it to the
// `WSMessage` union, then handlers narrowing on `msg.type === '<literal>'`
// automatically get the correct payload shape. No central registry edit.
//
// Server side broadcasts via `broadcastToAll(message: object)` — the wire
// format isn't enforced. These types document intent at the boundary; if the
// server changes a payload shape, narrowing here may surface stale reads.

// --- Snapshot / settings -----------------------------------------------------
export type { WSProvidersSnapshotMessage } from '../../../shared/types';
// 3.4 — il goal della chat: forma unica in shared/, niente copia qui.
export type { WSGoalUpdatedMessage, TopicGoal, GoalStep, GoalStatus, GoalStepStatus } from '../../../shared/types';

export interface WSGatewayStatusMessage {
  type: 'gateway:status';
  connected: boolean;
}

// --- Topics ------------------------------------------------------------------
export interface WSTopicUpdatedMessage {
  type: 'topic:updated' | 'topic:created' | 'topic:archived';
  topic: Topic;
}

export interface WSTopicsReorderedMessage {
  type: 'topics:reordered';
  // Wire field is `order` (the server emits { order: string[] } — topics.ts).
  // Was mislabeled `topicIds`, which would read undefined in any consumer.
  order: string[];
}

export interface WSTopicSwitchCompleteMessage {
  type: 'topic:switch:complete';
  /** Original session id that just got migrated. */
  fromSessionKey: string;
  /** New session id the conversation now lives under. */
  toSessionKey: string;
  fromTopicId: string;
  toTopicId: string;
  /** First user message that triggered the switch (replayed cross-window). */
  userContent?: string;
  /** Assistant response from the switching turn. */
  assistantContent?: string;
  topicId?: string;
}

export interface WSTopicSwitchMessage {
  type: 'topic:switch';
  fromTopicId: string;
  toTopicId: string;
  toSessionKey: string;
  // Originating stream's session key — scopes the open+focus side-effect to the
  // window that drove the switch via isOwnStream(). Required on the wire (the
  // server always stamps it); inbound zod keeps it optional for version skew.
  fromSessionKey?: string;
}

export interface WSOpenProjectMessage {
  type: 'open-project';
  projectPath: string;
}

export interface WSDragMessage {
  type: 'drag:start' | 'drag:end' | 'drag:accepted' | 'drag:drop';
  /** Originating window id. Some emit sites only set `windowId`; receivers
   *  treat the two as synonyms. Both optional so the type accepts every
   *  current emit shape without forcing back-fill. */
  sourceWindowId?: string;
  windowId?: string;
  topicId?: string;
}

/** Cross-window presence — this window declaring the topics it holds (outbound
 *  client → server). Server rebroadcasts the full window list as
 *  `presence:windows`. WS-ephemeral; never persisted. */
export interface WSPresenceAnnounceMessage {
  type: 'presence:announce';
  windowId: string;
  windowLabel?: string;
  detached?: boolean;
  topicIds: string[];
  focusedTopicId?: string;
}

/** Per-topic delta routing — this window declaring the set of topics it
 *  currently has open (outbound client → server). The server stores it on the
 *  connection (`WSData.openTopicIds`) and routes streaming per-token deltas only
 *  to windows showing that topic. WS-ephemeral; never persisted. Re-sent on
 *  every open/close/focus change and on reconnect, so the set stays fresh. */
export interface WSSubscribeMessage {
  type: 'subscribe';
  topicIds: string[];
}

/** Full-list presence snapshot (inbound server → client). */
export interface WSPresenceWindowsMessage {
  type: 'presence:windows';
  windows: Array<{
    windowId: string;
    clientId: string;
    windowLabel?: string;
    detached?: boolean;
    topicIds: string[];
    focusedTopicId?: string;
  }>;
}

// --- Streaming / chat --------------------------------------------------------
export interface WSStreamStartMessage {
  type: 'stream:start';
  sessionKey: string;
  messageId?: string;
}

export interface WSStreamEndMessage {
  type: 'stream:end';
  sessionKey: string;
  messageId?: string;
  topicId?: string;
  /** Wall-clock duration of the request in ms. Persisted on the message
   *  footer (`<duration>s · <tokens> · $<cost>`). Always present on the
   *  WS-streaming path; absent on the legacy `topic:user_abort` broadcast. */
  latencyMs?: number;
  /** Provider-reported prompt token count for the turn that just completed. */
  usagePromptTokens?: number;
  /** Provider-reported completion token count for the turn that just completed. */
  usageCompletionTokens?: number;
  /** Cost in cents (USD). Computed via `calculateCost` from prompt+completion. */
  costCents?: number;
  /** Free-form reason carried on non-success terminations (e.g. `user_abort`). */
  reason?: string;
}

// Per-event slices of a streaming assistant turn. The server's chat
// pipeline broadcasts these for cross-window sync; the local SSE stream
// that originated the turn ignores them (see `localSSESessionsRef` in
// `useChat.handleStreamEvent`) to avoid duplicate content. Every variant
// carries `sessionKey` so the receiver can route to the right pane.
export interface WSStreamThinkingStartMessage {
  type: 'stream:thinking_start';
  sessionKey: string;
}
export interface WSStreamThinkingChunkMessage {
  type: 'stream:thinking_chunk';
  sessionKey: string;
  content: string;
}
export interface WSStreamThinkingEndMessage {
  type: 'stream:thinking_end';
  sessionKey: string;
}
export interface WSStreamContentChunkMessage {
  type: 'stream:content_chunk';
  sessionKey: string;
  content: string;
}
export interface WSStreamToolCallMessage {
  type: 'stream:tool_call';
  sessionKey: string;
  toolCall: ToolCall;
}
export interface WSStreamToolResultMessage {
  type: 'stream:tool_result';
  sessionKey: string;
  toolCallId: string;
  status?: ToolCall['status'];
  result?: string;
  error?: string;
  detail?: ToolCall['detail'];
  /** Server-stamped close of the tool's real-usage window (epoch ms). */
  endedAt?: number;
}
export interface WSStreamToolUpdateMessage {
  type: 'stream:tool_update';
  sessionKey: string;
  toolCallId: string;
  partialResult?: string;
}
export interface WSStreamToolDetailMessage {
  type: 'stream:tool_detail';
  sessionKey: string;
  toolCallId: string;
  detail: ToolCall['detail'];
}
export interface WSStreamErrorMessage {
  type: 'stream:error';
  sessionKey: string;
  error?: string;
}
/** Marker di confine di compattazione (CHAT-COMPACT-01), come arriva da
 *  `GET /api/history`. UNA dichiarazione in shared/types.ts: la copia locale
 *  ometteva `topicId` e `sessionKey`, che il server manda comunque. */
export type { StoredCompactionMarker as CompactionMarker } from '../../../shared/types';
export interface WSStreamCompactionMessage {
  type: 'stream:compaction';
  sessionKey: string;
  topicId?: string;
  markerId: string;
  afterMessageId: string | null;
  trigger: 'auto' | 'manual' | 'unknown';
  preTokens?: number;
  /** Filled by a follow-up broadcast once the post-compaction context size is
   *  known (the next result's input tokens) — drives the pre→post delta. */
  postTokens?: number;
  createdAt: string;
}
/**
 * Il contesto REALE del modello, misurato su UNA chiamata
 * (`input + cache_read + cache_creation`) contro la finestra di quel modello.
 *
 * Da non confondere con il preventivo dell'envelope che mostra il Context
 * Inspector (`ContextBudgetBar`): quello è "cosa sto iniettando io", questo è
 * "cosa ha in pancia il modello adesso". Due domande diverse.
 */
export interface ContextUsage {
  used: number;
  size: number;
  /** 0–100, satura a 100. */
  percent: number;
  level: 'ok' | 'warn' | 'critical';
  /** Perché il livello non è `ok`. Vedi `ContextUpdatePayload.reason`. */
  reason?: 'window' | 'cost';
  /** true = finestra dedotta dal default perché il modello non è in tabella. */
  estimated: boolean;
  model?: string;
}
/**
 * Il blocco `usage_update` di ACP, verbatim (3.1). Arriva così sia dall'evento
 * WS che da `GET /api/context/live`: `used` e `size` stanno QUI dentro e sono
 * obbligatori — un provider non può mandare metà del rapporto e lasciare il
 * ring a indovinare il denominatore. Il resto del payload è presentazione
 * nostra e vive fuori dal blocco.
 */
export type { AcpUsageUpdate, UsageCost } from '../../../shared/types';
/** Payload sul filo: blocco ACP + presentazione. `useRealContext` lo appiattisce
 *  in `ContextUsage` per la UI, che di ACP non deve sapere niente. */
export interface ContextUpdatePayload {
  usage: AcpUsageUpdate;
  percent: number;
  level: 'ok' | 'warn' | 'critical';
  /** Perché il livello non è `ok`: `window` = la finestra sta finendo,
   *  `cost` = la finestra è ampia ma ogni chiamata rilegge già un prompt grosso.
   *  Due motivi diversi meritano due messaggi diversi. */
  reason?: 'window' | 'cost';
  estimated: boolean;
  model?: string;
}
export interface WSStreamContextMessage extends ContextUpdatePayload {
  type: 'stream:context';
  sessionKey: string;
  topicId?: string;
}
/**
 * A tool call paused the stream and is asking the user for input.
 * The client opens the inline `ToolInputForm` against `schema`; on
 * submission it `POST /api/chat/tool-response` with the resolved
 * `ToolUserResponse`. See `ToolCall.userInputSchema` for the lifecycle.
 */
export interface WSStreamToolUserInputRequiredMessage {
  type: 'stream:tool_user_input_required';
  sessionKey: string;
  topicId?: string;
  toolCallId: string;
  schema: UserInputSchema;
}
/**
 * Sent by the server when a client reconnects mid-stream. Carries the
 * accumulated buffer so the late joiner doesn't see a blank assistant
 * message until the next chunk arrives.
 */
export interface WSStreamCatchupMessage {
  type: 'stream:catchup';
  sessionKey: string;
  // Mirrors the wire shape — server emits topicId so cross-window UI can
  // route the catchup to the right topic row even when no client is
  // currently focused on it.
  topicId?: string;
  content?: string;
  thinking?: string;
  isThinking?: boolean;
  messageId?: string;
  /**
   * Tool calls already attached to the partial message in DB. Without these
   * the late joiner sees text-only content and loses any tools that ran
   * before they connected — the chronological timeline gets a hole that
   * the next `stream:tool_call` event cannot fill (it appends, not inserts).
   */
  toolCalls?: ToolCall[];
  /**
   * Chronological blocks timeline (text/thinking/tool interleaved) from DB.
   * Mirrors `StoredMessage.blocks` — preferred by the renderer when present.
   */
  blocks?: ContentBlock[];
}

/**
 * Lightweight presence event — another window in the same browser session
 * (or another connected client) is composing a reply on `topicId`. The
 * UI shows an "X is typing…" hint for ~2s.
 */
export interface WSTypingMessage {
  type: 'typing';
  topicId: string;
  text?: string;
}

export interface WSMessageNewMessage {
  type: 'message:new';
  topicId: string;
  sessionKey: string;
  role: 'user' | 'assistant';
  /** Stable message id — used for cross-window dedupe. Optional for legacy
   *  broadcasts; receivers fall back to last-of-role/content matching. */
  messageId?: string;
  /** Full message body — receivers also accept `preview` as a fallback. */
  content?: string;
  /** First 100 chars, used for unread previews. */
  preview?: string;
  message?: { id: string; role: string; content: string; timestamp?: string };
}

/** Inline media (images/files) appended to the last assistant message. */
export interface WSMessageMediaMessage {
  type: 'message:media';
  sessionKey: string;
  media: string[];
}

/** Server requests the client to drop a session's local message buffer. */
export interface WSClearMessage {
  type: 'clear';
  sessionKey: string;
}

// --- Sessions / agents -------------------------------------------------------
export interface WSAgentsSessionsMessage {
  type: 'agents:sessions';
  sessions: Array<{ key: string; status: string; topicId?: string; updatedAt?: number }>;
}

export interface WSAgentsSpawnedMessage {
  type: 'agents:spawned';
  topicId: string;
  sessionKey: string;
  label: string;
}

export interface WSAgentsStoppedMessage {
  type: 'agents:stopped';
  sessionKey: string;
}

export interface WSTerminalSessionsMessage {
  type: 'terminal:sessions';
  sessions: TerminalSessionInfo[];
}

/** Per-session pty activity. Server-tracked from the central pty data path so
 *  it covers every session, mounted or not. `finished` marks an active→idle
 *  transition (a completed turn) — used to raise a notification for
 *  claude-code. `kind` is the session type. */
export interface WSTerminalActivityMessage {
  type: 'terminal:activity';
  id: string;
  busy: boolean;
  finished?: boolean;
  kind?: 'shell' | 'claude-code' | 'claude-code-team';
}

// --- Notifications -----------------------------------------------------------
/** Initial unread snapshot sent on WS connect. Keyed by topicId. */
export interface WSUnreadInitMessage {
  type: 'unread:init';
  data?: Record<string, { lastReadAt: string; unreadCount: number }>;
}
export interface WSUnreadUpdatedMessage {
  type: 'unread:updated';
  topicId: string;
  unreadCount: number;
}

/**
 * Emitted by the server to ask listeners to bring a topic's pane into focus.
 */
export interface WSPaneFocusSuggestMessage {
  type: 'pane:focus-suggest';
  topicId: string;
  /** Present when the focus was triggered by a board task (jump-to-tab). */
  taskId?: string;
  /**
   * When set, the listener opens this project window and nests the topic
   * inside it. Sent inline (rather than read from the topic) so the client
   * needn't wait for a preceding topic:updated to land first — used when a
   * session binds itself to a project via the bind/create/open-project
   * control endpoints or the /project command.
   */
  projectPath?: string;
}

/**
 * Periodic ping from a worker telling the board "I'm alive". Used to grey
 * out tasks whose owner has gone silent.
 */
export interface WSAgentHeartbeatMessage {
  type: 'agent:heartbeat';
  agentId: string;
  /** Optional project scoping — heartbeats from agents NOT bound to a
   *  project still need to clear stale entries everywhere. */
  projectId?: string;
}

/**
 * Worker is asking the human for help — surfaces as a banner. Payload
 * mirrors `WSAgentNudgeMessage` because the UI renders them the same
 * way, but the literal is distinct so handlers can choose to ignore one.
 */
export interface WSAgentEscalationMessage {
  type: 'agent:escalation';
  agentId: string;
  agentName: string;
  message: string;
  taskId: string | null;
  projectId: string;
  timestamp?: number;
}

/**
 * Lightweight "is doing something" presence ping per agent. Distinct from
 * heartbeat because consumers may want to update activity UI more often
 * than they refresh the heartbeat map.
 */
export interface WSAgentActiveMessage {
  type: 'agent_active';
  agentId: string;
  projectId?: string;
}

export interface WSAgentNudgeMessage {
  type: 'agent:nudge';
  agentId: string;
  agentName: string;
  message: string;
  taskId: string | null;
  projectId: string;
  timestamp: number;
}

export interface WSDashboardUpdatedMessage {
  type: 'dashboard:updated' | 'cron:updated';
}

// --- Misc resource-update broadcasts ---------------------------------------
/** Memory store changed — consumers refetch. `scope` narrows the refresh
 *  (e.g. only the global memory or a specific topic's memory); when absent
 *  consumers refresh everything. */
export interface WSMemoryUpdatedMessage {
  type: 'memory:updated';
  projectId?: string;
  scope?: 'global' | 'topic';
  topicId?: string;
}
/** Repo git status snapshot updated. */
export interface WSGitStatusMessage {
  type: 'git:status';
  projectPath?: string;
  projectId?: string;
  status?: unknown;
}
/** Scripts list (package.json scripts etc.) changed. */
export interface WSScriptsUpdatedMessage {
  type: 'scripts:updated';
  projectPath?: string;
  projectId?: string;
  /** Full scripts payload — opaque to the type system; consumers cast. */
  scripts?: unknown;
}
/** Browser pane navigation broadcast. */
export interface WSBrowserNavigateMessage {
  type: 'browser:navigate';
  /** Topic that asked to surface the URL (membership guard + spawner tracking). */
  topicId: string;
  url: string;
  /**
   * Browser-pane contextId the pane must register its native CDP target under
   * (== resolveContextIdForTopic(topic) === topic.id). Lets the agent's
   * browser_observe/act/eval resolve the SAME native view the pane drives,
   * instead of an invisible Playwright phantom. Absent → legacy random id.
   */
  contextId?: string;
}
/**
 * Open a browser pane in the same layout group as a specific pane, then
 * navigate it. Emitted when a Claude Code *terminal* calls open_browser_pane
 * (the chat path uses topic-targeted `browser:navigate` instead). `paneId` is
 * the terminal's pane id (`terminal:<sessionId>`); whichever layout currently
 * renders that pane — standalone or project — opens the browser beside it.
 */
export interface WSBrowserOpenNearPaneMessage {
  type: 'browser:open-near-pane';
  paneId: string;
  /**
   * Deterministic browser contextId the pane must register under (e.g.
   * `term-<terminalId>`). Lets the server's observe/act/import-chrome routes
   * resolve the SAME pane the terminal opened — so a terminal can drive it,
   * not just open it. Absent → legacy behaviour (singleton picks an id).
   */
  contextId?: string;
  url: string;
}
/**
 * Fallback: open_browser_pane could not mount a VISIBLE native pane in any
 * rendered cell (the spawner terminal/topic isn't a tab anywhere), so the server
 * asks the PRIMARY window to force one open — otherwise the agent would drive an
 * off-screen browser the user can't see. The client routes this through
 * openBrowserPane (single-owner, idempotent). The url is then loaded by the
 * server over CDP once the forced pane registers its native target.
 */
export interface WSBrowserForceOpenMessage {
  type: 'browser:force-open';
  /** Deterministic browser contextId to mount the visible pane under. */
  contextId: string;
  url: string;
}
/**
 * Task-owned browser open (feature-flagged, server env TOPICS_TASK_BROWSER):
 * the agent working a task called open_browser_pane on its dispatch topic, so
 * instead of the layout-level `browser:navigate` the server forks a task-scoped
 * open. The GLOBAL layout hooks (usePaneOrdering / useProjectLayout) DELIBERATELY
 * ignore this frame — that's the fork that keeps the tab out of the global pane
 * store; only the task's in-drawer group (state/taskBrowserTabs via
 * useTaskBrowserTabsSync) consumes it, upserting `{contextId,url}` under `taskId`.
 * `contextId` is the canonical, self-describing `task-<id8>-…` the pane registers
 * its native target under, so the agent's browser_* tools drive the SAME tab.
 */
export interface WSBrowserOpenTaskTabMessage {
  type: 'browser:open-task-tab';
  /** Task that owns the tab group (its ui-state key `task-browser-tabs:<taskId>`). */
  taskId: string;
  /** Canonical task-scoped browser contextId (`task-<id8>-…`). */
  contextId: string;
  url: string;
}
/**
 * Remote pane close (close_browser_pane MCP tool / REST): every window that
 * renders `browser:<contextId>` closes it through its NORMAL close flow (same
 * as the tab's X — closedStack tombstone, membership persist, native
 * teardown), so live clients converge instead of clobbering a server-side
 * state edit back. Windows that don't own the pane ignore the frame.
 */
export interface WSBrowserClosePaneMessage {
  type: 'browser:close-pane';
  contextId: string;
}
/**
 * Remote pane focus (browser_focus_tab MCP tool / REST): every window that
 * renders `browser:<contextId>` brings that tab to the front (activates it in
 * its group / surfaces it if backgrounded). Same client-originated, idempotent
 * model as close-pane — windows that don't own the pane ignore the frame.
 */
export interface WSBrowserFocusPaneMessage {
  type: 'browser:focus-pane';
  contextId: string;
}
/**
 * Pane / sidebar UI state replicated across windows (Phase 30 PANE-02).
 * Split into init (full snapshot keyed by store key) vs updated (single
 * key/value pair) so consumers can narrow without optional-field casts.
 */
export interface WSUIStateInitMessage {
  type: 'ui-state:init';
  /** Full snapshot keyed by `useServerState` key. */
  data?: Record<string, unknown>;
  // Wire fields are server_seq / sourceClientId (ui-state.ts + ws-outbound).
  // Were mislabeled seq/originId — a future LWW/echo consumer would read
  // undefined and reintroduce duplicate-echo / stale-ordering bugs.
  server_seq?: number;
  sourceClientId?: string;
}
export interface WSUIStateUpdatedMessage {
  type: 'ui-state:updated';
  /** The store key that changed. */
  key: string;
  /** The new value for that key. Opaque to the type system. */
  value: unknown;
  server_seq?: number;
  sourceClientId?: string;
}

// --- Project + Worktree (Phase A · migrations 016-018) ----------------------
export interface WSProjectMessage {
  type: 'project:new' | 'project:updated' | 'project:archived' | 'project:deleted';
  /** Full row on new/updated/archived; `{ id }` on deleted. */
  project: Partial<Project> & { id: string };
  payload_version?: 1;
}

export interface WSWorktreeMessage {
  type: 'worktree:new' | 'worktree:updated' | 'worktree:deleted';
  /** Full row on new/updated; `{ id }` on deleted. */
  worktree: Partial<Worktree> & { id: string };
  payload_version?: 1;
}

export interface WSMachineMessage {
  type: 'machine:upserted' | 'machine:updated' | 'machine:deleted';
  machine: Partial<Machine> & { id: string };
  payload_version?: 1;
}

// --- Catch-all ---------------------------------------------------------------
/**
 * Fallback for message types not (yet) listed above. Keeps the dispatcher
 * resilient to forward-compat messages without forcing every new server
 * broadcast to add a typed variant first. Index sig is `unknown` (not `any`)
 * so reads require explicit casts — visible churn is the point.
 */
/**
 * Catch-all kept OUTSIDE the `WSMessage` union below. Its `type: string`
 * would widen `WSMessage['type']` to plain `string` if it were a union
 * member, which destroys literal narrowing on every handler — after a
 * `msg.type === '<literal>'` check the narrowed type would still contain
 * `WSUnknownMessage`, so fields like `msg.task` collapse to `unknown`.
 *
 * Forward-compatibility is preserved without it: at runtime the server
 * can emit any `{type, ...}` shape, and handlers already gate on
 * `if (msg.type === '<literal>')` so unknown types fall through silently.
 * If a call site needs to introspect an unknown message it can cast to
 * `WSUnknownMessage` explicitly.
 */
export interface WSUnknownMessage {
  type: string;
  [key: string]: unknown;
}

// ─── Claude Code session lifecycle (see openspec/changes/claude-session-tracker) ──

export type { ClaudeSessionPhase } from '../../../shared/types';

/**
 * The two visual tiers of "a session needs you", split so the UI can paint them
 * differently (the status-system redesign):
 *   - 'input' — a permission prompt mid-task (awaiting-approval): you must ACT
 *     now. Painted LOUD (amber, assertive pulse).
 *   - 'done'  — the turn finished or timed out (awaiting-user / paused): look
 *     when you're ready. Painted CALM (blue, gentle breathe).
 * Single definition shared by signals.ts (derivation) and selectionStyles.ts
 * (surface colours) so every surface agrees on the tier→colour mapping.
 */
export type AttentionTier = 'input' | 'done';

// UNA dichiarazione in shared/types.ts. La copia locale era una versione
// RIDOTTA dello stato che il server manda: senza `jsonlPath`, `jsonlOffset` e
// `createdAt`, che arrivano a ogni broadcast `session:state`.
export type {
  ClaudeSessionPendingApproval,
  ClaudeSessionActiveTool,
  ClaudeSessionError,
  ClaudeSessionState,
} from '../../../shared/types';

export interface WSSessionStateMessage {
  type: 'session:state';
  /** Null for topic-less terminal claude sessions — key off state.claudeSessionId. */
  sessionKey: string | null;
  state: ClaudeSessionState;
}

/** A board task just ENTERED review — the end-of-task cue. Emitted IN ADDITION
 *  to (not instead of) `task:updated`, only on the transition edge, so the
 *  completion notifier fires exactly once per delivery. `taskId` makes the OS
 *  banner clickable → opens that task's drawer (openTaskInApp). */
export interface WSTaskReviewReadyMessage {
  type: 'task:review-ready';
  projectId: string;
  taskId: string;
  taskTitle: string;
  reason?: string;
}

export type WSMessage =
  | WSProvidersSnapshotMessage
  | WSGoalUpdatedMessage
  | WSGatewayStatusMessage
  | WSTopicUpdatedMessage
  | WSTopicsReorderedMessage
  | WSTopicSwitchCompleteMessage
  | WSTopicSwitchMessage
  | WSOpenProjectMessage
  | WSDragMessage
  | WSPresenceAnnounceMessage
  | WSSubscribeMessage
  | WSPresenceWindowsMessage
  | WSStreamStartMessage
  | WSStreamEndMessage
  | WSStreamThinkingStartMessage
  | WSStreamThinkingChunkMessage
  | WSStreamThinkingEndMessage
  | WSStreamContentChunkMessage
  | WSStreamToolCallMessage
  | WSStreamToolResultMessage
  | WSStreamToolUpdateMessage
  | WSStreamToolDetailMessage
  | WSStreamErrorMessage
  | WSStreamCompactionMessage
  | WSStreamContextMessage
  | WSStreamToolUserInputRequiredMessage
  | WSStreamCatchupMessage
  | WSTypingMessage
  | WSMessageNewMessage
  | WSMessageMediaMessage
  | WSClearMessage
  | WSAgentsSessionsMessage
  | WSAgentsSpawnedMessage
  | WSAgentsStoppedMessage
  | WSTerminalSessionsMessage
  | WSTerminalActivityMessage
  | WSUnreadInitMessage
  | WSUnreadUpdatedMessage
  | WSPaneFocusSuggestMessage
  | WSAgentHeartbeatMessage
  | WSAgentEscalationMessage
  | WSAgentActiveMessage
  | WSAgentNudgeMessage
  | WSDashboardUpdatedMessage
  | WSMemoryUpdatedMessage
  | WSGitStatusMessage
  | WSScriptsUpdatedMessage
  | WSBrowserNavigateMessage
  | WSBrowserOpenNearPaneMessage
  | WSBrowserForceOpenMessage
  | WSBrowserOpenTaskTabMessage
  | WSBrowserClosePaneMessage
  | WSBrowserFocusPaneMessage
  | WSUIStateInitMessage
  | WSUIStateUpdatedMessage
  | WSProjectMessage
  | WSWorktreeMessage
  | WSMachineMessage
  | WSTaskReviewReadyMessage
  | WSSessionStateMessage;
// (Historical note: an earlier shape included `WSUnknownMessage` as a
// union member, whose `type: string` widened the union's `type` to plain
// `string` and broke literal narrowing across every handler. Keeping the
// catch-all OUT of the union — see its doc comment above — preserves
// narrowing without losing forward-compat catch-all behavior.)
// This was the contract before Phase A and the consumers we don't own
// (useBoard.ts, useChat.ts, …) still assume the wider shape. The new
// typed members above (WSProjectMessage, WSWorktreeMessage, …) are
// usable by their own consumers via discriminant checks; existing
// consumers are unaffected.

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface TopicTemplate {
  name: string;
  icon: string;
  color: string;
  systemPrompt: string;
  description: string;
}

export interface FileNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  size?: number;
  modified?: string;
  children?: FileNode[];
}

export interface GitStatus {
  branch: string;
  lastCommit: { hash: string; message: string; author: string; ago: string };
  files: { path: string; status: string }[];
  ahead: number;
  behind: number;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
  isRemote: boolean;
  ahead?: number;
  behind?: number;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
  ago: string;
}

export type PanelTab = 'chat' | 'files' | 'changes' | 'processes' | 'browser' | 'terminal';

export interface TerminalSessionInfo {
  id: string;
  name: string;
  createdAt: string;
  cwd: string;
  command: string;
  clients: number;
  topicId?: string;
  type: 'shell' | 'claude-code' | 'claude-code-team' | 'codex';
  claudeSessionId?: string | null;
  /** sessionKey of the orchestrator that spawned this session as a sub-agent.
   *  Null for human-/chat-created sessions. Lets the roster nest sub-agents
   *  under the session that spawned them. */
  parentSessionKey?: string | null;
  /** Authoritative pty-busy snapshot from the server roster. Used to
   *  reconcile loading state so a missed terminal:activity busy:false delta
   *  (server restart / WS reconnect / dropped message) can't leave a session
   *  spinning forever. Absent on optimistic/cached entries → treated idle. */
  busy?: boolean;
}

// ── Pane types — single source of truth lives in state/pane/types.ts ─────────
// The pane-store reducer owns the canonical `Pane` + `PaneType` shapes. This
// file re-exports them so existing `import { Pane } from '@/types'` call sites
// continue to compile without churn during the cutover. New code should import
// directly from '@/state/pane/types'.
export type { Pane, PaneType } from '../state/pane/types';
// `PANE_TYPES` is the runtime array `PaneType` is derived from — re-exported so
// a pane-type picker or validator can import the canonical list from '@/types'.
export { PANE_TYPES } from '../state/pane/types';

// Pane Groups — each group has its own tab bar (like VS Code editor groups)
export type PaneGroupType = 'chat' | 'file' | 'utility';

export interface PaneGroup {
  id: string;
  paneIds: string[];
  activePaneId: string;
  type: PaneGroupType;
}

/**
 * Optional vertical sub-stack inside a single COLUMN of a `GroupLayoutRow`
 * (the project-window twin of `PanelGridCellStack`). A row's columns are
 * `groupIds[colIdx]` — one group per column. When the user drops a tab on a
 * column's top/bottom edge (or hits "Split Down"), we split JUST that column
 * vertically instead of inserting a full-width row under every column. The
 * soloed group is appended to `cellStacks[primaryGroupId].groupIds` and the
 * renderer composes the cell as `[primary, ...stack.groupIds]` stacked
 * top-to-bottom — leaving the row's sibling columns full-height.
 *
 * Invariants (mirrors PanelGridCellStack):
 *   - `groupIds` holds ONLY the additional groups below the primary; the
 *     primary (`row.groupIds[colIdx]`) is NOT included.
 *   - `heights.length === groupIds.length + 1` (primary slot + each member),
 *     every entry > 0, sum ≈ 1.
 *   - a column with no vertical split simply has no `cellStacks` entry, so the
 *     single-group-per-column legacy case stays `cellStacks` being absent.
 */
export interface GroupCellStack {
  groupIds: string[];
  heights: number[];
}

export interface GroupLayoutRow {
  groupIds: string[];
  widths: number[];       // fractions summing to 1
  /**
   * Optional per-column vertical stacks, keyed by the column's primary
   * `groupIds[colIdx]`. Present only for columns split vertically; absent for
   * the legacy single-group-per-column case. Persisted to the project layout.
   */
  cellStacks?: Record<string, GroupCellStack>;
}

/**
 * Optional vertical sub-stack inside a single cell of a `PanelGridRow`.
 *
 * Why this is additive (vs reshaping `itemKeys` into a list of cells): the
 * row's primary layout is already `itemKeys[colIdx]` → one pane per cell.
 * 99% of cells today host exactly one item; we don't need to pay the cost
 * of restructuring 40+ read sites in PanelGrid for that common case. When
 * the user splits-down on a tab inside cell C, we append the soloed pane
 * to `cellStacks[itemKeys[C]]` and the renderer composes it as a vertical
 * stack below the primary — leaving the row's columns intact.
 *
 * Invariants:
 *   - items.length === heights.length
 *   - heights[i] > 0, sum(heights) === 1 (small float drift tolerated)
 *   - the primary item (`itemKeys[colIdx]`) is NOT included in `items`;
 *     conceptually the cell renders [primary, ...stack.items] vertically
 *     with [primary_height, ...stack.heights] proportions, but storing
 *     only the *additional* items keeps the legacy single-pane case as
 *     `cellStacks` simply being absent.
 */
export interface PanelGridCellStack {
  items: string[];
  heights: number[];
}

export interface PanelGridRow {
  itemKeys: string[];     // GridItem.key values in this row (one per cell)
  widths: number[];       // fractions summing to 1 per row
  /**
   * Optional vertical sub-stacks keyed by the primary `itemKeys[colIdx]`.
   * Present only for cells that have been split vertically. Persisted to
   * localStorage when present; absent for the legacy single-pane case.
   */
  cellStacks?: Record<string, PanelGridCellStack>;
}

// Discriminant for the topics-menu "expanded tool" popover. Only `'remote'`
// is ever produced (the other former menu entries open as full pages via
// handleOpenAsPage, not as an expanded tool), so the union is intentionally
// a single literal — widening it back to the old 7-member set just creates
// dead, untyped surface.
export type SidebarTab = 'remote';

/** Preferenze della UI. Omonimo ma NON parente dell'`AppSettings` di
 *  `server/services/app-settings.ts`, che è la config dei provider AI
 *  (modello, max tokens, effort) e non ha un campo in comune con questo. */
export interface AppSettings {
  fontSize: number;       // 12-18
  messageDensity: 'compact' | 'comfortable';
  sidebarWidth: number;   // 180-400
  sidebarCollapsed: boolean;
  // Topic / agent completion notifications (in-app toast + native Electron).
  // Surfaced in Settings → Notifications. When `notificationsEnabled` is
  // false, no toast and no native notification fires for completions, and the
  // sub-toggles are ignored. `notifyEvenWhenFocused` lets the desktop
  // notification fire even when the corresponding topic is the focused tab —
  // useful when several topics run in parallel and the user wants the cue
  // even on the visible one.
  notificationsEnabled: boolean;
  notificationsSound: boolean;
  notifyEvenWhenFocused: boolean;
  // Gates creation of NEW standalone/project chats (the "New Chat" affordance,
  // ⌘⇧N, and the command-palette pill). A new chat drives a paid provider turn
  // (subscription only works through an interactive PTY — see the billing
  // constraint), so this is OPT-IN and defaults to OFF: when false the New Chat
  // entry points are hidden and ⌘⇧N is inert. Surfaced in Settings → Features,
  // flagged as a paid feature.
  enableNewChat: boolean;
  // EXPERIMENTAL, desktop-only. When on, every window split and the sidebar
  // render as detached, rounded "floating" cards separated by small gaps that
  // reveal the macOS window vibrancy underneath — making the split layout
  // easier to read. Gated to Electron (relies on native vibrancy) and ignored
  // on web/PWA. Surfaced in Settings → Appearance. Defaults OFF.
  floatingSplits: boolean;
  // Apple-Intelligence-style animated glow ring around a chat pane while its
  // session is actively WORKING (streaming / an agent running). Thin, cool,
  // low-opacity rotating conic-gradient ring — never a fill, never behind text.
  // Purely cosmetic; the ring element only exists in the DOM while the session
  // is working (see .chat-working-ring). Surfaced in Settings → Appearance.
  // Defaults ON.
  workingGlow: boolean;
}

export interface ScriptProcess {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: 'running' | 'done' | 'error';
  pid: number | null;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
}

// Streaming events from server
/** Gli eventi di streaming che la chat consuma dal WS. Omonimo ma NON parente
 *  dello `StreamEvent` di `server/providers/types.ts`: quello è cosa un provider
 *  AI emette VERSO il server, e non arriva mai al browser in quella forma. */
export type StreamEvent =
  | { type: 'thinking_start'; sessionKey: string }
  | { type: 'thinking_chunk'; sessionKey: string; content: string }
  | { type: 'thinking_end'; sessionKey: string }
  | { type: 'content_start'; sessionKey: string }
  | { type: 'content_chunk'; sessionKey: string; content: string }
  | { type: 'tool_call_start'; sessionKey: string; toolCall: ToolCall }
  | { type: 'tool_call_result'; sessionKey: string; toolCallId: string; result: string; error?: string }
  | { type: 'message_end'; sessionKey: string; finishReason: string }
  | { type: 'media'; sessionKey: string; paths: string[] };
