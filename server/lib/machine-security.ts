/**
 * The security probes of ONE machine: updates, disk, access, antivirus.
 *
 * All READ-ONLY: no probe changes a setting. The probes run on the machine they
 * describe (the same Topics code runs on the Mac, the fixed server and the PC)
 * and the Mac collects the result; the commands depend on the operating system,
 * but the parsers are pure functions on text, tested on recorded output
 * (`machine-security.test.ts`).
 *
 * One rule for failures: a command that is missing, lacks permission or does
 * not answer in time gives `unknown` with the sentence saying why, never an
 * error that breaks the round.
 */
import type { AccessFacts, CheckKey, CheckStatus, MachineSecurityReport, SecurityCheck, SecurityStatus } from "../../shared/machine-health";

/** Deadline of a probe. */
export const PROBE_TIMEOUT_MS = 5_000;
/** The macOS unified log cannot be read in 5 s (measured 6-18 s): this one command gets more room. */
const MAC_LOG_TIMEOUT_MS = 20_000;
/** A security update pending for longer than this = warning. */
export const PENDING_WARN_DAYS = 7;
/** A Linux reboot-required flag older than this = warning (the patch is installed but not active). */
const REBOOT_WARN_MS = 24 * 3_600_000;
/** Maximum length of a check sentence (file contract). */
export const DETAIL_MAX = 60;
const DAY_MS = 86_400_000;
/** Failed logins in 24 h above which even a key-only server deserves a warning. */
const FAILED_LOGINS_WARN = 1000;
/** Antivirus signatures older than this = warning. */
const SIGNATURE_WARN_DAYS = 3;
/** On Windows the pending updates cannot be listed in 5 s: a KB older than this is a warning. */
const WINDOWS_KB_WARN_DAYS = 45;
/** XProtect updates every few days: older than this means it is stuck. */
const XPROTECT_WARN_DAYS = 30;
/** Ports that must not be reachable from outside: databases, telnet, remote desktop. */
const RISKY_PORTS = new Set([21, 23, 3389, 5900, 3306, 5432, 6379, 11211, 27017, 9200]);

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The command does not exist on this machine. */
  missing: boolean;
}

export type Runner = (argv: string[], timeoutMs?: number) => Promise<RunResult>;

export interface ProbeEnv {
  platform: NodeJS.Platform;
  run: Runner;
  /** Text of a file, `null` if missing or unreadable. */
  readFile: (path: string) => Promise<string | null>;
  /** File names of a folder, `null` if missing or unreadable. */
  listDir: (path: string) => Promise<string[] | null>;
  /** Last modification of a file in ms, `null` if missing. */
  mtimeMs: (path: string) => Promise<number | null>;
  /** Topics' app data folder (where `harness-sync.json` lives). */
  appDataDir: string;
  now: () => number;
}

const SEVERITY: Record<CheckStatus, number> = { ok: 0, info: 0, unknown: -1, warn: 1, problem: 2 };

