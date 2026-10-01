/**
 * Tool call OUTPUT stored out of the message row (`message_tool_outputs`).
 *
 * Why: `messages.blocks` is one zstd blob per row, and every tool call inside
 * it carries its whole output. A history page ships none of that text (the
 * wire blanks it and the row fetches it on expand), yet reading a row meant
 * decompressing and parsing all of it: 848 MB decompressed for 163 MB stored
 * on the live DB, ~456 MB of it the fields the page throws away.
 *
 * What moves: exactly what the history wire does not ship. For a tool call of
 * a CLOSED row (`partial = 0`) with a final status and a `detail` the schema
 * accepts, the non-empty `output` / `content` / `result` of that detail
 * (`STRIP_FIELDS`, the fields `stripDetailText` blanks) and a top-level
 * `result` that repeats one of its strings (the copy `leanToolCall` drops).
 * The row keeps the call with those fields at `''` and a `movedOutput` mark
 * counting what left, so the history strip reports the same `detailBytes`.
 * `args`, other detail fields and a `result` of its own stay in the row: the
 * wire ships them, and moving them would change what a page shows.
 *
 * Which rows: only those `encodeCol` stores as a blob (see `blocksColumn`).
 * A plain-text row is either small or carries a machine mark that SQL `LIKE`
 * probes read; neither is touched, and a split row stays a blob at any size
 * (`MOVED_OUTPUT_MARK` in shared/message-blob.ts), so no `LIKE` probe on
 * `blocks` changes its answer.
 *
 * Reading: `restoreToolOutputs` puts the text back and removes the mark. The
 * full read of a row (`parseBlocksCol`, server/utils.ts) does it before the
 * detail is sanitized, so every reader that is not the history page sees the
 * row exactly as before. A later write that put text back in a field wins
 * over the stored copy.
 *
 * Writing: the output leaves the row only in the transaction that writes it
 * here, and the transaction reads it back and rebuilds the row before it
 * commits (`writeSplitRow`); any mismatch rolls it back and the row is
 * written whole.
 */
import type { Database } from "bun:sqlite";
import type { ContentBlock } from "../../shared/types";
import { containsSameString, leanBlocks, STRIP_FIELDS, type MovedOutputMark } from "../../shared/lean-tool-call";
import { decodeCol, encodeCol, MACHINE_MARKS, MOVED_OUTPUT_MARK } from "../../shared/message-blob";
import { parseToolCallDetail } from "../../shared/tool-call-detail";
import { warnThrottled } from "./warn-throttled";

/**
 * A tool call moves only when this much text would leave it. Measured on the
 * live DB (2026-09-30): calls at or above 1,024 movable characters are 78,610
 * of 229,501 and hold 388 of the 456 MB; the 150,000 smaller ones would be one
 * side row each for 68 MB, most of them a few hundred bytes.
 */
export const MIN_MOVED_CHARS = 1024;

/** The text that left one tool call. */
export interface MovedOutput {
  detail?: Record<string, string>;
  result?: string;
}

type AnyToolCall = Record<string, unknown> & { id?: unknown; status?: unknown; detail?: unknown; result?: unknown; movedOutput?: MovedOutputMark };

const toolCallOf = (b: unknown): AnyToolCall | null => {
  const block = b as { kind?: unknown; toolCall?: unknown } | null;
  return block && typeof block === "object" && block.kind === "tool" && block.toolCall && typeof block.toolCall === "object"
    ? (block.toolCall as AnyToolCall)
    : null;
};

/**
 * `blocks` with the movable output of every eligible tool call replaced by
 * `''` and a mark, plus what left, by tool call id. `null` when nothing moves.
 * Never mutates its input: the caller may still be holding it (the turn's
 * in-memory timeline).
 *
 * A tool call id that appears twice in the row is skipped: the stored text is
 * keyed by (message, tool call), and two outputs under one key would lose one.
 */
