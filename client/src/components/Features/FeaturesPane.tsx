/**
 * THE FEATURE MAP (hub-smistamento, HUBBR-18): the usage hub's feature map in a
 * whole view, opened from System and from the palette, never from a row of
 * its own in the sidebar: a map to study, at hand but not in sight.
 *
 * At the top the verdict (where Jarvis is behind, out of how many features,
 * how many systems, Jarvis's share and place), then the ranking of the
 * systems, then the features area by area: by default only the ones where
 * Jarvis is behind, or all of them, with a search. A feature opens in place:
 * who has it, who has it in part, and the news the hub's watcher found on it.
 *
 * Loaded as its own chunk, only where the hub is part of the installation. A
 * hub that stops answering keeps the last map on screen with a band and a retry.
 */
import { useMemo, useState } from 'react';
import { Blocks, ChevronDown, ChevronRight, CloudOff, ExternalLink, Search } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import FEATURES_IT from '../../lib/i18n-features-it';
import FEATURES_EN from '../../lib/i18n-features-en';
import FEATURE_NAMES_IT from '../../lib/i18n-features-names-it';
import { featuresView, localizeFeatures, visibleAreas, OURS, type FeatureFilter, type FeatureLeaf, type FeaturesView, type LeafStatus } from '../../lib/hubFeatures';
import { HUB_FEATURES_DOC, useHubDoc } from '../../state/hubDocs';
import { useHubEverRead } from '../../state/hubLive';

addCatalogue('it', FEATURES_IT);
addCatalogue('en', FEATURES_EN);

type Tr = ReturnType<typeof useT>;

/** The map changes once a day: a view opened again within ten minutes reads nothing. */
const MAX_AGE_MS = 10 * 60_000;
/** News items shown in an opened feature: the watcher keeps thirty days of them. */
const NEWS_SHOWN = 5;

const SECTION = 'mb-1.5 mt-[18px] flex items-center gap-2 text-mini font-semibold uppercase tracking-[0.04em] text-app-text-tertiary';
const SECTION_COUNT = 'font-medium normal-case tracking-normal text-app-text-muted tabular-nums';
const SECTION_REST = 'ml-auto truncate font-normal normal-case tracking-normal text-app-text-muted';
const BOX = 'overflow-hidden rounded border border-app-border bg-surface';

const STATUS_CHIP: Record<LeafStatus, string> = {
  yes: 'bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400',
  partial: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  no: 'bg-red-500/10 text-red-700 dark:text-red-400',
  unknown: 'bg-app-hover text-app-text-secondary',
};

function useFormats(locale: string) {
  return useMemo(() => {
    const tag = locale === 'en' ? 'en-GB' : 'it-IT';
    const time = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' });
    const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' });
    return {
      time: (at: number) => time.format(at),
      day: (at: number) => day.format(at).replace(/\./g, ''),
    };
  }, [locale]);
}

