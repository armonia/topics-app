import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";

export interface WSData {
  id: string;
  focusedTopicId: string | null;
  lastPong: number;
  terminalId?: string;
  _termHandler?: { message: (data: string | Buffer | ArrayBuffer) => void; close: () => void };
}

export interface ToolCall {
  id: string;
  name: string;
  /**
   * Tool arguments as parsed from the provider stream. Keys are field names,
   * values are arbitrary JSON — consumers JSON.stringify before persistence.
   * `unknown` over `any` so callers must narrow before use.
   */
  args: Record<string, unknown>;
  status?: 'pending' | 'running' | 'success' | 'error';
  result?: string;
  error?: string;
  contentOffset?: number;
}

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

  // State
  activeStreams: Map<string, ActiveStream>;
  wsClients: Set<ServerWebSocket<WSData>>;

  // Utils
  broadcast: (message: object, exclude?: ServerWebSocket<WSData>) => void;
  broadcastToAll: (message: object) => void;
  broadcastToTopic: (topicId: string, message: object, exclude?: ServerWebSocket<WSData>) => void;
  isTopicFocused: (topicId: string) => boolean;
  loadTopics: () => TopicsData;
  saveTopics: (data: TopicsData) => void;
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
