import { Check, ChevronRight, FileText, FolderSearch, Plus, Search, X } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { TONE_CHIP } from '../tone';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { TextField } from '../primitives/Field';
import { Spinner } from '../primitives/Progress';
import { PanelHeading, PanelSection, KeyValue, SidePanel } from '../primitives/Panel';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { CatalogHitModel, FacetModel, WhereHitModel } from './model';
import { ConnectionChip, ProgramTile } from './Shared';

export type SearchMode = 'where' | 'catalog';

function WhereHit({ hit, copy }: { hit: WhereHitModel; copy: UiCopy }) {
  const w = copy.programs.search.where;
  return (
    <article className="rounded-lg border border-app-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-body-lg font-semibold leading-5 text-app-text">{hit.document}</h3>
        </div>
        <span className="mt-1 text-compact text-app-text-tertiary">{w.holdsIn}</span>
        <button
          type="button"
          onClick={hit.program.onOpen || undefined}
          className={clsx('inline-flex h-7 items-center gap-2 rounded-lg bg-black/[0.05] px-2.5 text-prose font-medium text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]', FOCUS_RING)}
          data-tip={w.openProgram}
        >
          {hit.program.name}
          <ChevronRight size={13} className="text-app-text-tertiary" aria-hidden="true" />
        </button>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-2.5 text-prose sm:grid-cols-[120px_1fr]">
        <dt className="text-app-text-secondary">{w.path}</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-1 text-app-text">
          {hit.path.map((p, i) => (
            <span key={`${p}-${i}`} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-app-text-faint" aria-hidden="true" />}
              <span className={i === hit.path.length - 1 ? 'font-medium' : 'text-app-text-secondary'}>{p}</span>
            </span>
          ))}
        </dd>
        <dt className="text-app-text-secondary">{w.how}</dt>
        <dd className="min-w-0 text-app-text">
          <ConnectionChip kind={hit.fetchKind} label={hit.fetchLabel} className="mb-1.5" />
          <p className="leading-5 text-app-text-secondary">{hit.fetch}</p>
        </dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-app-border pt-3">
        {hit.busy ? (
          <span className="inline-flex items-center gap-2 text-prose text-app-text-secondary"><Spinner size={13} />{w.fetching}</span>
        ) : (
          <Button icon={FolderSearch} onClick={hit.onFetch}>{w.fetchExample}</Button>
        )}
        {hit.fetched && (
          <span className={clsx('inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-prose', TONE_CHIP.green)}>
            <Check size={13} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0">{w.fetched}: {hit.fetched}</span>
          </span>
        )}
      </div>
    </article>
  );
}

