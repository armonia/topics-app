/**
 * Canonical Topic Context Envelope
 * --------------------------------
 *
 * Single source of truth for "what context does a topic have, right now, for
 * provider X". Both the chat streaming path (`streamEditResponse` in
 * `server/routes/topics.ts`) and the inspector preview endpoint
 * (`/api/topics/:id/context-preview`) MUST derive their data from the same
 * `assembleTopicContext()` function — there are NO independent reconstructions
 * elsewhere in the codebase.
 *
 * See `openspec/changes/topic-context-canonical/design.md` for the rationale,
 * algorithm, and migration plan.
 *
 * This file contains **only types**. The implementation lives in:
 *   - `server/context/assemble.ts`        — `assembleTopicContext()`
 *   - `server/context/adapt.ts`           — `adaptEnvelope()`
 *   - `server/context/snapshots.ts`       — in-memory ring buffer
 *   - `server/context/provider-strategy.ts` — registry helper
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { ChatMessage, ProviderContextStrategy } from "../providers/types";

// Re-export so consumers can `import { ProviderContextStrategy } from "./envelope"`
// (or `from "./context"`) without having to know which file defines it.
export type { ProviderContextStrategy };

// ────────────────────────────────────────────────────────────────────────────
// System block taxonomy
// ────────────────────────────────────────────────────────────────────────────

/**
 * Origin of a system block. Categories are stable identifiers used for
 * filtering, grouping in the inspector UI, and deciding editability.
 *
 * - `openclaw`  — files injected by the OpenClaw workspace
 *                 (SOUL.md, MEMORY.md, AGENTS.md, TOOLS.md, IDENTITY.md,
 *                 USER.md, plus the aggregated memory tree).
 * - `memory`    — global memory (`memory/_global.md`) and topic-specific
 *                 memory (`memory/${topicId}.md`).
 * - `prompt`    — `topic.systemPrompt` configured by the user.
 * - `template`  — project-level files discovered automatically:
 *                 CLAUDE.md, README.md, .cursorrules, AGENTS.md
 *                 (with `.claude/CLAUDE.md` fallback).
 * - `file`      — entries from `topic.contextFiles[]` (user uploads).
 * - `pinned`    — concatenation of pinned messages.
 * - `synthetic` — reserved for future programmatic blocks (project awareness,
 *                 plan-mode banner, browser-tool instructions, etc.).
 */
export type SystemBlockCategory =
  | "openclaw"
  | "memory"
  | "prompt"
  | "template"
  | "file"
  | "pinned"
  | "synthetic";

// `ProviderContextStrategy` is defined in `../providers/types` (and re-exported
// at the top of this file). It lives there so the `AIProvider` interface can
// declare `contextStrategy` without `providers/types.ts` importing from this
// module.

// ────────────────────────────────────────────────────────────────────────────
// System blocks
// ────────────────────────────────────────────────────────────────────────────

/**
 * One ordered, named slice of context that the model will see (or not, if
 * `enabled: false`). System blocks are merged into the provider payload by
 * `adaptEnvelope()` according to the provider strategy.
 */
export interface SystemBlock {
  /**
   * Stable identifier used for toggling and tracking across reloads.
   * Examples: `"openclaw:SOUL.md"`, `"memory:topic"`, `"prompt:system"`,
   * `"template:CLAUDE.md"`, `"file:/abs/path/to/foo.md"`,
   * `"pinned:messages"`, `"openclaw:memory-tree"`.
   *
   * MUST match the ids used by `topic.disabledContextSources[]` so the
   * inspector toggle persists correctly.
   */
  id: string;

  /** Human-readable label rendered in the inspector. */
  label: string;

  category: SystemBlockCategory;

  /** Full content as it would be sent to the provider. */
  content: string;

  /**
   * Token estimate. Currently `Math.round(content.length / 4)`.
   * Per-provider tokenizer is out of scope for this change.
   */
  tokens: number;

  /**
   * Reflects `topic.disabledContextSources` (or the override passed to
   * `assembleTopicContext`). Disabled blocks are STILL listed in the envelope
   * (for the inspector) but are skipped by `adaptEnvelope()`.
   */
  enabled: boolean;

  /**
   * Whether this block contributes to the budget bar. Reference-only blocks
   * (e.g. the OpenClaw memory tree aggregate) MAY be excluded so the user
   * sees the realistic cost of what is actually inlined.
   */
  countInBudget: boolean;

  /**
   * Optional filesystem URI of the source. Lets the inspector "open in editor"
   * without a separate roundtrip. Absent for synthetic and pinned blocks.
   */
  sourceUri?: string;

