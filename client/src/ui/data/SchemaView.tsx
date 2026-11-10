import { ArrowRight, Database, ListChecks } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip, FieldChip } from '../primitives/Chip';
import { KeyValue, PanelHeading, PanelSection, SectionLabel } from '../primitives/Panel';
import { Stepper } from '../primitives/Stepper';
import { Table, type TableRowModel } from '../primitives/Table';
import { FIELD_ICON, FIELD_TONE } from '../icons';
import { FOCUS_RING } from '../shell/pressable';
import { TONE_TEXT } from '../tone';
import type { Action } from '../types';
import type { SchemaDetailModel, SchemaGroupModel, TableOverviewRow } from './model';

/** The types of data, in groups: what arrives, what belongs to the organization, what lives in the programs. */
export function TypeList({ groups, selectedId, onSelect, phone, copy }: {
  groups: SchemaGroupModel[];
  selectedId: string;
  onSelect: (id: string) => void;
  phone: boolean;
  copy: UiCopy;
}) {
  const all = groups.flatMap((g) => g.items);
  if (phone) {
    return (
      <nav aria-label={copy.dataMore.schema.typesLabel} className="scrollbar-none flex shrink-0 gap-1.5 overflow-x-auto border-b border-app-border px-3 py-2">
        {all.map((i) => (
          <button key={i.id} type="button" aria-current={i.id === selectedId || undefined} onClick={() => onSelect(i.id)} className={clsx('inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-prose', i.id === selectedId ? 'bg-black/[0.08] font-medium text-app-text dark:bg-white/[0.14]' : 'bg-black/[0.04] text-app-text-secondary dark:bg-white/[0.06]', FOCUS_RING)}>{i.label}</button>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label={copy.dataMore.schema.typesLabel} className="h-full w-[260px] shrink-0 overflow-y-auto border-r border-app-border px-2.5 py-3">
      {groups.map((g, gi) => (
        <div key={g.id} className={gi ? 'mt-4' : undefined}>
          <SectionLabel className="mb-2 px-1">{g.label}</SectionLabel>
          <ul className="space-y-1">
            {g.items.map((i) => {
              const Icon = FIELD_ICON[i.fieldKind];
              const on = i.id === selectedId;
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    aria-current={on || undefined}
                    onClick={() => onSelect(i.id)}
                    className={clsx('flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-prose leading-5 transition-colors', on ? 'bg-black/[0.08] font-medium text-app-text dark:bg-white/[0.14]' : 'bg-black/[0.03] text-app-text hover:bg-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]', FOCUS_RING)}
                  >
                    <Icon size={14} className={clsx('shrink-0', TONE_TEXT[FIELD_TONE[i.fieldKind]])} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                    {i.added && <Chip tone="green">{copy.dataMore.schema.addedNow}</Chip>}
                    <span className="shrink-0 text-compact tabular-nums text-app-text-tertiary">{i.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The chain of links from the case to the norm, as nodes joined by arrows; each node opens that type. */
function Chain({ chain, selectedId, onSelect, copy }: { chain: SchemaDetailModel['chain']; selectedId: string; onSelect: (id: string) => void; copy: UiCopy }) {
  return (
    <ol aria-label={copy.dataMore.schema.chainLabel} className="flex flex-wrap items-center gap-y-2">
      {chain.map((n, i) => {
        const Icon = FIELD_ICON[n.fieldKind];
        const on = n.id === selectedId;
        return (
          <li key={n.id} className="flex items-center">
            {i > 0 && (
              <span className="mx-1.5 flex flex-col items-center text-app-text-tertiary" aria-hidden="true">
                <ArrowRight size={14} />
                {n.how && <span className="text-nano">{n.how}</span>}
              </span>
            )}
            <button
              type="button"
              aria-current={on || undefined}
              onClick={() => onSelect(n.id)}
              className={clsx('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-prose transition-colors', on ? 'border-primary/50 bg-primary/10 font-medium text-app-text' : 'border-app-border bg-surface text-app-text hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING)}
            >
              <Icon size={13} className={TONE_TEXT[FIELD_TONE[n.fieldKind]]} aria-hidden="true" />{n.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** One type: what it is, the states it goes through, its fields, and the chain of links it sits in. */
export function TypeDetail({ detail, copy, phone, onSelectType, onOpenTable, onOpenFields }: {
  detail: SchemaDetailModel;
  copy: UiCopy;
  phone: boolean;
  onSelectType: (id: string) => void;
  /** Absent when the type has no table or no page of fields. */
  onOpenTable?: Action;
  onOpenFields?: Action;
}) {
  const t = copy.dataMore.schema;
  const rows: TableRowModel[] = detail.fields.map((f) => ({
    id: f.id,
    cells: {
      field: <span className="font-semibold">{f.label}</span>,
      type: f.linkTo ? <FieldChip field={{ kind: 'link', name: `→ ${f.linkTo}` }} /> : <span className="font-mono text-compact">{f.typeText}</span>,
      from: <span className="block whitespace-normal leading-5">{f.from}</span>,
      editedBy: <span className="block whitespace-normal leading-5">{f.editedBy}</span>,
      required: f.required,
    },
  }));
  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-[19px] font-semibold text-app-text">{detail.label}</h2>
        <span className="min-w-0 flex-1 text-prose text-app-text-secondary">{detail.about}</span>
        <Chip>{detail.home}</Chip>
      </div>
      {(onOpenTable || onOpenFields) && (
        <div className="flex flex-wrap gap-2">
          {onOpenTable && <Button icon={Database} onClick={onOpenTable}>{detail.tableLabel}</Button>}
          {onOpenFields && <Button icon={ListChecks} onClick={onOpenFields}>{t.openFields}</Button>}
        </div>
      )}
      <Card title={t.chainTitle}>
        <Chain chain={detail.chain} selectedId={detail.id} onSelect={onSelectType} copy={copy} />
      </Card>
      {detail.states && (
        <Card title={t.states}>
          <Stepper steps={detail.states} orientation={phone ? 'vertical' : 'horizontal'} copy={copy} ariaLabel={t.states} />
          <p className="mt-3 text-compact text-app-text-secondary">{t.statesNote}</p>
        </Card>
      )}
      {rows.length === 0 && <p className="text-prose text-app-text-secondary">{t.noFields}</p>}
      {rows.length > 0 && (
        <Table
          ariaLabel={t.fieldsLabel}
          columns={[
            // The narrow columns sit at their floor (the longest word) so the free room goes to the one with the longest text.
            { id: 'field', label: t.columns.field, width: 100 },
            { id: 'type', label: t.columns.type, width: 124 },
            { id: 'from', label: t.columns.from, width: 190 },
            { id: 'editedBy', label: t.columns.editedBy, width: 80 },
            { id: 'required', label: t.columns.required, width: 84 },
          ]}
          rows={rows}
        />
      )}
    </div>
  );
}

/** The links of a type, who uses it and how long it is kept. */
export function TypeLinks({ detail, copy, phone, onSelectType }: {
  detail: SchemaDetailModel;
  copy: UiCopy;
  phone: boolean;
  onSelectType: (id: string) => void;
}) {
  const t = copy.dataMore.schema;
  return (
    <aside className={clsx('flex shrink-0 flex-col border-app-border bg-surface', phone ? 'w-full border-t' : 'h-full w-[320px] border-l')}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelHeading tag={t.linksTag} title={t.linksTitle(detail.label)} />
        <PanelSection>
          {detail.links.length === 0 && <p className="text-prose text-app-text-secondary">{t.noLinks}</p>}
          {detail.links.map((l) => (
            <button key={l.id} type="button" onClick={() => onSelectType(l.id)} className={clsx('-mx-1 flex min-h-8 w-[calc(100%+8px)] items-center gap-2 rounded px-1 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING)}>
              <FieldChip field={{ kind: l.fieldKind, name: l.label }} />
              <span className="ml-auto text-prose text-app-text">{l.how}</span>
            </button>
          ))}
        </PanelSection>
        {detail.usedBy.length > 0 && (
          <PanelSection label={t.usedBy}>{detail.usedBy.map((u) => <KeyValue key={u.label} label={u.label} value={u.value} />)}</PanelSection>
        )}
        {detail.keep.length > 0 && (
          <PanelSection label={t.keeping}>{detail.keep.map((u) => <KeyValue key={u.label} label={u.label} value={u.value} />)}</PanelSection>
        )}
      </div>
    </aside>
  );
}

/** «Tables»: the tables of the organization, with where they live and how many fields they have. */
export function TablesOverview({ rows, copy, onOpenRows, onOpenFields }: {
  rows: TableOverviewRow[];
  copy: UiCopy;
  onOpenRows: (id: string) => void;
  onOpenFields: (id: string) => void;
}) {
  const t = copy.dataMore.schema;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-5 py-5">
      <Table
        ariaLabel={t.tablesLabel}
        columns={[
          { id: 'label', label: t.tableColumns.table, width: 200 },
          { id: 'summary', label: t.tableColumns.about, width: 380 },
          { id: 'home', label: t.tableColumns.home, width: 130 },
          { id: 'rows', label: t.tableColumns.rows, width: 130, align: 'right' },
          { id: 'fields', label: t.tableColumns.fields, width: 90, align: 'right' },
          { id: 'actions', label: '', width: 190 },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          onOpen: () => onOpenRows(r.id),
          cells: {
            label: <span className="font-semibold">{r.label}</span>,
            summary: <span className="block whitespace-normal leading-5 text-app-text-secondary">{r.summary}</span>,
            home: <Chip>{r.home}</Chip>,
            rows: r.rows,
            fields: r.fields,
            actions: (
              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <Button size="sm" onClick={() => onOpenFields(r.id)}>{t.openFields}</Button>
              </span>
            ),
          },
        }))}
      />
    </div>
  );
}
