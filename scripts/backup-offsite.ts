/**
 * The copy of the daily snapshot that lives OFF this machine's disk.
 *
 * WHY. `scripts/db-snapshot.ts` writes a snapshot every night and
 * `scripts/backup-restore-check.ts` proves the newest one restores, but both
 * sides of that proof sit on the same disk as the live DB. A disk failure
 * takes the database and every proof of it at once. This module copies the
 * day's snapshot to a different host over `scp` (the home Windows PC, woken
 * first by a configurable command), reads the copy back over the same channel
 * and only then writes a receipt. The wake command returns as soon as the magic
 * packet is sent, while the PC is still booting: the copy waits for the host's
 * ssh port to answer (`waitForSsh`) before the first `scp`, or `scp` dies with
 * «Connection closed» and the night is lost. `verifyOffsite` later checks the receipt
 * without touching the network: the read-back already happened at copy time,
 * so a green check means bytes that were seen coming back, not bytes assumed
 * sent.
 *
 * Remote layout is 7 rotating slots, one per local weekday
 * (`topics-<sun|mon|tue|wed|thu|fri|sat>.db.zst`). Seven days of history with
 * no remote delete ever needed: each night overwrites its own weekday.
 *
 *   ~/.topics/backup-offsite.json   {"dest":"backup@host.example.test:E:/topics-backups","wake":"optional wake command"}
 */
import { spawnSync } from "child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

export interface OffsiteConfig {
  /** scp destination directory: `[user@]host:path`, e.g. `backup@host.example.test:E:/topics-backups`. */
  dest: string;
  /** Optional shell command run first to wake the host (idempotent). */
  wake?: string;
}

export interface OffsiteReceipt {
  name: string;
  slot: string;
  bytes: number;
  sha256: string;
  at: string;
}

export const RECEIPT_FILE = "offsite.json";

/** Maximum age of a receipt before the restore check goes red (days). */
export const MAX_AGE_DAYS = 2;

export type Transfer = (args: string[]) => { status: number | null; stderr: string };

/**
 * How long the copy waits for the host's ssh port after the wake command, and
 * how it asks. `probe` runs one `ssh` with the given args and returns its exit
 * code (null when it could not run). Tests replace it or shorten the times.
 */
export interface SshWait {
  /** Give up after this many ms without an answer. */
  waitMs: number;
  /** Pause between two tries, in ms. */
  everyMs: number;
  probe: (args: string[]) => number | null;
}

export const DEFAULT_SSH_WAIT: SshWait = {
  waitMs: 90_000,
  everyMs: 3_000,
  probe: (args) => spawnSync("ssh", args, { timeout: 15_000 }).status,
};

/** Synchronous pause: `copyOffsite` is synchronous and the job is a plain script. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** `[user@]host` of an scp destination: everything before the first `:`. */
export function sshTarget(dest: string): string {
  return dest.slice(0, dest.indexOf(":"));
}

/**
 * True when one probe shows that ssh reached the host and ran the command.
 * ssh itself exits 255 when it cannot connect or log in, and null when the
 * probe timed out; any other code is the remote shell's own. The home PC is
 * Windows, where the default shell is cmd.exe: there `true` does not exist and
 * exits 1 even though the port is perfectly alive, so «exit 0» is not the test,
 * «ssh got through» is.
 */
export const sshAnswered = (status: number | null): boolean => status !== null && status !== 255;

/**
 * Waits until `ssh <target> "exit 0"` gets through, then returns the number of
 * tries. The command is `exit 0` because cmd.exe, PowerShell and sh all know
 * it (`true` is sh only). The wake command returns while the PC is still
 * booting, so the first scp after it used to die with «Connection closed».
 * Throws, naming the host, when no try answers within `waitMs`: the caller then
 * writes no receipt and the restore check stays red with a reason.
 */
export function waitForSsh(dest: string, ssh: SshWait = DEFAULT_SSH_WAIT, sleep: (ms: number) => void = sleepSync): number {
  const target = sshTarget(dest);
  const args = ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", target, "exit 0"];
  const deadline = Date.now() + ssh.waitMs;
  let tries = 0;
  for (;;) {
    tries++;
    if (sshAnswered(ssh.probe(args))) return tries;
    if (Date.now() >= deadline) break;
    sleep(ssh.everyMs);
  }
  throw new Error(
    `off-disk host ${target} does not answer ssh after ${ssh.waitMs / 1000} s (${tries} tries): no off-disk copy`,
  );
}

const SCP_OPTS = ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

const WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Hosts that mean "this machine": copying there is not off-disk. */
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

/** `topics-<sun|mon|tue|wed|thu|fri|sat>.db.zst`, by LOCAL weekday. */
export function offsiteSlot(now: Date): string {
  return `topics-${WEEKDAY[now.getDay()]}.db.zst`;
}

/**
 * Reads `<home>/.topics/backup-offsite.json` (`os.homedir()` by default).
 * Null when the file is missing; throws on malformed JSON or a
 * missing/empty `dest`.
 */
export function loadOffsiteConfig(home: string = homedir()): OffsiteConfig | null {
  const path = join(home, ".topics", "backup-offsite.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`off-disk config malformed: ${path} is not valid JSON`);
  }
  const dest = (parsed as Partial<OffsiteConfig> | null)?.dest;
  if (typeof dest !== "string" || dest.trim() === "") {
    throw new Error(`off-disk config malformed: ${path} needs a non-empty "dest"`);
  }
  const wake = (parsed as Partial<OffsiteConfig>).wake;
  return wake === undefined ? { dest } : { dest, wake };
}

