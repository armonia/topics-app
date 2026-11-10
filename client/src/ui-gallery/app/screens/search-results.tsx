/**
 * The full results of a search (`/cerca/:q`, `/cerca/:q/:kind`): the same allow-italian: quotes the words on screen
 * ranking and groups as the palette, nothing cut, the words found in `<mark>`.
 */
import { Search } from 'lucide-react';
import type { ScreenCtx, SearchEntry } from '../kit';
import { PaneHeader } from '../../../ui/shell/PaneHeader';
import { SubNav } from '../../../ui/shell/SubNav';
import { Marked } from '../../../ui/shell/Marked';
import { EmptyState } from '../../../ui/primitives/EmptyState';
import { SectionLabel } from '../../../ui/primitives/Panel';
import { TextField } from '../../../ui/primitives/Field';
import type { SearchKind } from '../../../ui/copy/app';
import { groupHits, isSearchKind, queryWords, searchHits } from '../search';
import { SEARCH_KIND_ICON, resultsPath } from '../palette';

/** The full results of a query, every kind or only `kind`. */
export function ResultsPage({ q, kind, ctx, entries }: { q: string; kind?: SearchKind; ctx: ScreenCtx; entries: SearchEntry[] }) {
  const a = ctx.copy.app.search;
  const words = queryWords(q);
  const all = groupHits(searchHits(entries, q));
  const total = all.reduce((n, g) => n + g.hits.length, 0);
  const shown = kind ? all.filter((g) => g.id === kind) : all;
  const count = shown.reduce((n, g) => n + g.hits.length, 0);
  const title = kind ? a.kindTitle(a.groups[kind], q) : a.resultsTitle(q);
  const nav = [
    { id: 'all', label: a.allKinds, count: total, active: !kind },
    ...all.flatMap((g) => (isSearchKind(g.id) ? [{ id: g.id, label: a.groups[g.id], icon: SEARCH_KIND_ICON[g.id], count: g.hits.length, active: kind === g.id }] : [])),
  ];
  return (
    <div data-search-page="" className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={[{ label: title, detail: a.count(count) }]}>
        <div className="w-[280px] max-md:hidden">
          <TextField size="sm" icon={Search} value={q} onChange={(next) => next.trim() && ctx.go(resultsPath(next, kind))} placeholder={a.placeholder} type="search" />
        </div>
      </PaneHeader>
      {total > 0 && <SubNav items={nav} label={a.resultsTitle(q)} onSelect={(id) => ctx.go(resultsPath(q, id === 'all' ? undefined : id))} className="px-4 md:px-8" />}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8">
        {shown.length ? shown.map((g) => {
          const known = isSearchKind(g.id) ? g.id : undefined;
          const GroupIcon = known ? SEARCH_KIND_ICON[known] : undefined;
          return (
            <section key={g.id} data-search-group={g.id} className="mx-auto mb-5 max-w-[760px]">
              <SectionLabel className="mb-1.5 flex items-center gap-1.5">
                {GroupIcon && <GroupIcon size={12} aria-hidden="true" />}
                {known ? a.groups[known] : g.label}
              </SectionLabel>
              <ul className="flex flex-col gap-1">
                {g.hits.map(({ entry: e, via }) => {
                  const Icon = e.icon;
                  return (
                    <li key={`${e.id}|${e.path}`}>
                      <button
                        type="button"
                        data-search-result={g.id}
                        onClick={() => ctx.go(e.path)}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.06]"
                      >
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-black/[0.05] text-app-text-secondary dark:bg-white/[0.08]">
                          <Icon size={15} aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-prose font-medium text-app-text"><Marked text={e.title} words={words} /></span>
                          {(e.detail || via) && (
                            <span className="block truncate text-mini text-app-text-secondary">
                              {e.detail && <Marked text={e.detail} words={words} />}
                              {via && <>{e.detail ? ' · ' : ''}<Marked text={via} words={words} /></>}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        }) : (
          <EmptyState icon={Search} title={a.empty(q)}>{a.emptyHint}</EmptyState>
        )}
      </div>
    </div>
  );
}