export function splitToolOutputs<B>(blocks: readonly B[]): { blocks: B[]; moved: Map<string, MovedOutput> } | null {
  const seen = new Map<string, number>();
  for (const b of blocks) {
    const id = toolCallOf(b)?.id;
    if (typeof id === "string") seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const moved = new Map<string, MovedOutput>();
  let out: B[] | null = null;
  blocks.forEach((b, i) => {
    const tc = toolCallOf(b);
    if (!tc || typeof tc.id !== "string" || tc.id === "" || seen.get(tc.id) !== 1) return;
    if (tc.movedOutput !== undefined) return;
    if (tc.status !== "success" && tc.status !== "error") return;
    const detail = tc.detail;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
    // What the wire strips is decided on the SANITIZED detail
    // (`sanitizeToolCallDetail` runs before the history strip): a detail the
    // schema rejects is dropped or kept raw there, and a key the schema does
    // not know never reaches `stripDetailText`. Those stay in the row.
    const parsed = parseToolCallDetail(detail);
    if (!parsed.ok) return;
    const clean = parsed.data as unknown as Record<string, unknown>;
    const raw = detail as Record<string, unknown>;
    const detailOut: Record<string, string> = {};
    const detailMark: Record<string, number> = {};
    let chars = 0;
    for (const k of STRIP_FIELDS) {
      const v = clean[k];
      if (typeof v === "string" && v.length > 0 && raw[k] === v) {
        detailOut[k] = v;
        detailMark[k] = v.length;
        chars += v.length;
      }
    }
    const result = typeof tc.result === "string" && tc.result.length > 0 && containsSameString(clean, tc.result)
      ? tc.result
      : undefined;
    if (result !== undefined) chars += result.length;
    if (chars < MIN_MOVED_CHARS) return;

    const stubDetail: Record<string, unknown> = { ...raw };
    for (const k of Object.keys(detailOut)) stubDetail[k] = "";
    const mark: MovedOutputMark = {};
    if (Object.keys(detailMark).length > 0) mark.detail = detailMark;
    if (result !== undefined) mark.result = result.length;
    const { result: _movedResult, ...kept } = tc;
    const stub: AnyToolCall = { ...(result !== undefined ? kept : tc), detail: stubDetail, movedOutput: mark };

    const entry: MovedOutput = {};
    if (Object.keys(detailOut).length > 0) entry.detail = detailOut;
    if (result !== undefined) entry.result = result;
    moved.set(tc.id, entry);
    out ??= [...blocks];
    out[i] = { ...(b as object), toolCall: stub } as B;
  });
  return out ? { blocks: out, moved } : null;
}

/**
 * Puts the stored text back into the marked tool calls of `blocks`, IN PLACE,
 * and removes the marks. A field the row filled again after the move keeps
 * the row's text. `only` limits it to those tool call ids and leaves every
 * other mark as it is. Returns the ids whose text was not found (never
 * expected: the text is written in the transaction that blanks the row).
 */
export function restoreToolOutputs(
  blocks: readonly unknown[],
  stored: ReadonlyMap<string, MovedOutput>,
  only?: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  for (const b of blocks) {
    const tc = toolCallOf(b);
    if (!tc || tc.movedOutput === undefined) continue;
    if (only && !(typeof tc.id === "string" && only.has(tc.id))) continue;
    const entry = typeof tc.id === "string" ? stored.get(tc.id) : undefined;
    delete tc.movedOutput;
    if (!entry) {
      missing.push(String(tc.id));
      continue;
    }
    if (entry.detail && tc.detail && typeof tc.detail === "object") {
      const detail = tc.detail as Record<string, unknown>;
      for (const [k, v] of Object.entries(entry.detail)) {
        if (detail[k] === "" || detail[k] === undefined) detail[k] = v;
      }
    }
    if (entry.result !== undefined && (tc.result === undefined || tc.result === "")) tc.result = entry.result;
  }
  return missing;
}

/** Does this parsed timeline carry at least one mark? */
export function hasMovedOutput(blocks: readonly unknown[]): boolean {
  return blocks.some((b) => toolCallOf(b)?.movedOutput !== undefined);
}

/** The stored text of `messageId`, by tool call id. */
export function readToolOutputs(db: Database, messageId: string): Map<string, MovedOutput> {
  const row = db.query("SELECT body FROM message_tool_outputs WHERE message_id = ?").get(messageId) as { body: unknown } | null;
  if (!row) return new Map();
  return new Map(Object.entries(JSON.parse(decodeCol(row.body) ?? "{}") as Record<string, MovedOutput>));
}

/** Tool call ids that carry a mark in `blocks`. */
function markedIds(blocks: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const b of blocks) {
    const tc = toolCallOf(b);
    if (tc?.movedOutput !== undefined && typeof tc.id === "string") ids.push(tc.id);
  }
  return ids;
}

