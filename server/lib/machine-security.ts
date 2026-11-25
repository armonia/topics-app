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
import { coded, WHY_CODE } from "./machine-security-msgs";
import { compareVersions } from "../../shared/modelMergeKey";
import type { CheckMsg, AccessFacts, CheckKey, CheckStatus, MachineSecurityReport, SecurityCheck, SecurityStatus } from "../../shared/machine-health";

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
  return { key, status: "unknown", detail: clip(`${what}: ${why}`), msgs: [{ code: "unknown", params: { why: WHY_CODE[why] ?? "failed" } }] };
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

const minorVersion = (id: string): number[] | null =>
  /^MSU_UPDATE_.*_patch_([\d.]+)_minor$/.exec(id)?.[1]?.split(".").map(Number) ?? null;

/**
 * `plutil -p` of com.apple.SoftwareUpdate.plist: the recommended system updates
 * (only the `_minor` ones, i.e. the fixes; a `_major` is a version jump, not a
 * fix) with the date the Mac started falling behind.
 *
 * Apple replaces the pending fix with every release, so the offer date of the
 * current one restarts each month: a Mac left on 26.2 read "13 days" in
 * November 2026, nine months after it skipped 26.3. With the `installed`
 * version (`sw_vers -productVersion`) the age is the first offer of ANY fix
 * newer than it; without it, the offer of the pending one as before.
 */
export function parseMacPendingUpdates(text: string, installed: string | null = null): Array<{ id: string; offeredAt: number | null }> {
  const offered = new Map<string, number>();
  const offerSection = /"FirstOfferDateDictionary" => \{([\s\S]*?)\n\s{2}\}/.exec(text)?.[1] ?? "";
  for (const m of offerSection.matchAll(/"([^"]+)" => (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \+0000/g)) {
    offered.set(m[1], Date.parse(`${m[2].replace(" ", "T")}Z`));
  }
  const current = installed && /^\d+(\.\d+)*$/.test(installed.trim()) ? installed.trim().split(".").map(Number) : null;
  const recommended = /"RecommendedUpdates" => \[([\s\S]*?)\n\s{2}\]/.exec(text)?.[1] ?? "";
  const out: Array<{ id: string; offeredAt: number | null }> = [];
  for (const m of recommended.matchAll(/"Identifier" => "([^"]+)"/g)) {
    if (!/^MSU_UPDATE_.*_minor$/.test(m[1])) continue;
    let offeredAt = offered.get(m[1]) ?? null;
    const target = minorVersion(m[1]);
    if (current && target) {
      for (const [id, at] of offered) {
        const v = minorVersion(id);
        if (v && compareVersions(v, current) > 0 && compareVersions(v, target) <= 0 && (offeredAt === null || at < offeredAt)) offeredAt = at;
      }
    }
    out.push({ id: m[1], offeredAt });
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
 * The lines of a failed SSH login. One pattern, valid as a JavaScript regex, as
 * grep -E and as journalctl --grep (PCRE2): the machine filters with it, so a
 * day of logs (1.9 MB of journal, 19 MB of auth.log on a busy server) never
 * crosses the wire, and the counter below reads the same lines.
 */
export const FAILED_LOGIN_PATTERN = "Failed password|Invalid user|authentication failure|Failed publickey";
const FAILED_LOGIN_RE = new RegExp(FAILED_LOGIN_PATTERN);

/**
 * Failed SSH logins in `journalctl -u ssh` or `auth.log`. One attempt is one
 * sshd process: "Invalid user" and "Failed password" of the same process count
 * once (lines without a pid count one each).
 */
