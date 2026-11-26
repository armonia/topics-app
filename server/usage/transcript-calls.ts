import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { CallTokens } from "./project-calls";

export type TranscriptCall = { ts: number; tokens: CallTokens; model: string | null; cwd: string | null };

/**
 * What was already parsed of one transcript: the calls, the ids seen and the
 * byte offset just past the last complete line. A transcript only grows by
 * appending, so a later read parses the new bytes alone. Reading every file of
 * the week whole on each refresh moved gigabytes through the server's heap
 * (the 2.8 GB of transcripts of one project took the process to 3-6 GB for a
 * few seconds, once a minute).
 */
interface ParsedTranscript { size: number; ino: number; offset: number; seen: Set<string>; calls: TranscriptCall[]; cost: number }
const parsedTranscripts = new Map<string, ParsedTranscript>();
/** Rough heap cost of one parsed call: the call object plus its id in the seen set. */
const CALL_COST_BYTES = 300;
/** Heap the parsed transcripts may hold together: the least recently read go first. */
const PARSED_TRANSCRIPTS_MAX_BYTES = 48 * 1024 * 1024;
let parsedCost = 0;
/** Bytes read per step while catching up: bounds the transient buffer, whatever the file size. */
const TRANSCRIPT_READ_CHUNK = 4 * 1024 * 1024;
const LINE_FEED = 0x0a;

function forget(path: string): void {
  const st = parsedTranscripts.get(path);
  if (!st) return;
  parsedCost -= st.cost;
  parsedTranscripts.delete(path);
}

function parseTranscriptLine(line: string, st: ParsedTranscript): void {
  if (!line.includes('"usage"')) return;
  let o: { type?: string; uuid?: string; timestamp?: string; cwd?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
  try { o = JSON.parse(line); } catch { return; }
  const u = o?.message?.usage;
  if (o?.type !== "assistant" || !u) return;
  const id = o.message?.id ?? o.uuid;
  if (id && st.seen.has(id)) return;
  if (id) st.seen.add(id);
  const ts = Date.parse(o.timestamp ?? "");
  if (!Number.isFinite(ts)) return;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cacheWrite = n(u.cache_creation_input_tokens);
  const model = o.message?.model && o.message.model !== "<synthetic>" ? o.message.model : null;
  st.calls.push({
    ts, model, cwd: o.cwd || null,
    tokens: { input: n(u.input_tokens), output: n(u.output_tokens), cacheWrite, cacheRead: n(u.cache_read_input_tokens), cacheWrite1h: n((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens) },
  });
}

/** One transcript's calls: one per `message.id` (per-block lines repeat), with the model and the `cwd` the line itself carries. */
export function readTranscript(path: string): TranscriptCall[] {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { forget(path); return []; }
  try {
    const stat = fstatSync(fd);
    let st = parsedTranscripts.get(path);
    // Shrunk or replaced: start over.
    if (st && (stat.size < st.offset || stat.ino !== st.ino)) { forget(path); st = undefined; }
    if (!st) st = { size: 0, ino: stat.ino, offset: 0, seen: new Set(), calls: [], cost: 0 };
    const before = st.cost;
    try {
      catchUp(fd, stat.size, st);
    } finally {
      st.cost = st.calls.length * CALL_COST_BYTES;
      // Re-insert last: the map order is the recency order.
      parsedTranscripts.delete(path);
      parsedTranscripts.set(path, st);
      parsedCost += st.cost - before;
      while (parsedCost > PARSED_TRANSCRIPTS_MAX_BYTES && parsedTranscripts.size > 1) forget(parsedTranscripts.keys().next().value!);
    }
    return st.calls;
  } finally {
    closeSync(fd);
  }
}

/** Parses the bytes past `st.offset`, working in bytes so a multi-byte character cut at a read edge is never counted as consumed. */
function catchUp(fd: number, size: number, st: ParsedTranscript): void {
  st.size = size;
  let pos = st.offset;
  if (size === pos) return;
  const chunk = Buffer.alloc(Math.min(TRANSCRIPT_READ_CHUNK, size - pos));
  let pending: Buffer = Buffer.alloc(0);
  while (pos < size) {
    const got = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
    if (got <= 0) break;
    pos += got;
    pending = Buffer.concat([pending, chunk.subarray(0, got)]);
    const lastNl = pending.lastIndexOf(LINE_FEED);
    if (lastNl < 0) continue;
    for (const line of pending.subarray(0, lastNl).toString("utf8").split("\n")) parseTranscriptLine(line, st);
    pending = pending.subarray(lastNl + 1);
    // The offset is the byte after the last newline: a half line is read again next time.
    st.offset = pos - pending.length;
  }
  // A last line with no newline yet counts when it is already a whole record.
  if (pending.length) {
    const tail = pending.toString("utf8");
    try { JSON.parse(tail); parseTranscriptLine(tail, st); st.offset = pos; } catch { /* still being written */ }
  }
}