function CatalogHit({ hit, copy, openLink, onLink }: {
  hit: CatalogHitModel;
  copy: UiCopy;
  openLink?: string;
  onLink: (hitId: string, label: string) => void;
}) {
  const s = copy.programs.search.catalog;
  return (
    <article className="rounded-lg border border-app-border bg-surface p-4">
      <div className="flex items-start gap-3.5">
        <ProgramTile initial={hit.initial} color={hit.color} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-body-lg font-semibold leading-5 text-app-text">{hit.name}</h3>
            <span className="text-prose text-app-text-tertiary">{hit.maker}</span>
            {hit.tag && <span className={clsx('inline-flex h-5 items-center rounded px-1.5 text-mini', TONE_CHIP[hit.tag.tone])}>{hit.tag.text}</span>}
          </div>
          <p className="mt-1 text-prose leading-5 text-app-text-secondary">{hit.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ConnectionChip kind={hit.connection.kind} label={hit.connection.label} />
            {hit.facts.map((f) => <span key={f} className="inline-flex h-5 items-center rounded bg-black/[0.05] px-1.5 text-mini text-app-text-secondary dark:bg-white/10">{f}</span>)}
            {hit.links.map((l) => {
              const on = openLink === `${hit.id}:${l.label}`;
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onLink(hit.id, l.label)}
                  className={clsx('inline-flex h-5 items-center gap-1 rounded bg-sky-500/10 px-1.5 text-mini font-medium text-sky-700 hover:bg-sky-500/20 dark:text-sky-300', FOCUS_RING, on && 'bg-sky-500/25')}
                >
                  <FileText size={12} aria-hidden="true" />
                  {l.label}
                </button>
              );
            })}
          </div>
          {openLink?.startsWith(`${hit.id}:`) && <p className="mt-2 rounded-md bg-app-inset px-2.5 py-1.5 text-mini text-app-text-secondary">{s.sourceLine(openLink.slice(hit.id.length + 1), '05/11/2026')}</p>}
        </div>
        <Button
          icon={hit.archived ? Check : hit.primaryIcon === 'plus' ? Plus : undefined}
          onClick={hit.onPrimary}
          className={clsx(hit.archived && 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300')}
        >
          {hit.primaryLabel}
        </Button>
      </div>
    </article>
  );
}

/**
 * Smart search of programs (p03). Two questions share one box: «where does
 * this document live» (which program holds it, the path to it and how Topics
 * fetches it) and «which program should we add» (the catalogue, with what the
 * question was understood as, which can be loosened). Handlers are the
 * container's; the lists are already filtered by the query.
 */
export function ProgramSearchScreen({
  copy, mode, onMode, query, onQuery, suggestions, onSuggestion, facets, onFacet, whereHits, catalogHits, openLink, onLink, stats, latest,
  backLabel, onBack, onEmptyAction, phone,
}: {
  copy: UiCopy;
  mode: SearchMode;
  onMode: (m: SearchMode) => void;
  query: string;
  onQuery: (q: string) => void;
  suggestions: string[];
  onSuggestion: (s: string) => void;
  facets: FacetModel[];
  onFacet: (id: string) => void;
  whereHits: WhereHitModel[];
  catalogHits: CatalogHitModel[];
  openLink?: string;
  onLink: (hitId: string, label: string) => void;
  stats: Array<[string, number]>;
  latest: Array<{ name: string; where: string }>;
  backLabel: string;
  onBack: () => void;
  onEmptyAction: Action;
  phone?: boolean;
}) {
  const s = copy.programs.search;
  const hits = mode === 'where' ? whereHits.length : catalogHits.length;
  const main = (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-3">
        <SegmentedControl
          value={mode}
          onChange={onMode}
          ariaLabel={s.modesLabel}
          options={[{ value: 'where', label: s.modes.where }, { value: 'catalog', label: s.modes.catalog }]}
        />
      </div>
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/[0.06] p-1.5">
        <TextField
          value={query}
          onChange={onQuery}
          placeholder={mode === 'where' ? s.placeholderWhere : s.placeholderCatalog}
          icon={Search}
          type="search"
        />
      </div>
      {mode === 'where' ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-compact text-app-text-tertiary">{s.suggestions}</span>
          {suggestions.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={query.trim().toLowerCase() === g}
              onClick={() => onSuggestion(g)}
              className={clsx('inline-flex h-6 items-center rounded-full bg-black/[0.05] px-2.5 text-mini font-medium text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08]', FOCUS_RING, query.trim().toLowerCase() === g && 'bg-primary text-white hover:bg-primary')}
            >
              {g}
            </button>
          ))}
        </div>
      ) : (
        facets.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label={s.understood}>
            <span className="text-compact text-app-text-tertiary">{s.understood}</span>
            {facets.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={f.on}
                onClick={() => onFacet(f.id)}
                className={clsx(
                  'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-mini transition-colors', FOCUS_RING,
                  f.on ? 'bg-black/[0.06] text-app-text dark:bg-white/10' : 'text-app-text-tertiary line-through ring-1 ring-inset ring-app-border',
                )}
              >
                {f.label}
                {f.on && <X size={11} className="text-app-text-tertiary" aria-hidden="true" />}
              </button>
            ))}
          </div>
        )
      )}
      <p className="mt-3 text-compact text-app-text-tertiary" aria-live="polite">{s.results(hits)}</p>
      <div className="mt-2 space-y-3">
        {mode === 'where' && whereHits.map((h) => <WhereHit key={h.id} hit={h} copy={copy} />)}
        {mode === 'catalog' && catalogHits.map((h) => <CatalogHit key={h.id} hit={h} copy={copy} openLink={openLink} onLink={onLink} />)}
        {hits === 0 && (
          <div className="rounded-lg border border-app-border bg-surface">
            <EmptyState
              icon={Search}
              title={mode === 'where' ? s.emptyWhereTitle(query.trim()) : s.emptyCatalogTitle}
              className="min-h-[220px]"
              action={<Button onClick={onEmptyAction}>{mode === 'where' ? s.emptyCatalogAction : s.clearFacets}</Button>}
            >
              {mode === 'where' ? s.emptyWhereBody : s.emptyCatalogBody}
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
  const side = (
    <>
      <PanelHeading tag={s.side.tag} title={s.side.title}>{s.side.body}</PanelHeading>
      <PanelSection label={s.side.numbers}>
        {stats.map(([label, n]) => <KeyValue key={label} label={label} value={n} />)}
      </PanelSection>
      <PanelSection label={s.side.collects}>
        <p className="text-prose leading-6 text-app-text-secondary">{s.side.collectsBody}</p>
      </PanelSection>
      <PanelSection label={s.side.latest} className="border-b-0">
        {latest.map((l) => <KeyValue key={`${l.name}-${l.where}`} label={l.name} value={<span className="text-app-text-secondary">{l.where}</span>} />)}
      </PanelSection>
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader leading={<BackButton label={backLabel} onClick={onBack} copy={copy} />} crumbs={[{ label: s.title }]} />
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {main}
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {main}
          <SidePanel width={340}>{side}</SidePanel>
        </div>
      )}
    </div>
  );
}
