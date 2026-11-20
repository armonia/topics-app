/**
 * The tool-input side of `--include-partial-messages`: a tool announced the
 * moment the model starts writing its input, the input accumulated delta by
 * delta, and delivered once complete (with the user-input detection that needs
 * the whole input).
 *
 * Moved out of `claude-code.ts` unchanged. Each function works on one process
 * record; the only thing it asks the provider is which session owns that
 * record (`sessionKeyOf`), and only when a question tool is detected.
 */

import type { StreamHandler } from "../types";
import type { PersistentProcess } from "./persistent-process";
import { isSubAgentToolName } from "./sidechain-tracker";
import { decodePartialStreamEvent, parseToolInputBuffer } from "./events";
import { PARTIAL_ARGS_EMIT_MS, extractPrimaryToolArg } from "../partial-tool-input";
import { detectUserInputRequest } from "../ask-user-detector";
import { isSpawnedChildSession } from "../../lib/subagent-tool-policy";

/** Which session owns a process record (the provider's pool lookup). */
export type SessionKeyOf = (pp: PersistentProcess) => string | null;

/**
 * `--include-partial-messages` stream_event handling. ONLY the tool_use
 * lifecycle is consumed here: `content_block_start` announces the tool the
 * moment the model STARTS writing its input (so the UI's running window
 * covers input generation + execution — the tool's real usage window),
 * `input_json_delta` accumulates the input, and `content_block_stop`
 * parses the complete input and upserts it via onToolArgsUpdate.
 * Text/thinking deltas are ignored — the cumulative snapshots remain their
 * single source, so nothing double-counts. Only the START and STOP of a
 * reasoning block are surfaced (no text), so the UI can show it live. Sidechain (sub-agent) partials
 * are skipped: child tools aggregate from the sidechain's own snapshots.
 */
export function handlePartialStreamEvent(pp: PersistentProcess, event: unknown, handler: StreamHandler | null, sessionKeyOf: SessionKeyOf): void {
  // The wire shape (`stream_event` → `content_block_*`) is decoded by
  // `claude/events.ts`: what is left here is applying it to the process state.
  const partial = decodePartialStreamEvent(event);
  if (!partial) return;
  const index = partial.index;
  if (partial.kind === "text_delta") {
    // The CLI's assistant snapshot carries a text block only once it is
    // COMPLETE, so text used to land in one lump per block. The piece goes
    // out now and is remembered in `streamedText`, so the snapshot that
    // follows adds only what was not streamed.
    if (!handler || pp.replaySilent || pp.commandTurn) return;
    pp.streamedText = (pp.streamedText ?? "") + partial.text;
    pp.fullText += partial.text;
    handler.onTextDelta(partial.text, pp.fullText);
    return;
  }
  if (partial.kind === "thinking_start") {
    // The cumulative snapshot skips a thinking block whose text is empty, which
    // is how the CLI delivers it live: this event is the only live sign that
    // the model is reasoning.
    (pp.streamingThinking ??= new Set()).add(index);
    if (!pp.replaySilent) handler?.onThinkingStart?.();
  } else if (partial.kind === "tool_start") {
    const toolName = partial.name;
    (pp.streamingToolInputs ??= new Map()).set(index, { id: partial.id, name: toolName, buf: "" });
    if (pp.activeToolCalls.has(partial.id) || pp.settledToolCalls?.has(partial.id)) return;
    pp.activeToolCalls.add(partial.id);
    // Task parents register immediately (empty input, back-filled by
    // finalizeToolArgs) so early sidechain child events find their parent.
    if (isSubAgentToolName(toolName)) pp.sidechain.registerParent(partial.id, {});
    handler?.onToolStart(partial.id, toolName, {});
  } else if (partial.kind === "input_delta") {
    const entry = pp.streamingToolInputs?.get(index);
    if (!entry) return;
    entry.buf += partial.chunk;
    // The input is actively streaming — the turn is NOT stalled. Two things,
    // throttled: (1) keep the ROUTE's stream timer alive so a minutes-long
    // Write/Edit input doesn't trip the false "stream slow" annotation
    // (input_json_delta reaches only the provider, not the route callbacks),
    // and (2) surface the primary field (filename / command / url) the moment
    // it's fully in the buffer, so the row reads `Write(App.tsx)` instead of a
    // blank running row for the whole (possibly 4-min) input generation.
    if (handler && !pp.replaySilent && !pp.settledToolCalls?.has(entry.id) && !pp.argsFinalized?.has(entry.id)) {
      const now = Date.now();
      if (!entry.lastEmitAt || now - entry.lastEmitAt >= PARTIAL_ARGS_EMIT_MS) {
        entry.lastEmitAt = now;
        handler.onToolActivity?.(entry.id);
        // Open values count: the command is written into the row as it arrives.
        const primary = extractPrimaryToolArg(entry.buf, { open: true });
        if (primary && primary.value !== entry.emittedPrimary) {
          entry.emittedPrimary = primary.value;
          handler.onToolArgsUpdate?.(entry.id, { [primary.key]: primary.value }, { partial: true });
        }
      }
    }
  } else if (partial.kind === "block_stop") {
    if (pp.streamingThinking?.delete(index)) {
      if (!pp.replaySilent) handler?.onThinkingEnd?.();
      return;
    }
    const entry = pp.streamingToolInputs?.get(index);
    if (!entry) return;
    pp.streamingToolInputs?.delete(index);
    // Empty buffer = the input REALLY is empty (tools without arguments emit no
    // delta). A buffer that does not read as an object = a truncated or odd
    // stream: null, and the cumulative snapshot finalizes it.
    const args = parseToolInputBuffer(entry.buf);
    if (args) finalizeToolArgs(pp, handler, entry.id, entry.name, args, sessionKeyOf);
  }
}

