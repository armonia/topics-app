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
import {
  mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
  chmodSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";

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
  constructor(public readonly livePid: number) {
    super(`Another Topics server is already running (pid ${livePid}).`);
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

/**
 * Write `data` to `path` atomically: write to `<path>.<pid>.<ts>.tmp`
 * then rename. Caller is responsible for removing the file at exit.
 *
 * @param mode permission bits applied AFTER rename so a sneaky reader
 *             can't observe the file at world-readable mode briefly.
 */
function atomicWrite(path: string, data: string, mode = 0o644): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Try to read the lock file. Returns null if missing or unparseable.
 */
function readLock(): LockFile | null {
  try {
    const raw = readFileSync(lockPath(), "utf-8");
    const obj = JSON.parse(raw);
    if (typeof obj?.pid === "number" && typeof obj?.acquiredAt === "string") {
      return obj;
    }
  } catch { /* missing or corrupt — treat as no lock */ }
  return null;
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
  const existing = readLock();
  if (existing && existing.pid !== process.pid) {
    const alive = pidAlive(existing.pid);
    if (alive && !lockPredatesBoot(existing.acquiredAt)) {
      throw new LiveLockError(existing.pid);
    }
    const reason = alive
      ? `pid ${existing.pid} reused across reboot`
      : `dead pid ${existing.pid}`;
    console.log(
      `[Daemon] stale lock recovered (${reason}, acquiredAt ${existing.acquiredAt})`,
    );
  }
  const lock: LockFile = { pid: process.pid, acquiredAt: new Date().toISOString() };
  atomicWrite(lockPath(), JSON.stringify(lock), 0o600);
  return lock;
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
  atomicWrite(statePath(), JSON.stringify(state), 0o600);
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

// ─── Port identity + fallback (squatter recovery) ────────────────────────────
//
// The daemon is the single owner of the machine's Topics data. It must come UP
// even when the preferred port (default 3333) is already held by an UNRELATED
// process — the "Van Damme-o-Matic" / account-switcher dashboard on this box
// binds 127.0.0.1:3333 and returns `200 text/html` for *every* path, including
// `/__daemon/healthz` and `/api/system/presence`. `Bun.serve` then throws
// `Failed to start server. Is port 3333 in use?` and the daemon process dies
// with the lock recovered but no listener — the desktop app sees a dead daemon
// and a live squatter, and the user gets "connection error".
//
// The fix has two cooperating halves:
//   * `chooseListenPort` — before binding, ask the port "who are you?" by the
//     SHAPE of the `/api/system/presence` body (two numeric fields no other
//     server would emit). A Topics server → keep the port. A squatter, or
//     nobody → bind an ephemeral port so the daemon always comes up and the
//     state file carries the REAL port for the desktop to find.
//   * `pickEphemeralPort` — a free, non-privileged port to fall back to.
//
// We deliberately do NOT kill the squatter: it belongs to someone else, and
// shutting down an unrelated process on suspicion is exactly what this module
// is not allowed to do (see `port-squatter.ts` header).

/** The route whose RESPONSE SHAPE is Topics' identity, for a loopback probe.
 *  Unauthenticated on loopback (no Origin header → origin gate passes), cheap
 *  (three indexed COUNTs), and its body has a shape no other local server would
 *  emit by chance. Same choice as `port-squatter.ts`. */
export const PROBE_ROUTE = "/api/system/presence";

/**
 * Is this `/api/system/presence` body OUR shape?
 *
 * Mirrors `port-squatter.rispostaNostra`: require the two numeric fields
 * `openSessions` and `workingSessions`. One common-named integer could appear
 * by accident in another server's response; two with these names could not.
 * Anything else — HTML, `{"status":"ok"}`, wrong types — is not Topics.
 */
export function isTopicsPresenceBody(body: string): boolean {
  try {
    const v = JSON.parse(body) as Record<string, unknown> | null;
    return (
      typeof v === "object" && v !== null &&
      typeof v.openSessions === "number" &&
      typeof v.workingSessions === "number"
    );
  } catch {
    return false;
  }
}

export interface PortProbeResult {
  /** Topics answered: this port is ours, safe to bind. */
  readonly ourServer: boolean;
  /** Somebody answered, but not with the Topics shape: a squatter. */
  readonly squatted: boolean;
  /** Nobody answered (connection refused / timeout): safe to bind. */
  readonly nobody: boolean;
}

/**
 * Ask `http://127.0.0.1:<port>/api/system/presence` whether the Topics daemon
 * is already listening there. Injectable `fetchFn` keeps this pure for tests
 * (the real one is a timed, plain-HTTP loopback fetch).
 */
export async function probeTopicsOnPort(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<PortProbeResult> {
  const url = `http://127.0.0.1:${port}${PROBE_ROUTE}`;
  let res: Response | null = null;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(1500) } as RequestInit);
  } catch {
    return { ourServer: false, squatted: false, nobody: true };
  }
  if (res === null) return { ourServer: false, squatted: false, nobody: true };
  let body = "";
  try { body = await res.text(); } catch { body = ""; }
  if (isTopicsPresenceBody(body)) {
    return { ourServer: true, squatted: false, nobody: false };
  }
  // Someone answered (any status) but not with our shape: a squatter.
  return { ourServer: false, squatted: true, nobody: false };
}

/**
 * Decide the port the daemon should bind.
 *
 *   * `configured === 0` → return 0 immediately (already ephemeral).
 *   * Otherwise ask `configured` "who are you?":
 *       - Topics   → keep it (idempotent restart / our own rebind).
 *       - squatter → 0 (bind ephemeral; state file records the real port).
 *       - nobody   → keep it (nothing to lose by binding the preferred port).
 *
 * The binding step in `server.ts` is the real guard: if we try to bind a port
 * that was taken between probe and bind, `Bun.serve` throws and the caller
 * retries on port 0 (fully kernel-assigned) — so a TOCTOU race cannot leave
 * the daemon dead.
 */
export async function chooseListenPort(
  configured: number,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  if (!configured || configured <= 0) return 0;
  const r = await probeTopicsOnPort(configured, fetchFn);
  if (r.ourServer) return configured;          // idempotent: already ours
  if (r.squatted) return 0;                     // squatter → ephemeral
  return configured;                            // nobody → prefer configured
}

/**
 * A free, non-privileged ephemeral port. Bind to 127.0.0.1:0, read the
 * kernel-assigned port, close, and hand it back. A small TOCTOU window exists
 * between close and the real bind, but the real bind is what matters — if that
 * port was stolen in the meantime, `Bun.serve` throws and the caller falls
 * back to port 0 (fully kernel-assigned) for real.
 */
export function pickEphemeralPort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

/**
 * True if something is listening on 127.0.0.1:<port> (i.e. the port is held).
 * Used to confirm a squatter before falling back, and to assert in tests that
 * a freshly-picked ephemeral port is actually free.
 */
export function portIsHeld(port: number, timeoutMs = 1500): Promise<boolean> {
  if (!port || port <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    const s = netConnect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      try { s.destroy(); } catch {}
      finish(true); // no answer in time → treat as held (conservative)
    }, timeoutMs);
    s.once("connect", () => { clearTimeout(timer); try { s.destroy(); } catch {} finish(true); });
    s.once("error", () => { clearTimeout(timer); finish(false); });
  });
}