/** Cuts a sentence to the contract maximum, with an ellipsis. */
export function clip(text: string, max = DETAIL_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The worst of the checks, with `info` not counting. An `unknown` does not stain
 * the verdict of the others (a log this user cannot read would stay a shadow on
 * a healthy machine for ever): the verdict is `unknown` only when no check could
 * say anything.
 */
export function worstStatus(checks: ReadonlyArray<Pick<SecurityCheck, "status">>): SecurityStatus {
  let worst = -1;
  let known = false;
  for (const c of checks) {
    if (c.status === "info") continue;
    if (c.status !== "unknown") known = true;
    worst = Math.max(worst, SEVERITY[c.status]);
  }
  if (!known) return "unknown";
  return worst >= 2 ? "problem" : worst === 1 ? "warn" : "ok";
}

/** Why a command gave no answer, in a sentence. */
export function whyNoAnswer(r: RunResult): string {
  if (r.missing) return "comando non disponibile";
  if (r.timedOut) return "nessuna risposta in tempo";
  if (/permission denied|not permitted|operation not permitted|must be root|need to be root|access is denied|accesso negato/i.test(r.stderr)) return "permessi insufficienti";
  return "lettura non riuscita";
}

function ok(r: RunResult): boolean {
  return !r.missing && !r.timedOut && r.code === 0;
}

function unknown(key: CheckKey, what: string, why: string): SecurityCheck {
  return { key, status: "unknown", detail: clip(`${what}: ${why}`) };
}

/** `dd/mm` for a date in ms (server time zone): the sentence carries no year, the context gives it. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function daysBetween(now: number, then: number): number {
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

// ───────────────────────────── pure parsers ─────────────────────────────

/** `plutil -p` of InstallHistory.plist: the entries with name, version and date. */
export function parseMacInstallHistory(text: string): Array<{ name: string; version: string; at: number }> {
  const out: Array<{ name: string; version: string; at: number }> = [];
  const blocks = text.split(/^\s{2}\d+ => \{$/m).slice(1);
  for (const block of blocks) {
    const name = /"displayName" => "(.*)"/.exec(block)?.[1];
    const version = /"displayVersion" => "(.*)"/.exec(block)?.[1] ?? "";
    const date = /"date" => (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \+0000/.exec(block)?.[1];
    if (!name || !date) continue;
    const at = Date.parse(`${date.replace(" ", "T")}Z`);
    if (Number.isFinite(at)) out.push({ name, version, at });
  }
  return out;
}

// A system update ("macOS Tahoe 26.2"), a security fix or XProtect; not service packages ("Setup macOS Recovery...").
const MAC_SECURITY_NAME = /^(?!.*(setup|recovery|dependencies))(macOS\b|.*(security|sicurezza)|xprotect|mrt\b|safari|.*rapid)/i;

/** The last security update on record (system, XProtect, rapid fixes). */
export function lastMacSecurityUpdate(history: ReturnType<typeof parseMacInstallHistory>): { name: string; at: number } | null {
  let best: { name: string; at: number } | null = null;
  for (const h of history) if (MAC_SECURITY_NAME.test(h.name) && (!best || h.at > best.at)) best = { name: h.name, at: h.at };
  return best;
}

/** The last XProtect installed: version and date. */
export function lastXProtect(history: ReturnType<typeof parseMacInstallHistory>): { version: string; at: number } | null {
  let best: { version: string; at: number } | null = null;
  for (const h of history) if (/^XProtect/i.test(h.name) && (!best || h.at > best.at)) best = { version: h.version, at: h.at };
  return best;
}

/**
 * `plutil -p` of com.apple.SoftwareUpdate.plist: the recommended system updates
 * (only the `_minor` ones, i.e. the fixes; a `_major` is a version jump, not a
 * fix) with the date Apple first offered them.
 */
export function parseMacPendingUpdates(text: string): Array<{ id: string; offeredAt: number | null }> {
  const offered = new Map<string, number>();
  const offerSection = /"FirstOfferDateDictionary" => \{([\s\S]*?)\n\s{2}\}/.exec(text)?.[1] ?? "";
  for (const m of offerSection.matchAll(/"([^"]+)" => (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \+0000/g)) {
    offered.set(m[1], Date.parse(`${m[2].replace(" ", "T")}Z`));
  }
  const recommended = /"RecommendedUpdates" => \[([\s\S]*?)\n\s{2}\]/.exec(text)?.[1] ?? "";
  const out: Array<{ id: string; offeredAt: number | null }> = [];
  for (const m of recommended.matchAll(/"Identifier" => "([^"]+)"/g)) {
    if (!/^MSU_UPDATE_.*_minor$/.test(m[1])) continue;
    out.push({ id: m[1], offeredAt: offered.get(m[1]) ?? null });
  }
  return out;
}

/** `fdesetup status`. */
export function parseFileVault(text: string): "on" | "off" | "working" | null {
  if (/FileVault is On/i.test(text)) return "on";
  if (/FileVault is Off/i.test(text)) return "off";
  if (/in progress|Encryption in progress|Decryption in progress/i.test(text)) return "working";
  return null;
}

/** `socketfilterfw --getglobalstate`. */
export function parseMacFirewall(text: string): boolean | null {
  if (/enabled|State = [12]/i.test(text)) return true;
  if (/disabled|State = 0/i.test(text)) return false;
  return null;
}

/** `sshd -T`: `passwordauthentication yes|no`. */
export function parseSshdT(text: string): boolean | null {
  const m = /^passwordauthentication\s+(yes|no)\b/im.exec(text);
  return m ? m[1].toLowerCase() === "yes" : null;
}

/**
 * The sshd configuration file, for when `sshd -T` cannot run (it needs root):
 * the first value wins, a `Match` block does not count, and a missing line
 * means OpenSSH's default, which accepts the password.
 */
export function parseSshdConfig(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^match\b/i.test(line)) break;
    const m = /^passwordauthentication\s+(yes|no)\b/i.exec(line);
    if (m) return m[1].toLowerCase() === "yes";
  }
  return true;
}

