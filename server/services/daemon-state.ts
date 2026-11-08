/**
 * Daemon state service — Phase B · DAEMON-01.
 *
 * Owns the canonical lifecycle artefacts the OS sees for a running
 * Topics server:
 *
 *   ~/.topics/daemon-process.lock   { pid, acquiredAt }
 *   ~/.topics/daemon-state.json     { pid, port, token, startedAt }
 *
 * Both files are written via atomic .tmp + rename so a crashed write
 * never leaves a half-file. The lock detects a stale holder two ways:
 * its recorded pid is dead (`process.kill(pid, 0)` → ESRCH), or its
 * `acquiredAt` predates the last boot (`os.uptime()`) — after a reboot
 * the OS is free to recycle the old pid onto an unrelated live process,
 * which would otherwise read as a false "already running".
 *
 * The token is the only secret; it's 32 random bytes hex-encoded and
 * lives in the (mode 0600) state file. La CLI `topics` (cli/topics.ts) e la
 * shell Tauri (probe healthz in src-tauri/src/lib.rs) lo leggono per fare
 * `Authorization: Bearer …` calls against the server's `/__daemon/*`
 * control endpoints.
 *
 * No `child_process` here — this is pure fs + crypto.
 */
import { homedir, uptime } from "node:os";
import { join, sep } from "node:path";
import { atomicTempPath, writeFileAtomic } from "../lib/atomic-write";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { probePort, realProbeDeps, type PortVerdict } from "../lib/port-squatter";

export interface DaemonState {
  pid: number;
  port: number;
  /** 32 random bytes, hex-encoded. Bearer-token for /__daemon/* */
  token: string;
  /** ISO timestamp. */
  startedAt: string;
}

interface LockFile {
  pid: number;
  acquiredAt: string;
}

export class LiveLockError extends Error {
  /** `null`: the lock kept changing hands while we judged it, holder unknown. */
  constructor(public readonly livePid: number | null) {
    super(livePid === null
      ? "Another Topics server is taking the lock at this same moment."
      : `Another Topics server is already running (pid ${livePid}).`);
    this.name = "LiveLockError";
  }
}

/**
 * `home` is injectable only so callers that already resolved a home (and tests
 * that must not touch the real one) can pass it down; unset it behaves exactly
 * as before.
 */
export function topicsHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.TOPICS_HOME || join(home, ".topics");
}

/**
 * A Topics server started from a DISPATCH WORKTREE (a checkout the dispatcher
 * carved under `~/.topics/worktrees/…` for an agent's isolated work) must NEVER
 * hijack the production singleton. The prod server (the main checkout) owns the
 * shared `~/.topics` daemon lock and the production port; a worktree server that
 * grabs them first serves its OWN (empty) worktree DB while starving the real
 * server into a crash-loop — exactly the "board sembra vuota / kanban non
 * funziona" failure. This detects that case so the boot can isolate the worktree
 * server onto its own TOPICS_HOME (returned here) + an ephemeral port.
 *
 * Pure (home injected for tests). Returns the isolated home to use, or null when
 * `baseDir` is a normal checkout and production defaults must stand.
 */
export function worktreeIsolationHome(baseDir: string, home: string): string | null {
  const worktreesRoot = join(home, ".topics", "worktrees") + sep;
  const norm = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  return norm.startsWith(worktreesRoot) ? join(baseDir, ".topics-daemon") : null;
}

/**
 * COSA CAMBIA NELL'AMBIENTE UN SERVER PARTITO DA UN WORKTREE.
 *
 * `worktreeIsolationHome` dice SE isolare; questa dice COSA spostare, e sta qui
 * per una ragione precisa: la decisione viveva dentro `server.ts`, dove nessun
 * test la raggiunge, ed era INCOMPLETA. Spostava la casa e la porta principale
 * e lasciava indietro la porta del TUNNEL, che e' un numero a parte letto da
 * `TOPICS_TUNNEL_PORT`.
 *
 * Il conto, misurato il 2026-08-18: un `bun run start` partito da un worktree
 * si isolava correttamente sulla 3333 (porta effimera) e si prendeva lo stesso
 * la 3334; la produzione e' rimasta GIU' in crash-loop per minuti, con
 * `Failed to start server. Is port 3334 in use?` ripetuto nel log. E' la stessa
 * «board vuota / kanban rotto» che l'isolamento esiste per impedire, entrata
 * dalla porta di servizio.
 *
 * `null` come valore vuol dire «togli questa variabile». Un server isolato non
 * ha nessuna ragione di servire il tunnel: quello e' il canale del relay verso
 * l'installazione VERA.
 */