  /**
   * Editable inline in the inspector (memory, prompt). Read-only for
   * filesystem templates and OpenClaw workspace files.
   */
  editable: boolean;

  /**
   * Whether `adaptEnvelope()` should emit this block to the provider.
   *
   * `true` for everything topics-app actually sends: system prompt, context
   * files, project templates, memory, pinned, synthetic instructions
   * (browser, project markers, topic-switch, plan mode).
   *
   * `false` for *informational* blocks shown in the inspector but injected
   * elsewhere — the OpenClaw workspace files (SOUL.md, MEMORY.md, AGENTS.md,
   * TOOLS.md, IDENTITY.md, USER.md, plus the memory tree aggregate) are
   * pushed gateway-side by the openclaw provider, not by topics-app.
   * The inspector lists them so the user understands what the model sees in
   * total; the adapter MUST skip them so we don't double-inject.
   */
  injectedByTopicsApp: boolean;

  /**
   * Pre-computed strings the adapter may consult when composing the
   * aggregated system message for this category. Free-form on purpose —
   * `SystemBlock` should not couple to specific composition rules.
   *
   * Currently used by:
   *   - `template:project-awareness` → `{ projectListing: "a, b/, c" }` so
   *     the adapter can append `Project root files: …` when no other
   *     templates are enabled (mirrors the legacy behaviour where
   *     `streamEditResponse` ran `readdirSync(projectDir).slice(0, 30)` at
   *     send time).
   */
  adapterHints?: Record<string, string>;
}

// ────────────────────────────────────────────────────────────────────────────
// History diagnostics
// ────────────────────────────────────────────────────────────────────────────

/**
 * Why a stored message was excluded from the final `history[]` sent to the
 * provider. Ordered by precedence in `assembleTopicContext`:
 *
 * 1. `partial`              — assistant message still streaming.
 * 2. `context-message`      — legacy OpenClaw envelope marker
 *                             ("[Chat messages since your last reply…").
 * 3. `empty-after-strip`    — content was only markers; nothing left.
 * 4. `duplicate-last-user`  — the caller passes the last user turn separately
 *                             via `userMessage`, so we drop it from history
 *                             to avoid duplication. Only when
 *                             `includeLastUserInHistory: false`.
 * 5. `limit`                — older than the most recent `historyLimit` turns.
 */
export type HistoryExcludeReason =
  | "limit"
  | "context-message"
  | "partial"
  | "empty-after-strip"
  | "duplicate-last-user";

/**
 * Per-message diagnostic record. The inspector uses this to render the
 * History section: which turns made it in, which got dropped and why,
 * which markers were stripped.
 *
 * One entry per `StoredMessage` considered by `assembleTopicContext`,
 * in chronological order. Entries with `excluded: false` correspond
 * one-to-one (in order) with `ContextEnvelope.history[]`.
 */
export interface HistoryEntryDiagnostic {
  /** `StoredMessage.id` from the SQLite messages table. */
  storedMessageId: string;

  role: "user" | "assistant";

  /**
   * Markers that were detected in the original content and stripped before
   * sending to the provider. Examples: `"{{BROWSER:open}}"`,
   * `"{{TOPIC_SWITCH:abc-123}}"`, `"{{TOPIC_NEW:Some Title}}"`.
   */
  strippedMarkers: string[];

  /** Bytes removed during marker stripping (`original.length - stripped.length`). */
  bytesDropped: number;

  /** True iff this entry is NOT present in the final `history[]`. */
  excluded: boolean;

  /** Set when `excluded: true`. */
  excludeReason?: HistoryExcludeReason;
}

// ────────────────────────────────────────────────────────────────────────────
// Diagnostics aggregate
// ────────────────────────────────────────────────────────────────────────────

export interface ContextDiagnostics {
  /**
   * Sum of `tokens` for system blocks that are `enabled && countInBudget`.
   * Does NOT include the chat history (computing that accurately is a
   * separate, future, change).
   */
  totalTokens: number;

  /** Reference budget for the bar. Currently 200_000. */
  budgetLimit: number;

  /** `Math.round((totalTokens / budgetLimit) * 100)`. */
  budgetPercent: number;

  /**
   * Number of historic turns dropped because they fell outside the most
   * recent `historyLimit` window. Equals the count of
   * `historyEntries[].excludeReason === "limit"`.
   */
  droppedHistoryTurns: number;

  /** One per stored message considered, chronological order. */
  historyEntries: HistoryEntryDiagnostic[];

