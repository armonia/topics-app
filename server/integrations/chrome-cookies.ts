/**
 * Chrome cookie decryption (macOS "v10" scheme) — vendored port of the canonical,
 * security-reviewed implementation in
 *   ~/.claude/jarvis/mcp-servers/jarvis-browser/import-chrome.mjs
 * Kept as a copy (not a cross-repo import) for a clean dependency boundary.
 *
 * Reads ONLY the Chrome Cookies store — never Login Data (saved passwords). The
 * macOS Keychain read (`security find-generic-password`) triggers a one-time OS
 * consent prompt; that gate is the authorization. Emits Chrome DevTools Protocol
 * `Network.setCookies` params so the caller can inject them into a WebContentsView
 * partition over CDP.
 *
 * ASYNC by design: this runs inside the long-lived bun server, so every external
 * call (sqlite3, the Keychain prompt) is async to avoid blocking the event loop
 * while the user clicks the consent dialog.
 *
 * Scheme: key = PBKDF2-HMAC-SHA1(keychainPw, "saltysalt", 1003, 16);
 * plaintext = AES-128-CBC(iv = 16 spaces, value[3:]); strip PKCS7; strip a leading
 * 32-byte SHA256(host_key) host-binding prefix when present.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pbkdf2Sync, createDecipheriv, createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";

const pExecFile = promisify(execFile);

export type CdpCookieParam = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number; // seconds since epoch; omitted for session cookies
};

type Row = {
  host_key: string;
  name: string;
  path: string;
  enc: string; // hex of encrypted_value
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
};

function cookiesDbPath(profile: string): string {
  return join(homedir(), "Library/Application Support/Google/Chrome", profile, "Cookies");
}

// Snapshot into a fresh 0700 temp dir (mkdtemp creates it owner-only) — the copy
// is the user's encrypted cookie DB, so keep it off shared, world-readable /tmp.
function snapshotDb(src: string): { dst: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "topics-chrome-"));
  const dst = join(dir, "Cookies");
  copyFileSync(src, dst);
  for (const ext of ["-wal", "-shm"]) if (existsSync(src + ext)) { try { copyFileSync(src + ext, dst + ext); } catch { /* ignore */ } }
  return { dst, dir };
}

async function queryRows(dbPath: string, domains: string[]): Promise<Row[]> {
  let where = "";
  if (domains.length) {
    // Precise match: the apex (host-only) OR a subdomain / leading-dot domain cookie.
    // Domains are pre-sanitized to hostname chars, so no quote/%/_ reaches the literal.
    const clauses = domains.map((d) => `host_key = '${d}' OR host_key LIKE '%.${d}'`).join(" OR ");
    where = `WHERE ${clauses}`;
  }
  const sql = `SELECT host_key, name, path, hex(encrypted_value) AS enc, expires_utc, is_secure, is_httponly, samesite FROM cookies ${where};`;
  const { stdout } = await pExecFile("sqlite3", ["-json", dbPath, sql], { maxBuffer: 256 * 1024 * 1024 });
  const out = stdout.toString().trim();
  return out ? (JSON.parse(out) as Row[]) : [];
}

