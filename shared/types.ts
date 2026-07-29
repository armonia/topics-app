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

// ─── ToolCall status (chat message → tool call lifecycle) ──────────────

/**
 * 5-state lifecycle of a tool call attached to a chat message. Emitted
 * by the provider boundary on stream events and read by both the
 * persisted message store (server) and the renderer (client).
 *
 *   pending             — sent to provider, not started yet
 *   running             — provider invoked the tool
 *   waiting_for_input   — tool emitted a user-input form; stream is
 *                         suspended until the user submits via
 *                         POST /api/chat/tool-response
 *   success             — terminal, result available
 *   error               — terminal, with an error field
 */
export type ToolCallStatus = 'pending' | 'running' | 'waiting_for_input' | 'success' | 'error';

// ─── User-input request / response envelopes ───────────────────────────
//
// Emitted when a tool needs human input (`status === 'waiting_for_input'`).
// The dispatcher persists `userResponse` and re-injects it into the
// provider stream verbatim, so these are on-wire payloads — any change
// must keep both halves compatible in the same commit.

/** One question emitted by the AskUserQuestion tool. */
export interface AskUserQuestionItem {
  question: string;
  /** Short label, ≤ 12 chars by SDK convention. */
  header: string;
  options: { label: string; description?: string }[];
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
  requirements: ProviderRequirement[];
  lastError?: string;
  /**
   * Effort/reasoning tier Topics forces on this provider's sessions
   * (claude-code `--effort`, codex `-c model_reasoning_effort`). Read-only
   * server policy surfaced for the picker badge; absent when the provider
   * has no such concept or the override is disabled.
   */
  effortTier?: string;
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
  | { type: 'search'; query: string; toolName?: 'search' | 'grep' | 'glob' | 'web_search'; content?: string; filePaths?: string[]; numFiles?: number; numMatches?: number; mode?: 'content' | 'files_with_matches' | 'count' }
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
  | { type: 'bash_output'; shellId: string; filter?: string; output?: string }
  | { type: 'kill_shell'; shellId: string; result?: string }
  | { type: 'notebook_edit'; notebookPath: string; cellId?: string; editMode?: string; cellType?: string }
  | { type: 'skill'; skill: string; args?: string; result?: string }
  | { type: 'slash_command'; command: string; result?: string }
  | { type: 'lsp'; operation: string; filePath?: string; symbol?: string; result?: string }
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
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCall: ToolCall };

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

/** Una nota della memoria di board (`/api/boards/:projectId/memory`). */
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

/**
 * Una riga del log azioni di un agente. `detail` è `unknown`, non `any`: la
 * copia del server diceva `any`, quindi lato server il payload di ogni azione
 * era scrivibile e leggibile senza controlli. Chi lo consuma restringe.
 */
export interface AgentActionLog {
  id: string;
  agentId: string;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  detail: unknown;
  createdAt: string;
}
