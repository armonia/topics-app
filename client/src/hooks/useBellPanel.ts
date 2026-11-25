/**
 * What only the OPEN bell needs: the History tab's reads (the diary, the
 * proxy's whole log), the writes of its rows («Done», «Fix it», «Renew») and
 * the «Retry» of the hub-down band. Kept apart from `useBellHub`, which the
 * Dock's ledger loads at boot: the panel is a lazy chunk, and these reads and
 * the proxy's event catalogue travel with it, not with the first download.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import { refreshHubLive, useHubEverRead } from '../state/hubLive';
import { startVisibleInterval } from '../state/documentVisibility';
import { refreshProxyActivity, useProxyActivity } from '../state/proxyActivity';
import { closeWaitingBody, diaryForHistory, type DiaryEntry } from '../lib/hubSystem';
import { rereadBellExtras } from '../state/bellExtras';
import { proxyEvents, type ProxyEvent } from '../lib/proxyEvents';
import { readJson } from '../lib/readJson';

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

/** The proxy's whole log (100 events, a week), described, for History; empty without the hub. */
export function useProxyEvents(enabled: boolean): ProxyEvent[] {
  const log = useProxyActivity(enabled);
  return useMemo(() => (log ? proxyEvents(log.activity, log.profiles) : []), [log]);
}

/** How far back History reads the diary: the hub's own page showed a week. */
const DIARY_DAYS = 7;
/** While History stays open the diary is read again this often, as the hub's page did. */
const DIARY_REFRESH_MS = 60_000;

/** A week of the diary, filtered for the History tab, and when it was read; empty without the hub. */
export function useBellDiary(enabled: boolean): { rows: DiaryEntry[]; readAt: number | null } {
  const present = useHubEverRead();
  const [state, setState] = useState<{ rows: DiaryEntry[]; readAt: number | null }>({ rows: [], readAt: null });
  useEffect(() => {
    if (!enabled || !present) return;
    let alive = true;
    const read = () => {
      void readJson(`/api/hub/diario?days=${DIARY_DAYS}`).then((data) => {
        if (alive && data !== null) setState({ rows: diaryForHistory(data), readAt: Date.now() });
      });
    };
    read();
    const stop = startVisibleInterval(read, DIARY_REFRESH_MS);
    return () => { alive = false; stop(); };
  }, [enabled, present]);
  return enabled && present ? state : { rows: [], readAt: null };
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
  // Renewed, the log is read again: the proxy wrote «token renewed» and the row goes.
  const renew = useCallback(async (profile: string) => {
    const failure = await post('/api/switchboard/refresh', { name: profile });
    if (failure === null) await refreshProxyActivity();
    return failure;
  }, []);
  return { closeWaiting, fix, renew };
}

/** «Retry» of the hub-down band: the snapshot read again, which makes the server ask the hub now, and the bell's lists with it. */
export async function retryHub(): Promise<void> {
  await refreshHubLive();
  await rereadBellExtras();
}
