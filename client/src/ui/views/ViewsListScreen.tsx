import { Plus, Search, Sparkles } from 'lucide-react';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { TextField } from '../primitives/Field';
import { Table } from '../primitives/Table';
import { PaneHeader } from '../shell/PaneHeader';
import { ViewCard } from './ViewCard';
import type { BlockId, BlockRowModel, ViewCardModel } from './model';

export type ViewScopeKey = 'org' | 'sector' | 'standard';

/**
 * The saved views (a01): the views of the organization, the ones that come
 * with the sector and the standard ones as cards, a search over them, the
 * way to create one (or to describe it in words), and the catalogue of the
 * blocks a view is made of. Handlers are optional; an absent one is a picture.
 */
export function ViewsListScreen({ copy, scope, onScope, counts, query, onQuery, cards, catalog, phone, deniedTitle, onCreate, onDescribe, onUseBlock, onOpen, onWhere, onAdd, onDuplicate, onRemove, metricLabel }: {
  copy: UiCopy;
  scope: ViewScopeKey;
  onScope: (s: ViewScopeKey) => void;
  counts: Record<ViewScopeKey, number>;
  query: string;
  onQuery: (q: string) => void;
  cards: ViewCardModel[];
  catalog: BlockRowModel[];
  phone?: boolean;
  /** Why creating and changing views is off for this person. */
  deniedTitle?: string;
  onCreate?: Action;
  onDescribe?: Action;
  onUseBlock?: (id: BlockId) => void;
  onOpen: (id: string) => Action;
  onWhere: (id: string) => Action;
  onAdd: (id: string) => Action;
  onDuplicate: (id: string) => Action;
  onRemove: (id: string) => Action;
  metricLabel: (id: string) => string;
}) {
  const v = copy.viewsMore.list;
  const scopes = (['org', 'sector', 'standard'] as const).map((s) => ({ value: s, label: `${v.scopes[s]} ${counts[s]}` }));
  const segmented = <SegmentedControl value={scope} options={scopes} onChange={onScope} ariaLabel={v.scopeLabel} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: copy.views.root, detail: v.subtitle }]}>
        {!phone && segmented}
        <Button variant="primary" icon={Plus} onClick={onCreate} title={onCreate === false ? deniedTitle : undefined}>{v.newView}</Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-4 py-4 sm:px-6">
          {phone && segmented}
          <TextField type="search" icon={Search} value={query} onChange={onQuery} placeholder={v.searchPlaceholder} className="max-w-[420px]" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((c) => (
              <ViewCard
                key={c.id}
                view={c}
                copy={copy}
                metricLabel={metricLabel(c.id)}
                deniedTitle={deniedTitle}
                onOpen={onOpen(c.id)}
                onWhere={onWhere(c.id)}
                onAdd={onAdd(c.id)}
                onDuplicate={onDuplicate(c.id)}
                onRemove={onRemove(c.id)}
              />
            ))}
            {cards.length > 0 && scope === 'org' && !query && (
              <section className="flex min-w-0 flex-col items-start justify-center gap-2 rounded-lg border border-dashed border-app-border p-4">
                <h3 className="flex items-center gap-2 text-prose font-semibold text-app-text"><Sparkles size={15} className="text-violet-600 dark:text-violet-300" aria-hidden="true" />{v.describeTitle}</h3>
                <p className="text-compact leading-5 text-app-text-secondary">{v.describeBody}</p>
                <Button size="sm" onClick={onDescribe} title={onDescribe === false ? deniedTitle : undefined}>{v.describeAction}</Button>
              </section>
            )}
          </div>
          {cards.length === 0 && (
            <div className="rounded-lg border border-app-border">
              {query ? (
                <EmptyState icon={Search} title={v.emptySearch(query)} action={<Button onClick={() => onQuery('')}>{v.clearSearch}</Button>} />
              ) : (
                <EmptyState icon={Plus} title={v.emptyScope} action={<Button variant="primary" onClick={onCreate}>{v.newView}</Button>}>{v.emptyScopeBody}</EmptyState>
              )}
            </div>
          )}
          <section aria-label={v.catalogTitle} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-body-lg font-semibold text-app-text">{v.catalogTitle}</h2>
              <p className="text-compact text-app-text-tertiary">{v.catalogNote}</p>
            </div>
            <Table
              ariaLabel={v.catalogTitle}
              columns={[
                { id: 'name', label: v.columns.block, width: 190 },
                { id: 'shows', label: v.columns.shows },
                { id: 'reads', label: v.columns.reads, width: 220 },
                { id: 'exists', label: v.columns.exists, width: 190 },
              ]}
              rows={catalog.map((b) => ({
                id: b.id,
                onOpen: onUseBlock ? () => onUseBlock(b.id) : undefined,
                cells: {
                  name: <span className="font-medium">{b.name}</span>,
                  shows: b.shows,
                  reads: b.reads,
                  exists: b.exists ? <Chip tone="green">{b.exists}</Chip> : <span className="text-app-text-tertiary">{v.newBlock}</span>,
                },
              }))}
            />
            <p className="text-mini text-app-text-tertiary">{v.catalogHint}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
