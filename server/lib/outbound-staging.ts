/**
 * THE BYTES A PERSON SAW, frozen away from the file the agent keeps editing.
 *
 * WHAT WAS WRONG WITH RESOLVING THE PATH. The route used to resolve every
 * attachment to its real path, show the name and the size in the question, and
 * then hand THAT PATH to the CLI once somebody answered. In between there is a
 * person reading, which takes minutes, and an agent with a shell in the same
 * workspace: `rm preventivo.pdf && ln -s ~/.topics-server-env preventivo.pdf`
 * (or a plain rewrite of the file, no link involved) is one command, and what
 * leaves is not what was confirmed. Reproduced both ways: the confirmation read
 * "preventivo.pdf (9 B)" and the child was handed a secret.
 *
 * WHAT THIS DOES. At question time the bytes are READ, hashed, and written to a
 * staging directory of the server (0700, under `~/.topics`, outside every
 * workspace). The path handed to the CLI is the COPY, and the question carries
 * name, size and the head of the sha256 of exactly those bytes.
 *
 * WHAT THE COPY DOES NOT BUY, because the first version of this comment claimed
 * it did ("frozen where the agent cannot reach them") and that is false. The
 * server and the agents run under the SAME uid - measured with `ps` on this
 * machine: `bun run server.ts` and the agent CLIs share one user, whose home
 * `~/.topics` is - so 0700 keeps other users out and keeps the agent nowhere.
 * Two ways
 * in were reproduced, and both are closed here by a different means than the
 * mode bits:
 *
 *   - PLANTING THE COPY BEFORE THE CALL. The directory used to be named after
 *     sha256(session key, file names and hashes) and the write was skipped when
 *     something was already there: both halves of the name are things the agent
 *     knows, so it computed the path, wrote its secret in it and called
 *     `send_mail`, and the "copy" that left was the file it had planted. No
 *     race, no timing. Now the name comes from `mkdtemp` (random, kept in a map
 *     for the polling legs) and every file is created with `O_EXCL`: a file
 *     already sitting at that path is an attack, not a leg that came before.
 *   - REWRITING THE COPY WHILE THE PERSON READS. `ls -t` finds it, no
 *     computation needed. That window is minutes long, and it is closed by
 *     `verifyFrozen`, which the route calls right after the yes and right
 *     before the spawn: the copy is read again and refused if it is not the one
 *     that was confirmed. What is left is the microseconds between that read
 *     and the CLI's own open, on a path the attacker cannot predict.
 *
 * The honest sentence is: an agent that runs as the server's user is inside the
 * trust boundary, and no file mode moves it. What this module buys is that the
 * workspace file stops mattering once the question is asked, and that the only
 * remaining window is microseconds wide instead of minutes.
 *
 * ONE DIRECTORY PER (SESSION, CONTENT). The bridge polls: the same send comes
 * back through this function every 25 seconds until somebody answers, and a
 * fresh directory per leg would be 600 copies of the same attachment. The map
 * from (session, hashes) to directory is kept in memory - not in the name, which
 * is the mistake above - and a leg that re-reads unchanged bytes lands on the
 * directory that is already there ONLY if the copies in it still hash right.
 * Bytes that CHANGED produce another directory and, upstream, another digest,
 * i.e. a new question: the person is asked again about the file that exists now.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { topicsHome } from "../services/daemon-state";

/** An attachment as it exists AFTER the freeze: a copy, with its fingerprint. */
export interface FrozenAttachment {
  /** The path handed to the CLI. Inside the staging directory, never the workspace. */
  path: string;
  /** The name the recipient sees, and the name the person read in the question. */
  name: string;
  bytes: number;
  /** The sha256 of the frozen bytes, whole: this is what gets re-checked before the spawn. */
  sha256: string;
  /** Its head: short enough to read in a question, long enough to name the file. */
  shortSha: string;
}

export interface FrozenAttachments {
  /** The directory holding the copies, to be discarded once the send is over. */
  dir: string;
  files: FrozenAttachment[];
}

export class OutboundStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundStagingError";
  }
}

/**
 * The ceiling on what gets copied, and it is measured BEFORE anything is read.
 *
 * Not a round number picked for safety: Gmail refuses a message over 25 MB, so
 * anything past it is a send that was never going to arrive. The order matters
 * as much as the number - the first version read the whole file and compared
 * afterwards, so a 64 MB attachment cost 64 MB of RSS to be told it was too big
 * (measured), which is the very failure this constant exists to prevent.
 */
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** How much of a file is in memory at a time while it is copied and hashed. */
const CHUNK_BYTES = 256 * 1024;

