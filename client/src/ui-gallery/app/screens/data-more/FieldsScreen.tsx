/**
 * x02 live: the fields of a table with their rules and calculations. A person
 * who may change the structure edits a field in the side panel and every
 * change is kept; a rule can be tested on the example rows and says which
 * ones fail. Everyone else reads the same page with the controls off.
 */
import { useState } from 'react';
import { Database } from 'lucide-react';
import { SegmentedControl } from '../../../../components/Shared/Segmented';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Select, TextField, Toggle } from '../../../../ui/primitives/Field';
import { Card } from '../../../../ui/primitives/Card';
import { Table } from '../../../../ui/primitives/Table';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { FieldInspector, FieldsTable } from '../../../../ui/data/FieldsView';
import type { FieldFormModel, FieldRowModel, RuleTestModel } from '../../../../ui/data/model';
import { ROLES } from '../../../../ui/fixtures/org/people';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import { EDITORS, TABLE_METAS, type FieldSeed, type FieldType, type FilledBy, type RuleKind } from '../../../../ui/fixtures/data';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { rolePermissions } from '../../store/permissions';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { computeTerm, editKey, fieldsOf, testField, type FieldEdits, type FieldsAdded, type RuleResult } from './fields';

type Tab = 'rows' | 'fields' | 'permissions' | 'automations';

const FIELD_TYPES: FieldType[] = ['text', 'choice', 'date', 'computedDate', 'money', 'link', 'person', 'yesNo', 'number'];
const FILLED: FilledBy[] = ['ai', 'rule', 'program', 'person', 'pec', 'flow'];
const RULES: RuleKind[] = ['none', 'required', 'format', 'list', 'range', 'notFuture', 'exists', 'calc'];
const FILLED_TONE = { ai: 'violet', rule: 'blue', program: 'amber', person: 'neutral', pec: 'neutral', flow: 'neutral' } as const;
const ALERT_RECIPIENTS = ['legal', 'legalDirection', 'direction', 'nobody'];

interface StoredTest extends RuleResult {
  sig: string;
}

