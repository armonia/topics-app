import { Calculator, FlaskConical, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Chip, FieldChip } from '../primitives/Chip';
import { Checkbox, Select, TextField, Toggle } from '../primitives/Field';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { ProgressBar } from '../primitives/Progress';
import { Table, type TableRowModel } from '../primitives/Table';
import { FOCUS_RING } from '../shell/pressable';
import { TONE_TEXT } from '../tone';
import type { Action } from '../types';
import type { FieldFormModel, FieldRowModel, RuleTestModel } from './model';

/** The fields of a table: what each one is, the rule that guards it, who fills it, who may change it. */
export function FieldsTable({ rows, selectedId, onSelect, copy, onAdd }: {
  rows: FieldRowModel[];
  selectedId?: string;
  onSelect: (id: string) => void;
  copy: UiCopy;
  /** `false` when the person may not change the structure. */
  onAdd: Action;
}) {
  const t = copy.dataMore.fields;
  const tableRows: TableRowModel[] = rows.map((r) => ({
    id: r.id,
    selected: r.id === selectedId,
    onOpen: () => onSelect(r.id),
    cells: {
      field: (
        <span className="flex items-center gap-1.5 font-semibold">
          {r.calculated && <Calculator size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
          <span className="min-w-0">{r.label}</span>
          {r.added && <Chip tone="green">{t.addedNow}</Chip>}
        </span>
      ),
      type: r.linkTo ? <FieldChip field={{ kind: 'link', name: `→ ${r.linkTo}` }} /> : <span className="font-mono text-compact">{r.typeText}</span>,
      rule: <span className="block whitespace-normal leading-5">{r.ruleText}</span>,
      filled: (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Chip tone={r.filled.tone}>{r.filled.text}</Chip>
          {r.filled.note && <span className="text-compact text-app-text-secondary">{r.filled.note}</span>}
        </span>
      ),
      editedBy: <span className="block whitespace-normal leading-5">{r.editedBy}</span>,
    },
  }));
  return (
    <div className="space-y-3">
      <Table
        ariaLabel={t.tableLabel}
        columns={[
          { id: 'field', label: t.columns.field, width: 150 },
          { id: 'type', label: t.columns.type, width: 120 },
          { id: 'rule', label: t.columns.rule },
          { id: 'filled', label: t.columns.filledBy, width: 150 },
          { id: 'editedBy', label: t.columns.editedBy, width: 120 },
        ]}
        rows={tableRows}
      />
      <button
        type="button"
        onClick={onAdd || undefined}
        disabled={onAdd === false}
        data-tip={onAdd === false ? t.addDenied : undefined}
        className={clsx('inline-flex items-center gap-1 text-compact font-semibold text-primary disabled:cursor-default disabled:opacity-45 dark:text-primary-dark', FOCUS_RING)}
      >
        <Plus size={13} aria-hidden="true" />{t.addField}
      </button>
    </div>
  );
}

/**
 * The panel of one field. For a person who may change the structure every
 * control is live and each change is kept at once; for the others the same
 * panel reads, with the controls off and the reason on hover. A calculated
 * field also shows its formula worked out on an example, who is told before
 * each deadline and where it appears. «Test the rule» runs it on the rows.
 */
export function FieldInspector({ form, test, copy, canEdit, deniedTitle, onChange, onChangeCalc, onTest, onDelete, onOpenFailure, onAlert, onAppears }: {
  form: FieldFormModel;
  test: RuleTestModel;
  copy: UiCopy;
  canEdit: boolean;
  deniedTitle?: string;
  onChange: (patch: Record<string, string | boolean>) => void;
  onChangeCalc: (patch: Record<string, string | boolean>) => void;
  onTest: Action;
  onDelete: Action;
  onOpenFailure: (id: string) => void;
  onAlert: (id: string, value: string) => void;
  onAppears: (id: string, on: boolean) => void;
}) {
  const t = copy.dataMore.fields;
  const off = !canEdit;
  const formula = form.calc;
  const need = (kind: string) => form.ruleKind === kind;
  return (
    <aside className="flex w-full shrink-0 flex-col border-t border-app-border bg-surface lg:h-full lg:w-[340px] lg:border-l lg:border-t-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelHeading tag={formula ? t.calculatedTag : t.fieldTag} title={form.label}>{formula ? t.calculatedBody : t.fieldBody}</PanelHeading>
        <PanelSection label={t.settings}>
          <div className="space-y-3">
            <TextField label={t.name} value={form.label} onChange={(v) => onChange({ label: v })} disabled={off} title={deniedTitle} />
            <Select label={t.type} value={form.type} options={form.typeOptions} onChange={(v) => onChange({ type: v })} disabled={off} title={deniedTitle} />
            <Toggle label={t.required} checked={form.required} onChange={(v) => onChange({ required: v })} disabled={off} title={deniedTitle} />
            <Select label={t.ruleKind} value={form.ruleKind} options={form.ruleKinds} onChange={(v) => onChange({ ruleKind: v })} disabled={off} title={deniedTitle} />
            {need('format') && <TextField label={t.pattern} value={form.rulePattern} onChange={(v) => onChange({ rulePattern: v })} disabled={off} title={deniedTitle} hint={t.patternHint} />}
            {need('list') && <TextField label={t.list} value={form.ruleList} onChange={(v) => onChange({ ruleList: v })} disabled={off} title={deniedTitle} hint={t.listHint} />}
            {need('range') && <TextField label={t.min} type="number" value={form.ruleMin} onChange={(v) => onChange({ ruleMin: v })} disabled={off} title={deniedTitle} />}
            <Select label={t.filledBy} value={form.filledBy} options={form.filledOptions} onChange={(v) => onChange({ filledBy: v })} disabled={off} title={deniedTitle} />
            <Select label={t.editedBy} value={form.editedBy} options={form.editorOptions} onChange={(v) => onChange({ editedBy: v })} disabled={off} title={deniedTitle} />
          </div>
        </PanelSection>
        {formula && (
          <>
            <PanelSection label={t.formula}>
              <div className="space-y-3">
                <TextField label={t.runsFrom} value={formula.from} onChange={(v) => onChangeCalc({ from: v })} disabled={off} title={deniedTitle} />
                <TextField label={t.days} type="number" value={formula.days} onChange={(v) => onChangeCalc({ days: v })} disabled={off} title={deniedTitle} />
                <Checkbox label={t.rollsOver} checked={formula.rollsOver} onChange={(v) => onChangeCalc({ rollsOver: v })} disabled={off} title={deniedTitle} />
                <Checkbox label={t.augustPause} checked={formula.augustPause} onChange={(v) => onChangeCalc({ augustPause: v })} disabled={off} title={deniedTitle} />
                <TextField label={t.norm} value={formula.norm} onChange={(v) => onChangeCalc({ norm: v })} disabled={off} title={deniedTitle} />
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-black/[0.04] px-3 py-2.5 font-mono text-compact leading-5 text-app-text dark:bg-white/[0.06]">{formula.example.join('\n')}</pre>
              </div>
            </PanelSection>
            <PanelSection label={t.alerts}>
              <div className="space-y-2.5">
                {formula.alerts.map((a) => <Select key={a.id} label={a.label} value={a.value} options={a.options} onChange={(v) => onAlert(a.id, v)} disabled={off} title={deniedTitle} />)}
              </div>
            </PanelSection>
            <PanelSection label={t.appearsIn}>
              <div className="space-y-1">
                {formula.appearsIn.map((a) => <Toggle key={a.id} label={a.label} checked={a.on} onChange={(v) => onAppears(a.id, v)} disabled={off} title={deniedTitle} />)}
              </div>
            </PanelSection>
          </>
        )}
        <PanelSection label={t.testTitle}>
          <p className="mb-2.5 text-compact leading-5 text-app-text-secondary">{t.testBody}</p>
          <Button icon={FlaskConical} onClick={test.status === 'running' ? false : onTest}>{t.testRun}</Button>
          {test.status === 'running' && <ProgressBar className="mt-3" value={test.progress} label={test.current} />}
          {test.status === 'done' && (
            <div className="mt-3 space-y-2" role="status">
              {test.untestable ? (
                <p className="text-prose text-app-text-secondary">{t.testNothing}</p>
              ) : (
                <>
                  <p className={clsx('text-prose font-medium', test.failures.length ? TONE_TEXT.red : TONE_TEXT.green)}>{test.failures.length ? t.testFailed(test.failures.length, test.total) : t.testPassed(test.total)}</p>
                  {test.failures.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => onOpenFailure(f.id)}
                      disabled={!f.canOpen}
                      className={clsx('flex w-full flex-col gap-0.5 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2 text-left transition-colors enabled:hover:bg-rose-500/10', FOCUS_RING)}
                    >
                      <span className="text-prose font-medium text-app-text">{f.title}</span>
                      <span className="text-compact text-app-text-secondary">{f.why}</span>
                      {f.expected !== undefined && <span className="text-compact tabular-nums text-app-text-secondary">{t.found(f.value)} · {t.expected(f.expected)}</span>}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </PanelSection>
        <PanelSection>
          <KeyValue label={t.whoMay} value={form.editedBy} />
        </PanelSection>
      </div>
      {form.added && (
        <div className="shrink-0 border-t border-app-border px-4 py-3">
          <Button variant="danger" icon={Trash2} onClick={onDelete} title={off ? deniedTitle : undefined} className="w-full">{t.deleteField}</Button>
        </div>
      )}
    </aside>
  );
}
