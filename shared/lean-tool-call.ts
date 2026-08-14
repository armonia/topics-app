/**
 * A tool result travels TWICE inside the same row.
 *
 * `ToolCall.result` is the raw text; `ToolCall.detail` is the typed version
 * built at the provider boundary, and for the tools that return text that text
 * lands in there verbatim: `detail.output` for a shell, `detail.content` for a
 * Read, `detail.result` for an MCP. The renderer reads `detail` when it is
 * there and valid (`resolveToolDetail`,
 * client/src/components/Chat/toolDetail.ts:277) and `result` stays a copy that
 * nobody looks at.
 *
 * Measured on the DB of this machine, topic:6b99e9cf: 8.20 MB of payload for
 * 118 messages, of which 2.48 MB is this duplicate, that is 30%. Across 891
 * tool calls with both `detail` and `result` present (612 shell, 247 read, 30
 * mcp, 2 monitor) the copy is IDENTICAL byte for byte in every case; the only
 * divergences are the `write` calls, where `result` is the write confirmation
 * and not the file, and those indeed stay intact.
 *
 * It is the same defect already removed one level up, `blocks` and `tool_calls`
 * carrying the same thing (server/routes/history.ts), only inside the toolCall
 * instead of next to it.
 *
 * ## Why it is lossless
 *
 * There is no table saying "for type X drop field Y": `result` is dropped only
 * when a string EQUAL to it, byte for byte, exists inside `detail`. If the
 * equal one is not there, `result` stays. So the text never disappears from the
 * payload: either it is still there, or it is already in the field the renderer
 * really reads.
 *
 * The other half of the guarantee is upstream: the server validates `detail`
 * with the same Zod schema as the client (`sanitizeToolCallDetail`,
 * server/utils.ts:67) and DISCARDS it if it does not pass. A `detail` that
 * reaches the client is therefore a `detail` the client will accept. The
 * fallback `deriveToolDetail(name, args, result)` only kicks in when `detail`
 * is missing, and in that case nothing here is touched.
 */

/** How deep we look for the copy inside `detail`. */
const MAX_DEPTH = 2;

/**
 * Is there, inside `value`, a string identical to `needle`?
 *
 * Bounded depth: the shapes of `ToolCallDetail` put the text either in a
 * top-level field (`output`, `content`, `result`, `text`) or inside `raw` (the
 * `unknown` one), that is, never below the second level. Comparing two strings
 * stops at the length before reading any byte, so walking the fields costs as
 * much as reading their lengths.
 */
function containsSameString(value: unknown, needle: string, depth = 0): boolean {
  if (typeof value === 'string') return value === needle;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsSameString(v, needle, depth + 1)) return true;
  }
  return false;
}

/** The minimum shape needed here: we do not import `ToolCall`, so shared/ is not tied to a type that changes often. */
type LeanableToolCall = { detail?: unknown; result?: unknown };

/**
 * The same toolCall without the duplicated `result`, or the identical original
 * (same reference) when there is nothing to drop.
 *
 * Returning the same object when nothing is touched is not a detail: the caller
 * can copy the message only if something really changed, and sessions with no
 * tools do not pay a reallocation per row.
 */
export function leanToolCall<T extends LeanableToolCall>(tc: T): T {
  if (!tc || typeof tc !== 'object') return tc;
  const { detail, result } = tc;
  if (typeof result !== 'string' || result.length === 0) return tc;
  if (detail === null || typeof detail !== 'object') return tc;
  if (!containsSameString(detail, result)) return tc;
  const { result: _dropped, ...rest } = tc;
  return rest as T;
}

/**
 * `leanToolCall` on every element, preserving the array reference when no
 * element changed.
 */
export function leanToolCalls<T extends LeanableToolCall>(calls: readonly T[]): readonly T[] {
  let changed = false;
  const out = calls.map((tc) => {
    const lean = leanToolCall(tc);
    if (lean !== tc) changed = true;
    return lean;
  });
  return changed ? out : calls;
}

/** A timeline block that may carry a toolCall. */
type LeanableBlock = { toolCall?: LeanableToolCall } & Record<string, unknown>;

/** The minimum of a message needed here. */
type LeanableMessage = {
  partial?: boolean;
  blocks?: readonly LeanableBlock[];
  toolCalls?: readonly LeanableToolCall[];
};

/**
 * A message ready for the wire: without the TWO copies the client does not read.
 *
 * 1. `toolCalls` next to `blocks`. They carry the same thing and the renderer
 *    uses the blocks: "When present and non-empty, [blocks] takes precedence
 *    over the legacy thinking/toolCalls/content bucket rendering"
 *    (client/src/components/MessageContent.tsx).
 * 2. `result` inside every `toolCall`, when `detail` already carries that text.
 *
 * A PARTIAL message comes out intact: it is the one streaming keeps applying
 * the tool events to (client/src/hooks/useChat.ts), and there `toolCalls` is
 * still the list that grows and `result` the field being filled in.
 *
 * This lives here, and not in a route handler, because more than one route
 * ships messages: `/api/history/:key` uses it for the chat, and
 * `/api/topics/:id/messages` for the agents over MCP. When the trimming lived
 * inside the first one, the second shipped 12.5 MB where the first shipped 5.4.
 */
export function leanMessageForWire<T extends LeanableMessage>(m: T): T {
  if (!m || typeof m !== 'object' || m.partial) return m;
  const blocks = m.blocks?.length ? leanBlocks(m.blocks) : m.blocks;
  const dropToolCalls = !!m.blocks?.length && !!m.toolCalls?.length;
  if (blocks === m.blocks && !dropToolCalls) return m;
  return { ...m, blocks, ...(dropToolCalls ? { toolCalls: undefined } : {}) };
}

/** `leanMessageForWire` over a list, preserving the reference if nothing changes. */
export function leanMessagesForWire<T extends LeanableMessage>(msgs: readonly T[]): readonly T[] {
  let changed = false;
  const out = msgs.map((m) => {
    const lean = leanMessageForWire(m);
    if (lean !== m) changed = true;
    return lean;
  });
  return changed ? out : msgs;
}

/**
 * `leanToolCall` on the toolCalls nested in the blocks of a message.
 * Same rule about the reference: array and blocks left intact if there is nothing to drop.
 */
export function leanBlocks<T extends LeanableBlock>(blocks: readonly T[]): readonly T[] {
  let changed = false;
  const out = blocks.map((b) => {
    if (!b || typeof b !== 'object' || !b.toolCall) return b;
    const lean = leanToolCall(b.toolCall);
    if (lean === b.toolCall) return b;
    changed = true;
    return { ...b, toolCall: lean };
  });
  return changed ? out : blocks;
}
