/**
 * FOLLOWING A LOG THAT SOMEBODY ELSE WRITES.
 *
 * Two kinds of process row get their output from a file instead of a pipe:
 *
 *   - a command started with `run_command` writes straight into its own log
 *     (`routes/processes.ts`). A pipe dies with the server that reads it, and
 *     this machine reloads the server on every save under `server/`: with a
 *     pipe, a re-adopted command kept its pid and lost its output for good.
 *     A file is still there after the reload, and the tail resumes from the
 *     byte it had reached;
 *   - a background shell of the CLI, whose output the CLI writes to the file it
 *     names when the shell starts. The CLI no longer calls `BashOutput`, so the
 *     file is the only place that output exists.
 *
 * Synchronous on purpose: the registry calls it once a second per live row and
 * once more when the row closes, and a read of what a process printed in one
 * second is far below a millisecond. The async version would need a queue per
 * row to keep a tick and the final drain from reading the same bytes twice.
 */
import { closeSync, fstatSync, openSync, readSync } from "fs";

export interface FileTail {
  path: string;
  /** The next byte to read. */
  offset: number;
  /** Streaming decoder: a character split across two reads is not mangled. */
  decoder: TextDecoder;
}

/** More than this in one read is not shown: the ring buffer keeps 500 KB anyway. */
export const TAIL_MAX_BYTES = 1024 * 1024;

export function openTail(path: string, offset = 0): FileTail {
  return { path, offset, decoder: new TextDecoder() };
}

/**
 * What the file gained since the last read, and how many bytes were jumped
 * over because there were more than `maxBytes`. A file that does not exist
 * (yet) reads as nothing: the CLI creates the shell's file a moment after it
 * announces it.
 */
export function readTail(tail: FileTail, maxBytes = TAIL_MAX_BYTES): { text: string; skipped: number } {
  let fd: number;
  try {
    fd = openSync(tail.path, "r");
  } catch {
    return { text: "", skipped: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    let skipped = 0;
    if (size - tail.offset > maxBytes) {
      skipped = size - maxBytes - tail.offset;
      tail.offset = size - maxBytes;
    }
    const length = size - tail.offset;
    if (length <= 0) return { text: "", skipped };
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, tail.offset);
    tail.offset += read;
    return { text: tail.decoder.decode(bytes.subarray(0, read), { stream: true }), skipped };
  } finally {
    closeSync(fd);
  }
}
