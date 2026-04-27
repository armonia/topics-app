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
  assignedAgents?: { id: string; name: string; role: string }[];
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
  args: Record<string, any>;
  status?: 'pending' | 'running' | 'success' | 'error';
  result?: string;
  error?: string;
  contentOffset?: number;
}

export interface ChatMessage extends Message {
  id: string;
  timestamp: string;
  pinned?: boolean;
  // Enhanced message structure
  thinking?: string;              // AI thinking content (collapsible)
  toolCalls?: ToolCall[];         // Tool calls made in this message
  media?: string[];               // Media file paths
  partial?: boolean;              // True if message is still streaming
  queued?: boolean;               // True if message is queued to send (offline)
  streamedAt?: string;            // When streaming started (for recovery)
  // Branching support
  parentId?: string | null;       // ID of parent message in tree
  branchIndex?: number;           // Index among siblings (0-based)
  siblingCount?: number;          // Total siblings at this branch point
  activeBranchIndex?: number;     // Currently active sibling index
}

export interface CreateTopicRequest {
  name: string;
  parentId?: string;
  color?: string;
  icon?: string;
  systemPrompt?: string;
  projectPath?: string;
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
  disabledContextSources?: string[];
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

export interface ProviderDiagnostic {
  name: string;
  status: ProviderStatus;
  isDefault?: boolean;
  binaryPath?: string;
  version?: string;
  modelsCount?: number;
  requirements: ProviderRequirement[];
  lastError?: string;
}

export interface ProviderModels {
  provider: string;
  models: string[];
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

export interface WSMessage {
  type: string;
  [key: string]: any;
}

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
