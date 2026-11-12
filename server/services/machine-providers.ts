/**
 * Provider adapters: what a hosting provider knows about a machine that the
 * machine cannot say about itself (monthly cost, spend so far, location, server
 * type). The UI never names a provider: it reads `ProviderFacts`. A new
 * provider is one more adapter in `createProviderRegistry`, nothing else moves.
 *
 * The API token lives in a 0600 file under the state dir, written from
 * Settings. It is never in the code, in the database or in a response.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineMoney, ProviderFacts } from "../../shared/machine-overview";

/** A server as a provider lists it, before it is matched to a machine. */
export interface ProviderServer {
  name: string;
  ipv4: string | null;
  status: "running" | "off" | "other";
  facts: ProviderFacts;
}

export interface ProviderAdapter {
  id: string;
  label: string;
  /** Every server of the account; throws with a short reason when the provider refuses. */
  listServers(token: string, fetchImpl: typeof fetch, now: number): Promise<ProviderServer[]>;
}

const TOKEN_SHAPE = /^[A-Za-z0-9_.-]{16,512}$/;
const ID_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;

function tokenPath(stateDir: string, providerId: string): string {
  if (!ID_SHAPE.test(providerId)) throw new Error("bad provider id");
  return join(stateDir, "providers", `${providerId}.token`);
}

export function readProviderToken(stateDir: string, providerId: string): string | null {
  try {
    const f = tokenPath(stateDir, providerId);
    if (!existsSync(f)) return null;
    const v = readFileSync(f, "utf8").trim();
    return TOKEN_SHAPE.test(v) ? v : null;
  } catch { return null; }
}

/** Returns false when the token does not look like one; null clears it. */
export function writeProviderToken(stateDir: string, providerId: string, token: string | null): boolean {
  const f = tokenPath(stateDir, providerId);
  if (token === null) { rmSync(f, { force: true }); return true; }
  const v = token.trim();
  if (!TOKEN_SHAPE.test(v)) return false;
  mkdirSync(join(stateDir, "providers"), { recursive: true, mode: 0o700 });
  writeFileSync(f, v, { mode: 0o600 });
  chmodSync(f, 0o600);
  return true;
}

// ── Hetzner Cloud ────────────────────────────────────────────────────────────

/** Overridable so a test points the adapter at a fake of the API. */
export const HETZNER_API_ENV = "TOPICS_HETZNER_API_URL";
const HETZNER_API = "https://api.hetzner.cloud/v1";

interface HetznerPrice { location: string; price_hourly: { gross: string }; price_monthly: { gross: string } }
interface HetznerServer {
  name: string;
  status: string;
  created: string;
  public_net?: { ipv4?: { ip?: string } | null };
  datacenter?: { location?: { city?: string; name?: string } };
  server_type?: { name?: string; prices?: HetznerPrice[] };
}

const money = (amount: number): MachineMoney => ({ amount: Math.round(amount * 100) / 100, currency: "EUR" });

/** Hourly billing capped at the monthly price, counted from the later of creation and the 1st of the month. */
export function hetznerSpentThisMonth(created: number, now: number, hourly: number, monthly: number): number {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const hours = Math.max(0, (now - Math.max(created, monthStart)) / 3_600_000);
  return Math.min(monthly, hours * hourly);
}

export const hetznerAdapter: ProviderAdapter = {
  id: "hetzner",
  label: "Hetzner Cloud",
  async listServers(token, fetchImpl, now) {
    const base = (process.env[HETZNER_API_ENV] || HETZNER_API).replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/servers?per_page=50`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error("token_rejected");
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = (await res.json()) as { servers?: HetznerServer[] };
    return (body.servers ?? []).map((s): ProviderServer => {
      const place = s.datacenter?.location?.name;
      const price = s.server_type?.prices?.find((p) => p.location === place) ?? s.server_type?.prices?.[0];
      const monthly = price ? Number(price.price_monthly.gross) : NaN;
      const hourly = price ? Number(price.price_hourly.gross) : NaN;
      const created = Date.parse(s.created);
      return {
        name: s.name,
        ipv4: s.public_net?.ipv4?.ip ?? null,
        status: s.status === "running" ? "running" : s.status === "off" ? "off" : "other",
        facts: {
          provider: "hetzner",
          providerLabel: "Hetzner Cloud",
          monthly: Number.isFinite(monthly) ? money(monthly) : null,
          spentThisMonth: Number.isFinite(monthly) && Number.isFinite(hourly) && Number.isFinite(created) ? money(hetznerSpentThisMonth(created, now, hourly, monthly)) : null,
          location: s.datacenter?.location?.city ?? place ?? null,
          serverType: s.server_type?.name ?? null,
          createdAt: Number.isFinite(created) ? created : null,
        },
      };
    });
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

export interface ProviderRegistry {
  adapters(): ProviderAdapter[];
  /** Servers of every configured adapter, cached; an adapter that fails is reported, not thrown. */
  servers(): Promise<{ servers: Array<ProviderServer & { adapterId: string }>; errors: Record<string, string> }>;
  configured(adapterId: string): boolean;
}

const CACHE_MS = 5 * 60_000;

export function createProviderRegistry(opts: {
  stateDir: string;
  adapters?: ProviderAdapter[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ProviderRegistry {
  const list = opts.adapters ?? [hetznerAdapter];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; token: string; servers?: ProviderServer[]; error?: string }>();
  return {
    adapters: () => list,
    configured: (id) => readProviderToken(opts.stateDir, id) !== null,
    async servers() {
      const servers: Array<ProviderServer & { adapterId: string }> = [];
      const errors: Record<string, string> = {};
      await Promise.all(list.map(async (a) => {
        const token = readProviderToken(opts.stateDir, a.id);
        if (!token) return;
        let hit = cache.get(a.id);
        if (!hit || hit.token !== token || now() - hit.at > CACHE_MS) {
          try { hit = { at: now(), token, servers: await a.listServers(token, fetchImpl, now()) }; }
          catch (err) { hit = { at: now(), token, error: err instanceof Error ? err.message : "failed" }; }
          cache.set(a.id, hit);
        }
        if (hit.error) errors[a.id] = hit.error;
        else for (const s of hit.servers ?? []) servers.push({ ...s, adapterId: a.id });
      }));
      return { servers, errors };
    },
  };
}

/** A provider server is a machine's when the name or the address says so. */
export function matchServer<T extends ProviderServer>(servers: readonly T[], machine: { name: string; hostname: string; baseUrl: string | null }): T | null {
  let host = "";
  try { host = machine.baseUrl ? new URL(machine.baseUrl).hostname : ""; } catch { /* no address */ }
  const names = [machine.name, machine.hostname].map((n) => n.trim().toLowerCase()).filter(Boolean);
  return servers.find((s) => names.includes(s.name.toLowerCase()) || (s.ipv4 !== null && s.ipv4 === host)) ?? null;
}