/**
 * How long a staging directory can survive without anybody claiming it.
 *
 * The anti-spin cap on the outbound tools is 600 legs of 25 seconds, i.e. about
 * four hours and ten minutes: past six hours no question is still open, so what
 * is left is the residue of a server that died mid-confirmation.
 */
const STAGING_TTL_MS = 6 * 60 * 60 * 1000;

/** The separator inside the hashed identity: a byte no file name can carry. */
const ID_SEPARATOR = "\x00";

/**
 * (session, exact bytes) -> the directory already holding them.
 *
 * In memory on purpose. Deriving the name from this key is what let an agent
 * compute the path and plant a file at it; a map costs one entry per send in
 * flight and cannot be computed from the outside.
 */
const STAGED_BY_CONTENT = new Map<string, string>();

export interface StagingOptions {
  /** The staging root. Injected by the tests, which must not touch the real home. */
  root?: string;
  now?: number;
}

function stagingRoot(opts: StagingOptions): string {
  return opts.root ?? join(topicsHome(), "outbound-attachments");
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The root, with the mode it promises.
 *
 * `mkdirSync` does NOT chmod a directory that already exists (measured: a 0777
 * directory stays 0777 through it), and this one does not exist on any machine
 * yet - so whoever creates it first decides who can read the attachments that
 * pass through it. The chmod is the only thing that makes 0700 a fact rather
 * than an intention.
 */
function ensureRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* not ours: the copies are still verified before they leave */ }
}

/**
 * Drop staging directories nobody can be waiting for any more. Runs on the way
 * in, because that is the only moment this code is guaranteed to run at all: a
 * server killed between the question and the answer leaves its copies behind,
 * and nothing else would ever come back for them.
 */
function sweep(root: string, now: number): void {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (now - statSync(dir).mtimeMs > STAGING_TTL_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* another leg removed it first: that is the intended end */ }
  }
}

/**
 * Open a file this module is willing to read, refusing everything that is not a
 * plain file and everything already too big for a mailbox.
 *
 * THE SIZE IS DECIDED ON THE STAT, before a byte is read. THE KIND IS DECIDED
 * TWICE: `stat` first, because opening a FIFO for reading blocks until a writer
 * shows up and `mkfifo report.csv` is one command in a worktree an agent owns -
 * a blocking read froze the whole event loop, not just the request, and a
 * measured 14 seconds in nobody had even been asked anything. Then `fstat` on
 * the descriptor, because between the stat and the open the name can be
 * replaced; `O_NONBLOCK` is what makes that second open return instead of hang.
 */
function openForFreeze(path: string, name: string, budget: number, overBudget: string): { fd: number; size: number } {
  let seen;
  try {
    seen = statSync(path);
  } catch (err) {
    throw new OutboundStagingError(`attachment "${name}" could not be read to be frozen: ${reason(err)}`);
  }
  if (!seen.isFile()) {
    throw new OutboundStagingError(
      `attachment "${name}" is not a regular file: a pipe, a socket or a device is not something a message can carry`,
    );
  }
  if (seen.size > budget) throw new OutboundStagingError(overBudget);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    throw new OutboundStagingError(`attachment "${name}" could not be read to be frozen: ${reason(err)}`);
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new OutboundStagingError(
        `attachment "${name}" stopped being a regular file while it was being frozen`,
      );
    }
  } catch (err) {
    closeSync(fd);
    throw err instanceof OutboundStagingError
      ? err
      : new OutboundStagingError(`attachment "${name}" could not be read to be frozen: ${reason(err)}`);
  }
  return { fd, size: seen.size };
}

function overCeiling(): string {
  return `attachments exceed ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB in total, which is more than a mailbox accepts`;
}

/**
 * Read a file in chunks, hashing as it goes and, when there is a sink, writing
 * the same chunk into it. One buffer for any size: the ceiling bounds what may
 * be sent, this bounds what is in memory while it is.
 *
 * `budget` is enforced DURING the read too, so a file that grows between the
 * stat and the copy is cut off and refused instead of being trusted twice.
 */
