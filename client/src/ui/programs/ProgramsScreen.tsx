import type { ReactNode } from 'react';
import { CheckCircle2, CircleAlert, Clock, Plus, Search } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { FieldChip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { TextField } from '../primitives/Field';
import { SectionLabel, SidePanel } from '../primitives/Panel';
import { Spinner } from '../primitives/Progress';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING, pressable } from '../shell/pressable';
import type { ConnectionFamily, ProgramGroupModel, ProgramRowModel, ProgramStateKind } from './model';
import { STATE_TONE } from './model';
import { ConnectionChip, StatePill } from './Shared';

/*
 * One grid for the header and every row (rows are subgrids): a column takes room in proportion to its share and never
 * goes below its longest word or widest pill, so a pill never runs into the next column; below that the frame scrolls.
 */
const TABLE_GRID = 'grid w-min min-w-full gap-x-3 grid-cols-[minmax(min-content,116fr)_minmax(min-content,130fr)_minmax(min-content,120fr)_minmax(min-content,84fr)_minmax(min-content,116fr)_minmax(min-content,72fr)]';
const GRID = 'col-span-full grid grid-cols-subgrid items-center';

function StateGlyph({ kind }: { kind: ProgramStateKind }) {
  if (kind === 'ok') return <CheckCircle2 size={12} aria-hidden="true" />;
  if (kind === 'to-connect') return <Clock size={12} aria-hidden="true" />;
  if (kind === 'failed') return <CircleAlert size={12} aria-hidden="true" />;
  if (kind === 'testing') return <Spinner size={11} />;
  return null;
}

function Row({ row, copy, phone }: { row: ProgramRowModel; copy: UiCopy; phone?: boolean }) {
  const open = row.onOpen || undefined;
  if (phone) {
    return (
      <div
        role="row"
        aria-selected={row.selected}
        {...pressable(open)}
        className={clsx(
          'flex flex-col gap-2 border-b border-app-border px-4 py-3 last:border-b-0',
          row.selected ? 'bg-sky-500/[0.08]' : open && 'hover:bg-app-hover',
          open && ['cursor-pointer transition-colors', FOCUS_RING],
        )}
      >
        <div role="cell" className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-prose font-semibold text-app-text [overflow-wrap:break-word]">{row.name}</div>
            {row.sub && <div className="text-mini text-app-text-tertiary [overflow-wrap:break-word]">{row.sub}</div>}
          </div>
          <StatePill tone={STATE_TONE[row.state.kind]} icon={<StateGlyph kind={row.state.kind} />}>{row.state.text}</StatePill>
        </div>
        <div role="cell" className="flex flex-wrap gap-1">
          {row.holds.map((f) => <FieldChip key={f.name} field={f} />)}
        </div>
        <div role="cell" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-app-text-secondary">
          <ConnectionChip kind={row.connection.kind} label={row.connection.label} />
          <span>{row.usage}</span>
          {row.alternatives && <span>{row.alternatives}</span>}
        </div>
      </div>
    );
  }
  return (
    <div
      role="row"
      aria-selected={row.selected}
      {...pressable(open)}
      className={clsx(
        GRID,
        'min-h-[52px] border-b border-app-border px-4 py-2 last:border-b-0',
        row.selected ? 'bg-sky-500/[0.08]' : open && 'hover:bg-app-hover',
        open && ['cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60'],
      )}
    >
      <div role="cell" className="min-w-0">
        <div className="text-prose font-semibold text-app-text [overflow-wrap:break-word]">{row.name}</div>
        {row.sub && <div className="text-mini text-app-text-tertiary [overflow-wrap:break-word]">{row.sub}</div>}
      </div>
      <div role="cell" className="flex min-w-0 flex-wrap gap-1">
        {row.holds.map((f) => <FieldChip key={f.name} field={f} />)}
      </div>
      <div role="cell" className="min-w-0"><ConnectionChip kind={row.connection.kind} label={row.connection.label} /></div>
      <div role="cell" className="min-w-0 text-prose text-app-text-secondary">{row.usage}</div>
      <div role="cell" className="min-w-0">
        <StatePill tone={STATE_TONE[row.state.kind]} icon={<StateGlyph kind={row.state.kind} />}>{row.state.text}</StatePill>
      </div>
      <div role="cell" className="min-w-0 text-prose text-app-text-secondary [overflow-wrap:break-word]">{row.alternatives ?? copy.programs.list.notUsed}</div>
    </div>
  );
}