async function keychainKey(): Promise<Buffer> {
  const { stdout } = await pExecFile("security", ["find-generic-password", "-ws", "Chrome Safe Storage"]);
  const pw = stdout.toString().replace(/\n$/, "");
  return pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

function decryptValue(encHex: string, key: Buffer, hostKey: string): string | null {
  const buf = Buffer.from(encHex, "hex");
  if (buf.subarray(0, 3).toString() !== "v10") return null; // classic macOS scheme only
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  const dec = createDecipheriv("aes-128-cbc", key, iv);
  dec.setAutoPadding(false);
  let out = Buffer.concat([dec.update(buf.subarray(3)), dec.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  const hostHash = createHash("sha256").update(hostKey).digest(); // newer Chrome host-binding prefix
  if (out.length >= 32 && out.subarray(0, 32).equals(hostHash)) out = out.subarray(32);
  return out.toString("utf8");
}

function toUnixSeconds(us: number): number {
  const n = Number(us);
  if (!n) return -1;
  return Math.floor(n / 1e6 - 11644473600);
}
// Chrome samesite: -1 = unspecified, 0 = None, 1 = Lax, 2 = Strict. Map -1 to
// undefined (omit the attribute) rather than guessing Lax — so an unspecified
// cookie isn't forced to Lax and silently withheld on cross-site (SSO) flows.
const SAME_SITE: Record<string, CdpCookieParam["sameSite"] | undefined> = { "-1": undefined, "0": "None", "1": "Lax", "2": "Strict" };

function toCdpCookie(row: Row, key: Buffer): CdpCookieParam | null {
  const value = decryptValue(row.enc, key, row.host_key);
  if (value == null) return null;
  let sameSite: CdpCookieParam["sameSite"] | undefined = SAME_SITE[String(row.samesite)];
  const secure = !!row.is_secure;
  if (sameSite === "None" && !secure) sameSite = undefined; // insecure None is rejected — omit instead
  const path = row.path || "/";
  const exp = toUnixSeconds(row.expires_utc);
  const base: CdpCookieParam = { name: row.name, value, secure, httpOnly: !!row.is_httponly };
  if (sameSite) base.sameSite = sameSite; // omit when unspecified
  if (exp > 0) base.expires = exp; // omit for session cookies
  // Leading-dot host_key = DOMAIN cookie → domain+path. Otherwise HOST-ONLY; __Host-/
  // __Secure- forbid a Domain attribute, so inject host-only via url (no domain).
  if (row.host_key.startsWith(".")) return { ...base, domain: row.host_key, path };
  const scheme = secure ? "https" : "http";
  return { ...base, url: `${scheme}://${row.host_key}${path.startsWith("/") ? path : "/" + path}` };
}

function sanitizeInputs(domains: string[], profile: string) {
  const cleanDomains = (domains || []).map((d) => String(d).replace(/[^a-zA-Z0-9.\-]/g, "")).filter(Boolean);
  const cleanProfile = String(profile || "Default").replace(/[^a-zA-Z0-9 _-]/g, "") || "Default";
  return { cleanDomains, cleanProfile };
}

async function readRows(domains: string[], profile: string): Promise<Row[]> {
  const src = cookiesDbPath(profile);
  if (!existsSync(src)) throw new Error(`no Chrome Cookies DB for profile '${profile}' at ${src}`);
  const read = async (): Promise<Row[]> => {
    const { dst, dir } = snapshotDb(src);
    try { return await queryRows(dst, domains); }
    finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  try { return await read(); }
  catch (e) { if (/malformed|locked|disk image/i.test(String((e as Error)?.message))) return await read(); throw e; }
}

/** Dry-run: which hosts/counts WOULD be imported. No Keychain prompt, no values. */
export async function listChromeCookieHosts({ domains = [], profile = "Default" }: { domains?: string[]; profile?: string } = {}) {
  const { cleanDomains, cleanProfile } = sanitizeInputs(domains, profile);
  const rows = await readRows(cleanDomains, cleanProfile);
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.host_key, (m.get(r.host_key) || 0) + 1);
  const hosts = [...m.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => b.cookies - a.cookies);
  return { dryRun: true as const, profile: cleanProfile, totalCookies: rows.length, hostCount: hosts.length, hosts };
}

/**
 * Decrypt matching Chrome cookies into CDP `Network.setCookies` params. Pure (no
 * filesystem writes, no network). Triggers the Keychain consent prompt.
 */
export async function decryptChromeCookies({ domains = [], profile = "Default" }: { domains?: string[]; profile?: string } = {}) {
  const { cleanDomains, cleanProfile } = sanitizeInputs(domains, profile);
  const rows = await readRows(cleanDomains, cleanProfile);
  if (!rows.length) return { profile: cleanProfile, domains: cleanDomains, cookies: [] as CdpCookieParam[], decrypted: 0, decryptFailed: 0, skippedEmpty: 0, appBoundEncrypted: 0 };
  const key = await keychainKey();
  const cookies: CdpCookieParam[] = [];
  let decryptFailed = 0, skippedEmpty = 0, appBoundEncrypted = 0;
  for (const r of rows) {
    const pfx = r.enc ? Buffer.from(r.enc.slice(0, 6), "hex").toString("latin1") : "";
    if (pfx && pfx !== "v10") { appBoundEncrypted++; continue; } // v20 = App-Bound Encryption
    let c: CdpCookieParam | null;
    try { c = toCdpCookie(r, key); } catch { decryptFailed++; continue; }
    if (!c) { decryptFailed++; continue; }
    if (c.value === "") { skippedEmpty++; continue; }
    cookies.push(c);
  }
  return { profile: cleanProfile, domains: cleanDomains, cookies, decrypted: cookies.length, decryptFailed, skippedEmpty, appBoundEncrypted };
}