/**
 * The full read of a parsed timeline: marked tool calls get their text back.
 * A timeline without marks costs one scan of its blocks and no query.
 */
export function restoreFromStore(db: Database, messageId: string, blocks: readonly unknown[]): void {
  if (!hasMovedOutput(blocks)) return;
  const missing = restoreToolOutputs(blocks, readToolOutputs(db, messageId));
  if (missing.length > 0) {
    warnThrottled("tool-output-store:missing", `[tool-outputs] message ${messageId}: no stored output for ${missing.join(", ")}`);
  }
}

/**
 * The same, on the JSON text of a `blocks` column, for the few readers that
 * hand the raw column on (the reattach snapshot, the crashed-turn notice).
 * The text comes back unchanged when it carries no mark.
 */
export function restoreBlocksJson(db: Database, messageId: string, json: string | null): string | null {
  if (!json || !json.includes(MOVED_OUTPUT_MARK)) return json;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return json; }
  if (!Array.isArray(parsed)) return json;
  restoreFromStore(db, messageId, parsed);
  return JSON.stringify(parsed);
}

/** The `blocks` column of a write, and the output that leaves the row with it. */
export interface BlocksColumn {
  /** What goes in `messages.blocks`. */
  value: string | Uint8Array | null;
  /** The whole timeline, as it would be stored without the split. */
  whole: string | Uint8Array | null;
  moved: Map<string, MovedOutput> | null;
  /** The split timeline before encoding, for the read-back check. */
  stubbed: unknown[] | null;
  /** The whole timeline before encoding, for the read-back check. */
  original: unknown[] | null;
}

/**
 * The `blocks` column for a row about to be written. A row that is not final,
 * or that `encodeCol` would keep as plain text, is written exactly as before.
 */
export function blocksColumn<B>(blocks: readonly B[] | null | undefined, final: boolean): BlocksColumn {
  if (!blocks) return { value: null, whole: null, moved: null, stubbed: null, original: null };
  const lean = leanBlocks(blocks as never) as unknown as unknown[];
  const text = JSON.stringify(lean);
  const whole = encodeCol(text) ?? null;
  if (!final || typeof whole === "string" || whole === null) return { value: whole, whole, moved: null, stubbed: null, original: null };
  const split = splitToolOutputs(lean);
  if (!split) return { value: whole, whole, moved: null, stubbed: null, original: null };
  const value = encodeCol(JSON.stringify(split.blocks)) ?? null;
  return { value, whole, moved: split.moved, stubbed: split.blocks, original: lean };
}

/**
 * Writes the stored text of `messageId` and checks it: read back, put into the
 * split timeline, it must rebuild `original` field for field. Throws otherwise,
 * so the caller's transaction rolls back with the row write. The message row
 * must already exist (the foreign key).
 *
 * The stored body is exactly the marks of `stubbed`: the calls moved now,
 * plus the ones an earlier write had moved and the row still marks. Text the
 * row no longer points to is dropped with the rewrite.
 */
