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
export function toolCallsColumnForRow<T extends LeanableToolCall>(
  calls: readonly T[] | null | undefined,
  hasBlocks: boolean,
): string | null {
  if (hasBlocks) return '[]';
  return toolCallsForDisk(calls);
}

/** `hasBlocks` from an in-memory message, for the callers that hold the array. */
export function rowHasBlocks(blocks: readonly unknown[] | null | undefined): boolean {
  return !!blocks && blocks.length > 0;
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

// ── Strip tool detail text ──────────────────────────────────────────────────

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
 * Minimum shape needed: a toolCall that may carry a detail object.
 *
 * `detail?: unknown` and not `Record<string, unknown>`, for the same reason
 * `LeanableToolCall` above does it: `ToolCallDetail` is a union of interfaces,
 * and an interface has no index signature, so constraining it to a Record
 * would reject the real type and force a cast at every call site. The shape is
 * narrowed at runtime instead, where the check is real.
 */
type StrippableToolCall = {
  detail?: unknown;
  detailBytes?: number;
};

/**
 * Replace the three large text fields inside `detail` with `''` and record the
 * original byte count in `detailBytes` on the toolCall (NOT inside detail —
 * Zod would discard any unknown field there).
 *
 * Returns the same reference when nothing was stripped (no detail, or detail
 * carries no text in those fields).
 *
 * CONSTRAINT: `detailBytes` must live on the toolCall, never inside `detail`.
 * `resolveToolDetail` -> `parseToolCallDetail` runs the Zod schema on `detail`
 * and DISCARDS unknown fields: putting the counter inside `detail` would
 * require adding it to all 20+ variants of the schema.
 */
export function stripDetailText<T extends StrippableToolCall>(tc: T): T {
  const det = tc.detail;
  if (!det || typeof det !== 'object') return tc;
  let stripped = false;
  let bytes = 0;
  const newDet: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(det)) {
    if ((STRIP_FIELDS as readonly string[]).includes(k) && typeof v === 'string' && v.length > 0) {
      bytes += v.length;
      newDet[k] = '';
      stripped = true;
    } else {
      newDet[k] = v;
    }
  }
  if (!stripped) return tc;
  return { ...tc, detail: newDet, detailBytes: bytes } as T;
}

/** Strip large text from every toolCall in the blocks of a message list. */
function stripBlocksDetailText<T extends LeanableBlock>(blocks: readonly T[]): readonly T[] {
  let changed = false;
  const out = blocks.map((b) => {
    if (!b || typeof b !== 'object' || !b.toolCall) return b;
    const stripped = stripDetailText(b.toolCall as StrippableToolCall);
    if (stripped === b.toolCall) return b;
    changed = true;
    return { ...b, toolCall: stripped };
  });
  return changed ? out : blocks;
}

/**
 * A message with blocks that may carry tool details to strip.
 *
 * No `& Record<string, unknown>`: `StoredMessage` is an interface and has no
 * index signature, so that intersection made the real message type UNASSIGNABLE
 * here -- the only caller would have had to cast, which is the shape in which a
 * type stops checking anything.
 */
type StrippableMessage = {
  partial?: boolean;
  blocks?: readonly LeanableBlock[];
};

/**
 * Strip the large text fields from every tool detail in a message list.
 *
 * Called in `history.ts` on the response of `GET /api/history/:sessionKey`,
 * AFTER `leanMessagesForWire`. Only the history route uses this; the MCP
 * `/api/topics/:id/messages` route is left as-is (agents need the full text).
 *
 * PARTIAL messages are left intact: the tool result is still being written
 * to them by the streaming layer.
 */
export function stripToolDetailText<T extends StrippableMessage>(msgs: readonly T[]): readonly T[] {
  let changed = false;
  const out = msgs.map((m) => {
    if (!m || typeof m !== 'object' || m.partial) return m;
    const blocks = m.blocks?.length ? stripBlocksDetailText(m.blocks) : m.blocks;
    if (blocks === m.blocks) return m;
    changed = true;
    return { ...m, blocks };
  });
  return changed ? out : msgs;
}
