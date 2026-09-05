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

// ── Scrittura magra: le due colonne grosse, pronte per il disco ─────────────

/**
 * `tool_calls` come va scritta sulla riga: senza le copie di `result` che
 * `detail` porta gia' identiche, o `null` se non c'e' niente da scrivere.
 *
 * Perche' una funzione e non `JSON.stringify(leanToolCalls(x))` sparso nei
 * chiamanti: i punti di scrittura di quella colonna sono SEI in
 * `server/utils.ts` piu' uno in `server/routes/topics.ts`, e una regola in
 * sette copie e' sei occasioni perche' una diverga. Qui la copia si toglie in
 * un posto solo, e il `null` per la colonna assente si decide con lei.
 *
 * La regola resta quella dichiarata in cima al file: si scarta `result` SOLO
 * quando dentro `detail` esiste una stringa uguale byte per byte. Un `result`
 * che non ha il suo gemello arriva intero sul disco, e questa e' la meta' che
 * rende l'operazione senza perdita.
 *
 * ANCHE sui messaggi PARZIALI, al contrario di `leanMessageForWire`, che li
 * lascia stare. Sul filo il parziale e' la bolla che lo streaming sta ancora
 * riempiendo e il client ci applica sopra gli eventi; sul disco no: chi muta la
 * riga (`updateToolCallResult`, `addToolCallToLastMessage`) riscrive il campo
 * dal valore che ha in mano, non lo legge da li'. E il turno che si chiude
 * finisce nella stessa riga: saltare i parziali qui vorrebbe dire non togliere
 * mai niente, perche' ogni tool call nasce su una riga parziale.
 */
export function toolCallsForDisk<T extends LeanableToolCall>(calls: readonly T[] | null | undefined): string | null {
  if (!calls) return null;
  return JSON.stringify(leanToolCalls(calls));
}

/**
 * The value the `tool_calls` column must take for a row that also carries
 * `blocks`: the empty array, because those very same tool calls already live
 * inside the blocks.
 *
 * This is the write-side twin of the rule `leanMessageForWire` applies on the
 * wire ("they carry the same thing and the renderer uses the blocks"): until
 * now the wire was lean and the disk was not. Measured on the database of this
 * machine: `tool_calls` weighs 149.2 MB, of which 144.4 MB sits on rows that
 * ALSO have `blocks`, and on the 40 heaviest rows every toolCall of
 * `tool_calls` exists identical inside `blocks`. It is the bulk of the
 * `messages` table, and every scan, every backup and every WAL page pays for
 * it.
 *
 * `'[]'` and not `null` on purpose: `updateMessage` writes the column through
 * `COALESCE($tool_calls, tool_calls)`, so `null` means "leave what is there"
 * and would never clear a row that already carries the copy. The empty array
 * is the same "no tool calls" the readers already understand (see the
 * `has_tool_calls` expression in `messageBodyPresence`).
 *
 * The other half of the guarantee is `rowToMessage`, which rebuilds
 * `msg.toolCalls` from the tool blocks when the column is empty: nothing is
 * lost, it is read from the one copy that remains.
 *
 * A message WITHOUT blocks keeps its column: on this database that is 4.8 MB
 * over 5,332 rows where `tool_calls` is the only source there is.
 */
export function toolCallsColumnForRow<T extends LeanableToolCall & { id?: unknown }>(
  calls: readonly T[] | null | undefined,
  blocks: readonly LeanableBlock[] | null | undefined,
): string | null {
  if (calls && calls.length > 0 && blocksCoverToolCalls(blocks, calls)) return '[]';
  return toolCallsForDisk(calls);
}

/**
 * Do the blocks carry every one of these tool calls?
 *
 * The check is by id and it is EXACT, not a guess: the column is given up
 * only when there is somewhere else it can be read back from. A message whose
 * timeline does not mirror its tool calls (an import that builds one and not
 * the other) keeps the column, and keeps its tool calls.
 */
function blocksCoverToolCalls(
  blocks: readonly LeanableBlock[] | null | undefined,
  calls: readonly { id?: unknown }[],
): boolean {
  if (!blocks || blocks.length === 0) return false;
  const inBlocks = new Set<unknown>();
  for (const b of blocks) {
    const id = (b?.toolCall as { id?: unknown } | undefined)?.id;
    if (id !== undefined) inBlocks.add(id);
  }
  if (inBlocks.size === 0) return false;
  for (const c of calls) if (!inBlocks.has((c as { id?: unknown }).id)) return false;
  return true;
}