/** `ss -ltnH`: the listening ports that are not loopback-only. */
export function parseSsListening(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN" || cols.length < 4) continue;
    const local = cols[3];
    const m = /^(.*):(\d+)$/.exec(local);
    if (!m) continue;
    if (/^(127\.|\[?::1\]?$)/.test(m[1])) continue;
    ports.add(Number(m[2]));
  }
  return [...ports].sort((a, b) => a - b);
}

/** macOS `netstat -an -p tcp`: listening ports that are not loopback-only (`*.7000`, `127.0.0.1.3535`, `::1.5421`). */
export function parseNetstatListening(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const local = line.trim().split(/\s+/)[3];
    const m = local && /^(.*)\.(\d+)$/.exec(local);
    if (!m) continue;
    if (/^(127\.|::1$)/.test(m[1])) continue;
    ports.add(Number(m[2]));
  }
  return [...ports].sort((a, b) => a - b);
}

/** The `key=value` lines the PowerShell scripts print (the rest, PowerShell noise, is ignored). */
export function parseKeyValueLines(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

/** Last line of `security-autopatch.log` that updated something: `2026-11-17T06:05:45+00:00 aggiornati: ...` (the log is written in Italian by the host script). */
export function parseAutopatchLog(text: string): number | null {
  let last: number | null = null;
  for (const line of text.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s+aggiornati:/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  return last;
}

/** `/var/log/apt/history.log`: the last `End-Date` (apt logs in the machine's local time; on servers that is UTC). */
export function parseAptHistory(text: string): number | null {
  let last: number | null = null;
  for (const m of text.matchAll(/^End-Date:\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/gm)) {
    const at = Date.parse(`${m[1]}T${m[2]}Z`);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  return last;
}

/** `apt list --upgradable`: how many pending packages come from the security channel. */
export function parseAptSecurityPending(text: string): number {
  return text.split("\n").filter((l) => /\[upgradable from:/.test(l) && /-security\b/.test(l)).length;
}

/**
 * Failed SSH logins in `journalctl -u ssh` or `auth.log`. One attempt is one
 * sshd process: "Invalid user" and "Failed password" of the same process count
 * once (lines without a pid count one each).
 */
export function countFailedLogins(text: string, sinceMs?: number): number {
  const pids = new Set<string>();
  let loose = 0;
  for (const line of text.split("\n")) {
    if (!/Failed password|Invalid user|authentication failure|Failed publickey/.test(line)) continue;
    if (sinceMs !== undefined) {
      // Modern Ubuntu's auth.log starts each line with an ISO time; without one the line counts.
      const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2})/.exec(line);
      if (m && Date.parse(m[1]) < sinceMs) continue;
    }
    const pid = /sshd(?:-session)?\[(\d+)\]/.exec(line)?.[1];
    if (pid) pids.add(pid); else loose++;
  }
  return pids.size + loose;
}

/** `/proc/mounts`: the mount points encrypted with gocryptfs. */
export function parseGocryptfsMounts(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const cols = line.split(" ");
    if (cols.length >= 3 && /gocryptfs/.test(cols[2])) out.push(cols[1]);
  }
  return out;
}

/**
 * Whether `harness-sync.json` declares a private folder: the first `private` key
 * found, at any depth (another component writes the file and we do not fix its
 * shape). Returns the path if it is a string, `true` if present but not saying
 * where, `null` if absent.
 */
export function findDeclaredPrivate(json: unknown): string | true | null {
  if (json === null || typeof json !== "object") return null;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (k === "private") {
      if (typeof v === "string" && v) return v;
      if (v && typeof v === "object") {
        const p = (v as Record<string, unknown>).path ?? (v as Record<string, unknown>).mountpoint ?? (v as Record<string, unknown>).dir;
        return typeof p === "string" && p ? p : true;
      }
      return v ? true : null;
    }
    const inner = findDeclaredPrivate(v);
    if (inner) return inner;
  }
  return null;
}

// ───────────────────────────── probes: macOS ─────────────────────────────

const MAC_HISTORY = ["plutil", "-p", "/Library/Receipts/InstallHistory.plist"];
const MAC_SOFTWAREUPDATE = ["plutil", "-p", "/Library/Preferences/com.apple.SoftwareUpdate.plist"];

