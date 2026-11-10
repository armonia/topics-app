import { useState, type DragEvent, type ReactNode } from 'react';
import { CircleCheck, CircleDashed, CircleDot, Circle, GripVertical, Kanban, MoveRight, Plus, Search } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { TextField } from '../primitives/Field';
import { MenuButton } from '../primitives/Menu';
import { PaneHeader } from '../shell/PaneHeader';
import { Monogram } from '../shell/SidebarRows';
import { FOCUS_RING, pressable } from '../shell/pressable';
import type { BoardCardModel, BoardColumnId, BoardColumnModel, BoardOrgChipModel } from './model';

const COLUMN_GLYPH: Record<BoardColumnId, { icon: typeof Circle; className: string }> = {
  backlog: { icon: CircleDashed, className: 'text-app-text-tertiary' },
  todo: { icon: Circle, className: 'text-app-text-secondary' },
  progress: { icon: CircleDot, className: 'text-sky-600 dark:text-sky-400' },
  review: { icon: CircleDot, className: 'text-rose-500' },
  done: { icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-400' },
};

/** One card of the Board. Opens its target; a menu moves it, and on a pointer it can be dragged. */
export function BoardCard({ card, copy, columnLabels, canMove, moveDeniedTitle, dragging, onOpen, onMove, onDragStart, onDragEnd }: {
  card: BoardCardModel;
  copy: UiCopy;
  columnLabels: Record<BoardColumnId, string>;
  canMove: boolean;
  moveDeniedTitle?: string;
  dragging?: boolean;
  onOpen?: () => void;
  onMove: (to: BoardColumnId) => void;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
}) {
  const b = copy.orgs.board;
  return (
    <div
      {...pressable(onOpen)}
      role="button"
      aria-label={card.title}
      data-board-card={card.id}
      draggable={canMove}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={clsx(
        'group rounded-lg border border-app-border bg-surface px-3 py-2.5 text-left transition-[background-color,border-color,opacity]',
        onOpen && 'cursor-pointer hover:border-app-border-light hover:bg-black/[0.02] dark:hover:bg-white/[0.04]',
        FOCUS_RING,
        dragging && 'opacity-40',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-compact text-app-text-secondary">
        <span className="shrink-0" data-tip={card.org.name}><Monogram text={card.org.monogram} color={card.org.color} size={16} /></span>
        {/* The monogram names the organization; the room goes to the area, which says where the work comes from. */}
        <span className="min-w-0 flex-1 break-words" data-tip={card.org.name}>{card.area}</span>
        <span
          className="-mr-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MenuButton
            label={b.moveTo}
            icon={MoveRight}
            iconOnly
            variant="ghost"
            size="sm"
            align="right"
            disabled={!canMove}
            title={canMove ? b.moveTo : moveDeniedTitle}
            items={card.moveTo.map((c) => ({ id: c, label: b.moveItem(columnLabels[c]) }))}
            onSelect={(id) => onMove(id as BoardColumnId)}
            className="opacity-60 transition-opacity group-hover:opacity-100 coarse:opacity-100"
          />
        </span>
      </div>
      <div className="mt-1 text-body-lg font-semibold leading-[22px] text-app-text">{card.title}</div>
      {card.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {card.chips.map((c) => <Chip key={c.id} tone={c.tone} icon={c.icon}>{c.text}</Chip>)}
        </div>
      )}
    </div>
  );
}

function BoardColumn({ column, copy, columnLabels, canMove, moveDeniedTitle, draggingId, over, onOverChange, onOpen, onMove, onDragStartCard, onDragEnd }: {
  column: BoardColumnModel;
  copy: UiCopy;
  columnLabels: Record<BoardColumnId, string>;
  canMove: boolean;
  moveDeniedTitle?: string;
  draggingId?: string;
  over: boolean;
  onOverChange: (over: boolean) => void;
  onOpen: (id: string) => void;
  onMove: (id: string, to: BoardColumnId) => void;
  onDragStartCard: (id: string, e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const b = copy.orgs.board;
  const glyph = COLUMN_GLYPH[column.id];
  const Glyph = glyph.icon;
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    onOverChange(false);
    const id = e.dataTransfer.getData('text/plain');
    if (id) onMove(id, column.id);
  };
  return (
    <section
      aria-label={column.label}
      data-board-column={column.id}
      onDragOver={canMove ? (e) => { e.preventDefault(); onOverChange(true); } : undefined}
      onDragLeave={canMove ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onOverChange(false); } : undefined}
      onDrop={canMove ? onDrop : undefined}
      className={clsx(
        'flex min-h-0 w-[84vw] max-w-[360px] shrink-0 snap-center flex-col rounded-xl border bg-app-inset md:w-auto md:max-w-none md:min-w-[220px] md:flex-1',
        over ? 'border-primary bg-primary/[0.04]' : 'border-app-border',
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        <Glyph size={15} className={glyph.className} aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-compact font-semibold uppercase tracking-wide text-app-text">{column.label}</h2>
        <span className="text-compact tabular-nums text-app-text-tertiary">{column.cards.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {column.cards.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            copy={copy}
            columnLabels={columnLabels}
            canMove={canMove}
            moveDeniedTitle={moveDeniedTitle}
            dragging={draggingId === card.id}
            onOpen={() => onOpen(card.id)}
            onMove={(to) => onMove(card.id, to)}
            onDragStart={(e) => onDragStartCard(card.id, e)}
            onDragEnd={onDragEnd}
          />
        ))}
        {column.cards.length === 0 && (
          <div className="flex flex-1 items-start justify-center px-3 py-6 text-center text-compact text-app-text-tertiary">
            <span className="flex items-center gap-1.5"><GripVertical size={13} aria-hidden="true" />{b.columnEmpty}</span>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The Board of every organization the person belongs to (n17): the columns
 * Backlog to Done, filter chips per organization with their counts, a
 * search, and cards that open what they are about. A card moves by dragging
 * it to another column (pointer) or from its menu «Sposta in…» (phone, (allow-italian: quotes the Italian interface)
 * keyboard); the container decides what a move changes.
 */
export function BoardScreen({ columns, orgChips, activeOrg, onOrg, query, onQuery, totalVisible, onOpen, onMove, onNew, newTitle, canMove, moveDeniedTitle, onClear, copy, phone }: {
  columns: BoardColumnModel[];
  orgChips: BoardOrgChipModel[];
  /** `all` or an organization id. */
  activeOrg: string;
  onOrg: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  /** Cards on show across all columns. */
  totalVisible: number;
  onOpen: (cardId: string) => void;
  onMove: (cardId: string, to: BoardColumnId) => void;
  onNew: Action;
  newTitle?: string;
  canMove: boolean;
  moveDeniedTitle?: string;
  onClear: () => void;
  copy: UiCopy;
  phone?: boolean;
}): ReactNode {
  const b = copy.orgs.board;
  const [draggingId, setDraggingId] = useState<string>();
  const [overId, setOverId] = useState<BoardColumnId>();
  const columnLabels = Object.fromEntries(columns.map((c) => [c.id, c.label])) as Record<BoardColumnId, string>;
  const allCount = orgChips.reduce((sum, c) => sum + c.count, 0);
  const filtered = Boolean(query) || activeOrg !== 'all';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: b.title }]}>
        <Button variant="primary" icon={Plus} onClick={onNew} title={newTitle}>{b.newCard}</Button>
      </PaneHeader>
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border px-4 py-2.5 md:flex-row md:items-center md:gap-3">
        <TextField
          type="search"
          icon={Search}
          value={query}
          onChange={onQuery}
          placeholder={b.searchPlaceholder}
          className="md:w-[280px]"
        />
        <div role="group" aria-label={b.orgFilter} className="scrollbar-none flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <FilterChip pressed={activeOrg === 'all'} onClick={() => onOrg('all')}>{b.all(allCount)}</FilterChip>
          {orgChips.map((c) => (
            <FilterChip key={c.id} pressed={activeOrg === c.id} tone={c.tone} onClick={() => onOrg(c.id)}>{`${c.label} ${c.count}`}</FilterChip>
          ))}
        </div>
        {!phone && <span className="ml-auto hidden shrink-0 text-compact text-app-text-tertiary xl:block">{b.hint}</span>}
      </div>
      {totalVisible === 0 && filtered ? (
        <EmptyState icon={Kanban} title={b.emptyTitle} action={<Button onClick={onClear}>{b.clearFilters}</Button>}>
          {b.emptyBody}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 md:snap-none">
          {columns.map((col) => (
            <BoardColumn
              key={col.id}
              column={col}
              copy={copy}
              columnLabels={columnLabels}
              canMove={canMove}
              moveDeniedTitle={moveDeniedTitle}
              draggingId={draggingId}
              over={overId === col.id}
              onOverChange={(o) => setOverId((prev) => (o ? col.id : prev === col.id ? undefined : prev))}
              onOpen={onOpen}
              onMove={(id, to) => { setDraggingId(undefined); onMove(id, to); }}
              onDragStartCard={(id, e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; setDraggingId(id); }}
              onDragEnd={() => { setDraggingId(undefined); setOverId(undefined); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const CHIP_TONE: Record<string, string> = {
  neutral: 'bg-black/[0.05] text-app-text-secondary dark:bg-white/10',
  green: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  blue: 'bg-sky-500/15 text-sky-800 dark:text-sky-300',
  red: 'bg-rose-500/15 text-rose-800 dark:text-rose-300',
  violet: 'bg-violet-500/15 text-violet-800 dark:text-violet-300',
  pink: 'bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-300',
};

function FilterChip({ pressed, tone = 'neutral', onClick, children }: { pressed: boolean; tone?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      /* one organization at a time: the chosen one is «current», not a toggle */
      aria-current={pressed || undefined}
      onClick={onClick}
      className={clsx(
        'inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-compact font-medium transition-shadow',
        CHIP_TONE[tone],
        pressed ? 'ring-2 ring-primary/70' : 'hover:ring-1 hover:ring-black/15 dark:hover:ring-white/20',
        FOCUS_RING,
      )}
    >
      {children}
    </button>
  );
}
