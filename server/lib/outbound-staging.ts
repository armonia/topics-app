/**
 * THE BYTES A PERSON SAW, frozen where the agent cannot reach them.
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
 * private staging directory of the server (0700, under `~/.topics`, outside
 * every workspace). The path handed to the CLI is the COPY, and the question
 * carries name, size and the head of the sha256 of exactly those bytes. After
 * that moment nothing an agent can do to the workspace changes what leaves.
 *
 * WHY A COPY AND NOT A RE-CHECK OF THE HASH BEFORE SPAWNING. A re-check is the
 * same race one round later: between the check and the spawn the file can
 * change again, and the window is small but it is the attacker's to choose. A
 * copy has no window at all, and it is the thing a person can be told in one
 * sentence.
 *
 * ONE DIRECTORY PER (SESSION, CONTENT). The bridge polls: the same send comes
 * back through this function every 25 seconds until somebody answers, and a
 * fresh directory per leg would be 600 copies of the same attachment. The name
 * of the directory is derived from the session and from the hashes, so a leg
 * that re-reads unchanged bytes lands on the directory that is already there,
 * while bytes that CHANGED produce another directory - and, upstream, another
 * digest, i.e. a new question. Which is the honest outcome: the person is asked
 * again about the file that exists now.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { topicsHome } from "../services/daemon-state";

/** An attachment as it exists AFTER the freeze: a copy, with its fingerprint. */
export interface FrozenAttachment {
  /** The path handed to the CLI. Inside the staging directory, never the workspace. */
  path: string;
  /** The name the recipient sees, and the name the person read in the question. */
  name: string;
  bytes: number;
  /** Head of the sha256 of the frozen bytes: short enough to read, long enough to name. */
  sha256: string;
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
 * The ceiling on what gets read into memory to be frozen.
 *
 * Not a round number picked for safety: Gmail refuses a message over 25 MB, so
 * anything past it is a send that was never going to arrive. Before the freeze
 * the server only passed a path around and the size of the file was somebody
 * else's problem; reading the bytes makes it this process's RAM, and an
 * "attachment" of two gigabytes would be an agent turning the mail tool into a
 * way to kill the server.
 */
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

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

export interface StagingOptions {
  /** The staging root. Injected by the tests, which must not touch the real home. */
  root?: string;
  now?: number;
}

function stagingRoot(opts: StagingOptions): string {
  return opts.root ?? join(topicsHome(), "outbound-attachments");
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

  let total = 0;
  const read = sources.map((source) => {
    let data: Buffer;
    try {
      data = readFileSync(source.path);
    } catch (err) {
      throw new OutboundStagingError(
        `attachment "${source.name}" could not be read to be frozen: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    total += data.byteLength;
    if (total > MAX_TOTAL_BYTES) {
      throw new OutboundStagingError(
        `attachments exceed ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB in total, which is more than a mailbox accepts`,
      );
    }
    // The hash is taken from the SAME buffer that gets written: hashing the
    // file and then copying it would leave one more window between two reads,
    // which is the window this whole module exists to close.
    return { name: basename(source.name), data, sha256: createHash("sha256").update(data).digest("hex") };
  });

  const stagingId = createHash("sha256")
    .update(sessionKey)
    .update(ID_SEPARATOR)
    .update(read.map((file) => `${file.name}:${file.sha256}`).join(ID_SEPARATOR))
    .digest("hex")
    .slice(0, 16);

  mkdirSync(root, { recursive: true, mode: 0o700 });
  sweep(root, now);
  const dir = join(root, stagingId);
  const files: FrozenAttachment[] = read.map((file, index) => {
    // One sub-directory per position so two attachments that share a basename
    // stay two files, and so the name the recipient reads is the name the
    // person confirmed - not `1-preventivo.pdf`.
    const holder = join(dir, String(index));
    mkdirSync(holder, { recursive: true, mode: 0o700 });
    const path = join(holder, file.name);
    // A leg that re-reads unchanged bytes lands here again: the directory is
    // named after those bytes, so what is already written is what would be
    // written. Rewriting it would only widen the window.
    if (!existsSync(path)) writeFileSync(path, file.data, { mode: 0o600 });
    return { path, name: file.name, bytes: file.data.byteLength, sha256: file.sha256.slice(0, 8) };
  });
  return { dir, files };
}

/** The send is over, whichever way it ended: the copies go. */
export function discardStaging(dir: string): void {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the sweep will get it */ }
}