async function macUpdates(env: ProbeEnv): Promise<SecurityCheck> {
  const [hist, pend] = await Promise.all([env.run(MAC_HISTORY), env.run(MAC_SOFTWAREUPDATE)]);
  if (!ok(hist) && !ok(pend)) return unknown("updates", "Aggiornamenti", whyNoAnswer(hist));
  const now = env.now();
  const last = ok(hist) ? lastMacSecurityUpdate(parseMacInstallHistory(hist.stdout)) : null;
  const waiting = ok(pend) ? parseMacPendingUpdates(pend.stdout) : [];
  const oldest = waiting.reduce<number | null>((acc, w) => (w.offeredAt !== null && (acc === null || w.offeredAt < acc) ? w.offeredAt : acc), null);
  if (oldest !== null && now - oldest > PENDING_WARN_DAYS * DAY_MS) {
    return { key: "updates", status: "warn", detail: clip(`${plural(waiting.length, "aggiornamento", "aggiornamenti")} in attesa da ${daysBetween(now, oldest)} giorni`) };
  }
  if (waiting.length > 0) return { key: "updates", status: "ok", detail: clip(`${plural(waiting.length, "aggiornamento", "aggiornamenti")} in arrivo, offerti da poco`) };
  if (last) return { key: "updates", status: "ok", detail: clip(`Ultimo aggiornamento di sicurezza il ${shortDate(last.at)}`) };
  return { key: "updates", status: "ok", detail: "Nessun aggiornamento in attesa" };
}

async function macDisk(env: ProbeEnv): Promise<SecurityCheck> {
  const r = await env.run(["fdesetup", "status"]);
  if (!ok(r)) return unknown("disk", "Cifratura del disco", whyNoAnswer(r));
  const state = parseFileVault(r.stdout);
  if (state === "on") return { key: "disk", status: "ok", detail: "Disco cifrato (FileVault acceso)" };
  if (state === "working") return { key: "disk", status: "warn", detail: "Cifratura del disco in corso" };
  if (state === "off") return { key: "disk", status: "warn", detail: "Disco non cifrato (FileVault spento)" };
  return unknown("disk", "Cifratura del disco", "risposta non riconosciuta");
}

async function macSshState(env: ProbeEnv, ports: number[] | null): Promise<{ listening: boolean | null; password: boolean | null }> {
  if (ports === null) return { listening: null, password: null };
  const listening = ports.includes(22);
  if (!listening) return { listening, password: null };
  return { listening, password: await passwordFromConfigFiles(env) };
}

