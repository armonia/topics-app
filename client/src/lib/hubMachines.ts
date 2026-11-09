/**
 * THE HUB'S MACHINES, shown among the devices: the PC and the pay-per-use
 * Hetzner server, read from the usage hub (`GET /api/hub/machines`, proxied by
 * `server/routes/hub.ts` to the hub's `/api/machines`).
 *
 * WHY THE HUB AND NOT A ROUTE OF OUR OWN. The hub already builds this list for
 * the menu-bar tray: the PC's sleep state, the Hetzner spend against its cap,
 * the 24 h timeline. A second reader here would be a second place that can be
 * wrong (and a second caller of Hetzner's API). Topics shows what the hub says,
 * words included: `state`, `caption` and `lines` arrive already written.
 *
 * WHAT IS LEFT OUT. The local row (`local: true`) is the computer the server
 * runs on, which the devices level already lists as "this computer". A hub
 * that does not answer is not an error to show: on an installation without the
 * hub the level simply has no such rows.
 *
 * THE ACTIONS ARE THE HUB'S TOO. A machine may carry `actions` (the Hetzner
 * server's "switch off all"), each with the sentence to confirm with and the
 * hub path to POST. Topics draws the button and the confirmation, and never
 * learns which servers get deleted: that rule lives in the hub's
 * `hetzner-tetto spegni` (only `offload` and `gh-runner` labels).
 */
import { apiFetch } from './shell/net';

export interface HubMachineAction {
  id: string;
  label: string;
  method?: string;
  /** A hub path, `/api/...`. */
  url: string;
  confirm?: string;
}

export interface HubMachine {
  id: string;
  name: string;
  local: boolean;
  /** Powered on right now. Absent on an older hub: then `level` alone decides. */
  on?: boolean;
  /** `cloud` for the Hetzner server; absent for a computer. */
  kind?: string;
  state: string;
  /** 0 fine, 1 busy or near the cap, 2 strained or over the cap. */
  level: number;
  caption?: string | null;
  lines?: string[];
  spend?: { eur: number; cap: number; warn: number; over: boolean } | null;
  servers?: { id: number; name: string; type: string; since: number; eurHour: number; ci: boolean }[];
  actions?: HubMachineAction[];
}

/** The rows to list: every machine of the hub except the local one. */
export function remoteHubMachines(list: unknown): HubMachine[] {
  if (!Array.isArray(list)) return [];
  return list.filter((m): m is HubMachine => !!m && typeof m === 'object'
    && typeof (m as HubMachine).id === 'string' && typeof (m as HubMachine).name === 'string'
    && (m as HubMachine).local !== true);
}

/** `null` when the hub did not answer: the caller then shows no hub rows. */
export async function readHubMachines(): Promise<HubMachine[] | null> {
  try {
    const r = await apiFetch('/api/hub/machines', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    return remoteHubMachines(await r.json());
  } catch {
    return null;
  }
}

/** The bridge path for a hub path: `/api/hetzner/spegni` -> `/api/hub/hetzner/spegni`. Anything else is refused. */
export function bridgePath(hubUrl: string): string | null {
  const m = /^\/api\/([A-Za-z0-9._~\-/]+)$/.exec(hubUrl);
  if (!m || m[1].startsWith('/') || m[1].includes('..') || m[1].includes('//')) return null;
  return `/api/hub/${m[1]}`;
}

/** Runs one action. Resolves to `null` when the hub accepted it, else to the hub's reason (or a generic one). */
export async function runHubMachineAction(action: HubMachineAction): Promise<string | null> {
  const path = bridgePath(action.url);
  if (!path) return 'invalid action path';
  try {
    const r = await apiFetch(path, { method: action.method ?? 'POST', credentials: 'same-origin' });
    if (r.ok) return null;
    const body = await r.json().catch(() => null) as { error?: string } | null;
    return body?.error ?? `hub answered ${r.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Euros the way the hub writes them, two decimals with a comma in Italian. */
export function formatMoney(v: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}