export function putToolOutputs(
  db: Database,
  messageId: string,
  moved: ReadonlyMap<string, MovedOutput>,
  stubbed: readonly unknown[],
  original: readonly unknown[],
): void {
  const before = readToolOutputs(db, messageId);
  const body: Record<string, MovedOutput> = {};
  for (const id of markedIds(stubbed)) {
    const entry = moved.get(id) ?? before.get(id);
    if (!entry) throw new Error(`tool output ${id} of ${messageId} is marked but stored nowhere`);
    body[id] = entry;
  }
  db.prepare("INSERT OR REPLACE INTO message_tool_outputs (message_id, body) VALUES (?, ?)")
    .run(messageId, Bun.zstdCompressSync(Buffer.from(JSON.stringify(body), "utf8"), { level: 3 }));
  // The check reads the body back from the table and rebuilds the blocks the
  // split replaced; every other block is the very object of `original`
  // (`splitToolOutputs` copies only what it changes), so there is nothing to
  // compare there, and nothing to clone. Only the calls moved now are put
  // back: a call split by an earlier write keeps its mark in `original` too.
  const stored = readToolOutputs(db, messageId);
  const only = new Set(moved.keys());
  let bad = stubbed.length !== original.length;
  for (let i = 0; !bad && i < stubbed.length; i++) {
    if (stubbed[i] === original[i]) continue;
    const block = structuredClone(stubbed[i]);
    bad = restoreToolOutputs([block], stored, only).length > 0 || !Bun.deepEquals(block, original[i]);
  }
  if (bad) throw new Error(`tool outputs of ${messageId} do not rebuild the row`);
}

/**
 * Runs `writeRow(value)` and stores the moved output in one transaction.
 * If storing or the check fails, the row is written whole instead: the output
 * never leaves it unless it is verifiably stored.
 */
export function writeSplitRow(
  db: Database,
  messageId: string,
  col: BlocksColumn,
  writeRow: (blocksValue: string | Uint8Array | null) => void,
): void {
  if (!col.moved || !col.stubbed || !col.original) {
    writeRow(col.value);
    return;
  }
  const { moved, stubbed, original } = col;
  try {
    db.transaction(() => {
      writeRow(col.value);
      putToolOutputs(db, messageId, moved, stubbed, original);
    })();
  } catch (err) {
    warnThrottled("tool-output-store:write", `[tool-outputs] message ${messageId}: output kept in the row:`, err);
    writeRow(col.whole);
  }
}

// --- Backfill of the rows written before the split existed -------------------

export interface BackfillTick {
  /** Rows looked at. */
  scanned: number;
  /** Rows whose output moved. */
  split: number;
  /** Characters of output that left the rows. */
  movedChars: number;
  /** Nothing left after this tick. */
  done: boolean;
}

/**
 * One bounded step of the backfill: at most `maxRows` rows and about `maxMs`
 * of work, from where the last step stopped. Each row is one IMMEDIATE
 * transaction that reads the row, stores its output, checks the read-back and
 * rewrites the row, and advances the cursor with it: a crash or a restart at
 * any point leaves every row either whole or split and verified, and the next
 * step resumes after the last row committed. A row that cannot be split
 * (unreadable, already split, nothing big enough) is only passed over.
 *
 * zstd is not readable from SQL, so this runs in JS, a few rows at a time.
 */
