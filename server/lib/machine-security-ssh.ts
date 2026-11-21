/**
 * Security probes for servers that do not run Topics, measured over
 * non-interactive SSH. The probes and parsers are the ones of
 * `machine-security.ts`; only the environment differs: every command, file
 * read and listing goes through `ssh -o BatchMode=yes` and nothing is
 * installed or written on the server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckKey, MachineSecurityReport } from "../../shared/machine-health";
import { PROBE_TIMEOUT_MS, probeMachineSecurity, whyNoAnswer, type ProbeEnv, type Runner, type RunResult } from "./machine-security";

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

/** The local `ssh` command line for one remote command. */
export function sshArgv(server: SshServer, remote: string[], timeoutMs = PROBE_TIMEOUT_MS): string[] {
  const argv = ["ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`];
  if (server.port) argv.push("-p", String(server.port));
  argv.push("--", server.user ? `${server.user}@${server.host}` : server.host, remote.map(shellQuote).join(" "));
  return argv;
}

/** A probe environment whose every access to the machine is an ssh command. */
export function createSshProbeEnv(server: SshServer, local: Runner, now: () => number = Date.now): ProbeEnv {
  const run: Runner = (argv, timeoutMs = PROBE_TIMEOUT_MS) => local(sshArgv(server, argv, timeoutMs), timeoutMs);
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

function unreachable(why: string, now: number): MachineSecurityReport {
  return {
    checked_at: Math.floor(now / 1000),
    status: "unknown",
    checks: KEYS.map((key) => ({ key, status: "unknown", detail: why })),
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
 */
export async function probeSshServer(
  server: SshServer,
  local: Runner,
  last: MachineSecurityReport | null = null,
  now: () => number = Date.now,
): Promise<MachineSecurityReport> {
  const env = createSshProbeEnv(server, local, now);
  const reach = await env.run(["true"]);
  if (reach.code !== 0) {
    if (last && last.checked_at !== null) return last;
    return unreachable(whyUnreachable(reach), now());
  }
  return probeMachineSecurity(env);
}
