/** Byte-sized transport chunks for DOM mirror frames. */
export const BROWSER_WS_CHUNK_BYTES = 192 * 1024;
export const BROWSER_WS_MAX_REASSEMBLED_BYTES = 12 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(BROWSER_WS_MAX_REASSEMBLED_BYTES / BROWSER_WS_CHUNK_BYTES);

export interface BrowserWsChunk {
  id: string;
  index: number;
  total: number;
  data: string;
}

export function chunkText(text: string, id: string): BrowserWsChunk[] {
  const bytes = new TextEncoder().encode(text);
  const total = Math.ceil(bytes.byteLength / BROWSER_WS_CHUNK_BYTES);
  const chunks: BrowserWsChunk[] = [];
  for (let index = 0; index < total; index++) {
    const part = bytes.subarray(index * BROWSER_WS_CHUNK_BYTES, (index + 1) * BROWSER_WS_CHUNK_BYTES);
    let binary = "";
    for (const byte of part) binary += String.fromCharCode(byte);
    chunks.push({ id, index, total, data: btoa(binary) });
  }
  return chunks;
}

/**
 * The frames a mirror host sends for a batch of rrweb events: the batch whole, or the event
 * list in pieces when it would not fit one. The server joins the pieces back into the list.
 */
export function hostEventFrames(events: unknown[], id: string): string[] {
  const text = JSON.stringify(events);
  if (new TextEncoder().encode(text).byteLength <= BROWSER_WS_CHUNK_BYTES) return [JSON.stringify({ type: "host_dom_events", events })];
  return chunkText(text, id).map((piece) => JSON.stringify({ type: "host_dom_events_chunk", ...piece }));
}

export class BrowserWsChunkAssembler {
  private readonly pending = new Map<string, { total: number; parts: Array<Uint8Array | undefined>; bytes: number }>();

  add(chunk: BrowserWsChunk): string | null {
    if (typeof chunk.id !== "string" || chunk.id.length > 100 || typeof chunk.data !== "string" || chunk.data.length > Math.ceil(BROWSER_WS_CHUNK_BYTES * 4 / 3) + 4 || !Number.isInteger(chunk.index) || !Number.isInteger(chunk.total) || chunk.total < 1 || chunk.total > MAX_CHUNKS || chunk.index < 0 || chunk.index >= chunk.total) return null;
    let binary: string;
    try { binary = atob(chunk.data); } catch { this.pending.delete(chunk.id); return null; }
    if (binary.length > BROWSER_WS_CHUNK_BYTES) { this.pending.delete(chunk.id); return null; }
    const part = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    let entry = this.pending.get(chunk.id);
    if (!entry) {
      this.pending.clear();
      entry = { total: chunk.total, parts: new Array(chunk.total), bytes: 0 };
      this.pending.set(chunk.id, entry);
    }
    if (entry.total !== chunk.total || entry.parts[chunk.index] || entry.bytes + part.byteLength > BROWSER_WS_MAX_REASSEMBLED_BYTES) {
      this.pending.delete(chunk.id);
      return null;
    }
    entry.parts[chunk.index] = part;
    entry.bytes += part.byteLength;
    if (entry.parts.includes(undefined)) return null;
    this.pending.delete(chunk.id);
    const bytes = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const value of entry.parts) { bytes.set(value!, offset); offset += value!.byteLength; }
    return new TextDecoder().decode(bytes);
  }
}
