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

/**
 * The last `maxBytes` of a file, in one positioned read, and the file's size,
 * which is where a tail of it resumes. Null when there is no file.
 *
 * A reload of the server reloads every log this way, and a command's log has
 * no rotation (the command writes it, not the registry): a dev server left
 * running for days would otherwise be read whole, on the event loop, at every
 * save under `server/`. Past the top of the file the window starts at the
 * first whole line, since the cut one is a fragment; a single line longer than
 * the window is kept, cut, rather than dropped.
 */
export function readFileEnd(path: string, maxBytes: number): { text: string; size: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(size - start);
    const read = readSync(fd, bytes, 0, bytes.length, start);
    let text = bytes.subarray(0, read).toString("utf-8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return { text, size: start + read };
  } finally {
    closeSync(fd);
  }
}