function streamFile(
  path: string,
  name: string,
  budget: number,
  sink: number | null,
  overBudget: string = overCeiling(),
): { bytes: number; sha256: string } {
  const { fd } = openForFreeze(path, name, budget, overBudget);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      let read: number;
      try {
        read = readSync(fd, buffer, 0, buffer.length, null);
      } catch (err) {
        throw new OutboundStagingError(`attachment "${name}" could not be read to be frozen: ${reason(err)}`);
      }
      if (read <= 0) break;
      bytes += read;
      if (bytes > budget) throw new OutboundStagingError(overBudget);
      hash.update(buffer.subarray(0, read));
      if (sink !== null) writeSync(sink, buffer, 0, read);
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** The identity of a set of attachments for one session: names and hashes. */
function identity(sessionKey: string, files: Array<{ name: string; sha256: string }>): string {
  return createHash("sha256")
    .update(sessionKey)
    .update(ID_SEPARATOR)
    .update(files.map((file) => `${file.name}:${file.sha256}`).join(ID_SEPARATOR))
    .digest("hex");
}

function frozenOf(dir: string, index: number, file: { name: string; bytes: number; sha256: string }): FrozenAttachment {
  return {
    path: join(dir, String(index), file.name),
    name: file.name,
    bytes: file.bytes,
    sha256: file.sha256,
    shortSha: file.sha256.slice(0, 8),
  };
}

/**
 * THE COPIES ARE STILL THE ONES THAT WERE CONFIRMED, asked after the yes and
 * before the spawn.
 *
 * The argument against this check used to be that it is "the same race one
 * round later". It is not the same race: the window it closes is the one the
 * person spends reading, which is minutes, and the one it leaves is between
 * this read and the CLI's open on a path nobody outside this process knows.
 * Minutes against microseconds is the whole difference, and it was the minutes
 * that were reproduced.
 */
export function verifyFrozen(frozen: FrozenAttachments): void {
  for (const file of frozen.files) {
    const changed = `the frozen copy of "${file.name}" is not the one that was confirmed: it changed after the question`;
    const seen = streamFile(file.path, file.name, file.bytes, null, changed);
    if (seen.bytes !== file.bytes || seen.sha256 !== file.sha256) throw new OutboundStagingError(changed);
  }
}

/**
 * Read the named files, hash them, and write the copies that will be sent.
 *
 * `sources` are paths already resolved and already checked against the session
 * workspace by the caller: containment is a decision about what an agent may
 * name, and it belongs upstream. This function only answers "which bytes".
 */
export function freezeAttachments(
  sessionKey: string,
  sources: Array<{ path: string; name: string }>,
  opts: StagingOptions = {},
): FrozenAttachments {
  if (!sources.length) return { dir: "", files: [] };
  const root = stagingRoot(opts);
  const now = opts.now ?? Date.now();
  ensureRoot(root);
  sweep(root, now);

  // PASS ONE: what the workspace holds right now, hashed and not written. It
  // answers one question only - "is this the send that already has copies?" -
  // and the authoritative hashes are the ones taken while writing, below.
  let budget = MAX_TOTAL_BYTES;
  const scanned = sources.map((source) => {
    const name = basename(source.name);
    const seen = streamFile(source.path, name, budget, null);
    budget -= seen.bytes;
    return { name, bytes: seen.bytes, sha256: seen.sha256 };
  });

  const key = identity(sessionKey, scanned);
  const known = STAGED_BY_CONTENT.get(key);
  if (known) {
    const files = scanned.map((file, index) => frozenOf(known, index, file));
    // A leg reuses what is there only if what is there is still what was
    // confirmed. Anything else - swept, deleted, rewritten - is a fresh copy.
    try {
      verifyFrozen({ dir: known, files });
      return { dir: known, files };
    } catch {
      STAGED_BY_CONTENT.delete(key);
    }
  }

  const dir = mkdtempSync(join(root, "leg-"));
  try {
    chmodSync(dir, 0o700);
    const files = scanned.map((file, index) => {
      // One sub-directory per position so two attachments that share a basename
      // stay two files, and so the name the recipient reads is the name the
      // person confirmed - not `1-preventivo.pdf`.
      const holder = join(dir, String(index));
      mkdirSync(holder, { mode: 0o700 });
      const path = join(holder, file.name);
      // `wx` is O_EXCL: the directory was just created with a random name, so a
      // file already sitting here is somebody who guessed, not a leg that came
      // before. `if (!existsSync)` was the hole - it handed that file over.
      const sink = openSync(path, "wx", 0o600);
      const moved = `attachment "${file.name}" changed while it was being frozen: nothing is sent on bytes that moved`;
      let copied: { bytes: number; sha256: string };
      try {
        copied = streamFile(sources[index].path, file.name, file.bytes, sink, moved);
      } finally {
        closeSync(sink);
      }
      if (copied.sha256 !== file.sha256) throw new OutboundStagingError(moved);
      return frozenOf(dir, index, { ...file, ...copied });
    });
    STAGED_BY_CONTENT.set(key, dir);
    return { dir, files };
  } catch (err) {
    // A half-written freeze is not a send waiting to happen: it goes now.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the sweep will get it */ }
    throw err;
  }
}

/** The send is over, whichever way it ended: the copies go. */
export function discardStaging(dir: string): void {
  if (!dir) return;
  for (const [key, value] of STAGED_BY_CONTENT) {
    if (value === dir) STAGED_BY_CONTENT.delete(key);
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the sweep will get it */ }
}
