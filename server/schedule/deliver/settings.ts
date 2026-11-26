/**
 * The delivery setting of the app (`scheduledDelivery`, one JSON text) and its
 * fallback (rule R21). Nothing in it names a service, a channel or a person:
 * the adapter is whatever command the owner of the installation writes here.
 *
 *   {
 *     "adapter": { "argv": ["/abs/send", "--to", "{chat}"], "env": { "TOKEN_FILE": "/abs/x" } },
 *     "owner":   { "channel": "...", "chat": "...", "thread": "" },
 *     "quietHours": { "from": "22:00", "to": "08:00", "tz": "Europe/Rome" },
 *     "agentJobs": "ask"
 *   }
 *
 * With no `adapter`, the environment variable `TOPICS_OWNER_ALERT_COMMAND` (a
 * JSON argv, shared with the project-quota alert) is used. With neither, nothing
 * leaves the app and the outcome stays in Topics.
 */
export interface AdapterConfig { argv: string[]; env: Record<string, string> }
export interface Destination { channel: string; chat: string; thread: string }
export interface QuietHours { from: string; to: string; tz: string | null }
export type AgentJobMode = "ask" | "auto";

export interface DeliverySettings {
  adapter: AdapterConfig | null;
  owner: Destination | null;
  quietHours: QuietHours | null;
  agentJobs: AgentJobMode;
}

export const OWNER_ALERT_ENV = "TOPICS_OWNER_ALERT_COMMAND";
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const text = (value: unknown) => (typeof value === "string" ? value : "");
/** The owner when the fallback variable IS the delivery: its command knows where to send, so nothing is filled in. */
const NO_DESTINATION: Destination = { channel: "", chat: "", thread: "" };

const badZones = new Set<string>();
/** A zone name `Intl` rejects would throw at every use; it is refused once, here, and logged once. */
function zoneIsValid(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch {
    if (!badZones.has(tz)) { badZones.add(tz); console.warn(`[schedule] quiet hours ignored: "${tz}" is not a time zone.`); }
    return false;
  }
}

function adapterOf(value: unknown): AdapterConfig | null {
  if (!value || typeof value !== "object") return null;
  const { argv, env } = value as { argv?: unknown; env?: unknown };
  if (!Array.isArray(argv) || !argv.length || !argv.every((item) => typeof item === "string") || !(argv[0] as string).trim()) return null;
  const clean: Record<string, string> = {};
  for (const [name, item] of Object.entries((env ?? {}) as Record<string, unknown>)) if (typeof item === "string") clean[name] = item;
  return { argv: argv as string[], env: clean };
}

/** The fallback variable holds a JSON argv. Anything else is read as no adapter, never as a shell line. */
function adapterFromEnv(env: Record<string, string | undefined>): AdapterConfig | null {
  const raw = env[OWNER_ALERT_ENV]?.trim();
  if (!raw) return null;
  try { return adapterOf({ argv: JSON.parse(raw) }); } catch { return null; }
}

export function parseDeliverySettings(raw: string | null | undefined, env: Record<string, string | undefined> = process.env): DeliverySettings {
  let value: Record<string, unknown> = {};
  try { const parsed = raw ? JSON.parse(raw) : {}; if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>; } catch { /* unreadable = nothing set */ }
  const owner = value.owner as Record<string, unknown> | undefined;
  const quiet = value.quietHours as Record<string, unknown> | undefined;
  const configured = adapterOf(value.adapter);
  const fromEnv = configured ? null : adapterFromEnv(env);
  const zone = text(quiet?.tz);
  return {
    adapter: configured ?? fromEnv,
    // With no setting at all, the variable of the project alerts is the delivery to the owner too (R21).
    owner: owner && typeof owner === "object" ? { channel: text(owner.channel), chat: text(owner.chat), thread: text(owner.thread) } : fromEnv ? NO_DESTINATION : null,
    quietHours: quiet && CLOCK.test(text(quiet.from)) && CLOCK.test(text(quiet.to)) && (!zone || zoneIsValid(zone)) ? { from: text(quiet.from), to: text(quiet.to), tz: zone || null } : null,
    agentJobs: value.agentJobs === "auto" ? "auto" : "ask",
  };
}

const minutesOf = (clock: string) => { const [hours, minutes] = clock.split(":").map(Number); return hours * 60 + minutes; };

/** The wall-clock minute of `at` in `tz` (the machine's zone when none is set). */
export function localClock(at: Date, tz: string | null): { minute: number; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz ?? undefined, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { minute: Number(part("hour")) * 60 + Number(part("minute")), day: `${part("year")}-${part("month")}-${part("day")}` };
}

/** True while `at` falls in the quiet window; the window may cross midnight. */
export function isQuietNow(quiet: QuietHours | null, at: Date): boolean {
  if (!quiet) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === to) return false;
  const { minute } = localClock(at, quiet.tz);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}
