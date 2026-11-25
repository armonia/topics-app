/**
 * Security probes for servers that do not run Topics, measured over
 * non-interactive SSH. The probes and parsers are the ones of
 * `machine-security.ts`; only the environment differs: every command, file
 * read and listing goes through `ssh -o BatchMode=yes` and nothing is
 * installed or written on the server.
 */
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckKey, MachineSecurityReport } from "../../shared/machine-health";
import { probeMachineSecurity, whyNoAnswer, type ProbeEnv, type Runner, type RunResult } from "./machine-security";

/**
 * Deadline of one ssh probe command. Bigger than the local `PROBE_TIMEOUT_MS`
 * because it also has to cover the handshake (measured 2.9-3.6 s from this
 * Mac under normal load), which the local probes never pay.
 */
export const SSH_PROBE_TIMEOUT_MS = 12_000;
/** How long the shared connection survives after the last command, so a round's later reads skip the handshake. */
export const SSH_CONTROL_PERSIST_S = 60;

export interface SshServer {
  host: string;
  /** Empty means the default of the ssh client. */
  user: string;
  /** 0 means the default of the ssh client. */
  port: number;
}

const KEYS: CheckKey[] = ["updates", "disk", "access", "antivirus"];
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;

/**
 * Reads the servers list from a settings value. Anything that could be taken
 * for an ssh option (leading dash) or smuggle a second argument is dropped.
 */
export function parseSshServers(raw: unknown): SshServer[] {
  if (!Array.isArray(raw)) return [];
  const out: SshServer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { host, user, port } = item as Record<string, unknown>;
    if (typeof host !== "string" || !SAFE_TOKEN.test(host) || host.startsWith("-")) continue;
    const u = typeof user === "string" ? user : "";
    if (u && (!SAFE_TOKEN.test(u) || u.startsWith("-"))) continue;
    const p = typeof port === "number" ? port : 0;
    if (!Number.isInteger(p) || p < 0 || p > 65_535) continue;
    out.push({ host, user: u, port: p });
  }
  return out;
}

/** File of the servers list, in the app data folder; absent means no servers. */
export const SSH_SERVERS_FILE = "ssh-servers.json";

export function readSshServers(appDataDir: string): SshServer[] {
  try { return parseSshServers(JSON.parse(readFileSync(join(appDataDir, SSH_SERVERS_FILE), "utf8"))); } catch { return []; }
}

/** Stable id of a server in the health round, derived from its address only. */
export function sshServerId(server: SshServer): string {
  return `ssh:${server.user ? `${server.user}@` : ""}${server.host}${server.port ? `:${server.port}` : ""}`;
}

/** POSIX single-quote escaping, so a path or argument reaches the server as one word. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The widest unix domain socket path all our platforms accept (macOS's
 * `sizeof(sockaddr_un.sun_path)` is the tightest, 104 bytes including the
 * trailing NUL). `ssh` substitutes `%C` with a 40 char hash of the
 * connection params, plus a temporary suffix of up to 17 bytes while it
 * binds the socket, so the directory itself has that much less room.
 */
const MAX_SOCKET_PATH_BYTES = 103;
const CONTROL_HASH_CHARS = 40;
const CONTROL_BIND_SUFFIX_BYTES = 17;

export function fitsControlSocket(dir: string): boolean {
  return Buffer.byteLength(join(dir, "x".repeat(CONTROL_HASH_CHARS))) + CONTROL_BIND_SUFFIX_BYTES <= MAX_SOCKET_PATH_BYTES;
}

/**
 * Fixed, short fallback root: `os.tmpdir()` is long on macOS
 * (`/var/folders/<..>/T`, measured 48 bytes) and that alone can push the
 * socket over the limit again, defeating the fallback it is meant to be.
 * `/tmp` is short on every platform we run on. One directory per OS user
 * (not per app-data path), so it stays stable across settings.
 */
function fixedFallbackDir(): string | null {
  if (typeof process.getuid !== "function") return null; // no POSIX uid (e.g. Windows): skip multiplexing instead of guessing
  return join("/tmp", `topics-ssh-${process.getuid()}`);
}

/**
 * Where the control sockets of `ControlPath` live. Inside the app data
 * folder when that leaves room for `ssh`'s own hash and bind suffix;
 * otherwise the fixed, short fallback. `null` means neither fits (or the
 * platform cannot be trusted to): the caller probes without multiplexing,
 * one connection per command, same as before this feature existed.
 */
export function sshControlDir(appDataDir: string): string | null {
  const inData = join(appDataDir, "ssh-control");
  if (fitsControlSocket(inData)) return inData;
  const fallback = fixedFallbackDir();
  return fallback && fitsControlSocket(fallback) ? fallback : null;
}

/**
 * `/tmp` is shared by every user on the machine: before trusting a
 * directory there for the control socket, make sure it is ours, private
 * (0700) and not a symlink someone else planted, so a hostile user on the
 * same box cannot hand us a socket path they control.
 */
