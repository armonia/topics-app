import { warnThrottled } from "./lib/warn-throttled";
import type { StoredMessage, ToolCall } from "./types";
import { parseToolCallDetail, knownDetailTypes } from "../shared/tool-call-detail";
import { type ToolCallDetail } from "../shared/types";

/**
 * v3 foundations NORM-01 DB hydration: validate a tool call's `detail`
 * field against the canonical Zod schema. If the detail is missing,
 * returns the toolCall unchanged. If the detail is present and parses,
 * the validated copy is substituted. If the detail is present but
 * malformed, there are two different failures behind that word and they get
 * two different answers.
 *
 * A detail whose `type` the schema has never heard of is the CLI growing a
 * tool kind: the shape is intact, only the taxonomy is behind. Dropping it
 * threw away the only copy of the payload, because persistence removes
 * `result` once the same text lives inside `detail` (shared/lean-tool-call.ts)
 * -- that is how 2736 questions to the human reached the chat mute. Those are
 * kept as `{ type: 'unknown', raw }`: the row degrades to a generic JSON card
 * instead of disappearing.
 *
 * A detail with a KNOWN type and a broken shape is a corrupt row. That one is
 * still dropped, because the renderer re-derives a proper card from `args`,
 * which beats showing the broken object.
 *
 * Both log one throttled line at NORM-DB level so drift stays observable
 * without the 3653 identical lines the untrottled warn used to write.
 */
/** What `sanitizeToolCallDetail` hands back: the same tool call with `detail` parsed, degraded or gone. */
type SanitizedToolCall<T> = T extends object ? Omit<T, 'detail'> & { detail?: ToolCallDetail } : T;

export function sanitizeToolCallDetail<T>(input: T): SanitizedToolCall<T> {
  type Loose = { id?: string; name?: string; detail?: { type?: unknown } };
  const tc = input as Loose | null | undefined;
  if (!tc || typeof tc !== 'object' || !tc.detail) return input as SanitizedToolCall<T>;
  const result = parseToolCallDetail(tc.detail);
  if (result.ok) {
    return (tc.detail === result.data ? tc : { ...tc, detail: result.data }) as SanitizedToolCall<T>;
  }
  const declaredType = typeof tc.detail?.type === 'string' ? tc.detail.type : undefined;
  if (declaredType && !knownDetailTypes.has(declaredType)) {
    warnThrottled(
      `NORM-DB:unknown-type:${declaredType}`,
      `[NORM-DB] Unknown detail type '${declaredType}' (${tc.name ?? '?'}): kept as raw`,
    );
    return { ...tc, detail: { type: 'unknown', raw: { args: tc.detail } } } as SanitizedToolCall<T>;
  }
  warnThrottled(
    `NORM-DB:malformed:${declaredType ?? '?'}`,
    `[NORM-DB] Dropping malformed detail for tool call ${tc.id ?? '?'} (${tc.name ?? '?'}): ${result.error}`,
  );
  // `_drop` non si usa PER COSTRUZIONE: destrutturare-e-scartare è il modo di
  // togliere una chiave da un oggetto senza mutarlo. Il valore che conta è `rest`.
  const { detail: _drop, ...rest } = tc;
  return rest as SanitizedToolCall<T>;
}

/**
 * `toolCalls` rebuilt from the tool blocks when the column left it empty (see
 * `rowToMessage`). Module level and exported: a route that picks a window of the
 * thread (`GET /api/topics/:id/messages`) needs the SAME rule for the partial row
 * it ships whole, not a copy of it.
 */
export function restoreToolCallsFromBlocks(msg: StoredMessage): void {
  if (!msg.toolCalls?.length && msg.blocks?.length) {
    const fromBlocks = msg.blocks
      .map((b) => b as { kind?: string; toolCall?: ToolCall })
      .filter((b) => b && b.kind === 'tool' && b.toolCall)
      .map((b) => b.toolCall as ToolCall);
    if (fromBlocks.length > 0) msg.toolCalls = fromBlocks;
  }
}
