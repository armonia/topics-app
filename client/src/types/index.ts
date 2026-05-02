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
  sortOrder?: number;
  autonomyLevel?: AutonomyLevel;
  disabledContextSources?: string[];
  provider?: string | null;
  /**
   * Last-used model for this topic. Persists across sessions so the picker
   * remembers your selection; mirrors `server/types.ts:Topic.model`. NULL =
   * use the provider's default.
   */
  model?: string | null;
  /**
   * Phase A · TOPIC-WT-01: optional binding to a Worktree. NULL = legacy
   * behaviour (chat/tools operate inside `projectPath`). When set, the
   * server scopes operations to the worktree's `absPath`. Mirrors
   * `server/types.ts:Topic.worktreeId`.
   */
  worktreeId?: string | null;
  assignedAgents?: { id: string; name: string; role: string }[];
}

/** First-class Project entity (Phase A · migration 016). Mirrors server/types.ts:Project. */
export interface Project {
  id: string;
  name: string;
  slug: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** First-class Worktree entity (Phase A · migration 017). Mirrors server/types.ts:Worktree. */
export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  branchName: string | null;
  baseRef: string | null;
  mode: 'branch' | 'reuse' | 'detached';
  absPath: string;
  isPushed: boolean;
  branchRenamed: boolean;
  status: 'pending' | 'ready' | 'error';
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TopicsData {
  topics: Record<string, Topic>;
  workspaceProjects?: string[];
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /**
   * Tool arguments as parsed from the provider stream. Keys are field names,
   * values are arbitrary JSON — consumers either JSON.stringify or run their
   * own narrowing. `unknown` instead of `any` so the type system forces
   * narrowing before use.
   */
  args: Record<string, unknown>;
  status?: 'pending' | 'running' | 'success' | 'error';
  result?: string;
  error?: string;
  contentOffset?: number;
}

/**
 * Chronological content block emitted during assistant streaming. The
 * server captures each text/thinking/tool event from the provider in
 * arrival order on this array; the renderer iterates it in order so
 * reasoning that happens *between* tool calls displays where it actually
 * occurred — instead of being lifted out into a "thinking" header above
 * everything else (the legacy bucket-rendering bug). See
 * `server/types.ts:ContentBlock`.
 */
export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCall: ToolCall };

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
  disabledContextSources?: string[];
  /** Phase A · TOPIC-WT-01. Pass `null` to clear the binding. */
  worktreeId?: string | null;
}

export interface LinkTopicRequest {
  targetId: string;
}

export interface ChatRequest {
  sessionKey: string;
  messages: Message[];
  planMode?: boolean;
  /** Per-message provider override (e.g. "claude-code", "codex"). Falls back to topic.provider or global default. */
  provider?: string;
  /** Per-message model override. Ignored by providers without per-call model selection. */
  model?: string;
}

// ============ Providers ============

export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface ProviderRequirement {
  key: string;
  label: string;
  present: boolean;
  hint?: string;
}

/**
 * One row in the provider snapshot. Combines diagnostic + model list so the
 * picker, settings page, and any other consumer subscribe to a single shape.
 * Mirrors `server/providers/types.ts:ProviderSnapshotEntry`.
 */
export interface ProviderSnapshotEntry {
  name: string;
  label?: string;
  status: ProviderStatus;
  isDefault: boolean;
  binaryPath?: string;
  version?: string;
  models: string[];
  requirements: ProviderRequirement[];
  lastError?: string;
  fetchedAt: string;
}

/** Server-authoritative snapshot served via REST and WS. */
export interface ProvidersSnapshot {
  providers: ProviderSnapshotEntry[];
  defaultProvider: string | null;
  generatedAt: string;
}

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
  sessionKey: string;
  topicId: string | null;
  topicName: string;
  topicIcon: string;
  role: string;
  content: string;
  timestamp: string | null;
}

export interface UnreadData {
  [topicId: string]: {
    lastReadAt: string;
    unreadCount: number;
  };
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
export interface WSProvidersSnapshotMessage {
  type: 'providers:snapshot';
  snapshot: ProvidersSnapshot;
}

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
  topicIds: string[];
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
  fromSessionKey?: string;
  toTopicId: string;
}

