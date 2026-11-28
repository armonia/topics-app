/**
 * THE DECLARED MAILBOXES: ONE LIST TO RECEIVE AND TO SEND (rule P1).
 *
 * The app setting `mailboxes` is one JSON text:
 *
 *   [{ "name": "work", "addresses": ["me@example.com"],
 *      "adapter": { "argv": ["/abs/adapter"], "env": {} },
 *      "trustedAuthserv": "mx.example.com",
 *      "agentsMayWait": true, "rulesEnabled": false, "windowHours": 72 }]
 *
 * Nothing here names an account or a person: whoever installs the app writes
 * the list. The send-side environment variables still describe mailboxes that
 * are not in the setting yet; a mailbox written in the setting wins over the
 * environment entry with the same name, and an environment entry has no
 * adapter, so it is never read.
 */
import type { MailAccount } from "../../lib/outbound-config";

export interface MailboxAdapter { argv: string[]; env: Record<string, string> }

export interface Mailbox {
  name: string;
  /** The mailbox's own addresses: a message sent from one of them is an own send. */
  addresses: string[];
  adapter: MailboxAdapter | null;
  /** The `authserv-id` whose Authentication-Results line can be trusted. */
  trustedAuthserv: string;
  agentsMayWait: boolean;
  rulesEnabled: boolean;
  /** How far back a read goes when the cursor is gone. */
  windowHours: number;
  /** True when the entry only exists in the environment (send side). */
  fromEnv: boolean;
}

export const DEFAULT_WINDOW_HOURS = 72;
const MAX_WINDOW_HOURS = 24 * 30;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function adapterOf(value: unknown): MailboxAdapter | null {
  if (!value || typeof value !== "object") return null;
  const { argv, env } = value as { argv?: unknown; env?: unknown };
  if (!Array.isArray(argv) || !argv.length || !argv.every((item) => typeof item === "string") || !(argv[0] as string).trim()) return null;
  const clean: Record<string, string> = {};
  for (const [name, item] of Object.entries((env ?? {}) as Record<string, unknown>)) if (typeof item === "string") clean[name] = item;
  return { argv: argv as string[], env: clean };
}

/** Reads the setting text. A broken text or entry is skipped, never thrown: the app must boot. */
export function parseMailboxes(raw: string | null | undefined): Mailbox[] {
  if (!raw?.trim()) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Mailbox[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const name = text(item.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const addresses = Array.isArray(item.addresses) ? item.addresses.map(text).filter(Boolean) : [];
    const hours = Number(item.windowHours);
    out.push({
      name,
      addresses,
      adapter: adapterOf(item.adapter),
      trustedAuthserv: text(item.trustedAuthserv),
      agentsMayWait: item.agentsMayWait === true,
      rulesEnabled: item.rulesEnabled === true,
      windowHours: Number.isFinite(hours) && hours >= 1 ? Math.min(hours, MAX_WINDOW_HOURS) : DEFAULT_WINDOW_HOURS,
      fromEnv: false,
    });
  }
  return out;
}

/** The setting first; environment accounts whose name is not in the setting follow, without an adapter. */
export function mergeMailboxes(declared: Mailbox[], envAccounts: MailAccount[]): Mailbox[] {
  const names = new Set(declared.map((box) => box.name));
  const extra: Mailbox[] = envAccounts
    .filter((account) => !names.has(account.name))
    .map((account) => ({
      name: account.name, addresses: [account.address], adapter: null, trustedAuthserv: "",
      agentsMayWait: false, rulesEnabled: false, windowHours: DEFAULT_WINDOW_HOURS, fromEnv: true,
    }));
  return [...declared, ...extra];
}

/** A mailbox is read only with an adapter and at least one of the two switches on. */
export function isReadable(box: Mailbox): boolean {
  return !!box.adapter && (box.agentsMayWait || box.rulesEnabled);
}

export const isOwnAddress = (box: Mailbox, from: string) => {
  const wanted = from.trim().toLowerCase();
  return box.addresses.some((address) => address.toLowerCase() === wanted);
};
