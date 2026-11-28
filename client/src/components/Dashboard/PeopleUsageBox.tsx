/**
 * WHO SPENT IT: the weekly quota split per person, and per request.
 *
 * One row per person with the % of one account and the share of the total; a
 * click opens their requests (the chat and the message that started the work).
 * The numbers come from `GET /api/usage/people`, cached for a minute: reading
 * more often gains nothing.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Merge, Users } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { readJson } from '../../lib/readJson';
import { apiFetch } from '../../lib/shell/net';
import { MenuButton } from '../../ui/primitives/Menu';
import { Skeleton } from '../../ui/primitives/States';
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
  // false = the last read failed: said in the box instead of an empty list that reads as «nobody spent anything»
  const [readOk, setReadOk] = useState(true);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [open, setOpen] = useState<PersonRow | null>(null);
  // the detail carries the key of the open person: once the person changes, the old one is not shown
  // (checked here, without clearing it inside the effect)
  const [loaded, setLoaded] = useState<{ key: string; data: PersonUsageDetail } | null>(null);
  const openKey = open ? open.personId ?? 'none' : null;
  const detail = loaded && loaded.key === openKey ? loaded.data : null;

  // bumped after a merge: the effect reads the list again at once instead of at the next poll
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      const r = (await readJson(`/api/usage/people?days=${DAYS}`)) as PeopleUsage | null;
      if (!alive) return;
      const ok = !!r && Array.isArray(r.people);
      setReadOk(ok);
      if (ok) setData(r);
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; stop(); };
  }, [reload]);

  /** Folds a person born from a channel into another one, then reads the list again. */
  const merge = async (from: string, into: string) => {
    setMergeError(null);
    try {
      const r = await apiFetch('/api/usage/people/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, into }) });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setMergeError(body?.error ?? String(r.status));
        return;
      }
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
      return;
    }
    setReload((n) => n + 1);
  };

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
      {!open && !data && readOk && (
        <div data-testid="people-usage-loading" role="status" aria-busy="true" className="flex flex-col gap-2 px-3 py-3">
          <Skeleton className="w-2/3" /><Skeleton className="w-1/2" /><Skeleton className="w-3/5" />
        </div>
      )}
      {!readOk && <div data-testid="people-usage-error" role="alert" className="px-3 py-2 text-mini text-rose-600 dark:text-rose-400">{tr('usage.people.readError')}</div>}
      {mergeError && <div data-testid="people-usage-merge-error" role="alert" className="px-3 py-2 text-mini text-rose-600 dark:text-rose-400">{tr('usage.people.mergeError', { reason: mergeError })}</div>}
      {!open && data && data.people.length === 0 && <div className="px-3 py-2 text-mini text-app-text-muted">{tr('usage.people.none')}</div>}
      {!open && data?.people.map((p) => (
        <div key={p.personId ?? 'none'} className="flex items-center hover:bg-app-hover">
          <button type="button" data-testid="people-usage-row" onClick={() => setOpen(p)}
            className={`${LINE} min-w-0 flex-1 text-left tabular-nums @max-2xl:h-auto @max-2xl:flex-wrap @max-2xl:py-1.5`}>
            <span className={`min-w-0 flex-[0_1_160px] truncate text-mini ${p.personId ? 'text-app-text' : 'text-app-text-muted'}`}>{nameOf(p)}</span>
            <Bar pct={(100 * p.sharePct) / max} />
            <span className="w-30 flex-none text-right text-mini text-app-text">
              {p.accountPct != null ? tr('usage.people.account', { pct: fmt(p.accountPct) }) : ''}
            </span>
            <span className="w-24 flex-none text-right text-mini text-app-text-muted">{tr('usage.people.share', { pct: fmt(p.sharePct) })}</span>
          </button>
          <span className="w-8 flex-none pr-2">
            {p.canMerge && p.personId && (
              <MenuButton label={tr('usage.people.mergeInto', { name: p.name })} icon={Merge} iconOnly variant="ghost" size="sm" align="right"
                items={[
                  { id: 'heading', label: tr('usage.people.mergeHeading', { name: p.name }), heading: true },
                  ...data.people.filter((o) => o.personId && o.personId !== p.personId).map((o) => ({ id: o.personId!, label: o.name })),
                ]}
                onSelect={(into) => { void merge(p.personId!, into); }} />
            )}
          </span>
        </div>
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
