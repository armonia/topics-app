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