  /**
   * Inspector-facing warnings, e.g. "context > 80%", "source X is very
   * large". Stable shape so the inspector can render without conditionals.
   */
  warnings: { type: string; detail: string }[];

  /** Epoch milliseconds when the envelope was assembled. */
  assembledAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// The envelope
// ────────────────────────────────────────────────────────────────────────────

/**
 * A `ContextEnvelope` represents the complete, provider-aware context for one
 * "send" — either an actual send (pushed to the snapshot ring) or a preview
 * ("if I sent now, the model would see this").
 *
 * Two distinct callers, both go through `assembleTopicContext`:
 *
 *   1. `streamEditResponse` (production send path):
 *        - `userMessageOverride`    = current user turn just persisted
 *        - `includeLastUserInHistory` = false (sent via `payload.userContent`)
 *        - Result feeds `adaptEnvelope` and then `provider.sendChat`,
 *          and is pushed to the snapshot ring.
 *
 *   2. Context Preview endpoint (inspector):
 *        - `userMessageOverride`    = none (uses last user turn from DB)
 *        - `includeLastUserInHistory` = true (full conversation visible)
 *        - Result is returned to the client for display.
 */
/**
 * Session-level metadata exposed alongside the envelope. NOT part of what
 * the model sees — these fields describe the session itself (which topic,
 * which working directory, which model variant, etc.) so the inspector
 * can render a complete picture without the consumer having to fetch the
 * topic separately.
 *
 * All fields are best-effort/optional. Absent when the data source
 * (`AppContext.getTopicBySessionKey`, worktree store, etc.) is missing
 * or returns null.
 */
export interface SessionMeta {
  /** Display name of the topic. */
  topicName?: string;
  /** Active model override (`topic.model`); `null` falls back to provider default. */
  modelName?: string | null;
  /** User-facing project path (`topic.projectPath`). */
  projectPath?: string | null;
  /** Resolved working dir (`resolveTopicCwd` — worktree absPath when bound). */
  workingDir?: string | null;
  /** Worktree id when the topic is bound to a git worktree. */
  worktreeId?: string | null;
  /** Total messages currently in the topic's active branch (incl. partial/excluded). */
  totalStoredMessages?: number;
  /** Whether plan-mode was active for this assembly. */
  planMode?: boolean;
}

export interface ContextEnvelope {
  topicId: string;
  sessionKey: string;

  /** Provider name this envelope was shaped for (drives `providerStrategy`). */
  providerName: string;

  /** Resolved via `getProviderStrategy(provider)`. */
  providerStrategy: ProviderContextStrategy;

  /** Session-level metadata (not part of provider payload). */
  sessionMeta?: SessionMeta;

  /**
   * Ordered list. Order matters: `adaptEnvelope` preserves it when prepending
   * system messages (history-aware) or concatenating into the inline preamble
   * (inline-system).
   *
   * Includes BOTH enabled and disabled blocks so the inspector can render
   * the toggles. Disabled blocks are filtered out by `adaptEnvelope`.
   */
  systemBlocks: SystemBlock[];

  /**
   * Final chat history that would be sent: post `stripMarkers`, post
   * `isContextMessage` filter, post partial filter, post `historyLimit`
   * truncation, with the last user turn excluded when the caller will pass
   * it via `userMessage`.
   */
  history: ChatMessage[];

  /**
   * The current/next user turn. `messageId` is the `StoredMessage.id`
   * when the turn has already been persisted (production send path); absent
   * when previewing a hypothetical next message.
   */
  userMessage: { content: string; messageId?: string };

  diagnostics: ContextDiagnostics;
}

// ────────────────────────────────────────────────────────────────────────────
// Provider payload (output of adaptEnvelope)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The concrete arguments passed to `provider.sendChat`. Produced by
 * `adaptEnvelope(envelope)` according to `envelope.providerStrategy`.
 *
 * `userContent` is what the route handler passes as the `message` arg.
 * `history` (when present) goes into `options.history`.
 * `options.tools` is set by the caller (browserTools registration), not by
 *   the adapter — it is provider-agnostic.
 *
 * `adaptationNotes[]` is purely diagnostic — the inspector renders these
 * strings so the user understands how their envelope was reshaped for the
 * provider in question (e.g. "7 system blocks inlined into user turn").
 */
export interface ProviderPayload {
  userContent: string;
  history?: ChatMessage[];
  options?: {
    model?: string;
    tools?: Tool[];
  };
  adaptationNotes: string[];
}