export function FieldsScreen({ ctx, table }: { ctx: ScreenCtx; table: string }) {
  const d = ctx.copy.dataMore;
  const t = d.fields;
  const meta = TABLE_METAS.find((m) => m.id === table);
  const [edits, setEdits] = ctx.slice<FieldEdits>('dataFieldEdits', {});
  const [added, setAdded] = ctx.slice<FieldsAdded>('dataFieldsAdded', {});
  const [tests, setTests] = ctx.slice<Record<string, StoredTest>>('dataFieldTests', {});
  const [meta2, setMeta2] = ctx.slice<{ alerts: Record<string, string>; appears: Record<string, boolean>; automations: Record<string, boolean> }>('dataFieldMeta', { alerts: {}, appears: {}, automations: {} });
  const [tab, setTab] = ctx.ui<Tab>(`dm.fields.${table}.tab`, 'fields');
  const fields = fieldsOf(table, edits, added);
  const [selectedId, setSelectedId] = ctx.ui<string>(`dm.fields.${table}.sel`, fields[0]?.id ?? '');
  const [adding, setAdding] = useState<{ name: string; type: FieldType; tried: boolean } | null>(null);
  const canEdit = ctx.can('edit:structure');
  const denied = ctx.deniedTitle('edit:structure');

  if (!meta || !fields.length) {
    return <EmptyState icon={Database} title={d.notFound.title} action={<Button variant="primary" onClick={() => ctx.go(P.data())}>{d.notFound.back}</Button>}>{d.notFound.body}</EmptyState>;
  }

  const selected = fields.find((f) => f.id === selectedId) ?? fields[0];
  const key = editKey(table, selected.id);
  const sentence = (rule: FieldSeed['rule']): string => {
    const s = t.ruleSentence;
    switch (rule.kind) {
      case 'none': return s.none;
      case 'required': return s.required;
      case 'format': return s.format(rule.pattern ?? '');
      case 'list': return s.list((rule.list ?? []).join(' · '));
      case 'range': return s.range(rule.min ?? 0);
      case 'notFuture': return s.notFuture;
      case 'exists': return s.exists;
      case 'calc': return s.calc;
    }
  };
  const patch = (fieldId: string, p: Partial<FieldSeed>, what: string) => {
    setEdits((prev) => ({ ...prev, [editKey(table, fieldId)]: { ...(prev[editKey(table, fieldId)] ?? {}), ...p } }));
    ctx.log(d.log.fieldEdited(what, meta.label), 'structure', P.dataFields(table));
  };

  const rows: FieldRowModel[] = fields.map((f) => ({
    id: f.id,
    label: f.label,
    typeText: t.types[f.type],
    linkTo: f.linkTo,
    ruleText: f.rule.text || t.ruleSentence.none,
    filled: { tone: FILLED_TONE[f.filledBy], text: f.filledBy === 'program' && f.filledNote ? f.filledNote : t.filled[f.filledBy], note: f.filledBy === 'program' ? undefined : f.filledNote },
    editedBy: f.editableBy,
    calculated: f.type === 'computedDate',
    added: (added[table] ?? []).some((a) => a.id === f.id),
  }));

  /* ---- the form of the selected field ---- */
  const formula = selected.calc;
  const sampleCase = formula ? CASES.find((c) => c.org === 'nocera' && c.deadlines.some((dl) => !dl.id.startsWith('avviso') && (dl.id.includes(formula.deadline) || dl.label.toLowerCase().includes(formula.deadline)))) : undefined;  // allow-italian: id of the fixture data, not shown
  const sampleDeadline = sampleCase?.deadlines.find((dl) => dl.id.includes(formula?.deadline ?? '#') || dl.label.toLowerCase().includes(formula?.deadline ?? '#'));
  const form: FieldFormModel = {
    id: selected.id,
    label: selected.label,
    type: selected.type,
    required: selected.required,
    ruleKind: selected.rule.kind,
    ruleKinds: RULES.map((r) => ({ value: r, label: t.ruleKinds[r] })),
    rulePattern: selected.rule.pattern ?? '',
    ruleList: (selected.rule.list ?? []).join(', '),
    ruleMin: String(selected.rule.min ?? 0),
    filledBy: selected.filledBy,
    filledOptions: FILLED.map((f) => ({ value: f, label: t.filled[f] })),
    editedBy: selected.editableBy,
    editorOptions: [...new Set([...EDITORS, selected.editableBy])].map((e) => ({ value: e, label: e })),
    typeOptions: FIELD_TYPES.map((x) => ({ value: x, label: t.types[x] })),
    added: (added[table] ?? []).some((a) => a.id === selected.id),
    calc: formula && {
      from: formula.from,
      days: String(formula.days),
      rollsOver: formula.rollsOver,
      augustPause: formula.augustPause,
      norm: formula.norm,
      example: sampleDeadline
        ? [t.example.from(formula.from, formatDay(sampleDeadline.from)), t.example.plus(formula.days), t.example.result(formatDay(computeTerm(formula, sampleDeadline.from))), ...(formula.rollsOver ? [t.example.holiday] : [])]
        : [t.example.none],
      alerts: [20, 5].map((n) => ({
        id: `${key}.${n}`,
        label: t.alertBefore(n),
        value: meta2.alerts[`${key}.${n}`] ?? (n === 20 ? 'legal' : 'legalDirection'),
        options: ALERT_RECIPIENTS.map((r) => ({ value: r, label: t.recipients[r as keyof typeof t.recipients] })),
      })),
      appearsIn: [
        { id: `${key}.schedule`, label: t.appears.schedule, on: meta2.appears[`${key}.schedule`] ?? true },
        { id: `${key}.outlook`, label: t.appears.outlook, on: meta2.appears[`${key}.outlook`] ?? true },
      ],
    },
  };

  const onChange = (p: Record<string, string | boolean>) => {
    const f = selected;
    if ('label' in p) patch(f.id, { label: String(p.label) }, f.label);
    else if ('type' in p) patch(f.id, { type: p.type as FieldType }, f.label);
    else if ('required' in p) patch(f.id, { required: Boolean(p.required) }, f.label);
    else if ('filledBy' in p) patch(f.id, { filledBy: p.filledBy as FilledBy }, f.label);
    else if ('editedBy' in p) patch(f.id, { editableBy: String(p.editedBy) }, f.label);
    else {
      const rule = { ...f.rule };
      if ('ruleKind' in p) rule.kind = p.ruleKind as RuleKind;
      if ('rulePattern' in p) rule.pattern = String(p.rulePattern);
      if ('ruleList' in p) rule.list = String(p.ruleList).split(',').map((x) => x.trim()).filter(Boolean);
      if ('ruleMin' in p) rule.min = Number(p.ruleMin) || 0;
      rule.text = sentence(rule);
      patch(f.id, { rule }, f.label);
    }
  };
  const onChangeFormula = (p: Record<string, string | boolean>) => {
    if (!selected.calc) return;
    const next = { ...selected.calc };
    if ('from' in p) next.from = String(p.from);
    if ('days' in p) next.days = Math.max(0, Number(p.days) || 0);
    if ('rollsOver' in p) next.rollsOver = Boolean(p.rollsOver);
    if ('augustPause' in p) next.augustPause = Boolean(p.augustPause);
    if ('norm' in p) next.norm = String(p.norm);
    const text = t.ruleSentence.calcOf(next.from, next.days, next.augustPause);
    patch(selected.id, { calc: next, rule: { ...selected.rule, text } }, selected.label);
  };

  /* ---- the test ---- */
  const sig = JSON.stringify([selected.rule, selected.calc, selected.required, selected.type]);
  const jobId = `rule-${key}`;
  const job = ctx.job(jobId);
  const stored = tests[key];
  const testModel: RuleTestModel = job?.status === 'running'
    ? { status: 'running', progress: job.progress, current: job.current, total: 0, passed: 0, untestable: false, failures: [] }
    : stored && stored.sig === sig
      ? {
        status: 'done', progress: 1, total: stored.total, passed: stored.passed, untestable: stored.untestable,
        failures: stored.failures.map((f) => ({ id: f.id, title: f.title, value: f.value, expected: f.expected, why: t.why[f.why], canOpen: Boolean(f.caseId) })),
      }
      : { status: 'idle', progress: 0, total: 0, passed: 0, untestable: false, failures: [] };
  const runTest = () => {
    const field = selected;
    const k = key;
    const s = sig;
    ctx.startJob({
      id: jobId,
      title: t.job.title(field.label),
      steps: [{ label: t.job.reading, ms: 500 }, { label: t.job.applying, ms: 700 }, { label: t.job.comparing, ms: 500 }],
      onDone: () => {
        const result = testField(table, field);
        setTests((prev) => ({ ...prev, [k]: { ...result, sig: s } }));
        ctx.log(d.log.ruleTested(field.label, result.failures.length, result.total), 'test', P.dataFields(table));
        ctx.toast({
          tone: result.failures.length ? 'warn' : 'ok',
          title: result.untestable ? t.testNothing : result.failures.length ? t.testFailed(result.failures.length, result.total) : t.testPassed(result.total),
        });
      },
    });
  };

  const addField = () => {
    if (!adding || !adding.name.trim()) { setAdding(adding && { ...adding, tried: true }); return; }
    const n = (added[table] ?? []).length + 1;
    const seed: FieldSeed = {
      id: `added-${n}`, label: adding.name.trim(), type: adding.type, required: false, rule: { kind: 'none', text: t.ruleSentence.none },
      filledBy: 'person', editableBy: EDITORS[6], source: 'case.none',
      ...(adding.type === 'computedDate' ? { calc: { from: '', days: 30, rollsOver: true, augustPause: false, norm: '', deadline: '#', direction: 1 as const } } : {}),
    };
    setAdded((prev) => ({ ...prev, [table]: [...(prev[table] ?? []), seed] }));
    setSelectedId(seed.id);
    setTab('fields');
    ctx.log(d.log.fieldAdded(seed.label, meta.label), 'structure', P.dataFields(table));
    ctx.toast({ tone: 'ok', title: t.toastAdded(seed.label) });
    setAdding(null);
  };
  const deleteField = () => {
    const f = selected;
    ctx.confirm({
      title: t.deleteConfirm.title(f.label),
      body: t.deleteConfirm.body,
      confirmLabel: t.deleteConfirm.confirm,
      tone: 'danger',
      onConfirm: () => {
        setAdded((prev) => ({ ...prev, [table]: (prev[table] ?? []).filter((x) => x.id !== f.id) }));
        setSelectedId(fields[0].id);
        ctx.log(d.log.fieldRemoved(f.label, meta.label), 'structure', P.dataFields(table));
        ctx.toast({ tone: 'info', title: t.toastRemoved(f.label) });
      },
    });
  };

  const tabOptions: Array<{ value: Tab; label: string }> = [
    { value: 'rows', label: t.tabs.rows }, { value: 'fields', label: t.tabs.fields }, { value: 'permissions', label: t.tabs.permissions }, { value: 'automations', label: t.tabs.automations },
  ];
  const automations = fields.filter((f) => f.type === 'computedDate' || f.filledBy === 'rule' || f.filledBy === 'ai');

  const main = tab === 'permissions' ? (
    <div className="space-y-3">
      <Card title={t.permissions.title}><p className="leading-6">{t.permissions.body}</p></Card>
      <Table
        ariaLabel={t.permissions.title}
        columns={[
          { id: 'role', label: t.permissions.role, width: 240 },
          { id: 'view', label: t.permissions.view, width: 140 },
          { id: 'data', label: t.permissions.editData, width: 150 },
          { id: 'structure', label: t.permissions.editStructure, width: 190 },
          { id: 'export', label: t.permissions.export, width: 130 },
        ]}
        rows={ROLES.map((r) => {
          const perms = rolePermissions(ctx.state, r.id);
          const yes = (p: Parameters<typeof perms.has>[0]) => <Chip tone={perms.has(p) ? 'green' : 'neutral'}>{perms.has(p) ? d.common.yes : d.common.no}</Chip>;
          return { id: r.id, cells: { role: <span className="font-semibold">{r.label}</span>, view: yes('view:data'), data: yes('edit:data'), structure: yes('edit:structure'), export: yes('export') } };
        })}
      />
    </div>
  ) : tab === 'automations' ? (
    <div className="space-y-3">
      <Card title={t.automations.title}><p className="leading-6">{t.automations.body}</p></Card>
      <Table
        ariaLabel={t.automations.title}
        columns={[
          { id: 'on', label: t.automations.active, width: 80 },
          { id: 'field', label: t.columns.field, width: 200 },
          { id: 'what', label: t.automations.what, width: 460 },
          { id: 'by', label: t.columns.filledBy, width: 140 },
        ]}
        rows={automations.map((f) => {
          const k = editKey(table, f.id);
          const on = meta2.automations[k] ?? true;
          return {
            id: f.id,
            muted: !on,
            onOpen: () => { setSelectedId(f.id); setTab('fields'); },
            cells: {
              on: (
                <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <Toggle
                    checked={on}
                    disabled={!canEdit}
                    title={canEdit ? t.automations.toggle(f.label) : denied}
                    onChange={(v) => { setMeta2((prev) => ({ ...prev, automations: { ...prev.automations, [k]: v } })); ctx.log(d.log.automation(f.label, v), 'structure', P.dataFields(table)); }}
                  />
                </span>
              ),
              field: <span className="font-semibold">{f.label}</span>,
              what: <span className="block whitespace-normal leading-5">{f.type === 'computedDate' ? f.rule.text : t.automations.fills(t.filled[f.filledBy])}</span>,
              by: <Chip tone={FILLED_TONE[f.filledBy]}>{t.filled[f.filledBy]}</Chip>,
            },
          };
        })}
      />
    </div>
  ) : (
    <FieldsTable rows={rows} selectedId={selected.id} onSelect={setSelectedId} copy={ctx.copy} onAdd={ctx.allow('edit:structure', () => setAdding({ name: '', type: 'text', tried: false }))} />
  );

  const tabs = (
    <SegmentedControl
      ariaLabel={t.tabsLabel}
      value={tab}
      onChange={(v) => (v === 'rows' ? ctx.go(table === 'pratiche' ? P.data() : P.data(table)) : setTab(v))}
      options={tabOptions}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={ctx.phone ? [{ label: meta.label }, { label: t.crumb }] : [{ label: ctx.copy.data.root }, { label: meta.label }, { label: t.crumb }]}>{!ctx.phone && tabs}</PaneHeader>
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">{tabs}</div>}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4 max-sm:px-3">{main}</div>
        {tab === 'fields' && (
          <FieldInspector
            form={form}
            test={testModel}
            copy={ctx.copy}
            canEdit={canEdit}
            deniedTitle={denied}
            onChange={onChange}
            onChangeCalc={onChangeFormula}
            onTest={runTest}
            onDelete={ctx.allow('edit:structure', deleteField)}
            onOpenFailure={(id) => ctx.go(P.record(id))}
            onAlert={(id, v) => { setMeta2((prev) => ({ ...prev, alerts: { ...prev.alerts, [id]: v } })); ctx.log(d.log.alertSet(selected.label), 'structure', P.dataFields(table)); }}
            onAppears={(id, on) => { setMeta2((prev) => ({ ...prev, appears: { ...prev.appears, [id]: on } })); ctx.log(d.log.appearsSet(selected.label, on), 'structure', P.dataFields(table)); }}
          />
        )}
      </div>
      {adding && (
        <Dialog
          title={t.addDialog.title}
          closeLabel={ctx.copy.common.close}
          size="sm"
          onClose={() => setAdding(null)}
          footer={<><Button onClick={() => setAdding(null)}>{d.common.cancel}</Button><Button variant="primary" onClick={addField}>{t.addDialog.create}</Button></>}
        >
          <div className="space-y-3">
            <TextField autoFocus label={t.addDialog.name} value={adding.name} onChange={(v) => setAdding({ ...adding, name: v })} onEnter={addField} placeholder={t.addDialog.placeholder} error={adding.tried && !adding.name.trim() ? t.addDialog.required : undefined} />
            <Select label={t.type} value={adding.type} options={FIELD_TYPES.map((x) => ({ value: x, label: t.types[x] }))} onChange={(v) => setAdding({ ...adding, type: v as FieldType })} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