export function ensureSafeControlDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory()) return false; // not a plain directory (e.g. a symlink): lstat does not follow it
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    return (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

/** The local `ssh` command line for one remote command. `controlDir` set reuses one connection per server across the round. */
export function sshArgv(server: SshServer, remote: string[], opts: { timeoutMs?: number; controlDir?: string | null } = {}): string[] {
  const { timeoutMs = SSH_PROBE_TIMEOUT_MS, controlDir } = opts;
  const argv = ["ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`];
  if (controlDir) argv.push("-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir, "%C")}`, "-o", `ControlPersist=${SSH_CONTROL_PERSIST_S}s`);
  if (server.port) argv.push("-p", String(server.port));
  argv.push("--", server.user ? `${server.user}@${server.host}` : server.host, remote.map(shellQuote).join(" "));
  return argv;
}

/** The command that closes an already shared connection, so a round that is done does not wait out `ControlPersist`. */
export function sshCloseControlArgv(server: SshServer, controlDir: string): string[] {
  const argv = ["ssh", "-o", `ControlPath=${join(controlDir, "%C")}`, "-O", "exit"];
  if (server.port) argv.push("-p", String(server.port));
  argv.push(server.user ? `${server.user}@${server.host}` : server.host);
  return argv;
}

/** A probe environment whose every access to the machine is an ssh command, sharing one connection per server. */
export function createSshProbeEnv(server: SshServer, local: Runner, now: () => number = Date.now, controlDir?: string | null): ProbeEnv {
  const run: Runner = (argv, timeoutMs = SSH_PROBE_TIMEOUT_MS) => local(sshArgv(server, argv, { timeoutMs, controlDir }), timeoutMs);
  return {
    platform: "linux",
    run,
    readFile: async (path) => {
      const r = await run(["cat", path]);
      return r.code === 0 ? r.stdout : null;
    },
    listDir: async (path) => {
      const r = await run(["ls", "-1", path]);
      return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : null;
    },
    mtimeMs: async (path) => {
      const r = await run(["stat", "-c", "%Y", path]);
      const s = Number(r.stdout.trim());
      return r.code === 0 && Number.isFinite(s) ? s * 1000 : null;
    },
    // Nothing of Topics lives on the server: a folder that cannot exist.
    appDataDir: "/nonexistent",
    now,
  };
}

/** The reason codes of `whyUnreachable`, worded by the client (`security.why.*`). */
const UNREACHABLE_CODE: Record<string, string> = {
  "chiave non accettata": "keyRejected",
  "chiave del server non riconosciuta": "hostKey",
  "server non raggiungibile": "unreachable",
  "comando non disponibile": "missing",
  "nessuna risposta in tempo": "timeout",
  "permessi insufficienti": "denied",
};

function unreachable(why: string, now: number): MachineSecurityReport {
  return {
    checked_at: Math.floor(now / 1000),
    status: "unknown",
    checks: KEYS.map((key) => ({ key, status: "unknown", detail: why, msgs: [{ code: "unknown", params: { why: UNREACHABLE_CODE[why] ?? "failed" } }] })),
  };
}

/** Why ssh could not talk to the server, in a sentence. */
export function whyUnreachable(r: RunResult): string {
  if (/permission denied/i.test(r.stderr)) return "chiave non accettata";
  if (/host key verification failed/i.test(r.stderr)) return "chiave del server non riconosciuta";
  return whyNoAnswer(r) === "lettura non riuscita" ? "server non raggiungibile" : whyNoAnswer(r);
}

/**
 * The control directory a round should use for the app data folder, or
 * `null` for no multiplexing: picks the path and makes sure it exists and
 * is ours. The caller resolves it once, outside the round, so the round
 * itself (and every test of it) never creates a directory of its own.
 */
export function resolveSshControlDir(appDataDir: string): string | null {
  const dir = sshControlDir(appDataDir);
  return dir && ensureSafeControlDir(dir) ? dir : null;
}

/**
 * One round on one server. A server that does not answer keeps its last
 * report (with the time it was taken) instead of replacing it with unknowns.
 * `controlDir` is required (not optional) so a caller that forgets to wire
 * it fails `typecheck` instead of silently losing the connection reuse;
 * `null` means no multiplexing. With a directory, every read of the round
 * shares one ssh connection (the handshake only happens once), closed again
 * before returning; with `null` the round opens one connection per command,
 * same as before this feature existed.
 */
export async function probeSshServer(
  server: SshServer,
  local: Runner,
  controlDir: string | null,
  last: MachineSecurityReport | null = null,
  now: () => number = Date.now,
): Promise<MachineSecurityReport> {
  try {
    const env = createSshProbeEnv(server, local, now, controlDir);
    const reach = await env.run(["true"]);
    if (reach.code !== 0) {
      if (last && last.checked_at !== null) return last;
      return unreachable(whyUnreachable(reach), now());
    }
    return await probeMachineSecurity(env);
  } finally {
    if (controlDir) await local(sshCloseControlArgv(server, controlDir), 3_000).catch(() => undefined);
  }
}
