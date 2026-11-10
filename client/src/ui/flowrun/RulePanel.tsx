import { Database, Plus, Trash2 } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button, IconButton } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Select, TextField } from '../primitives/Field';
import { Table, type TableColumnModel } from '../primitives/Table';
import type { Condition, ConditionField, ConditionOp } from './model';

export interface RuleSampleRow {
  id: string;
  label: string;
  /** The values the fields read, already formatted, by field id. */
  values: Record<string, string>;
  result: 'then' | 'else';
  onOpen?: () => void;
}

export interface RuleView {
  question: string;
  thenLabel: string;
  elseLabel: string;
  conditions: Condition[];
  fields: ConditionField[];
  ops: ConditionOp[];
  table: { name: string; items: string[]; shown: number };
  samples: RuleSampleRow[];
  /** Fields the samples print a column for. */
  sampleFields: string[];
  samplesTitle: string;
}

export interface RuleHandlers {
  onCondition: (id: string, patch: Partial<Condition>) => void;
  onAddCondition: () => void;
  onRemoveCondition: (id: string) => void;
  onOpenTable: () => void;
  onOpenTableItem: (item: string) => void;
  onToggleItems: () => void;
}

/** The page of a fixed rule (n06): the conditions, the table it reads, and what it does on real items. */
export function RulePanel({ copy, view, handlers, editable, deniedTitle }: {
  copy: UiCopy;
  view: RuleView;
  handlers: RuleHandlers;
  editable: boolean;
  deniedTitle?: string;
}) {
  const c = copy.flowRun.rule;
  const off = editable ? undefined : deniedTitle;
  const kindOf = (id: string) => view.fields.find((f) => f.id === id)?.kind;
  const columns: TableColumnModel[] = [
    { id: 'label', label: c.colItem },
    ...view.sampleFields.map((id) => ({ id, label: view.fields.find((f) => f.id === id)?.label ?? id, width: 130 })),
    // Wide enough for the longest result chip, which does not wrap.
    { id: 'result', label: c.colResult, width: 260 },
  ];
  const rows = view.samples.map((s) => ({
    id: s.id,
    onOpen: s.onOpen,
    cells: {
      label: s.label,
      ...s.values,
      result: <Chip tone={s.result === 'then' ? 'amber' : 'green'}>{s.result === 'then' ? view.thenLabel : view.elseLabel}</Chip>,
    },
  }));
  return (
    <div className="flex min-w-0 flex-col gap-4 p-5">
      <Card title={c.conditionsTitle} actions={<Chip tone="blue">{c.fixedTag}</Chip>}>
        <p className="mb-3 text-prose text-app-text-secondary">{c.conditionsLead(view.thenLabel)}</p>
        <div className="flex flex-col gap-2">
          {view.conditions.map((cond, i) => {
            const kind = kindOf(cond.field);
            return (
              <div key={cond.id} className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-7 w-[72px] shrink-0 items-center justify-center rounded-lg bg-black/[0.05] text-compact font-medium text-app-text-secondary dark:bg-white/10">
                  {i === 0 ? c.if : c.or}
                </span>
                <Select
                  size="sm"
                  className="min-w-[180px] flex-1"
                  value={cond.field}
                  options={view.fields.map((f) => ({ value: f.id, label: f.label }))}
                  onChange={(v) => handlers.onCondition(cond.id, { field: v, op: view.fields.find((f) => f.id === v)?.kind === 'list' ? 'in' : cond.op === 'in' ? 'lt' : cond.op })}
                  disabled={!editable}
                  title={off ?? c.pickField}
                />
                <Select
                  size="sm"
                  className="w-[150px]"
                  value={cond.op}
                  options={view.ops.filter((o) => (kind === 'list' ? o.id === 'in' : o.id !== 'in')).map((o) => ({ value: o.id, label: o.label }))}
                  onChange={(v) => handlers.onCondition(cond.id, { op: v as Condition['op'] })}
                  disabled={!editable}
                  title={off ?? c.pickOp}
                />
                {kind === 'list' ? (
                  <span className="inline-flex h-6 w-[190px] items-center gap-1.5 rounded-lg border border-app-border-input px-2 text-mini text-app-text"><Database size={12} aria-hidden="true" />{view.table.name}</span>
                ) : (
                  <TextField size="sm" type="number" className="w-[90px]" value={cond.value} onChange={(v) => handlers.onCondition(cond.id, { value: v })} disabled={!editable} title={off ?? c.pickValue} />
                )}
                {editable && <IconButton icon={Trash2} label={c.removeCondition} onClick={() => handlers.onRemoveCondition(cond.id)} />}
              </div>
            );
          })}
          {view.conditions.length === 0 && <p className="text-prose text-app-text-tertiary">{c.noConditions(view.elseLabel)}</p>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button icon={Plus} size="sm" onClick={editable ? handlers.onAddCondition : false} title={off}>{c.addCondition}</Button>
          <span className="text-compact text-app-text-tertiary">{c.elseIs(view.elseLabel)}</span>
        </div>
      </Card>
      {view.conditions.some((cond) => kindOf(cond.field) === 'list') && (
        <Card
          title={c.tableTitle(view.table.name)}
          icon={Database}
          actions={<Button size="sm" variant="ghost" onClick={handlers.onOpenTable}>{c.openInData}</Button>}
        >
          <div className="flex flex-wrap gap-1.5">
            {view.table.items.slice(0, view.table.shown).map((it) => (
              <button
                key={it}
                type="button"
                onClick={() => handlers.onOpenTableItem(it)}
                className="inline-flex h-6 items-center rounded-md bg-black/[0.05] px-2 text-compact text-app-text hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:bg-white/10"
              >
                {it}
              </button>
            ))}
            {view.table.items.length > 4 && (
              <Button size="sm" variant="ghost" onClick={handlers.onToggleItems}>
                {view.table.shown >= view.table.items.length ? c.fewer : c.more(view.table.items.length - view.table.shown)}
              </Button>
            )}
          </div>
        </Card>
      )}
      <Card title={view.samplesTitle}>
        <Table ariaLabel={view.samplesTitle} columns={columns} rows={rows} empty={c.noSamples} />
      </Card>
    </div>
  );
}