export function FeaturesPane() {
  const tr = useT();
  const locale = useLocale();
  const fmt = useFormats(locale);
  const hubPresent = useHubEverRead();
  const doc = useHubDoc(HUB_FEATURES_DOC, hubPresent, MAX_AGE_MS);
  const view = useMemo(() => {
    const raw = featuresView(doc.data);
    // The hub writes the map in English: the Italian words come with this chunk.
    return raw && locale === 'it' ? localizeFeatures(raw, FEATURE_NAMES_IT) : raw;
  }, [doc.data, locale]);
  const [filter, setFilter] = useState<FeatureFilter>('behind');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const areas = useMemo(() => (view ? visibleAreas(view, filter, query) : []), [view, filter, query]);
  const down = doc.state === 'down';

  return (
    <div className="@container relative flex h-full min-h-0 bg-app-bg" data-testid="features-pane">
      <section className="min-w-0 flex-1 overflow-auto px-5 pb-6 pt-4 @max-2xl:px-3 @max-2xl:pb-8 @max-2xl:pt-3">
        <Verdict view={view} tr={tr} fmt={fmt} okAt={doc.okAt} down={down} />
        {down && (
          <div role="status" data-testid="features-hub-down" className="mt-2.5 flex min-h-7 items-center gap-1.5 rounded bg-app-hover py-1 pl-2.5 pr-1 text-compact text-app-text-secondary">
            <CloudOff size={14} className="flex-none" aria-hidden="true" />
            <span className="min-w-0 flex-1 tabular-nums">{doc.okAt === null ? tr('feat.hubDownNever') : tr('feat.hubDown', { time: fmt.time(doc.okAt) })}</span>
            <button type="button" className="inline-flex h-[26px] items-center rounded-sm border border-app-border bg-elevated px-2.5 text-mini text-app-text-body hover:bg-app-hover" onClick={() => { void doc.reread(); }}>{tr('feat.retry')}</button>
          </div>
        )}
        {!view && !down && <p className="mt-4 text-compact text-app-text-secondary">{tr('feat.reading')}</p>}
        {view && (
          <>
            <Ranking view={view} tr={tr} />
            <div className="mt-[18px] flex items-end gap-2 @max-2xl:block">
              <div role="tablist" className="inline-flex gap-0.5 rounded border border-app-border-subtle bg-app-inset p-0.5 @max-2xl:flex @max-2xl:w-full">
                {(['behind', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    data-testid={`features-filter-${f}`}
                    onClick={() => setFilter(f)}
                    className={`inline-flex h-[26px] items-center gap-1.5 rounded-sm px-3 text-compact @max-2xl:h-9 @max-2xl:flex-1 @max-2xl:justify-center ${filter === f ? 'bg-elevated text-app-text shadow-[0_0_0_1px_var(--border)]' : 'text-app-text-secondary hover:text-app-text'}`}
                  >
                    {tr(f === 'behind' ? 'feat.filter.behind' : 'feat.filter.all')}
                    <span className="text-mini tabular-nums text-app-text-muted">{f === 'behind' ? view.behind : view.leaves}</span>
                  </button>
                ))}
              </div>
              <label className="ml-auto inline-flex h-[26px] w-[200px] items-center gap-1.5 rounded-sm border border-app-border-input bg-app-input px-2 text-app-text-muted @max-2xl:mt-2 @max-2xl:h-9 @max-2xl:w-full">
                <Search size={13} aria-hidden="true" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tr('feat.search')}
                  aria-label={tr('feat.search')}
                  data-testid="features-search"
                  className="min-w-0 flex-1 bg-transparent text-mini text-app-text outline-none placeholder:text-app-text-muted @max-2xl:text-compact"
                />
              </label>
            </div>
            {areas.length === 0 && <p data-testid="features-empty" className="mt-4 text-compact text-app-text-secondary">{tr('feat.empty')}</p>}
            {areas.map((a) => (
              <div key={a.id} data-testid="features-area" data-area={a.id}>
                <h2 className={SECTION}>
                  <span className="truncate">{a.name}</span>
                  <span className={SECTION_COUNT}>{a.leaves.length}</span>
                  {a.oursPct !== null && a.oursRank !== null && (
                    <span className={SECTION_REST}>{tr('feat.area.hint', { pct: a.oursPct, rank: a.oursRank, of: view.systems.length })}</span>
                  )}
                </h2>
                <div className={BOX}>
                  {a.leaves.map((l) => (
                    <Leaf key={l.id} leaf={l} tr={tr} fmt={fmt} open={openId === l.id} onToggle={() => setOpenId(openId === l.id ? null : l.id)} />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

function Verdict({ view, tr, fmt, okAt, down }: { view: FeaturesView | null; tr: Tr; fmt: ReturnType<typeof useFormats>; okAt: number | null; down: boolean }) {
  const updated = view?.updated ? Date.parse(view.updated) : NaN;
  const parts = view ? [
    tr('feat.verdict.systems', { n: view.systems.length }),
    view.ours?.pct != null && view.ours.rank != null ? tr('feat.verdict.ours', { pct: view.ours.pct, rank: view.ours.rank }) : null,
    Number.isFinite(updated) ? tr('feat.verdict.updated', { date: fmt.day(updated) }) : null,
  ].filter(Boolean) : [];
  return (
    <div className="flex items-start gap-3" data-testid="features-verdict">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-headline font-semibold tracking-[-0.01em] text-app-text @max-2xl:text-title" data-testid="features-verdict-title">
          {!view ? <span className="inline-flex items-center gap-2"><Blocks size={18} aria-hidden="true" />{tr('features.open')}</span>
            : view.behind > 0
              ? <>{tr('feat.verdict.behind', { n: view.behind })}<span className="font-medium text-app-text-muted">{tr('feat.verdict.rest', { total: view.leaves })}</span></>
              : tr('feat.verdict.none', { total: view.leaves })}
        </h1>
        {parts.length > 0 && <p className="m-0 mt-1 text-compact tabular-nums text-app-text-secondary">{parts.join(' · ')}</p>}
      </div>
      {okAt !== null && (
        <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap pt-1.5 text-mini tabular-nums text-app-text-muted @max-2xl:hidden" data-testid="features-live">
          <span className={`h-1.5 w-1.5 rounded-full ${down ? 'bg-amber-500' : 'bg-emerald-500 dark:bg-emerald-400'}`} />
          {tr('feat.live', { time: fmt.time(okAt) })}
        </span>
      )}
    </div>
  );
}

function Ranking({ view, tr }: { view: FeaturesView; tr: Tr }) {
  const ranked = view.systems.filter((s) => s.pct !== null);
  if (ranked.length === 0) return null;
  // Read down the first column, then the second: 1 to 8 on the left, 9 to 16 on the right.
  const half = Math.ceil(ranked.length / 2);
  return (
    <>
      <h2 className={SECTION}>{tr('feat.ranking')}<span className={SECTION_COUNT}>{ranked.length}</span><span className={`${SECTION_REST} @max-2xl:hidden`}>{tr('feat.ranking.hint')}</span></h2>
      <div
        className={`${BOX} grid grid-flow-col grid-cols-2 gap-x-6 px-3 py-2 [grid-template-rows:var(--rank-rows)] @max-2xl:grid-flow-row @max-2xl:grid-cols-1 @max-2xl:[grid-template-rows:none]`}
        style={{ '--rank-rows': `repeat(${half}, auto)` } as React.CSSProperties}
        data-testid="features-ranking"
      >
        {ranked.map((s) => {
          const ours = s.id === OURS;
          return (
            <div key={s.id} data-testid="features-system" data-ours={ours} className="flex items-center gap-2 py-[3px] text-compact">
              <span className="w-5 flex-none text-right text-mini tabular-nums text-app-text-muted">{s.rank}</span>
              <span className={`w-[112px] flex-none truncate ${ours ? 'font-semibold text-app-text' : 'text-app-text-body'}`} title={s.name}>{s.name}</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-app-border">
                <span className={`block h-full rounded-full ${ours ? 'bg-primary' : 'bg-app-text-faint/60'}`} style={{ width: `${Math.max(2, s.pct ?? 0)}%` }} />
              </span>
              <span className={`w-9 flex-none text-right text-mini tabular-nums ${ours ? 'font-semibold text-primary' : 'text-app-text-secondary'}`}>{s.pct}%</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Leaf({ leaf, tr, fmt, open, onToggle }: { leaf: FeatureLeaf; tr: Tr; fmt: ReturnType<typeof useFormats>; open: boolean; onToggle: () => void }) {
  const sub = [leaf.group, leaf.desc].filter(Boolean).join(' · ');
  const news = leaf.news.length === 1 ? tr('feat.newsOne') : leaf.news.length > 1 ? tr('feat.news', { n: leaf.news.length }) : null;
  return (
    <div data-testid="features-leaf" data-leaf={leaf.id} data-behind={leaf.behind} className="border-t border-app-border-subtle first:border-t-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-app-hover @max-2xl:flex-wrap @max-2xl:py-2.5 ${open ? 'bg-primary/[0.06]' : ''}`}>
        {open ? <ChevronDown size={13} className="flex-none text-app-text-muted" aria-hidden="true" /> : <ChevronRight size={13} className="flex-none text-app-text-muted" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-compact text-app-text">{leaf.name}</span>
          {sub && <span className="mt-0.5 block truncate text-mini text-app-text-secondary" title={sub}>{sub}</span>}
        </span>
        <span className="flex flex-none items-center gap-2.5 @max-2xl:w-full @max-2xl:pl-[23px]">
          <span data-testid="features-ours" className={`rounded-xs px-1.5 py-px text-mini font-medium ${STATUS_CHIP[leaf.ours]}`}>{tr('feat.ourStatus')}: {tr(`feat.status.${leaf.ours}`)}</span>
          <span className="w-[112px] text-mini tabular-nums text-app-text-secondary @max-2xl:w-auto">{tr('feat.have', { n: leaf.have, of: leaf.of })}</span>
          <span className="w-[68px] text-right text-mini tabular-nums text-app-text-muted @max-2xl:ml-auto @max-2xl:w-auto">{news ?? ''}</span>
        </span>
      </button>
      {open && (
        <div data-testid="features-leaf-detail" className="border-t border-app-border-subtle bg-app-inset px-3 py-2.5 pl-[35px] text-mini">
          {leaf.desc && <p className="m-0 mb-1.5 text-compact text-app-text-body">{leaf.desc}</p>}
          <p className="m-0"><span className="text-app-text-muted">{tr('feat.withIt')}: </span><span className="text-app-text">{leaf.withIt.join(', ') || tr('feat.nobody')}</span></p>
          {leaf.partly.length > 0 && <p className="m-0 mt-0.5"><span className="text-app-text-muted">{tr('feat.partly')}: </span><span className="text-app-text-body">{leaf.partly.join(', ')}</span></p>}
          {leaf.news.length > 0 && (
            <div className="mt-2">
              <div className="mb-0.5 flex items-baseline gap-2">
                <span className="font-semibold uppercase tracking-wide text-app-text-tertiary">{tr('feat.newsTitle')}</span>
                <span data-testid="features-news-hint" className="text-app-text-muted">{tr('feat.newsHint')}</span>
              </div>
              {leaf.news.slice(0, NEWS_SHOWN).map((n, i) => (
                <div key={i} data-testid="features-news" className="flex min-w-0 items-baseline gap-2 py-0.5">
                  <span className="w-12 flex-none tabular-nums text-app-text-muted">{n.at !== null ? fmt.day(n.at) : ''}</span>
                  {n.source && <span data-testid="features-news-source" className="max-w-[96px] flex-none truncate text-app-text-secondary">{n.source}</span>}
                  {n.url ? (
                    <a href={n.url} target="_blank" rel="noopener noreferrer" lang="en" className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline">
                      <span className="truncate">{n.title}</span><ExternalLink size={11} className="flex-none" aria-hidden="true" />
                    </a>
                  ) : <span lang="en" className="truncate text-app-text-body">{n.title}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