/**
 * `blocks` come va scritta sulla riga: stessa regola, dentro i toolCall
 * annidati nei blocchi della timeline.
 *
 * E' la colonna che pesa di piu' (720 MB su 781 di database contando
 * entrambe), perche' quando ci sono i blocchi e' li' che il disegno legge.
 */
export function blocksForDisk<T extends LeanableBlock>(blocks: readonly T[] | null | undefined): string | null {
  if (!blocks) return null;
  return JSON.stringify(leanBlocks(blocks));
}

/**
 * I campi di `detail` che portano il testo dell'esito. Sono gli stessi tre che
 * `stripDetailText` svuota per il filo, piu' `text`: e' l'elenco di dove va a
 * finire una stringa quando il provider costruisce il `detail` tipato.
 */
const TEXT_FIELDS = ['output', 'content', 'result', 'text'] as const;

/**
 * L'esito di una tool call come TESTO, da qualunque campo lo porti.
 *
 * E' il rovescio di `leanToolCall`, e sta qui apposta: chi ha deciso di
 * scartare la copia deve anche dire dove si va a riprendere il testo. Con
 * `result` sul disco, chi lo leggeva da li' trovava sempre qualcosa; senza,
 * dovrebbe sapere da solo che quella stringa vive anche dentro `detail`, e
 * saperlo in ogni chiamante e' il modo in cui una regola si perde.
 *
 * Ordine: `result` se c'e' (e' il testo grezzo, il piu' fedele), altrimenti il
 * primo campo di testo non vuoto dentro `detail`. `undefined` quando non c'e'
 * ne' l'uno ne' l'altro, che NON e' la stessa cosa di una stringa vuota: chi
 * chiama deve poter dire «nessun esito registrato» invece di «esito vuoto».
 */
