/**
 * Security probes for servers that do not run Topics, measured over
 * non-interactive SSH. The probes and parsers are the ones of
 * `machine-security.ts`; only the environment differs: every command, file
 * read and listing goes through `ssh -o BatchMode=yes` and nothing is
 * installed or written on the server.
 */
import { mkdirSync, readFileSync } from "node:fs";
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

/** Where the control sockets of `ControlPath` live: inside the app data folder, never on the server. */
export function sshControlDir(appDataDir: string): string {
  return join(appDataDir, "ssh-control");
}

/** The local `ssh` command line for one remote command. `controlDir` set reuses one connection per server across the round. */
export function sshArgv(server: SshServer, remote: string[], opts: { timeoutMs?: number; controlDir?: string } = {}): string[] {
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
export function createSshProbeEnv(server: SshServer, local: Runner, now: () => number = Date.now, controlDir?: string): ProbeEnv {
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
 * One round on one server. A server that does not answer keeps its last
 * report (with the time it was taken) instead of replacing it with unknowns.
 * With `appDataDir` every read of the round shares one ssh connection (the
 * handshake only happens once), closed again before returning.
 */
export async function probeSshServer(
  server: SshServer,
  local: Runner,
  last: MachineSecurityReport | null = null,
  now: () => number = Date.now,
  appDataDir?: string,
): Promise<MachineSecurityReport> {
  const controlDir = appDataDir ? sshControlDir(appDataDir) : undefined;
  if (controlDir) { try { mkdirSync(controlDir, { recursive: true }); } catch { /* best effort: no reuse this round */ } }
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