export function backfillToolOutputsTick(db: Database, opts: { maxRows: number; maxMs: number }): BackfillTick {
  const t0 = performance.now();
  const state = db.query("SELECT after_id, finished_at FROM message_tool_outputs_backfill WHERE id = 1").get() as
    | { after_id: string; finished_at: string | null }
    | null;
  const tick: BackfillTick = { scanned: 0, split: 0, movedChars: 0, done: false };
  if (!state || state.finished_at) {
    tick.done = true;
    return tick;
  }
  const ids = (db.query(
    `SELECT id FROM messages WHERE id > ? AND partial = 0 AND typeof(blocks) = 'blob' ORDER BY id LIMIT ?`,
  ).all(state.after_id, opts.maxRows) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) {
    db.run("UPDATE message_tool_outputs_backfill SET finished_at = ? WHERE id = 1", [new Date().toISOString()]);
    tick.done = true;
    return tick;
  }
  const readRow = db.prepare("SELECT blocks, partial FROM messages WHERE id = ?");
  const writeBlocks = db.prepare("UPDATE messages SET blocks = ? WHERE id = ?");
  const advance = db.prepare("UPDATE message_tool_outputs_backfill SET after_id = ? WHERE id = 1");
  for (const id of ids) {
    tick.scanned++;
    try {
      db.transaction(() => {
        const row = readRow.get(id) as { blocks: unknown; partial: number | null } | null;
        advance.run(id);
        if (!row || row.partial || !(row.blocks instanceof Uint8Array)) return;
        const text = decodeCol(row.blocks);
        if (!text || MACHINE_MARKS.some((m) => text.includes(m))) return;
        const parsed = JSON.parse(text) as unknown;
        if (!Array.isArray(parsed)) return;
        const split = splitToolOutputs(parsed as ContentBlock[]);
        if (!split) return;
        const value = encodeCol(JSON.stringify(split.blocks));
        writeBlocks.run(value ?? null, id);
        putToolOutputs(db, id, split.moved, split.blocks, parsed);
        tick.split++;
        for (const e of split.moved.values()) {
          tick.movedChars += (e.result?.length ?? 0) + Object.values(e.detail ?? {}).reduce((n, v) => n + v.length, 0);
        }
      }).immediate();
    } catch (err) {
      // The transaction rolled back: the row is whole, the cursor did not
      // move. A busy database is retried by the next tick from the same row.
      // Anything else (an unreadable row, a read-back that does not rebuild
      // it) is stepped past on its own, so one row cannot stall the backfill;
      // the row stays as it is.
      if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(`${(err as { code?: unknown })?.code ?? ""} ${String(err)}`)) break;
      warnThrottled("tool-output-store:backfill", `[tool-outputs] backfill left ${id} whole:`, err);
      try { advance.run(id); } catch { break; }
    }
    if (performance.now() - t0 > opts.maxMs) break;
  }
  return tick;
}

/** The pace of the backfill, measured on a copy of the live DB (see the commit). */
export const BACKFILL_EVERY_MS = 2_000;
export const BACKFILL_MAX_ROWS = 20;
export const BACKFILL_MAX_MS = 15;
/** A timer this late means the loop is busy with something else: not now. */
export const BACKFILL_BUSY_LAG_MS = 100;

/**
 * Runs the backfill in the background until it finds nothing left: one
 * bounded tick every `everyMs`, and none while the event loop is behind (the
 * timer fired more than `BACKFILL_BUSY_LAG_MS` late), then five periods of
 * rest. Every tick is safe to cut anywhere (`backfillToolOutputsTick`), so a
 * restart just starts again from the cursor. Returns the stop function.
 */
export function startToolOutputBackfill(
  db: Database,
  opts: { startDelayMs?: number; everyMs?: number; maxRows?: number; maxMs?: number; log?: (line: string) => void } = {},
): () => void {
  const every = opts.everyMs ?? BACKFILL_EVERY_MS;
  const budget = { maxRows: opts.maxRows ?? BACKFILL_MAX_ROWS, maxMs: opts.maxMs ?? BACKFILL_MAX_MS };
  const total = { rows: 0, split: 0, movedChars: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (delay: number) => {
    const due = Date.now() + delay;
    timer = setTimeout(() => run(due), delay);
    (timer as { unref?: () => void }).unref?.();
  };
  const run = (due: number) => {
    if (stopped) return;
    if (Date.now() - due > BACKFILL_BUSY_LAG_MS) return schedule(every * 5);
    let tick: BackfillTick;
    try {
      tick = backfillToolOutputsTick(db, budget);
    } catch (err) {
      // A tick that cannot even read its cursor (the table is missing on a
      // database that has not migrated) stops here; the reads work either way.
      opts.log?.(`[tool-outputs] backfill stopped: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    total.rows += tick.scanned;
    total.split += tick.split;
    total.movedChars += tick.movedChars;
    if (tick.done) {
      if (total.rows > 0) {
        opts.log?.(`[tool-outputs] backfill done: ${total.rows} rows read, ${total.split} split, ${(total.movedChars / 1048576).toFixed(1)} MB of output moved out of the rows`);
      }
      return;
    }
    schedule(every);
  };
  schedule(opts.startDelayMs ?? every);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
