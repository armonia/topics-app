import { openSync, readSync, fstatSync, closeSync } from "fs";

/** The part of a scan state the reader owns: how far it got and the unfinished line. */
export interface IncrementalScanBase {
  /** Bytes of the file already consumed (including the carried tail). */
  offset: number;
  /** Trailing partial line carried to the next scan, as RAW BYTES: the delta
   *  boundary can fall mid-multibyte-char, so decoding happens only on complete
   *  lines ('\n' = 0x0A never occurs inside a UTF-8 sequence). */
  carry: Buffer;
}

export interface IncrementalScanSpec<S extends IncrementalScanBase, R> {
  /** A fresh state, offset 0 and an empty carry. */
  blank: () => S;
  /** Folds one batch of complete lines into the state. */
  scanLines: (st: S, lines: string[]) => void;
  /** Reads the answer out of a state. */
  choose: (st: S) => R | null;
  /** Cap of the per-path state cache. */
  cacheMax: number;
}

/**
 * Builds a reader of an append-only JSONL file that consumes only the bytes
 * added since the last call. Transcript paths are unique per session, so the
 * per-path state is LRU-capped: without it the map grows with every session the
 * process has ever seen. A shrunken file (rotation/truncation) resets the scan.
 */
export function createIncrementalJsonlScanner<S extends IncrementalScanBase, R>(
  spec: IncrementalScanSpec<S, R>,
): (path: string) => R | null {
  const cache = new Map<string, S>();

  function touch(path: string, st: S): void {
    // Map iteration order is insertion order: delete+set moves this key to the
    // tail, so the head is always the least-recently-used entry.
    cache.delete(path);
    cache.set(path, st);
    while (cache.size > spec.cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return (path) => {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return null; }
    try {
      const size = fstatSync(fd).size;
      let st = cache.get(path);
      // First sight, or the file shrank (rotation/truncation) → full rescan.
      if (!st || size < st.offset) st = spec.blank();
      if (size > st.offset) {
        const delta = Buffer.alloc(size - st.offset);
        let read = 0;
        while (read < delta.length) {
          const n = readSync(fd, delta, read, delta.length - read, st.offset + read);
          if (n <= 0) break;
          read += n;
        }
        // Consume complete lines only: split on the LAST '\n' byte and carry the
        // raw remainder. The writer may be mid-append, and the boundary may even
        // land mid-multibyte-char; both resolve on the next call.
        const combined = st.carry.length
          ? Buffer.concat([st.carry, delta.subarray(0, read)])
          : delta.subarray(0, read);
        const lastNl = combined.lastIndexOf(0x0a);
        if (lastNl >= 0) {
          spec.scanLines(st, combined.toString("utf-8", 0, lastNl).split("\n"));
        }
        // Copy: a subarray view would pin the whole delta buffer in memory.
        st.carry = Buffer.from(combined.subarray(lastNl + 1));
        st.offset += read;
        touch(path, st);
      }
      // A final unterminated line is parsed opportunistically (a complete line
      // missing only its newline flush is common at turn end) WITHOUT consuming
      // it from the carry. If it is a genuinely partial write, JSON.parse fails
      // and the committed state wins.
      if (st.carry.length) {
        const peek: S = { ...st };
        spec.scanLines(peek, [st.carry.toString("utf-8")]);
        return spec.choose(peek);
      }
      return spec.choose(st);
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  };
}
