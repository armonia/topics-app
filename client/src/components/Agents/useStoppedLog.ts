/**
 * The channel engine's own record of turns it stopped before replying
 * (AGENTS-NAV-01), read from `/api/agent-permissions/stopped`: paged and
 * filterable by agent and reason, re-fetched whenever one of those changes.
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/shell/net';
import type { StoppedPage as BaseStoppedPage } from '../../../../shared/stopped-log';

/** The server's page, plus the chat title resolved server-side for display. */
export type ResolvedStoppedPage = Omit<BaseStoppedPage, 'rows'> & { rows: (BaseStoppedPage['rows'][number] & { chatTitle: string | null })[] };

const EMPTY: ResolvedStoppedPage = { rows: [], total: 0, page: 1, pageSize: 20 };

export function useStoppedLog(opts: { agent?: string; reason?: string; page?: number; pageSize?: number }): ResolvedStoppedPage {
  const { agent, reason, page = 1, pageSize = 20 } = opts;
  const [result, setResult] = useState<ResolvedStoppedPage>(EMPTY);
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (agent) params.set('agent', agent);
    if (reason) params.set('reason', reason);
    void apiFetch(`/api/agent-permissions/stopped?${params.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: Partial<ResolvedStoppedPage> | null) => { if (alive && body) setResult({ rows: body.rows ?? [], total: body.total ?? 0, page: body.page ?? page, pageSize: body.pageSize ?? pageSize }); })
      .catch(() => { if (alive) setResult({ ...EMPTY, page, pageSize }); });
    return () => { alive = false; };
  }, [agent, reason, page, pageSize]);
  return result;
}
