/**
 * The glue between the app's message store and `configureNativeHistorySource`.
 *
 * Pulled out of `server.ts` so it can be tested against a real `AppContext`
 * instead of only through the module's side effects. The one decision that
 * matters lives here: `withBlocks: true`.
 *
 * `tool_calls` is left EMPTY on disk for a row that also carries `blocks`
 * (`toolCallsColumnForRow`, shared/lean-tool-call.ts) — the tool calls live
 * inside the timeline, and `rowToMessage` (server/utils.ts) only recovers them
 * from there when `withBlocks` is true. Loading with `withBlocks: false` reads
 * the tool_calls column cheaply, but that column is `'[]'` for almost every
 * native session: measured on the live database, 99,171 tool calls sit across
 * 626 of 633 native sessions, and every one of them lives in `blocks`. Skipping
 * blocks did not shrink the history that comes back after a restart or the
 * 15-minute idle eviction — it emptied it: a resumed agent saw its own
 * sentences and none of the files it had read or edited.
 */
import type { AppContext } from "../../types";
import type { PersistedTurn } from "./history-rehydrate";

export function nativeHistorySource(ctx: AppContext, sessionKey: string): PersistedTurn[] {
  return ctx.loadActiveThread(sessionKey, { withBlocks: true }).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    partial: (m as { partial?: number | boolean | null }).partial ?? null,
    toolCalls: m.toolCalls ?? null,
    id: m.id,
    steeredInto: steeredInto(m.blocks),
  }));
}

/** The turn a steered row joined (`steered` block, CHAT-QUEUE-08), or null. */
function steeredInto(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const b = blocks.find((x) => (x as { kind?: unknown } | null)?.kind === "steered") as { into?: unknown } | undefined;
  return b && typeof b.into === "string" ? b.into : null;
}