export function worktreeIsolationEnv(
  env: Record<string, string | undefined>,
  isoHome: string,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  if (!env.TOPICS_HOME) patch.TOPICS_HOME = isoHome;
  if (!env.PORT && !env.BUN_PORT) patch.PORT = "0";
  if (env.TOPICS_TUNNEL_PORT) patch.TOPICS_TUNNEL_PORT = null;
  return patch;
}

function statePath() { return join(topicsHome(), "daemon-state.json"); }
function lockPath()  { return join(topicsHome(), "daemon-process.lock"); }
function logsDir()   { return join(topicsHome(), "logs"); }

function ensureHomeDir(): void {
  mkdirSync(topicsHome(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
}

/** The lock file's raw text, or null if missing. */
function readLockRaw(): string | null {
  try { return readFileSync(lockPath(), "utf-8"); } catch { return null; }
}

/** The lock, or null if unparseable. */
function parseLock(raw: string): LockFile | null {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.pid === "number" && typeof obj?.acquiredAt === "string") {
      return obj;
    }
  } catch { /* corrupt — treat as no lock */ }
  return null;
}

/**
 * Test seams of the lock: `link` stands in a filesystem without hard links,
 * `beforeStaleRemoval` runs between judging a lock stale and removing it, the
 * instant a competitor booting on the same home can slip its own lock in.
 */
export const lockSeams: { link: typeof linkSync; beforeStaleRemoval: (() => void) | null } = {
  link: linkSync,
  beforeStaleRemoval: null,
};

/**
 * The codes a filesystem without hard links answers `link` with (some FUSE and
 * SMB homes): EPERM / ENOTSUP / EOPNOTSUPP / ENOSYS. EXDEV and EMLINK are not
 * "unsupported" but end the same way: the link cannot be made here.
 */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/**
 * Create `path` with `body` only if there is none. Preferred: written complete
 * to a temp, then `link`ed to the final name, which fails with EEXIST when the
 * name is taken (a rename would replace it unconditionally). Where the
 * filesystem has no hard links, an exclusive `wx` create: still atomic on the
 * NAME, at the price of a reader seeing an empty file for the microseconds
 * before the write, which `acquireLock` treats as a lock being written.
 */