/**
 * Deliver a tool's COMPLETE input for a call that was announced early with
 * partial args. Idempotent (argsFinalized guard): fires from
 * content_block_stop AND from every cumulative snapshot re-emission —
 * whichever lands first wins. Back-fills Task parents and runs user-input
 * detection, both of which need the full input.
 */
export function finalizeToolArgs(
  pp: PersistentProcess,
  handler: StreamHandler | null,
  toolId: string,
  toolName: string,
  args: Record<string, unknown>,
  sessionKeyOf: SessionKeyOf,
): void {
  const finalized = (pp.argsFinalized ??= new Set<string>());
  if (finalized.has(toolId) || pp.settledToolCalls?.has(toolId)) return;
  finalized.add(toolId);
  if (isSubAgentToolName(toolName)) pp.sidechain.updateParentInput(toolId, args);
  handler?.onToolArgsUpdate?.(toolId, args);
  detectUserInputForTool(pp, handler, toolId, toolName, args, sessionKeyOf);
}

/**
 * Detect "I am asking the user a question" tools (AskUserQuestion, MCP
 * elicitation) — requires the COMPLETE input, so it runs at announce time
 * only when the full args are already in hand, otherwise at args-finalize.
 * When matched, the CLI is sitting on stdin waiting for a `tool_result`
 * line; the route handler must pause the soft inactivity timer, broadcast
 * the form schema, and wait for `POST /api/chat/tool-response`. During a
 * reattach REPLAY we rebuild pendingInputs but do NOT re-surface the form
 * live — reattach() re-fires onUserInputRequired once, after replay, for
 * the entries that are STILL unanswered.
 */
export function detectUserInputForTool(
  pp: PersistentProcess,
  handler: StreamHandler | null,
  toolId: string,
  toolName: string,
  input: unknown,
  sessionKeyOf: SessionKeyOf,
): void {
  const schema = detectUserInputRequest({ name: toolName, input });
  if (!schema) return;
  const sessionKey = sessionKeyOf(pp);
  // A spawn_agent child's chat is hidden from whoever spawned it (SUBAGENT-23);
  // `permission.ts` already refuses the `/ask-user` rendezvous for the same
  // reason, but that refusal runs AFTER this detector already fired — the box
  // would still sit on screen in a topic nobody watches. Drop it here instead
  // of registering it, so no panel exists to answer and the CLI's own
  // permission denial is what the model sees.
  if (sessionKey && isSpawnedChildSession(sessionKey)) return;
  if (sessionKey) {
    pp.pendingInputs.set(toolId, { sessionKey, schema, awaitingSince: Date.now() });
  }
  if (!pp.replaySilent) handler?.onUserInputRequired?.(toolId, toolName, schema);
}