export interface WSOpenProjectMessage {
  type: 'open-project';
  projectPath: string;
}

export interface WSDragMessage {
  type: 'drag:start' | 'drag:end' | 'drag:accepted' | 'drag:drop';
  sourceWindowId: string;
  /** Window that initiated the drop (mirror of sourceWindowId for drag:drop). */
  windowId?: string;
  topicId?: string;
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

// --- Notifications -----------------------------------------------------------
export interface WSUnreadUpdatedMessage {
  type: 'unread:updated';
  topicId: string;
  unreadCount: number;
}

// --- Boards ------------------------------------------------------------------
export interface WSTaskMessage {
  type: 'task:created' | 'task:updated' | 'task:moved' | 'task:deleted'
       | 'task:archived' | 'task:unarchived';
  projectId: string;
  task?: unknown;
  taskId?: string;
}

export interface WSDashboardUpdatedMessage {
  type: 'dashboard:updated' | 'cron:updated';
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

// --- Catch-all ---------------------------------------------------------------
/**
 * Fallback for message types not (yet) listed above. Keeps the dispatcher
 * resilient to forward-compat messages without forcing every new server
 * broadcast to add a typed variant first. Index sig is `unknown` (not `any`)
 * so reads require explicit casts — visible churn is the point.
 */
export interface WSUnknownMessage {
  type: string;
  [key: string]: unknown;
}

export type WSMessage =
  | WSProvidersSnapshotMessage
  | WSGatewayStatusMessage
  | WSTopicUpdatedMessage
  | WSTopicsReorderedMessage
  | WSTopicSwitchCompleteMessage
  | WSTopicSwitchMessage
  | WSOpenProjectMessage
  | WSDragMessage
  | WSStreamStartMessage
  | WSStreamEndMessage
  | WSMessageNewMessage
  | WSMessageMediaMessage
  | WSClearMessage
  | WSAgentsSessionsMessage
  | WSAgentsSpawnedMessage
  | WSAgentsStoppedMessage
  | WSTerminalSessionsMessage
  | WSUnreadUpdatedMessage
  | WSTaskMessage
  | WSDashboardUpdatedMessage
  | WSProjectMessage
  | WSWorktreeMessage
  | WSUnknownMessage;

/** @deprecated alias retained while consumers migrate. Use `WSMessage`. */
export type TypedWSMessage = WSMessage;

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface TopicTemplate {
  name: string;
  icon: string;
  color: string;
  systemPrompt: string;
  description: string;
}

export interface ViewMode {
  sidebar: boolean;
  details: boolean;
}

export interface PanelSizes {
  sidebar: number;
  details: number;
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

export interface GitDiff {
  file: string;
  diff: string;
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
  type: 'shell' | 'claude-code';
}

// ── Pane types — single source of truth lives in state/pane/types.ts ─────────
// The pane-store reducer owns the canonical `Pane` + `PaneType` shapes. This
// file re-exports them so existing `import { Pane } from '@/types'` call sites
// continue to compile without churn during the cutover. New code should import
// directly from '@/state/pane/types'.
export type { Pane, PaneType } from '../state/pane/types';

export interface PaneLayoutRow {
  panes: string[];       // Pane IDs
  widths: number[];      // fractions summing to 1
}

// Pane Groups — each group has its own tab bar (like VS Code editor groups)
export type PaneGroupType = 'chat' | 'file' | 'utility';

export interface PaneGroup {
  id: string;
  paneIds: string[];
  activePaneId: string;
  type: PaneGroupType;
}

export interface GroupLayoutRow {
  groupIds: string[];
  widths: number[];       // fractions summing to 1
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

export type SidebarTab = 'agents' | 'activity' | 'journal' | 'remote' | 'system' | 'browser' | 'terminal';

export interface AppSettings {
  fontSize: number;       // 12-18
  messageDensity: 'compact' | 'comfortable';
  sidebarWidth: number;   // 180-400
  sidebarCollapsed: boolean;
}

export interface ProcessInfo {
  sessionKey: string;
  label: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  completedAt?: string;
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