function createExclusive(path: string, body: string): boolean {
  const tmp = atomicTempPath(path);
  let linkRefused = false;
  try {
    writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
    lockSeams.link(tmp, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return false;
    if (!NO_HARD_LINKS.has(code)) throw err;
    linkRefused = true;
  } finally {
    try { unlinkSync(tmp); } catch { /* never created */ }
  }
  if (!linkRefused) return false;
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try { writeSync(fd, body); } finally { closeSync(fd); }
  return true;
}

function createLockExclusive(body: string): boolean {
  return createExclusive(lockPath(), body);
}

/**
 * Remove the lock we judged stale, and ONLY that one.
 *
 * Re-reading and then unlinking left a window: two boots judge the same stale
 * lock, the first unlinks it and writes its own, the second (whose re-read
 * still saw the stale bytes) unlinks the FIRST one's fresh lock and writes its
 * own, and both go on believing they hold it. A rename is atomic: exactly one
 * process moves away whatever is at the name. If what we moved is not what we
 * judged, it is a competitor's fresh lock, and it goes back where it was
 * (exclusively: if that fails, the name was taken again in that instant and
 * the competitor that took it is the holder; either way we lose).
 */
function takeOverStaleLock(judged: string): void {
  const tomb = `${lockPath()}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  lockSeams.beforeStaleRemoval?.();
  try {
    renameSync(lockPath(), tomb);
  } catch {
    return; // already gone: somebody else moved it, the next create decides
  }
  let moved: string | null = null;
  try { moved = readFileSync(tomb, "utf-8"); } catch { /* unreadable: put it back below */ }
  if (moved !== judged) createExclusive(lockPath(), moved ?? "");
  try { unlinkSync(tomb); } catch { /* best effort */ }
}

/** Sleep synchronously: the lock is taken before the server has an event loop worth keeping. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `process.kill(pid, 0)` is the POSIX idiom for "is this pid alive?".
 * Returns true on success, false on ESRCH (pid is dead). Throws on
 * EPERM (the pid exists but we lack permission — we treat as "alive"
 * to be safe).
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    if (err?.code === "EPERM") return true;
    return false;
  }
}

/**
 * Small allowance (ms) for clock skew around the boot instant, so a lock
 * written in the first moments after boot is never mistaken for a pre-boot
 * one. We err toward *keeping* a lock (conservative): better to ask the user
 * to clear a genuinely stale lock than to risk starting a second server.
 */
const BOOT_SKEW_MS = 2_000;

/**
 * True if `acquiredAt` is from before the machine last booted. Such a lock
 * cannot belong to a live process — every process from the previous boot is
 * gone, and the OS may have handed its pid to something unrelated. Computed
 * from `os.uptime()` (seconds since boot), so no native deps and it works on
 * macOS/Linux/Windows alike. Unparseable timestamps are *not* treated as
 * pre-boot (we fall back to the pid check alone).
 */
function lockPredatesBoot(acquiredAt: string): boolean {
  const acquired = Date.parse(acquiredAt);
  if (Number.isNaN(acquired)) return false;
  const bootMs = Date.now() - uptime() * 1000;
  return acquired < bootMs - BOOT_SKEW_MS;
}

/**
 * Acquire the singleton lock. Returns the freshly-written lock object.
 *
 * @throws LiveLockError if another live process holds the lock. Un lock STALE
 *         non e' un errore: viene recuperato in modo trasparente con una riga
 *         di log strutturata (c'era una StaleLockError mai lanciata da
 *         nessuno — rimossa).
 */
export function acquireLock(): LockFile {
  ensureHomeDir();
  const lock: LockFile = { pid: process.pid, acquiredAt: new Date().toISOString() };
  const body = JSON.stringify(lock);
  // EXCLUSIVE, not read-then-write: two servers booting on this home in the
  // same instant both saw "no lock" (or the same dead pid), both wrote, and
  // both opened the DB. Now only one create succeeds; a stale lock is removed
  // and the create retried ONCE, so a competitor that wins that retry wins.
  for (let attempt = 0; ; attempt++) {
    if (createLockExclusive(body)) return lock;
    let raw = readLockRaw();
    // Empty: a competitor on a filesystem without hard links is between its
    // `wx` create and its write. Give it a moment before judging the file.
    if (raw === "") { sleepSync(50); raw = readLockRaw(); }
    const existing = raw === null ? null : parseLock(raw);
    if (existing && existing.pid === process.pid) {
      writeFileAtomic(lockPath(), body, { mode: 0o600 });
      return lock;
    }
    if (existing) {
      const alive = pidAlive(existing.pid);
      if (alive && !lockPredatesBoot(existing.acquiredAt)) {
        throw new LiveLockError(existing.pid);
      }
      if (attempt === 0) {
        const reason = alive
          ? `pid ${existing.pid} reused across reboot`
          : `dead pid ${existing.pid}`;
        console.log(
          `[Daemon] stale lock recovered (${reason}, acquiredAt ${existing.acquiredAt})`,
        );
      }
    }
    // A second miss means the lock changed hands under us twice: another
    // server is booting on this home right now. Losing is the safe outcome,
    // and `server.ts` exits cleanly only on a LiveLockError.
    if (attempt >= 1) throw new LiveLockError(existing?.pid ?? null);
    // Remove it only if it is still the lock we judged (`takeOverStaleLock`).
    if (raw !== null) takeOverStaleLock(raw);
  }
}

/**
 * Write the state file. Caller passes `port` (from the actual Bun.serve
 * listener) and we generate the bearer token here so it never leaks
 * into a wider scope than necessary.
 */
export function writeState(port: number): DaemonState {
  ensureHomeDir();
  const state: DaemonState = {
    pid: process.pid,
    port,
    token: randomBytes(32).toString("hex"),
    startedAt: new Date().toISOString(),
  };
  writeFileAtomic(statePath(), JSON.stringify(state), { mode: 0o600 });
  return state;
}

/**
 * Read the state file. Returns null if missing or unparseable.
 */
export function readState(): DaemonState | null {
  try {
    const raw = readFileSync(statePath(), "utf-8");
    const obj = JSON.parse(raw);
    if (
      typeof obj?.pid === "number" &&
      typeof obj?.port === "number" &&
      typeof obj?.token === "string" &&
      obj.token.length === 64 &&
      typeof obj?.startedAt === "string"
    ) {
      return obj;
    }
  } catch {}
  return null;
}

/**
 * Best-effort cleanup. Called from the SIGINT/SIGTERM handler.
 * Idempotent: silently no-ops if files are already gone.
 */
export function releaseLock(): void {
  try { unlinkSync(lockPath()); } catch {}
  try { unlinkSync(statePath()); } catch {}
}

/**
 * Convenience for downstream code (e.g. /__daemon/healthz handler).
 */
export function uptimeMsSince(startedAt: string): number {
  return Math.max(0, Date.now() - Date.parse(startedAt));
}

// ─── Binding the port when somebody else may hold it ────────────────────────
//
// The daemon must come UP even when the preferred port (default 3333) is held
// by an UNRELATED process: an account-switcher dashboard on one of these
// machines binds 127.0.0.1:3333 and answers `200 text/html` to every path.
//
// ORDER MATTERS, and the first version had it backwards. Probing BEFORE the
// bind means deciding on the answer of a stranger who may not even be there:
// on a TLS build the plain-HTTP probe times out against our own listener and
// the daemon walks away from 3333 for no reason, dragging MCP children, hooks
// and the phone with it. So: BIND FIRST. Only an `EADDRINUSE` is evidence that
// the port is contested, and only then is it worth asking who is there.
//
// And the answer decides three different things, not two:
//   * a confirmed STRANGER answers      → ephemeral port, the state file
//                                          carries the real one;
//   * TOPICS answers                    → a second server on the same data
//                                          directory: exit, do not sneak onto
//                                          another port (that is what
//                                          `reusePort: false` is defending);
//   * nobody / cannot tell              → exit. A daemon that guesses here is
//                                          a second universe with the real
//                                          data somewhere else.
//
// We never kill the squatter: the process belongs to someone else (see the
// header of `server/lib/port-squatter.ts`).

/** The port is contested and it is NOT a stranger holding it: do not fall back. */
export class PortTakenError extends Error {
  readonly port: number;
  readonly outcome: PortVerdict;
  constructor(port: number, outcome: PortVerdict, message: string) {
    super(message);
    this.name = "PortTakenError";
    this.port = port;
    this.outcome = outcome;
  }
}

/**
 * Is this bind failure "somebody already holds the port"?
 *
 * Bun does not surface `err.code` when the listener fails to start: what it
 * throws reads `Failed to start server. Is port 3333 in use?`. Node errors carry
 * `EADDRINUSE`, so both shapes are accepted. Any OTHER failure (a bad TLS
 * certificate, for instance) must keep propagating: falling back to an
 * ephemeral port would hide a broken configuration behind a moved daemon.
 */
export function isAddressInUse(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /EADDRINUSE|address already in use|is port\s+\d+\s+in use/i.test(message);
}

export interface ListenOutcome<T> {
  /** Whatever `bind` returned (the live server). */
  readonly listener: T;
  /** True when the configured port was taken by a stranger and we moved. */
  readonly movedToEphemeral: boolean;
  /** What the probe saw, when it had to run. */
  readonly probed: PortVerdict | null;
}

/**
 * Bind `configured`, and only if the kernel says it is taken ask who is there.
 *
 * `probe` defaults to the real loopback probe of `port-squatter.ts`, which
 * tries HTTPS and then HTTP: production is TLS on some machines and plain on
 * others, and a single-scheme probe is blind on the other half of them.
 *
 * Throws `PortTakenError` when the port is contested by Topics itself or by
 * something the probe could not identify; the caller turns that into a non-zero
 * exit. Only a CONFIRMED stranger earns the ephemeral fallback.
 */
export async function listenWithSquatterFallback<T>(
  configured: number,
  bind: (port: number) => T,
  probe: (port: number) => Promise<PortVerdict> = (port) => probePort(port, realProbeDeps(process.pid)),
): Promise<ListenOutcome<T>> {
  if (!configured || configured <= 0) {
    return { listener: bind(0), movedToEphemeral: false, probed: null };
  }
  try {
    return { listener: bind(configured), movedToEphemeral: false, probed: null };
  } catch (err) {
    if (!isAddressInUse(err)) throw err;
    const outcome = await probe(configured);
    if (outcome.stato === "estraneo") {
      return { listener: bind(0), movedToEphemeral: true, probed: outcome };
    }
    throw new PortTakenError(configured, outcome, portTakenMessage(configured, outcome));
  }
}

/** The line a person reads when the daemon refuses to start. */
export function portTakenMessage(port: number, outcome: PortVerdict): string {
  switch (outcome.stato) {
    case "nostro":
      return `port ${port} is already served by another Topics daemon. ` +
        `Two servers on the same data directory corrupt each other: stop that one first.`;
    case "silenzio":
      return `port ${port} is taken but nobody answers on it. ` +
        `Refusing to start elsewhere: the machine would end up with two Topics universes.`;
    case "ignoto":
      return `port ${port} is taken and I could not tell who holds it (${outcome.perche}). ` +
        `Refusing to guess.`;
    case "estraneo":
      return `port ${port} is held by a foreign process.`;
  }
}
