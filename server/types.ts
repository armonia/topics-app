import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { ToolCallStatus, UserInputSchema, ToolUserResponse } from "../shared/types";

// Re-export so existing imports `from "./types"` keep resolving.
export type {
  ToolCallStatus,
  AskUserQuestionItem,
  UserInputSchema,
  ToolUserResponse,
} from "../shared/types";

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
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | { type: "search"; query: string; toolName?: "search" | "grep" | "glob" | "web_search"; content?: string; filePaths?: string[]; numFiles?: number; numMatches?: number; mode?: "content" | "files_with_matches" | "count" }
  | { type: "fetch"; url: string; prompt?: string; result?: string; statusCode?: number; bytes?: number }
  | { type: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> }
  | {
      type: "sub_agent";
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
  | { type: "plan"; text: string }
  | { type: "mcp"; server: string; tool: string; args?: Record<string, unknown>; result?: string }
  | { type: "unknown"; raw: { args?: Record<string, unknown>; result?: string } };

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
  result?: string;
  error?: string;
  contentOffset?: number;
  /**
   * Optional typed detail built at the provider boundary. Renderers branch on
   * `detail.type` for per-tool UI. When absent, fall back to generic rendering
   * via `args` + `result`. Sub-agents (Task) accumulate child activity in
   * `detail.actions[]` rather than emitting separate timeline items.
   */
  detail?: ToolCallDetail;
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
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; toolCall: ToolCall };

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
}

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
  sortOrder?: number;
  autonomyLevel?: 'ask' | 'auto-apply' | 'yolo';
  provider?: string | null;
  /** Last-used model for this topic. NULL = use the provider's default. */
  model?: string | null;
  /**
   * Fast Mode toggle (migration 024). When `true`, the chat route asks the
   * provider to use its native "fast model" (e.g. claude-haiku, gpt-4o-mini)
   * for this topic's turns, unless a per-message or topic-persisted model
   * override is set. Persists across sessions and synchronises across windows
   * via the `topic:updated` WS broadcast. Defaults to `false`.
   */
  fastMode?: boolean;
  /**
   * Optional binding to a Worktree (a specific git working copy of a Project).
   * NULL = legacy/default behaviour: chat, tools, and slash commands operate
   * inside `projectPath`. NON-NULL = operations are scoped to the worktree's
   * `absPath` instead. ON DELETE SET NULL — deleting the worktree gracefully
   * degrades the topic back to its `projectPath`. See migration 018.
   */
  worktreeId?: string | null;
  /**
   * Phase C · one-shot initial message. When non-null, the renderer
   * auto-dispatches it on first session open then PATCHes back to null.
   * Mirrors `client/src/types:Topic.initialMessage`.
   */
  initialMessage?: string | null;
  disabledContextSources?: string[];
  assignedAgents?: { id: string; name: string; role: string }[];
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

/**
 * First-class Project entity (migration 016).
 *
 * Optional canonical record for any project that the user wants to register.
 * Legacy code paths that key off `topics.project_path` / `tasks.project_id`
 * strings continue to work without a corresponding `Project` row — auto-
 * creation only happens on explicit user action.
 */
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
  createdAt: string;
  updatedAt: string;
}

/**
 * First-class Worktree entity (migration 017).
 *
 * Each row is a checked-out git working copy of a Project at a specific
 * branch (or detached HEAD). Disk layout: `~/.topics/worktrees/<project-
 * slug>/<worktree-name>/` (configurable via env `TOPICS_WORKTREES_DIR`).
 *
 * The `mode` enum tracks how the worktree was created so deletion knows
 * whether it owns the underlying git branch:
 *   - `branch`:   we created a fresh branch off `baseRef`; delete on row deletion
 *   - `reuse`:    we attached to an existing branch; do NOT delete on row deletion
 *   - `detached`: detached HEAD at a ref; `branchName` is null
 *
 * The `status` enum is the materialisation state, exposed in the WS broadcast
 * so the UI can show a loader while the on-disk worktree is being built.
 */
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

export interface TopicsData {
  topics: Record<string, Topic>;
}

export interface UnreadData {
  [topicId: string]: {
    lastReadAt: string;
    unreadCount: number;
  };
}

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
  broadcast: (message: object, exclude?: ServerWebSocket<WSData>) => void;
  broadcastToAll: (message: object) => void;
  broadcastToTopic: (topicId: string, message: object, exclude?: ServerWebSocket<WSData>) => void;
  broadcastToTopicSubscribers: (topicId: string, message: object, exclude?: ServerWebSocket<WSData>) => void;
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
  updateLastMessage: (sessionKey: string, updates: Partial<StoredMessage>) => StoredMessage | null;
  appendToLastMessage: (sessionKey: string, contentDelta: string, thinkingDelta?: string) => StoredMessage | null;
  finalizeLastMessage: (sessionKey: string) => StoredMessage | null;
  addToolCallToLastMessage: (sessionKey: string, toolCall: ToolCall) => StoredMessage | null;
  updateToolCallResult: (sessionKey: string, toolCallId: string, result: string, error?: string) => StoredMessage | null;
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
  endStream: (sessionKey: string) => void;
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
  findNewMediaFiles: (sinceMs: number) => string[];
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

// --- Agent Autonomy Types ---

export interface AgentAuthResult {
  agent: {
    id: string;
    name: string;
    role: string;
    status: string;
    avatarEmoji: string;
    maxConcurrentTasks: number;
    isBoardLead: boolean;
    gatewaySessionId: string | null;
  };
  isLead: boolean;
}

export interface BoardMemory {
  id: string;
  projectId: string;
  content: string;
  tags: string[];
  isChat: boolean;
  source: string | null;
  agentId: string | null;
  createdAt: string;
}

export interface AgentActionLog {
  id: string;
  agentId: string;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  detail: any;
  createdAt: string;
}
