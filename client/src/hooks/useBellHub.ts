/**
 * What the hub adds to the bell's panel (HUBBR-06, HUBBR-07), read only while
 * the panel is open. The live topics (waiting items, services, quotas, alerts)
 * come from the socket; the rest is read once at the open:
 *
 *   - the failed automations (`/api/hub/automations`, close to a megabyte, so
 *     only when the live summary says at least one is broken);
 *   - the contradictions of the agents' rules (`/api/hub/contesto`);
 *   - the Claude proxy's account events (`/api/switchboard/activity`, with
 *     `/profiles` for the labels);
 *   - for the History tab, two days of the diary (`/api/hub/diario`).
 *
 * Without the hub (never read in this window) nothing is asked: the bell is
 * the Topics inbox of before and the network stays silent (HUBBR-04). With
 * the hub read once and down now, the panel shows Topics alone: the extras
 * read at the open go too, and `downSince` says since when.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import { refreshHubLive, useHubEverRead, useHubLive, type HubLiveEntry, type HubLiveState } from '../state/hubLive';
import { NO_HUB, liveBellHub, type BellHub } from '../lib/bellGroups';
import {
  accountEvents, automationSummary, closeWaitingBody, contradictions, diaryForHistory, failedJobs,
  type AccountEvent, type Contradiction, type DiaryEntry, type FailedJob,
} from '../lib/hubSystem';

async function readJson(path: string): Promise<unknown> {
  try {
    const resp = await apiFetch(path);
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const resp = await apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (resp.ok) return null;
    const answer = (await resp.json().catch(() => null)) as { error?: string } | null;
    return answer?.error ?? `HTTP ${resp.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

interface Extras {
  failed: FailedJob[];
  accounts: AccountEvent[];
  contradictions: Contradiction[];
}

const NO_EXTRAS: Extras = { failed: [], accounts: [], contradictions: [] };

/** Since when the hub has not answered: the oldest error of the live topics, null while one answers. */
function downSinceOf(live: HubLiveState): number | null {
  const entries = Object.values(live).filter((e): e is HubLiveEntry => !!e);
  if (entries.length === 0 || entries.some((e) => e.data !== undefined)) return null;
  return Math.min(...entries.map((e) => e.at));
}

/**
 * The hub's part of the bell. `present`: the hub was read in this window (it
 * is part of the installation); `answering`: it answers now (some live topic
 * carries data), what the foot of the panel says; `downSince`: when it
 * stopped, while it does not.
 */
export function useBellHub(): { hub: BellHub; present: boolean; answering: boolean; downSince: number | null } {
  const live = useHubLive();
  const present = useHubEverRead();
  const [extras, setExtras] = useState<Extras>(NO_EXTRAS);
  const broken = automationSummary(live.automations?.data)?.broken ?? 0;
  const answering = present && Object.values(live).some((entry) => entry?.data !== undefined);

  useEffect(() => {
    if (!answering) return;
    let alive = true;
    void (async () => {
      const [automations, contesto, activity, profiles] = await Promise.all([
        broken > 0 ? readJson('/api/hub/automations') : Promise.resolve(null),
        readJson('/api/hub/contesto'),
        readJson('/api/switchboard/activity'),
        readJson('/api/switchboard/profiles'),
      ]);
      if (!alive) return;
      setExtras({ failed: failedJobs(automations), accounts: accountEvents(activity, profiles, Date.now()), contradictions: contradictions(contesto) });
    })();
    return () => { alive = false; };
  }, [answering, broken]);

  // Down, the panel is Topics alone: what was read at the open is as old as the hub's silence.
  const hub = useMemo((): BellHub => (answering ? { ...liveBellHub(live), ...extras } : NO_HUB), [answering, live, extras]);
  return { hub, present, answering, downSince: present ? downSinceOf(live) : null };
}

/** Two days of the diary, filtered for the History tab; empty without the hub. */
export function useBellDiary(enabled: boolean): DiaryEntry[] {
  const present = useHubEverRead();
  const [rows, setRows] = useState<DiaryEntry[]>([]);
  useEffect(() => {
    if (!enabled || !present) return;
    let alive = true;
    void readJson('/api/hub/diario?days=2').then((data) => { if (alive) setRows(diaryForHistory(data)); });
    return () => { alive = false; };
  }, [enabled, present]);
  return enabled && present ? rows : [];
}

/**
 * The writes of the bell: «Done» on a hub item (closed on the hub, then
 * the snapshot is read again so every window drops it), «Fix it» on a
 * failed automation (a job in the hub's queue) and «Renew» on an expired
 * token of the Claude proxy. Each answers null or the reason of the refusal.
 */
export function useBellActions(): {
  closeWaiting: (id: string) => Promise<string | null>;
  fix: (key: string) => Promise<string | null>;
  renew: (profile: string) => Promise<string | null>;
} {
  const closeWaiting = useCallback(async (id: string) => {
    const failure = await post('/api/hub/attesa', closeWaitingBody(id)); // allow-italian: the hub's own path
    if (failure === null) await refreshHubLive();
    return failure;
  }, []);
  const fix = useCallback((key: string) => post('/api/hub/fix', { key }), []);
  // The proxy renews the account's token now (its dashboard's «Refresh token» button).
  const renew = useCallback((profile: string) => post('/api/switchboard/refresh', { name: profile }), []);
  return { closeWaiting, fix, renew };
}

/** «Retry» of the hub-down band: the snapshot read again, which makes the server ask the hub now. */
export function retryHub(): Promise<void> {
  return refreshHubLive();
}
