/**
 * A tool call's times are given ONCE: the first `startedAt` and the first
 * `endedAt` win over any later announcement of the same id.
 *
 * After a restart the re-adoption replays the whole turn (`reattachSurvivingChatTurns`
 * in server.ts, then `ClaudeCodeProvider.reattach`), and each replayed tool came
 * through `onToolStart` / `onToolResult` stamped with `Date.now()`. Every tool
 * that ran before the restart was rewritten with a duration of zero, and a
 * burst of 27-356 tool frames in one minute read as tools that had just run.
 * Measured on topic d740f8ae, 03/10: 380 tools out of 1,820 (21%) in 5 bursts,
 * one per SIGTERM during a turn.
 */
import type { ToolCall } from "../../shared/types";

export type ToolTimes = Pick<ToolCall, "startedAt" | "endedAt">;

/** `incoming` with the times `existing` already had; the same reference when there is nothing to keep. */
export function keepFirstTimes<T extends ToolTimes>(existing: ToolTimes | undefined, incoming: T): T {
  if (!existing) return incoming;
  const startedAt = existing.startedAt ?? incoming.startedAt;
  const endedAt = existing.endedAt ?? incoming.endedAt;
  if (startedAt === incoming.startedAt && endedAt === incoming.endedAt) return incoming;
  return {
    ...incoming,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

/** The two times, each from the first source that has it. */
export function firstTimes(...sources: Array<ToolTimes | undefined>): ToolTimes {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const s of sources) {
    if (startedAt === undefined && typeof s?.startedAt === "number") startedAt = s.startedAt;
    if (endedAt === undefined && typeof s?.endedAt === "number") endedAt = s.endedAt;
  }
  return { startedAt, endedAt };
}

/** The times of every tool call an adopted row already holds, from its raw `blocks` and `tool_calls` columns. */
export function toolTimesOfRow(blocksJson: string | null | undefined, toolCallsJson: string | null | undefined): Map<string, ToolTimes> {
  const out = new Map<string, ToolTimes>();
  const add = (tc: unknown) => {
    const call = tc as { id?: unknown; startedAt?: unknown; endedAt?: unknown } | null;
    if (!call || typeof call.id !== "string") return;
    const known = out.get(call.id);
    out.set(call.id, firstTimes(known, {
      startedAt: typeof call.startedAt === "number" ? call.startedAt : undefined,
      endedAt: typeof call.endedAt === "number" ? call.endedAt : undefined,
    }));
  };
  const parse = (json: string | null | undefined): unknown[] => {
    if (!json) return [];
    try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  for (const b of parse(blocksJson)) {
    const block = b as { kind?: unknown; toolCall?: unknown } | null;
    if (block?.kind === "tool") add(block.toolCall);
  }
  for (const tc of parse(toolCallsJson)) add(tc);
  return out;
}
