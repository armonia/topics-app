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
interface ParsedTranscript { size: number; ino: number; offset: number; seen: Set<string>; calls: TranscriptCall[] }
const parsedTranscripts = new Map<string, ParsedTranscript>();
/** Files kept parsed: a week holds thousands of subagent files, each entry is a few KB of calls. */
const PARSED_TRANSCRIPTS_MAX = 6000;
/** Bytes read per step while catching up: bounds the transient buffer, whatever the file size. */
const TRANSCRIPT_READ_CHUNK = 4 * 1024 * 1024;

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
  try { fd = openSync(path, "r"); } catch { parsedTranscripts.delete(path); return []; }
  try {
    const stat = fstatSync(fd);
    let st = parsedTranscripts.get(path);
    // Shrunk or replaced: start over.
    if (st && (stat.size < st.offset || stat.ino !== st.ino)) st = undefined;
    if (!st) st = { size: 0, ino: stat.ino, offset: 0, seen: new Set(), calls: [] };
    parsedTranscripts.delete(path);
    parsedTranscripts.set(path, st); // most recently used last
    if (parsedTranscripts.size > PARSED_TRANSCRIPTS_MAX) parsedTranscripts.delete(parsedTranscripts.keys().next().value!);
    if (stat.size === st.offset) { st.size = stat.size; return st.calls; }
    const decoder = new TextDecoder();
    let carry = "";
    let pos = st.offset;
    const buf = Buffer.alloc(Math.min(TRANSCRIPT_READ_CHUNK, stat.size - pos));
    while (pos < stat.size) {
      const want = Math.min(buf.length, stat.size - pos);
      const got = readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      pos += got;
      carry += decoder.decode(buf.subarray(0, got), { stream: true });
      const lastNl = carry.lastIndexOf("\n");
      if (lastNl < 0) continue;
      for (const line of carry.slice(0, lastNl).split("\n")) parseTranscriptLine(line, st);
      carry = carry.slice(lastNl + 1);
      // The offset moves only past complete lines: a half line is read again next time.
      st.offset = pos - Buffer.byteLength(carry);
    }
    // A last line with no newline yet counts when it is already a whole record.
    const tail = carry + decoder.decode();
    if (tail) {
      try { JSON.parse(tail); parseTranscriptLine(tail, st); st.offset = pos; } catch { /* still being written */ }
    }
    st.size = stat.size;
    return st.calls;
  } finally {
    closeSync(fd);
  }
}