export function toolCallResultText(tc: { result?: unknown; detail?: unknown } | null | undefined): string | undefined {
  if (!tc || typeof tc !== 'object') return undefined;
  if (typeof tc.result === 'string' && tc.result.length > 0) return tc.result;
  const det = tc.detail;
  if (!det || typeof det !== 'object') return undefined;
  const rec = det as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    const v = rec[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// ── The history wire: a tool call carries only what its CLOSED row draws ─────

/**
 * The fields inside `detail` that carry large text blobs — the output of a
 * shell, the content of a Read, the result of an MCP call. These are the
 * bytes that make the history payload fat for CLOSED tool rows: the renderer
 * never reads them until the user actually expands the row.
 *
 * `plan.text` is intentionally excluded: `buildToolDisplayLabel` reads it for
 * the summary shown on the CLOSED row (PLAN-LABEL-01), so dropping it would
 * break the collapsed summary. Measured on the full DB: 52,106 characters
 * total across all plan.text fields, i.e. effectively zero cost.
 */
const STRIP_FIELDS = ['output', 'content', 'result'] as const;

/**
 * Above this many characters a string inside `args` or `detail` travels as a
 * PREVIEW on the history wire: its first `WIRE_STRING_PREVIEW_CHARS`
 * characters, with the count of what was cut declared on the tool call
 * (`argsBytes` / `detailBytes`). At or below it, the string travels whole.
 *
 * Why a threshold and not a list of fields. Blanking the three text fields
 * above left the rest of every tool call intact, and on a real thread the rest
 * is most of the weight: `args` repeats what `detail` already types (a Write's
 * `content`, an Edit's `new_string`, a Bash script in `command`), and `detail`
 * has long fields of its own that no closed row reads (`command` beyond its
 * first line, `oldString`, `newString`, `unifiedDiff`, an MCP `args` object).
 * Measured on the live DB on 2026-09-05, six working topics of 16-69 messages
 * and 521-3,627 tool calls: `args` weighed 197 KB-1.86 MB per topic and the
 * non-text fields of `detail` another 313 KB-1.8 MB, out of 1.1-5.4 MB total;
 * a 17-message topic took 2.6 MB and 1.4 s to open. A field list would have
 * to be kept in step with 25 detail variants and every provider's argument
 * names; a length rule does not care what the field is called.
 *
 * Why 512. A closed row draws a path, the head of a command, a pattern, a
 * URL, a one-line summary: `buildToolDisplayLabel` never shows more than one
 * CSS-truncated line, and `summarizeArgs` cuts each value at 48 characters.
 * 512 covers every one of those with room to spare, and on the six topics it
 * removes 32-59% of the `args` bytes and 30-91% of the non-text `detail`
 * bytes. The short strings that remain are the ones the row actually draws.
 *
 * What is NOT here, and why: `toolCall.result` that survived `leanToolCall`
 * (a result with no identical copy in `detail`) weighed 2-13 KB per topic on
 * the same measurement. Not worth a third counter.
 */
export const WIRE_STRING_PREVIEW_CHARS = 512;

/**
 * How deep the preview walk goes. The long strings sit at most a few levels
 * down: `args.edits[i].new_string` (MultiEdit) is depth 3, `detail.raw.args.x`
 * (an unknown tool) is depth 3, `detail.actions[i].summary` is depth 3. Six is
 * a ceiling against a pathological payload, not a shape anyone relies on: a
 * string deeper than this simply travels whole.
 */
const PREVIEW_MAX_DEPTH = 6;

/** A value after the preview walk and how many characters the walk removed. */
type Previewed = { value: unknown; removed: number };

/**
 * `value` with every string longer than `WIRE_STRING_PREVIEW_CHARS` cut to its
 * head, recursively through objects and arrays. Same reference (and `removed`
 * 0) when nothing was long enough, so a caller can skip the copy of the row.
 */
function previewLongStrings(value: unknown, depth = 0): Previewed {
  if (typeof value === 'string') {
    if (value.length <= WIRE_STRING_PREVIEW_CHARS) return { value, removed: 0 };
    return { value: value.slice(0, WIRE_STRING_PREVIEW_CHARS), removed: value.length - WIRE_STRING_PREVIEW_CHARS };
  }
  if (depth >= PREVIEW_MAX_DEPTH || value === null || typeof value !== 'object') return { value, removed: 0 };
  let removed = 0;
  if (Array.isArray(value)) {
    const out = value.map((v) => {
      const p = previewLongStrings(v, depth + 1);
      removed += p.removed;
      return p.value;
    });
    return removed > 0 ? { value: out, removed } : { value, removed: 0 };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = previewLongStrings(v, depth + 1);
    removed += p.removed;
    out[k] = p.value;
  }
  return removed > 0 ? { value: out, removed } : { value, removed: 0 };
}

/**
 * Minimum shape needed: a toolCall that may carry a detail object and args.
 *
 * `detail?: unknown` and not `Record<string, unknown>`, for the same reason
 * `LeanableToolCall` above does it: `ToolCallDetail` is a union of interfaces,
 * and an interface has no index signature, so constraining it to a Record
 * would reject the real type and force a cast at every call site. The shape is
 * narrowed at runtime instead, where the check is real.
 */
type StrippableToolCall = {
  args?: unknown;
  argsBytes?: number;
  detail?: unknown;
  detailBytes?: number;
};

/**
 * `detail` as the history wire carries it: the three large text fields
 * replaced with `''`, every other string longer than the threshold cut to its
 * preview, and the characters removed summed into `detailBytes` on the
 * toolCall (NOT inside detail — Zod would discard any unknown field there).
 *
 * `plan.text` is the one field left whole whatever its length: the closed row
 * summarises it, and it is measured to weigh nothing (see `STRIP_FIELDS`).
 *
 * Returns the same reference when nothing was removed.
 *
 * CONSTRAINT: `detailBytes` must live on the toolCall, never inside `detail`.
 * `resolveToolDetail` -> `parseToolCallDetail` runs the Zod schema on `detail`
 * and DISCARDS unknown fields: putting the counter inside `detail` would
 * require adding it to all 20+ variants of the schema.
 */
export function stripDetailText<T extends StrippableToolCall>(tc: T): T {
  const det = tc.detail;
  if (!det || typeof det !== 'object') return tc;
  const rec = det as Record<string, unknown>;
  let bytes = 0;
  const newDet: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if ((STRIP_FIELDS as readonly string[]).includes(k) && typeof v === 'string' && v.length > 0) {
      bytes += v.length;
      newDet[k] = '';
      continue;
    }
    if (rec.type === 'plan' && k === 'text') {
      newDet[k] = v;
      continue;
    }
    const p = previewLongStrings(v);
    bytes += p.removed;
    newDet[k] = p.value;
  }
  if (bytes === 0) return tc;
  return { ...tc, detail: newDet, detailBytes: bytes } as T;
}

/**
 * `args` as the history wire carries them: every string longer than the
 * threshold cut to its preview, the characters removed declared in
 * `argsBytes`. Same reference when nothing was long.
 *
 * `args` is read by the renderer only as a FALLBACK, when `detail` is missing
 * or untyped (`deriveToolDetail`): the path, the head of the command and the
 * pattern it needs there all fit in the preview. The whole object comes back
 * from the detail route when the row opens.
 */
export function stripArgsText<T extends StrippableToolCall>(tc: T): T {
  const p = previewLongStrings(tc.args);
  if (p.removed === 0) return tc;
  return { ...tc, args: p.value, argsBytes: p.removed } as T;
}

/** A tool call as `GET /api/history` ships it: lean `detail` AND lean `args`. */
export function leanToolCallForHistory<T extends StrippableToolCall>(tc: T): T {
  return stripArgsText(stripDetailText(tc));
}

/** `leanToolCallForHistory` on every toolCall nested in the blocks of a message. */
function leanBlocksForHistory<T extends LeanableBlock>(blocks: readonly T[]): readonly T[] {
  let changed = false;
  const out = blocks.map((b) => {
    if (!b || typeof b !== 'object' || !b.toolCall) return b;
    const lean = leanToolCallForHistory(b.toolCall as StrippableToolCall);
    if (lean === b.toolCall) return b;
    changed = true;
    return { ...b, toolCall: lean };
  });
  return changed ? out : blocks;
}

/** `leanToolCallForHistory` on a flat list of tool calls (the legacy bucket). */
function leanToolCallsForHistory<T extends StrippableToolCall>(calls: readonly T[]): readonly T[] {
  let changed = false;
  const out = calls.map((tc) => {
    const lean = leanToolCallForHistory(tc);
    if (lean !== tc) changed = true;
    return lean;
  });
  return changed ? out : calls;
}

/**
 * A message whose tool calls may need trimming for the history wire.
 *
 * No `& Record<string, unknown>`: `StoredMessage` is an interface and has no
 * index signature, so that intersection made the real message type UNASSIGNABLE
 * here -- the only caller would have had to cast, which is the shape in which a
 * type stops checking anything.
 */
type StrippableMessage = {
  partial?: boolean;
  blocks?: readonly LeanableBlock[];
  toolCalls?: readonly StrippableToolCall[];
};

/**
 * Every tool call of a message list in its history-wire form.
 *
 * Called in `history.ts` on the response of `GET /api/history/:sessionKey`,
 * AFTER `leanMessagesForWire`. Only the history route uses this; the MCP
 * `/api/topics/:id/messages` route is left as-is (agents need the full text).
 *
 * The tool calls live in `blocks`; the legacy `toolCalls` bucket is trimmed
 * too, because a message persisted before blocks existed has its calls only
 * there and the renderer draws them through the very same rows. When both are
 * present `leanMessageForWire` has already dropped the bucket.
 *
 * PARTIAL messages are left intact: the tool result is still being written
 * to them by the streaming layer, and the client applies the live events on
 * top of what it holds.
 */
export function leanMessagesForHistory<T extends StrippableMessage>(msgs: readonly T[]): readonly T[] {
  let changed = false;
  const out = msgs.map((m) => {
    if (!m || typeof m !== 'object' || m.partial) return m;
    const blocks = m.blocks?.length ? leanBlocksForHistory(m.blocks) : m.blocks;
    const toolCalls = m.toolCalls?.length ? leanToolCallsForHistory(m.toolCalls) : m.toolCalls;
    if (blocks === m.blocks && toolCalls === m.toolCalls) return m;
    changed = true;
    return { ...m, blocks, toolCalls };
  });
  return changed ? out : msgs;
}
