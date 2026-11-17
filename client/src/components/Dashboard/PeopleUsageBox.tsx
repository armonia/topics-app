/**
 * WHO SPENT IT: the weekly quota split per person, and per request.
 *
 * One row per person with the % of one account and the share of the total; a
 * click opens their requests (the chat and the message that started the work).
 * The numbers come from `GET /api/usage/people`, cached for a minute: reading
 * more often gains nothing.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Users } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { readJson } from '../../lib/readJson';
import { startVisibleInterval } from '../../state/documentVisibility';
import { Bar, Box, LINE } from './hubUsageUi';
import type { PeopleUsage, PersonUsageDetail, PersonUsageRow } from '../../../../shared/person-usage';

const POLL_MS = 60_000;
const DAYS = 7;
/** The costliest requests are enough to see where the quota went; the rest is counted. */
const MAX_REQUESTS = 20;

type PersonRow = PersonUsageRow;

const fmt = (x: number) => (Math.round(x * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });

export function PeopleUsageBox() {
  const tr = useT();
  const [data, setData] = useState<PeopleUsage | null>(null);
  const [open, setOpen] = useState<PersonRow | null>(null);
  // the detail carries the key of the open person: once the person changes, the old one is not shown
  // (checked here, without clearing it inside the effect)
  const [loaded, setLoaded] = useState<{ key: string; data: PersonUsageDetail } | null>(null);
  const openKey = open ? open.personId ?? 'none' : null;
  const detail = loaded && loaded.key === openKey ? loaded.data : null;

  useEffect(() => {
    let alive = true;
    const read = async () => {
      const r = (await readJson(`/api/usage/people?days=${DAYS}`)) as PeopleUsage | null;
      if (alive && r && Array.isArray(r.people)) setData(r);
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; stop(); };
  }, []);

  useEffect(() => {
    if (!openKey) return;
    let alive = true;
    void readJson(`/api/usage/people/${encodeURIComponent(openKey)}?days=${DAYS}`).then((r) => {
      if (alive && r) setLoaded({ key: openKey, data: r as PersonUsageDetail });
    });
    return () => { alive = false; };
  }, [openKey]);

  const nameOf = (p: { personId: string | null; name: string }) => (p.personId ? p.name : tr('usage.people.noAuthor'));
  const meta = !data ? '' : data.quotaHistory && data.totalPoints != null
    ? tr('usage.people.meta', { pts: fmt(data.totalPoints), days: data.days })
    : tr('usage.people.metaTokens', { days: data.days });
  const max = Math.max(1, ...(data?.people ?? []).map((p) => p.sharePct));

  return (
    <Box testId="dashboard-people-usage" icon={<Users size={13} />} title={open ? tr('usage.people.requests', { name: nameOf(open) }) : tr('usage.people.title')} meta={meta}
      foot={data && !data.quotaHistory ? <span>{tr('usage.people.noHistory')}</span> : undefined}>
      {!open && data && data.people.length === 0 && <div className="px-3 py-2 text-mini text-app-text-muted">{tr('usage.people.none')}</div>}
      {!open && data?.people.map((p) => (
        <button key={p.personId ?? 'none'} type="button" data-testid="people-usage-row" onClick={() => setOpen(p)}
          className={`${LINE} w-full text-left tabular-nums hover:bg-app-hover @max-2xl:h-auto @max-2xl:flex-wrap @max-2xl:py-1.5`}>
          <span className={`min-w-0 flex-[0_1_160px] truncate text-mini ${p.personId ? 'text-app-text' : 'text-app-text-muted'}`}>{nameOf(p)}</span>
          <Bar pct={(100 * p.sharePct) / max} />
          <span className="w-[120px] flex-none text-right text-mini text-app-text">
            {p.accountPct != null ? tr('usage.people.account', { pct: fmt(p.accountPct) }) : ''}
          </span>
          <span className="w-[96px] flex-none text-right text-mini text-app-text-muted">{tr('usage.people.share', { pct: fmt(p.sharePct) })}</span>
        </button>
      ))}
      {open && (
        <>
          <button type="button" data-testid="people-usage-back" onClick={() => setOpen(null)} className={`${LINE} w-full text-left text-mini text-app-text-muted hover:bg-app-hover`}>
            <ArrowLeft size={12} aria-hidden="true" />{tr('usage.people.back')}
          </button>
          {detail?.requests.slice(0, MAX_REQUESTS).map((r, i) => (
            <div key={`${r.requestId ?? ''}-${i}`} data-testid="people-usage-request" className="flex items-start gap-2 border-t border-app-border-subtle px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-mini text-app-text" title={r.request}>{r.request || tr('usage.people.noRequest')}</div>
                <div className="truncate text-mini text-app-text-muted">{r.chatName} · {new Date(r.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} · {tr('usage.people.calls', { n: r.calls })}</div>
              </div>
              <span className="flex-none text-right text-mini tabular-nums text-app-text">
                {r.accountPct != null ? `${fmt(r.accountPct)}%` : r.weighted.toLocaleString()}
              </span>
            </div>
          ))}
          {detail && detail.requests.length > MAX_REQUESTS && (
            <div className="border-t border-app-border-subtle px-3 py-2 text-mini text-app-text-muted">{tr('usage.people.moreRequests', { n: detail.requests.length - MAX_REQUESTS })}</div>
          )}
        </>
      )}
    </Box>
  );
}
