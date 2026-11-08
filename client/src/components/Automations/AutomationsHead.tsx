/**
 * The head and the foot of «Automazioni».
 *
 * Head: the verdict, how fresh the numbers are (live, or the hub's last good
 * copy after a failed read, or the hub down), and the pills: the runs of
 * today, the tokens the automations took per provider (today and 7 days),
 * the ones that call a model without their count reaching the hub, and how
 * many of the hub's sources do not answer.
 *
 * Foot: each source with the time it was read, «?» when it is silent, «PC
 * dorme» when the PC sleeps, and the jobs the hub hides (switched off,
 * silenced, paused in Jarvis), which open into the list of why: the only
 * place a silence given by mistake can be found again.
 */
import { useState } from 'react';
import { CircleDashed, Coins, EyeOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { silentSources } from '../../lib/automationsHead';
import type { verdictOf } from '../../lib/automations';
import type { AutomationsData } from './useAutomationsData';
import { providerName, tokenWords, type Clock } from './automationsUi';

const PILL = 'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-sm border border-app-border-subtle bg-app-inset px-2 text-mini tabular-nums text-app-text-secondary';

export function Verdict({ data, verdict, clock }: { data: AutomationsData; verdict: ReturnType<typeof verdictOf>; clock: Clock }) {
  const tr = useT();
  const parts = [
    verdict.decide > 0 ? tr('auto.verdict.decide', { n: verdict.decide }) : null,
    verdict.broken > 0 ? (verdict.broken === 1 ? tr('auto.verdict.brokenOne') : tr('auto.verdict.broken', { n: verdict.broken })) : null,
    tr('auto.verdict.ok', { ok: verdict.ok, total: verdict.total }),
    data.model ? tr('auto.verdict.runs', { n: data.model.runsToday }) : null,
    verdict.next ? tr('auto.verdict.next', { title: verdict.next.title, time: clock.dayTime(verdict.next.at) }) : null,
  ].filter(Boolean);
  const at = data.model?.checkedAt ?? data.readAt;
  const fresh = data.readAt === null ? tr('auto.reading')
    : data.hubDown ? tr('auto.readAt', { time: clock.time(data.readAt) })
      : data.model?.stale && at !== null ? tr('auto.stale', { time: clock.time(at) })
        : tr('auto.live', { time: clock.time(at ?? data.readAt) });
  const amber = data.hubDown || !!data.model?.stale;
  return (
    <div className="flex items-start gap-3" data-testid="automations-verdict">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-headline font-semibold tracking-[-0.01em] text-app-text @max-2xl:text-title" data-testid="automations-verdict-title">
          {verdict.toFix > 0 ? (
            <>{tr('auto.verdict.toFix', { n: verdict.toFix })}<span className="font-medium text-app-text-muted">{tr('auto.verdict.rest')}</span></>
          ) : tr('auto.verdict.allOk', { n: verdict.total })}
        </h1>
        {data.model && <p className="m-0 mt-1 text-compact tabular-nums text-app-text-secondary">{parts.join(' · ')}</p>}
        {data.model && <Pills data={data} />}
      </div>
      <span className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap pt-1.5 text-mini tabular-nums @max-2xl:hidden ${amber ? WARNING_TEXT : 'text-app-text-muted'}`} data-testid="automations-live" data-stale={amber}>
        <span className={`h-1.5 w-1.5 rounded-full ${amber ? 'bg-amber-500' : 'bg-emerald-500 dark:bg-emerald-400'}`} />
        {fresh}
      </span>
    </div>
  );
}

function Pills({ data }: { data: AutomationsData }) {
  const tr = useT();
  const locale = useLocale();
  const m = data.model!;
  const u = m.usage;
  const providers = u ? [...new Set([...Object.keys(u.d7), ...Object.keys(u.d1)])] : [];
  const silent = silentSources(m.sources);
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="automations-pills">
      {m.stale && (
        <span className={`${PILL} ${WARNING_TEXT}`} data-testid="automations-pill-stale">
          <RefreshCw size={12} aria-hidden="true" />{tr('auto.pill.stale')}
        </span>
      )}
      {providers.map((p) => (
        <span key={p} className={PILL} title={tr('auto.pill.tokensWhy')} data-testid="automations-pill-tokens" data-provider={p}>
          <Coins size={12} aria-hidden="true" />
          <b className="font-semibold text-app-text">{providerName(p)}</b>
          {tr('auto.pill.tokens', { d1: tokenWords(u!.d1[p] ?? 0, locale), d7: tokenWords(u!.d7[p] ?? 0, locale) })}
        </span>
      ))}
      {u && u.unmeasured > 0 && (
        <span className={`${PILL} text-app-text-muted`} title={tr('auto.usage.unmeasuredWhy')} data-testid="automations-pill-unmeasured">
          <CircleDashed size={12} aria-hidden="true" />
          {tr(u.unmeasured === 1 ? 'auto.pill.unmeasuredOne' : 'auto.pill.unmeasured', { n: u.unmeasured })}
        </span>
      )}
      {silent.length > 0 && (
        <span className={`${PILL} ${WARNING_TEXT}`} title={silent.map((s) => s.label).join(', ')} data-testid="automations-pill-sources">
          <TriangleAlert size={12} aria-hidden="true" />
          {tr(silent.length === 1 ? 'auto.pill.sourcesOne' : 'auto.pill.sources', { n: silent.length, total: m.sources.length })}
        </span>
      )}
    </div>
  );
}

export function SourcesFooter({ data, clock }: { data: AutomationsData; clock: Clock }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const m = data.model;
  if (!m || (m.sources.length === 0 && m.hidden.length === 0)) return null;
  return (
    <footer className="mt-5 border-t border-app-border-subtle pt-2.5 text-mini text-app-text-muted" data-testid="automations-footer">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
        {m.sources.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-1" data-testid="automations-source" data-source={s.name} data-ok={s.ok}>
            {i > 0 && <span aria-hidden="true" className="mr-1 text-app-text-faint">·</span>}
            {s.asleep ? tr('auto.source.asleep') : (
              <>
                {s.label}{' '}
                {s.ok && s.at !== null ? clock.time(s.at) : (
                  <span className={`font-semibold ${WARNING_TEXT}`} title={tr(s.pending ? 'auto.source.pending' : 'auto.source.silent')}>?</span>
                )}
              </>
            )}
          </span>
        ))}
        {m.hidden.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-xs px-1 text-app-text-secondary hover:bg-app-hover hover:text-app-text"
            title={m.hidden.map((h) => (h.reason ? `${h.title}: ${h.reason}` : h.title)).join('\n')}
            data-testid="automations-hidden"
          >
            <EyeOff size={12} aria-hidden="true" />{tr('auto.hidden', { n: m.hidden.length })}
          </button>
        )}
      </div>
      {open && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 rounded border border-app-border bg-surface p-0" data-testid="automations-hidden-list">
          {m.hidden.map((h, i) => (
            <li key={i} className="flex min-h-8 items-center gap-2 border-t border-app-border-subtle px-3 py-1.5 text-compact first:border-t-0">
              <EyeOff size={13} className="flex-none text-app-text-faint" aria-hidden="true" />
              <span className="min-w-0 truncate text-app-text">{h.title}</span>
              {h.reason && <span className="ml-auto truncate text-mini text-app-text-muted">{h.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}