export function countFailedLogins(text: string, sinceMs?: number): number {
  const pids = new Set<string>();
  let loose = 0;
  for (const line of text.split("\n")) {
    if (!FAILED_LOGIN_RE.test(line)) continue;
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

/**
 * A rule of `iptables -S` (words after `-A <chain>`): its target, whether it is
 * a goto, and whether it matches every inbound TCP packet. Only "-p tcp" leaves
 * the match open: any other condition narrows it, an input interface included,
 * since the probe cannot tell the public interface from a VPN or private one.
 */
function iptablesRule(words: string[]): { target: string; goto: boolean; everyPacket: boolean } | null {
  const jump = words.findIndex((w) => w === "-j" || w === "-g");
  if (jump < 0 || jump + 1 >= words.length) return null;
  const conditions = words.slice(0, jump).join(" ");
  return { target: words[jump + 1], goto: words[jump] === "-g", everyPacket: conditions === "" || conditions === "-p tcp" };
}

/**
 * Whether `iptables -S` (or `ip6tables -S`) drops inbound traffic: the INPUT
 * policy is DROP, or a DROP/REJECT matching every inbound TCP packet is reached
 * from INPUT through jumps, before an ACCEPT or RETURN that would let the packet
 * through. Chains reached only from OUTPUT or FORWARD guard other traffic and
 * do not count.
 */
export function iptablesBlocksInput(text: string): boolean {
  const chains = new Map<string, string[][]>();
  let policy = "ACCEPT";
  for (const line of text.split("\n")) {
    // A comment changes no match and may hold spaces (or "-j"): it goes before the line is split into words.
    const words = line.replace(/\s-m comment --comment (?:"(?:[^"\\]|\\.)*"|\S+)/g, "").trim().split(/\s+/);
    if (words[0] === "-P" && words[1] === "INPUT" && words[2]) policy = words[2];
    else if (words[0] === "-A" && words[1]) {
      const rules = chains.get(words[1]);
      if (rules) rules.push(words.slice(2));
      else chains.set(words[1], [words.slice(2)]);
    }
  }
  const seen = new Set<string>();
  // null = the packet falls through back to the caller.
  const verdict = (chain: string): "block" | "accept" | null => {
    if (seen.has(chain)) return null;
    seen.add(chain);
    for (const words of chains.get(chain) ?? []) {
      const rule = iptablesRule(words);
      if (!rule?.everyPacket) continue;
      if (rule.target === "DROP" || rule.target === "REJECT") return "block";
      if (rule.target === "ACCEPT") return "accept";
      if (rule.target === "RETURN") return null;
      const inner = chains.has(rule.target) ? verdict(rule.target) : null;
      // A goto does not come back: falling out of its target leaves this chain as well.
      if (inner || rule.goto) return inner;
    }
    return null;
  };
  const v = verdict("INPUT");
  return v === "block" || (v === null && (policy === "DROP" || policy === "REJECT"));
}

/**
 * Whether `nft list ruleset` drops inbound traffic of one address family: a
 * chain on the input hook, in a table of that family or of `inet` (both), with
 * policy drop, or with a bare drop/reject rule (a counter in front is allowed)
 * before any bare accept. Jumps are not followed: the rules written by
 * iptables-nft are read by `iptablesBlocksInput`.
 */
export function nftBlocksInput(text: string, family: "ip" | "ip6"): boolean {
  // The ruleset lists its tables one after the other, each header at the start of a line.
  for (const table of text.split(/^table\s+/m).slice(1)) {
    const kind = table.split(/\s/, 1)[0];
    if (kind !== family && kind !== "inet") continue;
    for (const m of table.matchAll(/chain\s+\S+\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.some((l) => /\bhook\s+input\b/.test(l))) continue;
      if (lines.some((l) => /\bpolicy\s+drop\b/.test(l))) return true;
      for (const l of lines) {
        const bare = /^(?:counter(?:\s+packets\s+\d+\s+bytes\s+\d+)?\s+)?(accept|drop|reject)(?:\s+with\s.*)?$/.exec(l)?.[1];
        if (bare === "accept") break;
        if (bare) return true;
      }
    }
  }
  return false;
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
const MAC_VERSION = ["sw_vers", "-productVersion"];

async function macUpdates(env: ProbeEnv): Promise<SecurityCheck> {
  const [hist, pend, ver] = await Promise.all([env.run(MAC_HISTORY), env.run(MAC_SOFTWAREUPDATE), env.run(MAC_VERSION)]);
  if (!ok(hist) && !ok(pend)) return unknown("updates", "Aggiornamenti", whyNoAnswer(hist));
  const now = env.now();
  const last = ok(hist) ? lastMacSecurityUpdate(parseMacInstallHistory(hist.stdout)) : null;
  const waiting = ok(pend) ? parseMacPendingUpdates(pend.stdout, ok(ver) ? ver.stdout : null) : [];
  const oldest = waiting.reduce<number | null>((acc, w) => (w.offeredAt !== null && (acc === null || w.offeredAt < acc) ? w.offeredAt : acc), null);
  if (oldest !== null && now - oldest > PENDING_WARN_DAYS * DAY_MS) {
    return coded("updates", "warn", clip(`${plural(waiting.length, "aggiornamento", "aggiornamenti")} in attesa da ${daysBetween(now, oldest)} giorni`), { code: "updates.macWaitingOld", params: { n: waiting.length, days: daysBetween(now, oldest) } });
  }
  if (waiting.length > 0) return coded("updates", "ok", clip(`${plural(waiting.length, "aggiornamento", "aggiornamenti")} in arrivo, offerti da poco`), { code: "updates.macWaitingRecent", params: { n: waiting.length } });
  if (last) return coded("updates", "ok", clip(`Ultimo aggiornamento di sicurezza il ${shortDate(last.at)}`), { code: "updates.lastSecurity", params: { date: shortDate(last.at) } });
  return coded("updates", "ok", "Nessun aggiornamento in attesa", { code: "updates.none" });
}

async function macDisk(env: ProbeEnv): Promise<SecurityCheck> {
  const r = await env.run(["fdesetup", "status"]);
  if (!ok(r)) return unknown("disk", "Cifratura del disco", whyNoAnswer(r));
  const state = parseFileVault(r.stdout);
  if (state === "on") return coded("disk", "ok", "Disco cifrato (FileVault acceso)", { code: "disk.fileVaultOn" });
  if (state === "working") return coded("disk", "warn", "Cifratura del disco in corso", { code: "disk.encrypting" });
  if (state === "off") return coded("disk", "warn", "Disco non cifrato (FileVault spento)", { code: "disk.fileVaultOff" });
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
  let tailMsg: CheckMsg | null = null;
  if (remote === false) { tail = "accesso remoto spento"; tailMsg = { code: "antivirus.remoteOff" }; }
  else if (remote === true) {
    const log = await env.run(["log", "show", "--last", "24h", "--style", "compact", "--predicate", 'process == "sshd" AND (eventMessage CONTAINS "Failed" OR eventMessage CONTAINS "Invalid user")'], MAC_LOG_TIMEOUT_MS);
    const failed = ok(log) ? countFailedLogins(log.stdout) : null;
    tail = failed !== null ? `${failed} accessi falliti in 24 ore` : "accessi falliti non leggibili";
    tailMsg = failed !== null ? { code: "antivirus.failedDay", params: { n: failed } } : { code: "antivirus.failedUnreadable" };
  }
  const baseMsg: CheckMsg = { code: "antivirus.xprotect", params: { version: x.version, date: shortDate(x.at) } };
  return coded("antivirus", stale ? "warn" : "ok", clip(tail ? `${base}, ${tail}` : base), ...(tailMsg ? [baseMsg, tailMsg] : [baseMsg]));
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
    return coded("updates", "warn", clip(`Riavvio in attesa da ${plural(daysBetween(now, reboot), "giorno", "giorni")} per gli aggiornamenti`), { code: "updates.rebootDays", params: { days: daysBetween(now, reboot) } });
  }
  if (pending > 0 && (last === null || now - last > PENDING_WARN_DAYS * DAY_MS)) {
    return coded("updates", "warn", clip(`${plural(pending, "aggiornamento", "aggiornamenti")} di sicurezza in attesa${last ? ` da ${daysBetween(now, last)} giorni` : ""}`), last ? { code: "updates.pendingSince", params: { n: pending, days: daysBetween(now, last) } } : { code: "updates.pending", params: { n: pending } });
  }
  if (last !== null) return coded("updates", "ok", clip(`Ultimo aggiornamento di sicurezza il ${shortDate(last)}`), { code: "updates.lastSecurity", params: { date: shortDate(last) } });
  return coded("updates", "ok", "Nessun aggiornamento di sicurezza in attesa", { code: "updates.noneSecurity" });
}

async function linuxDisk(env: ProbeEnv): Promise<SecurityCheck> {
  const raw = await env.readFile(`${env.appDataDir}/harness-sync.json`);
  let declared: string | true | null = null;
  if (raw) { try { declared = findDeclaredPrivate(JSON.parse(raw)); } catch { /* unreadable file: same as declaring nothing */ } }
  if (declared === null) return coded("disk", "info", "Disco di sistema non cifrato", { code: "disk.systemPlain" });
  const mounts = await env.readFile("/proc/mounts");
  const crypt = mounts ? parseGocryptfsMounts(mounts) : [];
  const mounted = declared === true ? crypt.length > 0 : crypt.some((m) => m === declared || declared.startsWith(`${m}/`) || m.endsWith(declared));
  if (mounted) return coded("disk", "ok", "Dati privati in cartella cifrata, aperta", { code: "disk.privateOpen" });
  return coded("disk", "info", "Dati privati in cartella cifrata, chiusa", { code: "disk.privateClosed" });
}

async function linuxFirewall(env: ProbeEnv): Promise<boolean | "unknown"> {
  const ufw = await env.run(["ufw", "status"]);
  if (ok(ufw) && /Status:\s*active/i.test(ufw.stdout)) return true;
  // ufw off does not mean no firewall: rules written straight into iptables or nftables guard the machine too.
  // Both address families must drop: a port bound on `*` or `[::]` answers over IPv6 as well.
  const [v4, v6, nft] = await Promise.all([env.run(["iptables", "-S"]), env.run(["ip6tables", "-S"]), env.run(["nft", "list", "ruleset"])]);
  const guarded = (rules: RunResult, family: "ip" | "ip6") =>
    (ok(rules) && iptablesBlocksInput(rules.stdout)) || (ok(nft) && nftBlocksInput(nft.stdout, family));
  if (guarded(v4, "ip") && guarded(v6, "ip6")) return true;
  if (ok(v4) || ok(v6) || ok(nft) || ok(ufw)) return false;
  // Not root: the kernel rules are not readable, ufw's own configuration is the only answer left.
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

/** Exit 1 from grep or journalctl --grep: the log was read and no line matched. */
function nothingMatched(r: RunResult): boolean {
  return !r.missing && !r.timedOut && r.code === 1;
}

/**
 * Failed SSH logins of the last 24 hours, `null` when no log can be read. The
 * machine filters the lines itself: the whole log does not arrive within the
 * probe deadline over SSH (measured 7.9 s for one day of journal).
 */
async function failedLoginsLastDay(env: ProbeEnv): Promise<number | null> {
  const j = await env.run(["journalctl", "-u", "ssh", "-u", "sshd", "--since", "24 hours ago", "--no-pager", "--grep", FAILED_LOGIN_PATTERN]);
  // Without permission to read the system journal, journalctl answers with a hint: that is not "zero attempts".
  const hidden = /not seeing messages from other users/i.test(j.stdout + j.stderr);
  // With --grep and no match, journalctl prints "-- No entries --" and exits 1, like grep (systemd journalctl.c).
  if (!hidden && (ok(j) || (nothingMatched(j) && /^-- No entries --$/m.test(j.stdout)))) return countFailedLogins(j.stdout);
  // Journal too slow, unreadable or without pattern support: auth.log, filtered on the machine as well.
  // -a: after an unclean shutdown auth.log holds NUL bytes, and grep would print "binary file matches" instead of the lines.
  const g = await env.run(["grep", "-a", "-E", FAILED_LOGIN_PATTERN, "/var/log/auth.log"]);
  if (ok(g)) return countFailedLogins(g.stdout, env.now() - DAY_MS);
  if (nothingMatched(g) && g.stdout.trim() === "") return 0;
  return null;
}

async function linuxAntivirus(env: ProbeEnv): Promise<SecurityCheck> {
  const count = await failedLoginsLastDay(env);
  if (count === null) return unknown("antivirus", "Accessi falliti", "registri non leggibili da questo utente");
  const sshd = await env.run(["sshd", "-T"]);
  const passwordOn = (ok(sshd) ? parseSshdT(sshd.stdout) : await passwordFromConfigFiles(env)) === true;
  const status: CheckStatus = count > FAILED_LOGINS_WARN || (passwordOn && count > 0) ? "warn" : "ok";
  const detail = passwordOn || status === "warn"
    ? `${plural(count, "tentativo", "tentativi")} di accesso in 24 ore`
    : `${plural(count, "tentativo", "tentativi")} di accesso respinti in 24 ore`;
  return coded("antivirus", status, clip(detail), { code: passwordOn || status === "warn" ? "antivirus.attempts" : "antivirus.attemptsRejected", params: { n: count } });
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
  // 1 = BitLocker on, 2 = off, 0 = never turned on (Get-BitLockerVolume: Off / FullyDecrypted, 23/11/2026), 3/4 = in progress, 5 = suspended, 6 = locked: no administrator rights needed.
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
  if (reboot) return coded("updates", "warn", clip(`Riavvio in attesa dopo l'aggiornamento del ${shortDate(last)}`), { code: "updates.rebootAfter", params: { date: shortDate(last) } });
  if (now - last > WINDOWS_KB_WARN_DAYS * DAY_MS) return coded("updates", "warn", clip(`Ultima correzione di sicurezza ${daysBetween(now, last)} giorni fa`), { code: "updates.lastFixAgo", params: { days: daysBetween(now, last) } });
  return coded("updates", "ok", clip(`Ultimo aggiornamento di sicurezza il ${shortDate(last)}`), { code: "updates.lastSecurity", params: { date: shortDate(last) } });
}

async function winDisk(env: ProbeEnv): Promise<SecurityCheck> {
  const r = await env.run(powershellArgv(WINDOWS_SCRIPTS.disk));
  if (!ok(r)) return unknown("disk", "Cifratura del disco", whyNoAnswer(r));
  const v = parseKeyValueLines(r.stdout).find(([k]) => k === "bitlocker")?.[1];
  if (v === "1" || v === "6") return coded("disk", "ok", "Disco cifrato (BitLocker acceso)", { code: "disk.bitlockerOn" });
  if (v === "3" || v === "4") return coded("disk", "warn", "Cifratura del disco in corso", { code: "disk.encrypting" });
  if (v === "5") return coded("disk", "warn", "Cifratura del disco sospesa", { code: "disk.suspended" });
  if (v === "2" || v === "0") return coded("disk", "warn", "Disco non cifrato (BitLocker spento)", { code: "disk.bitlockerOff" });
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
  const tailMsgs: CheckMsg[] = failed && failed !== "?" ? [{ code: "antivirus.failedLogins", params: { n: Number(failed) } }] : [];
  if (enabled !== "True") return coded("antivirus", "problem", "Defender spento", { code: "antivirus.defenderOff" });
  if (realtime !== "True") return coded("antivirus", "problem", "Protezione in tempo reale spenta", { code: "antivirus.realtimeOff" });
  if (stale) return coded("antivirus", "warn", clip(`Firme di Defender ferme al ${shortDate(sigAt)}${tail}`), { code: "antivirus.sigStale", params: { date: shortDate(sigAt) } }, ...tailMsgs);
  return coded("antivirus", "ok", clip(`Defender attivo, firme del ${shortDate(sigAt)}${tail}`), { code: "antivirus.defenderOn", params: { date: shortDate(sigAt) } }, ...tailMsgs);
}

// ───────────────────────────── access: the single sentence ─────────────────────────────

/** Puts SSH key, open ports and firewall into one check, the worst part first. */
export function composeAccess(f: AccessFacts): SecurityCheck {
  const parts: Array<{ status: CheckStatus; text: string; msg: CheckMsg }> = [];
  if (f.ssh.kind === "on") {
    if (f.ssh.password === true) parts.push({ status: "problem", text: "SSH accetta la password", msg: { code: "access.sshPassword" } });
    else if (f.ssh.password === false) parts.push({ status: "ok", text: "solo chiave SSH", msg: { code: "access.sshKeyOnly" } });
    else parts.push({ status: "unknown", text: "SSH non verificabile", msg: { code: "access.sshUnverifiable" } });
  } else if (f.ssh.kind === "off") parts.push({ status: "ok", text: "accesso SSH spento", msg: { code: "access.sshOff" } });
  else parts.push({ status: "unknown", text: "SSH non verificabile", msg: { code: "access.sshUnverifiable" } });

  // Measured from outside, the ports that really answer win over what the machine says it listens on.
  const measured = f.providerFirewall;
  const ports = measured ? measured.open : f.ports;
  if (measured && measured.open.length === 0) {
    parts.push({ status: "ok", text: "firewall del provider: aperta solo la 22", msg: { code: "access.providerFirewall" } });
  } else if (ports !== null) {
    const risky = ports.filter((p) => RISKY_PORTS.has(p));
    if (risky.length > 0) parts.push({ status: "warn", text: `porta ${risky[0]} aperta alla rete`, msg: { code: "access.riskyPort", params: { port: risky[0] } } });
    else parts.push({ status: "ok", text: ports.length === 0 ? "nessuna porta aperta" : `${plural(ports.length, "porta aperta", "porte aperte")}`, msg: ports.length === 0 ? { code: "access.noPorts" } : { code: "access.ports", params: { n: ports.length } } });
  }

  const noPorts = ports !== null && ports.length === 0;
  if (measured && noPorts) { /* the provider's firewall already answered: the machine's own one is not the question */ }
  else if (f.firewall === true) parts.push({ status: "ok", text: "firewall acceso", msg: { code: "access.firewallOn" } });
  else if (f.firewall === false) parts.push(f.linuxServer && noPorts ? { status: "ok", text: "firewall spento", msg: { code: "access.firewallOff" } } : { status: "warn", text: "firewall spento", msg: { code: "access.firewallOff" } });
  else if (f.firewall === "unknown" && !(f.linuxServer && noPorts)) parts.push({ status: "unknown", text: "firewall non leggibile", msg: { code: "access.firewallUnreadable" } });

  const status = worstStatus(parts.map((p) => ({ status: p.status })));
  // The sentence puts what is wrong first; the "cannot verify" parts last.
  const order = (s: CheckStatus) => (s === "problem" ? 0 : s === "warn" ? 1 : s === "ok" ? 2 : 3);
  const sorted = [...parts].sort((a, b) => order(a.status) - order(b.status));
  const text = sorted.map((p) => p.text).join(", ");
  return coded("access", status, clip(text.charAt(0).toUpperCase() + text.slice(1)), ...sorted.map((p) => p.msg));
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

/** What a node reports when its build does not know the probe route at all (an old version): four honest unknowns, not silence. */
export function probeUnavailableReport(nowMs: number): MachineSecurityReport {
  const checks = KEYS.map((key) => unknown(key, "Controllo", "il nodo ha una versione senza sonda di sicurezza"));
  return { checked_at: Math.floor(nowMs / 1000), status: "unknown", checks };
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
