import { CheckCircle2, FlaskConical, Plus, Power, Search, Sparkles, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { Action, Tone } from '../types';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { Card } from '../primitives/Card';
import { Table, type TableColumnModel } from '../primitives/Table';
import { TextField, Select } from '../primitives/Field';
import { Tabs } from '../primitives/Tabs';
import type { MenuItemModel } from '../primitives/Menu';
import { PaneHeader } from '../shell/PaneHeader';
import { Avatar } from '../shell/SidebarRows';
import { RowMenu } from './RowMenu';

export type FlowStatus = 'attivo' | 'collaudo' | 'bozza' | 'spento';

export interface FlowRowModel {
  id: string;
  name: string;
  /** `versione 4 · 9 blocchi`, already worded. */
  subtitle: string;
  status: FlowStatus;
  /** A live flow whose next version is on trial: «versione 5 in collaudo», under the status. */
  trial?: string;
  trigger: string;
  /** Items today, an estimate; none for a flow that does not run. */
  today?: number;
  /** What waits for a person: the count and the office it waits at. */
  stuck?: { label: string };
  errors?: number;
  owner: { label: string; monogram: string; color: string };
  /** Already worded: «ieri», «3/11». */
  modified: string;
}

export interface FlowTabModel {
  value: string;
  label: string;
  count: number;
}

export interface SuggestionCardModel {
  id: string;
  title: string;
  body: string;
}

const STATUS_VIEW: Record<FlowStatus, { tone: Tone; icon: LucideIcon }> = {
  attivo: { tone: 'green', icon: CheckCircle2 },
  collaudo: { tone: 'blue', icon: FlaskConical },
  bozza: { tone: 'neutral', icon: Sparkles },
  spento: { tone: 'neutral', icon: Power },
};

/** The chip that says in which state a flow is. */
export function FlowStatusChip({ status, copy, version }: { status: FlowStatus; copy: UiCopy; version?: number }) {
  const v = STATUS_VIEW[status];
  return <Chip tone={v.tone} icon={v.icon} strong>{copy.flowBuild.status[status]}{version ? ` · v${version}` : ''}</Chip>;
}

/**
 * The list of flows (n01): what each one starts from, how many items it saw
 * today, what waits for a person, who answers for it. The filters, the search
 * and the menu of every row are the caller's: this draws what it is given,
 * and an empty result says so and offers the way back.
 */
export function FlowListScreen({
  copy, crumbs, rows, tabs, tab, onTab, query, onQuery, offices, office, onOffice, onNew, newTitle, onTestAll, testTitle,
  onOpen, onOpenStuck, menuItems, onMenu, suggestions, onSuggestion, onAllTemplates, onResetFilters, phone,
}: {
  copy: UiCopy;
  crumbs: Array<{ label: string; detail?: string }>;
  rows: FlowRowModel[];
  tabs: FlowTabModel[];
  tab: string;
  onTab: (v: string) => void;
  query: string;
  onQuery: (v: string) => void;
  offices: Array<{ value: string; label: string }>;
  office: string;
  onOffice: (v: string) => void;
  onNew: Action;
  /** Why «new» is off for this person. */
  newTitle?: string;
  onTestAll: Action;
  testTitle?: string;
  onOpen: (id: string) => void;
  onOpenStuck: (id: string) => void;
  menuItems: (id: string) => MenuItemModel[];
  onMenu: (id: string, item: string) => void;
  suggestions: SuggestionCardModel[];
  onSuggestion: (id: string) => Action;
  onAllTemplates: () => void;
  onResetFilters: () => void;
  phone?: boolean;
}) {
  const t = copy.flowBuild.list;
  const columns: TableColumnModel[] = [
    { id: 'flow', label: t.columns.flow },
    { id: 'status', label: t.columns.status, width: 126 },
    { id: 'start', label: t.columns.start, width: 140 },
    { id: 'today', label: t.columns.today, width: 108, align: 'right' },
    { id: 'stuck', label: t.columns.stuck, width: 146 },
    { id: 'errors', label: t.columns.errors, width: 112, align: 'right' },
    { id: 'owner', label: t.columns.owner, width: 176 },
    { id: 'modified', label: t.columns.modified, width: 104 },
    { id: 'menu', label: '', width: 56 },
  ];
  const dash = <span className="text-app-text-faint">—</span>; // allow-emdash: empty-cell placeholder
  const tableRows = rows.map((r) => ({
    id: r.id,
    onOpen: () => onOpen(r.id),
    muted: r.status === 'spento', // allow-italian: state identifier, not shown
    cells: {
      flow: (
        <span className="block min-w-0 whitespace-normal">
          <span className="block font-semibold leading-5 text-app-text">{r.name}</span>
          <span className="block truncate text-compact font-normal text-app-text-tertiary">{r.subtitle}</span>
        </span>
      ),
      status: r.trial ? (
        <span className="flex flex-col items-start gap-1">
          <FlowStatusChip status={r.status} copy={copy} />
          <span className="text-compact leading-4 text-app-text-tertiary">{r.trial}</span>
        </span>
      ) : <FlowStatusChip status={r.status} copy={copy} />,
      start: <span className="block whitespace-normal leading-5 text-app-text">{r.trigger}</span>,
      today: r.today === undefined ? dash : <span data-tip={t.todayTitle}>{r.today}</span>,
      stuck: r.stuck ? (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            data-tip={t.openStuck}
            onClick={() => onOpenStuck(r.id)}
            className="inline-flex h-5 items-center rounded bg-amber-500/15 px-1.5 text-mini font-medium text-amber-800 transition-colors hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-amber-300"
          >
            {r.stuck.label}
          </button>
        </span>
      ) : <span className="text-app-text-tertiary">{r.status === 'bozza' ? '—' : t.noneStuck}</span>, // allow-emdash: empty-cell placeholder
      errors: r.errors === undefined ? dash : r.errors,
      owner: (
        <span className="inline-flex min-w-0 items-center gap-2">
          <Avatar text={r.owner.monogram} color={r.owner.color} size={20} />
          <span className="truncate" data-tip={r.owner.label}>{r.owner.label}</span>
        </span>
      ),
      modified: <span className="text-app-text-tertiary">{r.modified}</span>,
      menu: <RowMenu label={t.menuLabel(r.name)} items={menuItems(r.id)} onSelect={(item) => onMenu(r.id, item)} />,
    } satisfies Record<string, ReactNode>,
  }));
  const filtered = Boolean(query.trim()) || office !== 'all' || tab !== 'all';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={crumbs}>
        <Button variant="primary" icon={Plus} onClick={onNew} title={newTitle}>{t.newFlow}</Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* On a phone a single column, not wrapped: a wrapped column sizes its line to the widest child (the tab strip) and the page slid sideways. */}
        <div className={clsx('flex gap-x-4 gap-y-2 px-4 pt-3', phone ? 'flex-col items-stretch' : 'flex-wrap items-center')}>
          <Tabs value={tab} onChange={onTab} ariaLabel={t.tabsLabel} options={tabs.map((x) => ({ value: x.value, label: x.label, count: x.count }))} className="border-b-0" />
          <span className="flex-1" />
          <TextField
            value={query}
            onChange={onQuery}
            icon={Search}
            type="search"
            placeholder={t.searchPlaceholder}
            className={phone ? undefined : 'w-[240px]'}
          />
          <Select value={office} onChange={onOffice} title={t.officeFilter} options={offices} className={phone ? undefined : 'w-[190px]'} />
          <Button onClick={onTestAll} icon={FlaskConical} title={testTitle}>{t.testAll}</Button>
        </div>
        <div className="p-4">
          <Table
            columns={columns}
            rows={tableRows}
            ariaLabel={t.tableLabel}
            empty={(
              <span className="flex flex-col items-center gap-2">
                <span>{filtered ? t.emptyFiltered : t.emptyNone}</span>
                {filtered && <Button onClick={onResetFilters}>{t.resetFilters}</Button>}
              </span>
            )}
          />
        </div>
        {suggestions.length > 0 && (
          <section className="px-4 pb-6">
            <Card
              title={t.suggestionsTitle}
              icon={Sparkles}
              tone="violet"
              actions={<Button size="sm" onClick={onAllTemplates}>{t.allTemplates}</Button>}
            >
              <p className="mb-3 text-compact text-app-text-tertiary">{t.suggestionsHint}</p>
              <div className={clsx('grid gap-3', phone ? 'grid-cols-1' : 'grid-cols-3')}>
                {suggestions.map((s) => (
                  <div key={s.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-app-border bg-surface px-3.5 py-3">
                    <h4 className="text-prose font-semibold text-app-text">{s.title}</h4>
                    <p className="flex-1 text-prose leading-5 text-app-text-secondary">{s.body}</p>
                    <div><Button onClick={onSuggestion(s.id)}>{t.createDraft}</Button></div>
                  </div>
                ))}
              </div>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
