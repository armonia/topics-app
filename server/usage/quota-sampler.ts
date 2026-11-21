/**
 * Writes the quota history (`history.jsonl`) that the points-per-person count
 * reads, so the count works on a clean install (card 29aa4259). Without a
 * writer the file does not exist, the points come back null and the
 * per-project brake never fires.
 *
 * One line per round: `{t: epochSeconds, s: {"claude|<account>|7d": pct, ...}}`,
 * the shape `readHistory` already reads. The account id is the address of
 * the login read at runtime, so another writer using the same id shares the series.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAccessToken } from "../providers/native/auth";
import { fetchUsage, type Usage } from "../providers/native/usage-window";
import { readHistory, usageHistoryFile, type QuotaHistorySample } from "./person-usage";

export const QUOTA_SAMPLE_EVERY_MS = 5 * 60_000;
/** A reading of OUR series younger than this means someone (maybe another tool) already covers this round. */
const QUOTA_SAMPLE_MIN_GAP_MS = QUOTA_SAMPLE_EVERY_MS - 30_000;
/** Another writer with keys of its own counts as alive when it wrote within this window. */
const FOREIGN_WRITER_ALIVE_MS = 60 * 60_000;

/** Keys this process appended: a series we wrote for a login we left is not "another writer". */
const ownKeys = new Set<string>();

/** Account label inside a key: the login's address, lower case, without the key separator. */
export function accountLabel(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\|/g, "");
  return v || null;
}

const is7d = (k: string) => k.startsWith("claude|") && k.endsWith("|7d");

/**
 * Decides whether this round must stay silent: our own series was read within the gap
 * (same account id from any writer), or a writer with different keys is alive.
 */
function covered(samples: QuotaHistorySample[] | null, key: string, nowMs: number): boolean {
  if (!samples) return false;
  for (const l of samples) {
    const age = nowMs - l.t * 1000;
    for (const k of Object.keys(l.s ?? {})) {
      if (!is7d(k)) continue;
      if (k === key) { if (age < QUOTA_SAMPLE_MIN_GAP_MS) return true; }
      else if (!ownKeys.has(k) && age < FOREIGN_WRITER_ALIVE_MS) return true;
    }
  }
  return false;
}

export interface SampleDeps {
  file?: string;
  nowMs?: number;
  read?: () => Promise<Usage | null>;
  /** The id of the login being read, from the login itself. Null = unknown, the round is skipped. */
  account?: () => Promise<string | null>;
}

/** One round. Returns true when a line was appended. Never throws. */
export async function sampleQuotaOnce(deps: SampleDeps = {}): Promise<boolean> {
  const file = deps.file ?? usageHistoryFile();
  const nowMs = deps.nowMs ?? Date.now();
  try {
    const id = await (deps.account ?? defaultAccount)();
    const label = id ? accountLabel(id) : null;
    if (!label) return false;
    const key7 = `claude|${label}|7d`;
    if (covered(readHistory(file), key7, nowMs)) return false;
    const usage = await (deps.read ?? defaultRead)();
    if (!usage?.sevenDay) return false;
    const s: Record<string, number> = { [key7]: usage.sevenDay.utilization };
    if (usage.fiveHour) s[`claude|${label}|5h`] = usage.fiveHour.utilization;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ t: Math.floor(nowMs / 1000), s })}\n`);
    ownKeys.add(key7);
    return true;
  } catch (e) {
    console.warn("[quota-sampler] round skipped:", (e as Error).message);
    return false;
  }
}

async function defaultRead(): Promise<Usage | null> {
  const token = await getAccessToken();
  return token ? fetchUsage(token) : null;
}

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const labelByToken = new Map<string, string>();

/** The address of the login that owns the token, read from the profile (cached per token). */
async function defaultAccount(): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const hit = labelByToken.get(token);
  if (hit) return hit;
  const res = await fetch(PROFILE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const email = ((await res.json()) as { account?: { email?: unknown } }).account?.email;
  if (typeof email !== "string" || !email) return null;
  labelByToken.set(token, email);
  return email;
}

/** Starts the periodic sampler; returns the stop function. */
export function startQuotaSampler(): () => void {
  void sampleQuotaOnce();
  const timer = setInterval(() => { void sampleQuotaOnce(); }, QUOTA_SAMPLE_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
