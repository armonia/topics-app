/**
 * GET /api/machines/health: the last round of the machines' health
 * (`boot/machine-health.ts`), the same data the tray reads from
 * `machines-health.json`. The client draws the security mark of every machine
 * row from it (MACHINE-09). Read-only; before the first round, or with an
 * unreadable file, the answer is an empty list and the client shows `unknown`.
 *
 * The file holds more than a row needs (the CPU/memory history, and servers
 * reached over ssh whose id carries a login and an address), so the answer is
 * rebuilt field by field: `{ id, name, kind, security }`, and a malformed
 * element is dropped here so the client never has to guard its render.
 */
import { readFile } from "node:fs/promises";
import type { CheckKey, CheckMsg, CheckStatus, MachineHealthEntry, MachineSecurity, SecurityCheck, SecurityStatus } from "../../shared/machine-health";
import type { RouteHandler } from "../types";

const STATUSES: ReadonlySet<string> = new Set<SecurityStatus | CheckStatus>(["ok", "warn", "problem", "unknown", "info"]);
const CHECK_KEYS: ReadonlySet<string> = new Set<CheckKey>(["updates", "disk", "access", "antivirus"]);
/** Servers reached over ssh are listed by `ssh:<login>@<host>`: not a machine of this list, and not for the browser. */
const SSH_ID_PREFIX = "ssh:";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanMsgs(v: unknown): CheckMsg[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CheckMsg[] = [];
  for (const m of v) {
    if (!isRecord(m) || typeof m.code !== "string") return undefined;
    const params: Record<string, string | number> = {};
    if (isRecord(m.params)) for (const [k, p] of Object.entries(m.params)) if (typeof p === "string" || typeof p === "number") params[k] = p;
    out.push({ code: m.code, params });
  }
  return out;
}

function cleanSecurity(v: unknown): MachineSecurity | null {
  if (!isRecord(v) || typeof v.status !== "string" || !STATUSES.has(v.status) || !Array.isArray(v.checks)) return null;
  const checks: SecurityCheck[] = [];
  for (const c of v.checks) {
    if (!isRecord(c) || typeof c.key !== "string" || !CHECK_KEYS.has(c.key) || typeof c.status !== "string" || !STATUSES.has(c.status)) continue;
    const msgs = cleanMsgs(c.msgs);
    checks.push({ key: c.key as CheckKey, status: c.status as CheckStatus, detail: typeof c.detail === "string" ? c.detail : "", ...(msgs ? { msgs } : {}) });
  }
  return { checked_at: typeof v.checked_at === "number" ? v.checked_at : null, status: v.status as SecurityStatus, checks };
}

export function cleanMachines(raw: unknown): Array<Pick<MachineHealthEntry, "id" | "name" | "kind" | "security">> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Pick<MachineHealthEntry, "id" | "name" | "kind" | "security">> = [];
  for (const m of raw) {
    if (!isRecord(m) || typeof m.id !== "string" || m.id.startsWith(SSH_ID_PREFIX) || typeof m.name !== "string") continue;
    if (m.kind !== "local" && m.kind !== "remote") continue;
    const security = cleanSecurity(m.security);
    if (security) out.push({ id: m.id, name: m.name, kind: m.kind, security });
  }
  return out;
}

export function createMachineHealthRoute(filePath: string): RouteHandler {
  return async (_req, _url, pathname, method) => {
    if (method !== "GET" || pathname !== "/api/machines/health") return null;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as { at?: unknown; machines?: unknown };
      return Response.json({ at: typeof parsed.at === "number" ? parsed.at : 0, machines: cleanMachines(parsed.machines) });
    } catch {
      return Response.json({ at: 0, machines: [] });
    }
  };
}
