/**
 * `adaptEnvelope` — turns a canonical `ContextEnvelope` into a
 * provider-specific `ProviderPayload` ready for `provider.sendChat`.
 *
 * Behaviour MUST be byte-for-byte identical to the legacy inline path in
 * `server/routes/topics.ts:2517-2559` (and the system-message construction
 * at `server/routes/topics.ts:1593-1734`). The regression test in
 * `topics-route-payload.test.ts` (Section 8 of the change `topic-context-canonical`)
 * pins this contract.
 *
 * Three strategies, set per-provider via `provider.contextStrategy`:
 *   - `history-aware`     prepend system messages to history; pass userContent verbatim.
 *   - `inline-system`     concatenate system messages, wrap in `<context>...</context>`,
 *                         prepend to userContent; do NOT pass history (CLI session-resident).
 *   - `gateway-stateful`  same shape as history-aware, different `adaptationNotes`.
 */

import type { ChatMessage } from "../providers/types";
import type { ContextEnvelope, ProviderPayload, SystemBlock } from "./envelope";

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export function adaptEnvelope(envelope: ContextEnvelope): ProviderPayload {
  const composedSystem = composeSystemMessages(envelope.systemBlocks);

  switch (envelope.providerStrategy) {
    case "history-aware":
      return adaptHistoryAware(envelope, composedSystem);
    case "inline-system":
      return adaptInlineSystem(envelope, composedSystem);
    case "gateway-stateful":
      return adaptGatewayStateful(envelope, composedSystem);
    default: {
      // Exhaustiveness guard. If a new strategy is added without updating
      // this switch, TypeScript will surface the unhandled case here.
      const _exhaustive: never = envelope.providerStrategy;
      throw new Error(`Unknown provider strategy: ${_exhaustive}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy implementations
// ────────────────────────────────────────────────────────────────────────────

function adaptHistoryAware(
  envelope: ContextEnvelope,
  composedSystem: ChatMessage[],
): ProviderPayload {
  return {
    userContent: envelope.userMessage.content,
    history: [...composedSystem, ...envelope.history],
    adaptationNotes: buildHistoryAwareNotes(envelope, composedSystem.length),
  };
}

function adaptInlineSystem(
  envelope: ContextEnvelope,
  composedSystem: ChatMessage[],
): ProviderPayload {
  let userContent = envelope.userMessage.content;
  if (composedSystem.length > 0) {
    const preamble = composedSystem.map((m) => m.content).join("\n\n---\n\n");
    userContent = `<context>\n${preamble}\n</context>\n\n${userContent}`;
  }
  return {
    userContent,
    // No `history` field — process-resident CLI keeps its own session state.
    adaptationNotes: buildInlineSystemNotes(envelope, composedSystem.length),
  };
}

function adaptGatewayStateful(
  envelope: ContextEnvelope,
  composedSystem: ChatMessage[],
): ProviderPayload {
  return {
    userContent: envelope.userMessage.content,
    history: [...composedSystem, ...envelope.history],
    adaptationNotes: buildGatewayStatefulNotes(envelope, composedSystem.length),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// composeSystemMessages — granular blocks → aggregated system messages
// ────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates `envelope.systemBlocks` into the same set of `system` messages
 * that `streamEditResponse` produced inline pre-refactor.
 *
 * Order (preserved across providers, mirrors the splice order in topics.ts):
 *   1. `prompt:system`
 *   2. `file:*` aggregated under `Context files for this topic:`
 *   3. project template aggregated (`template:project-awareness` + `template:NAME`)
 *   4. `synthetic:browser-instruction`
 *   5. `synthetic:project-markers`
 *   6. `synthetic:topic-switch-directory`
 *   7. memory aggregated (`memory:global` + `memory:topic`)
 *   8. `pinned:messages` aggregated under "Pinned messages from this conversation"
 *   9. `synthetic:plan-mode`
 *
 * Disabled blocks are skipped. Informational blocks (`injectedByTopicsApp: false`)
 * are skipped — they're surfaced for inspector visibility only.
 */
export function composeSystemMessages(blocks: SystemBlock[]): ChatMessage[] {
  const enabled = blocks.filter((b) => b.enabled && b.injectedByTopicsApp);
  const messages: ChatMessage[] = [];

  // ── 1. System prompt ──
  const prompt = enabled.find((b) => b.id === "prompt:system");
  if (prompt) messages.push(sys(prompt.content));

  // ── 2. Context files (aggregated) ──
  const files = enabled.filter((b) => b.category === "file");
  if (files.length > 0) {
    const parts = files.map((f) => `--- File: ${f.label} ---\n${f.content}`);
    messages.push(sys(`Context files for this topic:\n\n${parts.join("\n\n")}`));
  }

  // ── 3. Project template (aggregated) ──
  const aware = enabled.find((b) => b.id === "template:project-awareness");
  const tmplFiles = enabled.filter(
    (b) => b.category === "template" && b.id !== "template:project-awareness",
  );
  if (aware) {
    let content = aware.content;
    if (tmplFiles.length > 0) {
      const parts = tmplFiles.map((t) => `--- Project file: ${t.label} ---\n${t.content}`);
      content += `\n\nProject context files:\n\n${parts.join("\n\n")}`;
    } else if (aware.adapterHints?.projectListing) {
      // Fallback: shallow root listing — only when there are no template files
      // available (or all of them were toggled off). Mirrors legacy behaviour.
      content += `\n\nProject root files: ${aware.adapterHints.projectListing}`;
    }
    messages.push(sys(content));
  }

  // ── 4. Browser instruction ──
  const browser = enabled.find((b) => b.id === "synthetic:browser-instruction");
  if (browser) messages.push(sys(browser.content));

  // ── 5. Project markers ──
  const projectMarkers = enabled.find((b) => b.id === "synthetic:project-markers");
  if (projectMarkers) messages.push(sys(projectMarkers.content));

  // ── 6. Topic switch directory ──
  const topicSwitch = enabled.find((b) => b.id === "synthetic:topic-switch-directory");
  if (topicSwitch) messages.push(sys(topicSwitch.content));

  // ── 7. Memory (aggregated, mirrors `loadMemoryForTopic`) ──
  const globalMem = enabled.find((b) => b.id === "memory:global");
  const topicMem = enabled.find((b) => b.id === "memory:topic");
  if (globalMem || topicMem) {
    const parts: string[] = [];
    if (globalMem) parts.push(`### Global Memory\n${globalMem.content.trim()}`);
    if (topicMem) parts.push(`### Topic Memory\n${topicMem.content.trim()}`);
    messages.push(sys(
      `\n\n## Memory\nThe following memories/notes have been saved for context:\n\n${parts.join("\n\n")}`,
    ));
  }

  // ── 8. Pinned messages ──
  const pinned = enabled.find((b) => b.id === "pinned:messages");
  if (pinned) {
    messages.push(sys(`Pinned messages from this conversation (important context):\n\n${pinned.content}`));
  }

  // ── 9. Plan mode ──
  const plan = enabled.find((b) => b.id === "synthetic:plan-mode");
  if (plan) messages.push(sys(plan.content));

  return messages;
}

// ────────────────────────────────────────────────────────────────────────────
// Adaptation notes (inspector text)
// ────────────────────────────────────────────────────────────────────────────

function buildHistoryAwareNotes(envelope: ContextEnvelope, composedCount: number): string[] {
  const notes: string[] = [];
  notes.push(
    `${composedCount} aggregated system message(s) prepended to history (from ${countEmittedBlocks(envelope)} enabled source block(s))`,
  );
  notes.push(`${envelope.history.length} historic turn(s) included (after marker strip + limit)`);
  if (envelope.diagnostics.droppedHistoryTurns > 0) {
    notes.push(`${envelope.diagnostics.droppedHistoryTurns} older turn(s) dropped due to history limit`);
  }
  return notes;
}

function buildInlineSystemNotes(envelope: ContextEnvelope, composedCount: number): string[] {
  const notes: string[] = [];
  notes.push(
    `${composedCount} aggregated system message(s) inlined into user turn as <context> preamble (from ${countEmittedBlocks(envelope)} enabled source block(s))`,
  );
  notes.push(
    `Provider does NOT receive the history field — the CLI session preserves prior turns process-side`,
  );
  notes.push(
    `Inspector History tab reflects the topics-app DB; the live CLI session may have additional state from --resume`,
  );
  return notes;
}

function buildGatewayStatefulNotes(envelope: ContextEnvelope, composedCount: number): string[] {
  const notes: string[] = [];
  notes.push(
    `${composedCount} aggregated system message(s) sent as fallback (from ${countEmittedBlocks(envelope)} enabled source block(s))`,
  );
  notes.push(
    `Gateway typically uses internal session state and may ignore the history field on the happy path`,
  );
  notes.push(
    `History is sent so the gateway can rehydrate after process restart or session expiry`,
  );
  return notes;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function sys(content: string): ChatMessage {
  return { role: "system", content };
}

function countEmittedBlocks(envelope: ContextEnvelope): number {
  return envelope.systemBlocks.filter((b) => b.enabled && b.injectedByTopicsApp).length;
}