const defaultTransfer: Transfer = (args) => {
  const r = spawnSync("scp", args, { encoding: "utf8", timeout: 600_000 });
  return { status: r.status, stderr: String(r.stderr ?? "") };
};

/** Streamed in 8 MB chunks: the snapshot is ~230 MB and this runs on a box already short of RAM. */
const sha256File = (path: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) {
      hasher.update(chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hasher.digest("hex") as string;
};

/** Host part of an scp destination: before the first `:`, after `user@`. */
function destHost(dest: string): string | null {
  const colon = dest.indexOf(":");
  if (colon < 0) return null;
  const before = dest.slice(0, colon);
  const at = before.lastIndexOf("@");
  return (at >= 0 ? before.slice(at + 1) : before).toLowerCase();
}

/**
 * Copies `<backupsDir>/<name>` to the off-disk destination, reads it back
 * over the same channel, and writes the receipt on hash match. Throws on a
 * same-machine destination, a failed transfer, or a read-back that differs;
 * in those cases no receipt is written. After the wake command it waits for
 * the host's ssh port (`waitForSsh`), so the upload starts on a booted host.
 */
export function copyOffsite(
  backupsDir: string,
  name: string,
  cfg: OffsiteConfig,
  now: Date = new Date(),
  transfer: Transfer = defaultTransfer,
  ssh: SshWait = DEFAULT_SSH_WAIT,
): OffsiteReceipt {
  if (LOCAL_HOSTS.has(destHost(cfg.dest) ?? "")) {
    throw new Error("off-disk destination is this machine");
  }
  if (cfg.wake) {
    // Idempotent by contract; a host that stays down fails below at ssh or scp time.
    spawnSync("/bin/sh", ["-c", cfg.wake], { timeout: 180_000 });
  }
  // Still before the receipt is removed: a host that never answers changes nothing on disk.
  waitForSsh(cfg.dest, ssh);
  const slot = offsiteSlot(now);
  const localFile = join(backupsDir, name);
  const remote = `${cfg.dest}/${slot}`;
  // The upload overwrites the slot the previous receipt vouches for: from here until the read-back
  // matches, that receipt describes a file that may be half there, so it must not outlive the start.
  rmSync(join(backupsDir, RECEIPT_FILE), { force: true });
  const up = transfer([...SCP_OPTS, localFile, remote]);
  if (up.status !== 0) throw new Error(`off-disk copy failed: ${up.stderr || `exit ${up.status}`}`);

  // Read it back before believing it: an upload nobody re-read is a guess.
  const scratchDir = mkdtempSync(join(tmpdir(), "topics-offsite-"));
  try {
    const scratchFile = join(scratchDir, slot);
    const down = transfer([...SCP_OPTS, remote, scratchFile]);
    if (down.status !== 0) throw new Error(`off-disk read-back failed: ${down.stderr || `exit ${down.status}`}`);
    const sha256 = sha256File(localFile);
    if (sha256File(scratchFile) !== sha256) throw new Error("off-disk copy differs after read-back");
    const receipt: OffsiteReceipt = { name, slot, bytes: statSync(localFile).size, sha256, at: now.toISOString() };
    const staging = join(backupsDir, ".offsite.json.tmp");
    writeFileSync(staging, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(staging, join(backupsDir, RECEIPT_FILE));
    return receipt;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function parseReceipt(backupsDir: string): OffsiteReceipt {
  const path = join(backupsDir, RECEIPT_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no off-disk copy: ${path} does not exist (configure ~/.topics/backup-offsite.json)`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`off-disk receipt malformed: ${path} is not valid JSON`);
  }
  const r = parsed as Partial<OffsiteReceipt>;
  if (
    typeof r.name !== "string" || r.name === "" ||
    typeof r.slot !== "string" || r.slot === "" ||
    typeof r.bytes !== "number" || !Number.isInteger(r.bytes) || r.bytes < 0 ||
    typeof r.sha256 !== "string" || r.sha256 === "" ||
    typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))
  ) {
    throw new Error(`off-disk receipt malformed: ${path} has missing or invalid fields`);
  }
  return r as OffsiteReceipt;
}

/**
 * Checks the copy-time receipt against the newest local snapshot. Never
 * contacts the remote: the read-back already happened when the receipt was
 * written. Returns the receipt when every check holds.
 */
export function verifyOffsite(backupsDir: string, latest: string, now: Date = new Date()): OffsiteReceipt {
  const receipt = parseReceipt(backupsDir);
  if (receipt.name !== latest) {
    throw new Error(`off-disk copy is of another day: receipt covers ${receipt.name}, latest snapshot is ${latest}`);
  }
  const sha256 = sha256File(join(backupsDir, latest));
  if (sha256 !== receipt.sha256) {
    throw new Error(`off-disk receipt no longer matches ${latest}: the snapshot changed since it was copied`);
  }
  const ageDays = (now.getTime() - Date.parse(receipt.at)) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) {
    throw new Error(`off-disk copy is ${Math.floor(ageDays)} days old (receipt from ${receipt.at})`);
  }
  return receipt;
}
