/**
 * w04 live: the types of data of the organization and how they link. A type
 * opens its table, its fields and the types it links to; «New type» adds one.
 * The same list as a table of tables sits under the second tab.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { SegmentedControl } from '../../../../components/Shared/Segmented';
import { Button } from '../../../../ui/primitives/Button';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { TextField } from '../../../../ui/primitives/Field';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { TablesOverview, TypeDetail, TypeLinks, TypeList } from '../../../../ui/data/SchemaView';
import type { SchemaDetailModel, SchemaGroupModel, SchemaTypeItem } from '../../../../ui/data/model';
import { CASE_STATES, CANALS, DEADLINES_TABLE, DECLARED_TOTALS, TABLE_METAS, TYPE_CHAIN, TYPE_FIELDS, TYPE_SEEDS, type FieldSeed, type TypeSeed } from '../../../../ui/fixtures/data';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { orgCases } from '../../store/cases';
import { buildRows } from './engine';
import { fieldsOf, type FieldEdits, type FieldsAdded } from './fields';

type Mode = 'types' | 'tables';

interface CustomType {
  id: string;
  label: string;
  about: string;
}

const GROUPS: TypeSeed['group'][] = ['incoming', 'organization', 'programs', 'territory'];

export function SchemaScreen({ ctx }: { ctx: ScreenCtx }) {
  const d = ctx.copy.dataMore;
  const t = d.schema;
  const fmt = new Intl.NumberFormat(d.format.locale);
  const [mode, setMode] = ctx.ui<Mode>('dm.schema.mode', 'types');
  const [selectedId, setSelectedId] = ctx.ui<string>('dm.schema.type', 'pratica');
  const [custom, setCustom] = ctx.slice<CustomType[]>('dataTypes', []);
  const [edits] = ctx.slice<FieldEdits>('dataFieldEdits', {});
  const [added] = ctx.slice<FieldsAdded>('dataFieldsAdded', {});
  const [dialog, setDialog] = useState<{ name: string; about: string; tried: boolean } | null>(null);
  const canEdit = ctx.can('edit:structure');
  const cases = orgCases(ctx.state, 'nocera');

  const countOf = (s: TypeSeed): string => {
    if (s.group === 'programs' || s.countText) return s.countText ?? s.home;
    if (s.id === 'scadenza') return t.openCount(fmt.format(DECLARED_TOTALS.scadenze));
    if (s.id === 'canale') return String(CANALS.length);
    const meta = TABLE_METAS.find((m) => m.id === s.table);
    if (meta?.total) return fmt.format(meta.total);
    return s.table ? String(cases.length) : s.home;
  };
  const kindOf = (id: string) => TYPE_SEEDS.find((x) => x.id === id)?.fieldKind ?? 'folder';
  const labelOf = (id: string) => TYPE_SEEDS.find((x) => x.id === id)?.label ?? custom.find((c) => c.id === id)?.label ?? id;

  const groups: SchemaGroupModel[] = GROUPS.map((g) => ({
    id: g,
    label: t.groups[g],
    items: [
      ...TYPE_SEEDS.filter((s) => s.group === g).map((s): SchemaTypeItem => ({ id: s.id, label: s.label, count: countOf(s), fieldKind: s.fieldKind })),
      ...(g === 'organization' ? custom.map((c): SchemaTypeItem => ({ id: c.id, label: c.label, count: '0', fieldKind: 'folder', added: true })) : []),
    ],
  }));

  const seed = TYPE_SEEDS.find((s) => s.id === selectedId);
  const customType = custom.find((c) => c.id === selectedId);
  const current = seed ?? (customType ? undefined : TYPE_SEEDS[2]);
  const activeId = seed?.id ?? customType?.id ?? 'pratica';

  const fieldRows = (list: FieldSeed[]): SchemaDetailModel['fields'] => list.map((f) => ({
    id: f.id,
    label: f.label,
    typeText: d.fields.types[f.type],
    linkTo: f.linkTo,
    from: f.filledBy === 'program' && f.filledNote ? f.filledNote : [d.fields.filled[f.filledBy], f.filledNote].filter(Boolean).join(', '),
    editedBy: f.editableBy,
    required: f.required ? d.common.yes : d.common.no,
  }));

  const detail: SchemaDetailModel = (() => {
    if (!current) {
      return { id: activeId, label: customType?.label ?? '', about: customType?.about ?? '', home: t.homeTopics, fields: [], links: [], usedBy: [], keep: [], chain: [] };
    }
    const fields = current.table ? fieldsOf(current.table, edits, added) : TYPE_FIELDS[current.id] ?? [];
    const chainIds = TYPE_CHAIN.includes(current.id) ? TYPE_CHAIN : [current.id, ...current.links.map((l) => l.to)];
    return {
      id: current.id,
      label: current.label,
      about: current.about,
      home: current.home === 'Topics' ? t.livesInTopics : t.livesIn(current.home),
      states: current.id === 'pratica' ? CASE_STATES.map((label, i) => ({ id: label, label, state: i < 4 ? 'done' as const : i === 4 ? 'current' as const : 'todo' as const })) : undefined,
      fields: fieldRows(fields),
      links: current.links.map((l) => ({ id: l.to, label: labelOf(l.to), fieldKind: kindOf(l.to), how: l.how })),
      usedBy: current.table ? [{ label: t.flows, value: String(FLOWS.filter((f) => f.org === 'nocera').length) }, { label: t.mcp, value: t.readOnly }] : [],
      keep: current.keep ? [{ label: t.keepPeriod, value: current.keep.period }, ...(current.keep.sealed ? [{ label: t.keepSealed, value: current.keep.sealed }] : [])] : [],
      chain: chainIds.map((id, i) => ({ id, label: labelOf(id), fieldKind: kindOf(id), how: i > 0 ? TYPE_SEEDS.find((x) => x.id === chainIds[i - 1])?.links.find((l) => l.to === id)?.how : undefined })),
      tableLabel: undefined,
    };
  })();

  /* Where a type leads: its table, or the place that holds it. */
  const target = (s: TypeSeed): { path: string; label: string } | undefined => {
    if (s.table) {
      const m = TABLE_METAS.find((x) => x.id === s.table);
      return { path: s.table === 'pratiche' ? P.data() : P.data(s.table), label: t.openIn(m?.label ?? s.label) };
    }
    if (s.id === 'scadenza') return { path: P.deadlines(), label: t.openIn(DEADLINES_TABLE.label) };
    if (s.id === 'protocollo') return { path: P.program('halley'), label: t.openIn(s.home) };
    if (s.id === 'avviso') return { path: P.program('prunes'), label: t.openIn(s.home) };
    if (s.id === 'pec' || s.id === 'allegato') return { path: P.channels(), label: t.openIn(ctx.copy.shell.nav.channels) };
    if (s.id === 'particella') return { path: P.views(), label: t.openIn(ctx.copy.shell.nav.views) };
    return { path: P.knowledge(), label: t.openIn(ctx.copy.shell.nav.knowledge) };
  };
  const where = current ? target(current) : undefined;
  if (where) detail.tableLabel = where.label;

  const createType = () => {
    if (!dialog || !dialog.name.trim()) { setDialog(dialog && { ...dialog, tried: true }); return; }
    const type: CustomType = { id: `custom-${custom.length + 1}`, label: dialog.name.trim(), about: dialog.about.trim() };
    setCustom((prev) => [...prev, type]);
    setSelectedId(type.id);
    setMode('types');
    ctx.log(d.log.typeAdded(type.label), 'structure', P.dataSchema());
    ctx.toast({ tone: 'ok', title: t.toastAdded(type.label) });
    setDialog(null);
  };

  const tableRows = TABLE_METAS.map((m) => ({
    id: m.id,
    label: m.label,
    summary: m.summary,
    home: m.home === 'topics' ? t.homeTopics : m.home === 'prunes' ? 'Prunes' : m.home === 'halley' ? 'Halley' : 'TeamSystem',
    rows: m.total ? fmt.format(m.total) : String(buildRows(m.id, ctx.state, ctx.persona, [], [], {}).length),
    fields: fieldsOf(m.id, edits, added).length,
  }));

  const controls = (
    <>
      <SegmentedControl ariaLabel={t.modeLabel} value={mode} onChange={setMode} options={[{ value: 'types', label: t.modes.types }, { value: 'tables', label: t.modes.tables }]} />
      <Button variant="primary" icon={Plus} onClick={ctx.allow('edit:structure', () => setDialog({ name: '', about: '', tried: false }))} title={canEdit ? undefined : ctx.deniedTitle('edit:structure')}>{t.newType}</Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: ctx.copy.data.root }, { label: t.crumb, detail: ctx.phone ? undefined : t.crumbDetail }]}>{!ctx.phone && controls}</PaneHeader>
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">{controls}</div>}
      {mode === 'tables' ? (
        <TablesOverview
          rows={tableRows}
          copy={ctx.copy}
          onOpenRows={(id) => ctx.go(id === 'pratiche' ? P.data() : P.data(id))}
          onOpenFields={(id) => ctx.go(P.dataFields(id))}
        />
      ) : (
        <div className={ctx.phone ? 'flex min-h-0 flex-1 flex-col overflow-y-auto' : 'flex min-h-0 flex-1'}>
          <TypeList groups={groups} selectedId={activeId} onSelect={setSelectedId} phone={ctx.phone} copy={ctx.copy} />
          <TypeDetail
            detail={detail}
            copy={ctx.copy}
            phone={ctx.phone}
            onSelectType={setSelectedId}
            onOpenTable={where ? () => ctx.go(where.path) : undefined}
            onOpenFields={current?.table ? () => ctx.go(P.dataFields(current.table as string)) : undefined}
          />
          <TypeLinks detail={detail} copy={ctx.copy} phone={ctx.phone} onSelectType={setSelectedId} />
        </div>
      )}
      {dialog && (
        <Dialog
          title={t.newTypeTitle}
          closeLabel={ctx.copy.common.close}
          size="sm"
          onClose={() => setDialog(null)}
          footer={<><Button onClick={() => setDialog(null)}>{d.common.cancel}</Button><Button variant="primary" onClick={createType}>{t.create}</Button></>}
        >
          <div className="space-y-3">
            <TextField autoFocus label={t.typeName} value={dialog.name} onChange={(v) => setDialog({ ...dialog, name: v })} onEnter={createType} error={dialog.tried && !dialog.name.trim() ? t.nameRequired : undefined} />
            <TextField label={t.typeAbout} value={dialog.about} onChange={(v) => setDialog({ ...dialog, about: v })} onEnter={createType} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