/**
 * The programs of the organization, grouped by area (w06): what each holds,
 * how Topics reaches it, which flows use it, where it stands and what could
 * replace it. A search box and a filter on «how it connects» narrow the list;
 * a row opens the program in the panel on the right (below the list on a
 * phone). Handlers are optional: without them it is a picture.
 */
export function ProgramsScreen({
  copy, groups, total, query, onQuery, families, onFamily, onAdd, onAddQuery, panel, phone,
}: {
  copy: UiCopy;
  groups: ProgramGroupModel[];
  total: number;
  query: string;
  onQuery: (q: string) => void;
  families: Array<{ id: ConnectionFamily | 'all'; label: string; count: number; active: boolean }>;
  onFamily: (id: ConnectionFamily | 'all') => void;
  onAdd: Action;
  /** Adds what was typed as a new program: leads to the search for it. */
  onAddQuery: Action;
  panel: ReactNode;
  phone?: boolean;
}) {
  const c = copy.programs.list;
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const search = (
    <TextField
      value={query}
      onChange={onQuery}
      placeholder={c.searchPlaceholder}
      icon={Search}
      type="search"
      size="sm"
      className={phone ? 'w-full' : 'w-[300px]'}
    />
  );
  const table = (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
      {phone && <div className="mb-3">{search}</div>}
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={c.filterLabel}>
        {families.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={f.active}
            onClick={() => onFamily(f.id)}
            className={clsx(
              'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-mini font-medium transition-colors',
              FOCUS_RING,
              f.active ? 'bg-primary text-white' : 'bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]',
            )}
          >
            {f.label}
            <span className={clsx('tabular-nums', f.active ? 'text-white/80' : 'text-app-text-tertiary')}>{f.count}</span>
          </button>
        ))}
      </div>
      <div className="min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface">
        <div role="table" aria-label={c.title} className={phone ? undefined : TABLE_GRID}>
          {!phone && <div role="row" className={clsx(GRID, 'h-9 border-b border-app-border bg-app-inset px-4 text-compact font-medium text-app-text-secondary')}>
            <span role="columnheader">{c.columns.program}</span>
            <span role="columnheader">{c.columns.holds}</span>
            <span role="columnheader">{c.columns.connection}</span>
            <span role="columnheader">{c.columns.usedBy}</span>
            <span role="columnheader">{c.columns.state}</span>
            <span role="columnheader">{c.columns.alternatives}</span>
          </div>}
          {groups.filter((g) => g.rows.length > 0).map((g) => (
            <div key={g.id} role="rowgroup" className={phone ? undefined : GRID}>
              <div className="col-span-full border-b border-app-border bg-app-inset/60 px-4 py-2"><SectionLabel>{g.label}</SectionLabel></div>
              {g.rows.map((r) => <Row key={r.id} row={r} copy={copy} phone={phone} />)}
            </div>
          ))}
        </div>
        {shown === 0 && (
          <EmptyState icon={Search} title={c.emptyTitle} className="min-h-[220px]" action={
            <>
              {query.trim() && <Button variant="primary" icon={Plus} onClick={onAddQuery}>{c.addFromQuery(query.trim())}</Button>}
              <Button onClick={() => { onQuery(''); onFamily('all'); }}>{c.emptyReset}</Button>
            </>
          }>
            {c.emptyBody}
          </EmptyState>
        )}
      </div>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={[{ label: c.title, detail: c.count(total) }]}>
        {!phone && search}
        <Button variant="primary" icon={Plus} onClick={onAdd}>{c.add}</Button>
      </PaneHeader>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {table}
          <div className="border-t border-app-border bg-surface">{panel}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {table}
          <SidePanel width={360}>{panel}</SidePanel>
        </div>
      )}
    </div>
  );
}