async function macAccess(env: ProbeEnv): Promise<SecurityCheck> {
  const [net, fw] = await Promise.all([
    env.run(["netstat", "-an", "-p", "tcp"]),
    env.run(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"]),
  ]);
  const ports = ok(net) ? parseNetstatListening(net.stdout) : null;
  const ssh = await macSshState(env, ports);
  return composeAccess({
    ssh: ssh.listening === null ? { kind: "unknown", why: whyNoAnswer(net) } : ssh.listening ? { kind: "on", password: ssh.password } : { kind: "off" },
    ports: ports === null ? null : ports.filter((p) => p !== 22),
    firewall: ok(fw) ? parseMacFirewall(fw.stdout) : "unknown",
    linuxServer: false,
  });
}

async function macAntivirus(env: ProbeEnv): Promise<SecurityCheck> {
  const hist = await env.run(MAC_HISTORY);
  if (!ok(hist)) return unknown("antivirus", "Protezione antivirus", whyNoAnswer(hist));
  const x = lastXProtect(parseMacInstallHistory(hist.stdout));
  if (!x) return unknown("antivirus", "Protezione antivirus", "XProtect non trovato");
  const now = env.now();
  const stale = now - x.at > XPROTECT_WARN_DAYS * DAY_MS;
  const base = `XProtect ${x.version} del ${shortDate(x.at)}`;
  // Failed logins exist only when remote access is on.
  const net = await env.run(["netstat", "-an", "-p", "tcp"]);
  const remote = ok(net) ? parseNetstatListening(net.stdout).includes(22) : null;
  let tail = "";
  if (remote === false) tail = "accesso remoto spento";
  else if (remote === true) {
    const log = await env.run(["log", "show", "--last", "24h", "--style", "compact", "--predicate", 'process == "sshd" AND (eventMessage CONTAINS "Failed" OR eventMessage CONTAINS "Invalid user")'], MAC_LOG_TIMEOUT_MS);
    tail = ok(log) ? `${countFailedLogins(log.stdout)} accessi falliti in 24 ore` : "accessi falliti non leggibili";
  }
  return { key: "antivirus", status: stale ? "warn" : "ok", detail: clip(tail ? `${base}, ${tail}` : base) };
}

// ───────────────────────────── probes: Linux ─────────────────────────────

async function passwordFromConfigFiles(env: ProbeEnv): Promise<boolean | null> {
  const main = await env.readFile("/etc/ssh/sshd_config");
  if (main === null) return null;
  // `Include` at the top: the included files stand in place of the line, in alphabetical order.
  const files = (await env.listDir("/etc/ssh/sshd_config.d")) ?? [];
  const extra: string[] = [];
  for (const f of files.filter((n) => n.endsWith(".conf")).sort()) {
    const t = await env.readFile(`/etc/ssh/sshd_config.d/${f}`);
    if (t) extra.push(t);
  }
  const merged = /^\s*Include\b/im.test(main) ? main.replace(/^\s*Include\b.*$/im, extra.join("\n")) : main;
  return parseSshdConfig(merged);
}

async function linuxUpdates(env: ProbeEnv): Promise<SecurityCheck> {
  const [auto, hist, apt, reboot] = await Promise.all([
    env.readFile("/var/log/security-autopatch.log"),
    env.readFile("/var/log/apt/history.log"),
    env.run(["apt", "list", "--upgradable"]),
    env.mtimeMs("/var/run/reboot-required"),
  ]);
  const now = env.now();
  const times = [auto ? parseAutopatchLog(auto) : null, hist ? parseAptHistory(hist) : null].filter((t): t is number => t !== null);
  const last = times.length ? Math.max(...times) : null;
  if (!ok(apt) && last === null) return unknown("updates", "Aggiornamenti", ok(apt) ? "nessun registro" : whyNoAnswer(apt));
  const pending = ok(apt) ? parseAptSecurityPending(apt.stdout) : 0;
  if (reboot !== null && now - reboot > REBOOT_WARN_MS) {
    return { key: "updates", status: "warn", detail: clip(`Riavvio in attesa da ${plural(daysBetween(now, reboot), "giorno", "giorni")} per gli aggiornamenti`) };
  }
  if (pending > 0 && (last === null || now - last > PENDING_WARN_DAYS * DAY_MS)) {
    return { key: "updates", status: "warn", detail: clip(`${plural(pending, "aggiornamento", "aggiornamenti")} di sicurezza in attesa${last ? ` da ${daysBetween(now, last)} giorni` : ""}`) };
  }
  if (last !== null) return { key: "updates", status: "ok", detail: clip(`Ultimo aggiornamento di sicurezza il ${shortDate(last)}`) };
  return { key: "updates", status: "ok", detail: "Nessun aggiornamento di sicurezza in attesa" };
}

async function linuxDisk(env: ProbeEnv): Promise<SecurityCheck> {
  const raw = await env.readFile(`${env.appDataDir}/harness-sync.json`);
  let declared: string | true | null = null;
  if (raw) { try { declared = findDeclaredPrivate(JSON.parse(raw)); } catch { /* unreadable file: same as declaring nothing */ } }
  if (declared === null) return { key: "disk", status: "info", detail: "Disco di sistema non cifrato" };
  const mounts = await env.readFile("/proc/mounts");
  const crypt = mounts ? parseGocryptfsMounts(mounts) : [];
  const mounted = declared === true ? crypt.length > 0 : crypt.some((m) => m === declared || declared.startsWith(`${m}/`) || m.endsWith(declared));
  if (mounted) return { key: "disk", status: "ok", detail: "Dati privati in cartella cifrata, aperta" };
  return { key: "disk", status: "info", detail: "Dati privati in cartella cifrata, chiusa" };
}

async function linuxFirewall(env: ProbeEnv): Promise<boolean | "unknown"> {
  const ufw = await env.run(["ufw", "status"]);
  if (ok(ufw)) return /Status:\s*active/i.test(ufw.stdout);
  const conf = await env.readFile("/etc/ufw/ufw.conf");
  if (conf !== null) return /^ENABLED=yes/im.test(conf);
  return "unknown";
}

/** The access check plus the facts it was built from, so the collector can rebuild it with an outside measurement. */
type AccessCheck = SecurityCheck & { facts?: AccessFacts };

async function linuxAccess(env: ProbeEnv): Promise<AccessCheck> {
  const [sshd, ss, fw] = await Promise.all([env.run(["sshd", "-T"]), env.run(["ss", "-ltnH"]), linuxFirewall(env)]);
  const ports = ok(ss) ? parseSsListening(ss.stdout) : null;
  let password: boolean | null = ok(sshd) ? parseSshdT(sshd.stdout) : null;
  if (password === null) password = await passwordFromConfigFiles(env);
  const sshListens = ports === null ? null : ports.includes(22);
  const facts: AccessFacts = {
    ssh: sshListens === null && password === null ? { kind: "unknown", why: whyNoAnswer(ss) }
      : sshListens === false ? { kind: "off" } : { kind: "on", password },
    ports: ports === null ? null : ports.filter((p) => p !== 22),
    firewall: fw,
    linuxServer: true,
  };
  return { ...composeAccess(facts), facts };
}

async function linuxAntivirus(env: ProbeEnv): Promise<SecurityCheck> {
  const since = env.now() - DAY_MS;
  const j = await env.run(["journalctl", "-u", "ssh", "-u", "sshd", "--since", "24 hours ago", "--no-pager"]);
  let count: number | null = null;
  // Without permission to read the system journal, journalctl exits 0 with a hint: that is not "zero attempts".
  if (ok(j) && !/not seeing messages from other users/i.test(j.stdout + j.stderr)) count = countFailedLogins(j.stdout);
  if (count === null) {
    const auth = await env.readFile("/var/log/auth.log");
    if (auth !== null) count = countFailedLogins(auth, since);
  }
  if (count === null) return unknown("antivirus", "Accessi falliti", "registri non leggibili da questo utente");
  const sshd = await env.run(["sshd", "-T"]);
  const passwordOn = (ok(sshd) ? parseSshdT(sshd.stdout) : await passwordFromConfigFiles(env)) === true;
  const status: CheckStatus = count > FAILED_LOGINS_WARN || (passwordOn && count > 0) ? "warn" : "ok";
  const detail = passwordOn || status === "warn"
    ? `${plural(count, "tentativo", "tentativi")} di accesso in 24 ore`
    : `${plural(count, "tentativo", "tentativi")} di accesso respinti in 24 ore`;
  return { key: "antivirus", status, detail: clip(detail) };
}

// ───────────────────────────── probes: Windows ─────────────────────────────

/** PowerShell without a profile, the script in base64: no quoting trouble inside ssh or cmd. */
export function powershellArgv(script: string): string[] {
  const body = `$ProgressPreference='SilentlyContinue'\n${script}`;
  const bytes = Buffer.alloc(body.length * 2);
  for (let i = 0; i < body.length; i++) bytes.writeUInt16LE(body.charCodeAt(i), i * 2);
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", bytes.toString("base64")];
}

export const WINDOWS_SCRIPTS = {
  updates: `$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_QuickFixEngineering | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 8 | ForEach-Object { 'hotfix=' + $_.HotFixID + '|' + $_.Description + '|' + $_.InstalledOn.ToString('yyyy-MM-dd') }
'reboot=' + (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')`,
  // 1 = BitLocker on, 2 = off, 3/4 = in progress, 5 = suspended, 6 = locked: the shell gives it without asking for administrator rights.
  disk: `$ErrorActionPreference='Stop'
$d = $env:SystemDrive; if (-not $d) { $d = 'C:' }
'bitlocker=' + (New-Object -ComObject Shell.Application).NameSpace($d).Self.ExtendedProperty('System.Volume.BitLockerProtection')`,
  access: `$ErrorActionPreference='SilentlyContinue'
foreach ($f in Get-NetFirewallProfile) { 'fw=' + $f.Name + '|' + $f.Enabled }
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -notin '127.0.0.1','::1' } | ForEach-Object { 'listen=' + $_.LocalPort }
$c = Join-Path $env:ProgramData 'ssh\\sshd_config'
if (Test-Path $c) { 'sshd=present'; Get-Content $c | ForEach-Object { 'cfg=' + $_ } } else { 'sshd=absent' }`,
  antivirus: `$ErrorActionPreference='Stop'
$s = Get-MpComputerStatus
'av=' + $s.AntivirusEnabled + '|' + $s.RealTimeProtectionEnabled + '|' + $s.AntivirusSignatureLastUpdated.ToString('yyyy-MM-dd') + '|' + $s.AntivirusSignatureVersion
try { 'failed=' + @(Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625;StartTime=(Get-Date).AddHours(-24)} -ErrorAction Stop).Count } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'failed=0' } else { 'failed=?' } }`,
} as const;

async function winUpdates(env: ProbeEnv): Promise<SecurityCheck> {
  const r = await env.run(powershellArgv(WINDOWS_SCRIPTS.updates));
  if (!ok(r)) return unknown("updates", "Aggiornamenti", whyNoAnswer(r));
  const kv = parseKeyValueLines(r.stdout);
  const now = env.now();
  let last: number | null = null;
  for (const [k, v] of kv) {
    if (k !== "hotfix") continue;
    const [, desc, date] = v.split("|");
    if (desc !== "Security Update") continue;
    const at = Date.parse(`${date}T12:00:00Z`);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  const reboot = kv.find(([k]) => k === "reboot")?.[1] === "True";
  if (last === null) return unknown("updates", "Aggiornamenti", "nessuna correzione di sicurezza registrata");
  if (reboot) return { key: "updates", status: "warn", detail: clip(`Riavvio in attesa dopo l'aggiornamento del ${shortDate(last)}`) };
  if (now - last > WINDOWS_KB_WARN_DAYS * DAY_MS) return { key: "updates", status: "warn", detail: clip(`Ultima correzione di sicurezza ${daysBetween(now, last)} giorni fa`) };
  return { key: "updates", status: "ok", detail: clip(`Ultimo aggiornamento di sicurezza il ${shortDate(last)}`) };
}

async function winDisk(env: ProbeEnv): Promise<SecurityCheck> {
  const r = await env.run(powershellArgv(WINDOWS_SCRIPTS.disk));
  if (!ok(r)) return unknown("disk", "Cifratura del disco", whyNoAnswer(r));
  const v = parseKeyValueLines(r.stdout).find(([k]) => k === "bitlocker")?.[1];
  if (v === "1" || v === "6") return { key: "disk", status: "ok", detail: "Disco cifrato (BitLocker acceso)" };
  if (v === "3" || v === "4") return { key: "disk", status: "warn", detail: "Cifratura del disco in corso" };
  if (v === "5") return { key: "disk", status: "warn", detail: "Cifratura del disco sospesa" };
  if (v === "2") return { key: "disk", status: "warn", detail: "Disco non cifrato (BitLocker spento)" };
  return unknown("disk", "Cifratura del disco", "risposta non riconosciuta");
}

async function winAccess(env: ProbeEnv): Promise<SecurityCheck> {
  const r = await env.run(powershellArgv(WINDOWS_SCRIPTS.access));
  if (!ok(r)) return unknown("access", "Accessi e rete", whyNoAnswer(r));
  const kv = parseKeyValueLines(r.stdout);
  const profiles = kv.filter(([k]) => k === "fw").map(([, v]) => v.split("|")[1]);
  const firewall: boolean | "unknown" = profiles.length === 0 ? "unknown" : profiles.every((p) => p === "True");
  const ports = [...new Set(kv.filter(([k]) => k === "listen").map(([, v]) => Number(v)))].sort((a, b) => a - b);
  const sshState = kv.find(([k]) => k === "sshd")?.[1];
  const config = kv.filter(([k]) => k === "cfg").map(([, v]) => v).join("\n");
  const listensOnSsh = ports.includes(22);
  return composeAccess({
    ssh: sshState === "absent" || !listensOnSsh ? { kind: "off" } : { kind: "on", password: parseSshdConfig(config) },
    ports: ports.filter((p) => p !== 22),
    firewall,
    linuxServer: false,
  });
}

async function winAntivirus(env: ProbeEnv): Promise<SecurityCheck> {
  const r = await env.run(powershellArgv(WINDOWS_SCRIPTS.antivirus));
  if (!ok(r)) return unknown("antivirus", "Defender", whyNoAnswer(r));
  const kv = parseKeyValueLines(r.stdout);
  const av = kv.find(([k]) => k === "av")?.[1];
  if (!av) return unknown("antivirus", "Defender", "risposta non riconosciuta");
  const [enabled, realtime, sigDate] = av.split("|");
  const failed = kv.find(([k]) => k === "failed")?.[1];
  const sigAt = Date.parse(`${sigDate}T12:00:00Z`);
  const stale = Number.isFinite(sigAt) && env.now() - sigAt > SIGNATURE_WARN_DAYS * DAY_MS;
  const tail = failed && failed !== "?" ? `, ${plural(Number(failed), "accesso fallito", "accessi falliti")}` : "";
  if (enabled !== "True") return { key: "antivirus", status: "problem", detail: "Defender spento" };
  if (realtime !== "True") return { key: "antivirus", status: "problem", detail: "Protezione in tempo reale spenta" };
  if (stale) return { key: "antivirus", status: "warn", detail: clip(`Firme di Defender ferme al ${shortDate(sigAt)}${tail}`) };
  return { key: "antivirus", status: "ok", detail: clip(`Defender attivo, firme del ${shortDate(sigAt)}${tail}`) };
}

// ───────────────────────────── access: the single sentence ─────────────────────────────

/** Puts SSH key, open ports and firewall into one check, the worst part first. */
export function composeAccess(f: AccessFacts): SecurityCheck {
  const parts: Array<{ status: CheckStatus; text: string }> = [];
  if (f.ssh.kind === "on") {
    if (f.ssh.password === true) parts.push({ status: "problem", text: "SSH accetta la password" });
    else if (f.ssh.password === false) parts.push({ status: "ok", text: "solo chiave SSH" });
    else parts.push({ status: "unknown", text: "SSH non verificabile" });
  } else if (f.ssh.kind === "off") parts.push({ status: "ok", text: "accesso SSH spento" });
  else parts.push({ status: "unknown", text: "SSH non verificabile" });

  // Measured from outside, the ports that really answer win over what the machine says it listens on.
  const measured = f.providerFirewall;
  const ports = measured ? measured.open : f.ports;
  if (measured && measured.open.length === 0) {
    parts.push({ status: "ok", text: "firewall del provider: aperta solo la 22" });
  } else if (ports !== null) {
    const risky = ports.filter((p) => RISKY_PORTS.has(p));
    if (risky.length > 0) parts.push({ status: "warn", text: `porta ${risky[0]} aperta alla rete` });
    else parts.push({ status: "ok", text: ports.length === 0 ? "nessuna porta aperta" : `${plural(ports.length, "porta aperta", "porte aperte")}` });
  }

  const noPorts = ports !== null && ports.length === 0;
  if (measured && noPorts) { /* the provider's firewall already answered: the machine's own one is not the question */ }
  else if (f.firewall === true) parts.push({ status: "ok", text: "firewall acceso" });
  else if (f.firewall === false) parts.push(f.linuxServer && noPorts ? { status: "ok", text: "firewall spento" } : { status: "warn", text: "firewall spento" });
  else if (f.firewall === "unknown" && !(f.linuxServer && noPorts)) parts.push({ status: "unknown", text: "firewall non leggibile" });

  const status = worstStatus(parts.map((p) => ({ status: p.status })));
  // The sentence puts what is wrong first; the "cannot verify" parts last.
  const order = (s: CheckStatus) => (s === "problem" ? 0 : s === "warn" ? 1 : s === "ok" ? 2 : 3);
  const text = [...parts].sort((a, b) => order(a.status) - order(b.status)).map((p) => p.text).join(", ");
  return { key: "access", status, detail: clip(text.charAt(0).toUpperCase() + text.slice(1)) };
}

// ───────────────────────────── the round ─────────────────────────────

type Probe = (env: ProbeEnv) => Promise<SecurityCheck | AccessCheck>;

const PROBES: Record<string, Record<CheckKey, Probe> | undefined> = {
  darwin: { updates: macUpdates, disk: macDisk, access: macAccess, antivirus: macAntivirus },
  linux: { updates: linuxUpdates, disk: linuxDisk, access: linuxAccess, antivirus: linuxAntivirus },
  win32: { updates: winUpdates, disk: winDisk, access: winAccess, antivirus: winAntivirus },
};

const KEYS: CheckKey[] = ["updates", "disk", "access", "antivirus"];

/** A runner that does not repeat the same command within one round (two probes read the same register). */
function memoRunner(run: Runner): Runner {
  const seen = new Map<string, Promise<RunResult>>();
  return (argv, timeoutMs) => {
    const key = argv.join("\u0000");
    let hit = seen.get(key);
    if (!hit) { hit = run(argv, timeoutMs); seen.set(key, hit); }
    return hit;
  };
}

/** This machine's four probes, in parallel; every failure becomes an `unknown`, never an exception. */
export async function probeMachineSecurity(env: ProbeEnv): Promise<MachineSecurityReport> {
  const probes = PROBES[env.platform];
  const shared: ProbeEnv = { ...env, run: memoRunner(env.run) };
  let accessFacts: AccessFacts | undefined;
  const checks = await Promise.all(KEYS.map(async (key): Promise<SecurityCheck> => {
    if (!probes) return unknown(key, "Controllo", "sistema non supportato");
    try {
      const { facts, ...check } = (await probes[key](shared)) as AccessCheck;
      if (facts) accessFacts = facts;
      return check;
    } catch { return unknown(key, "Controllo", "lettura non riuscita"); }
  }));
  return { checked_at: Math.floor(env.now() / 1000), status: worstStatus(checks), checks, ...(accessFacts ? { access_facts: accessFacts } : {}) };
}
