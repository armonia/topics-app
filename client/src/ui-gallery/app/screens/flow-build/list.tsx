/** n01: the list of flows. */
import { Copy, FlaskConical, FolderOpen, Power } from 'lucide-react';
import type { MenuItemModel } from '../../../../ui/primitives/Menu';
import { FlowListScreen, type FlowRowModel } from '../../../../ui/flows/FlowList';
import { OFFICE_LABEL, ORGS } from '../../../../ui/fixtures/org/people';
import { DEMO_TODAY, addDays, formatShortDay } from '../../../../ui/fixtures/org/clock';
import { FLOW_FACTS, SUGGESTIONS, TEMPLATES } from '../../../../ui/fixtures/flow-build';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { orgCases } from '../../store/cases';
import { stuckLabelOf, stuckOffices } from '../orgs/overview-model';
import { TESTS_INITIAL, flowTrialRunning, testedVersion, type TestsSlice } from '../team/testing';
import { askSwitch, createFlow, duplicateFlow, useFlowsSlice } from './actions';
import { capitalize, editedSteps, findFlow, flowsOf, ownerOf } from './model';

// Same words and same count as the «Ferme da persone» column of the overview (n18).
const stuckLabel = (ctx: ScreenCtx, flow: string): string | undefined => {
  const waiting = orgCases(ctx.state, 'nocera').filter((c) => c.status === 'da-confermare');
  return stuckLabelOf(stuckOffices(waiting, flow), ctx.copy);
};

function modifiedLabel(ctx: ScreenCtx, day: string): string {
  const t = ctx.copy.flowBuild.list;
  if (day === DEMO_TODAY) return t.modifiedToday;
  if (day === addDays(DEMO_TODAY, -1)) return t.modifiedYesterday;
  return formatShortDay(day).replace(/^0/, '');
}

export function FlowListPage({ ctx }: { ctx: ScreenCtx }) {
  const t = ctx.copy.flowBuild.list;
  const [slice, setSlice] = useFlowsSlice(ctx);
  const [tab, setTab] = ctx.ui('flows.tab', 'all');
  const [query, setQuery] = ctx.ui('flows.query', '');
  const [office, setOffice] = ctx.ui('flows.office', 'all');
  const flows = flowsOf(slice, 'nocera');

  const matches = (f: FlowSeed) => {
    if (tab === 'active' && f.status !== 'attivo') return false;
    if (tab === 'testing' && f.status !== 'collaudo') return false;
    if (tab === 'draft' && f.status !== 'bozza') return false;
    if (tab === 'off' && f.status !== 'spento') return false;
    if (office !== 'all' && f.office !== office) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [f.name, f.trigger, OFFICE_LABEL[f.office], ownerOf(f).owner, ...editedSteps(f, slice.edits[f.id]).map((s) => s.label)].join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  };
  const shown = flows.filter(matches);

  const tests = (ctx.state.slices.tests as TestsSlice | undefined) ?? TESTS_INITIAL;
  const rows: FlowRowModel[] = shown.map((f) => {
    const n = editedSteps(f, slice.edits[f.id]).length;
    const runs = f.status === 'attivo' || f.status === 'collaudo';
    const created = 'createdAt' in f ? (f as { createdAt: string }).createdAt : undefined;
    return {
      id: f.id,
      name: f.name,
      subtitle: f.status === 'bozza' ? t.draftBlocks(n) : `${t.version(f.version)} · ${t.blocks(n)}`,
      status: f.status,
      // The footer counts trials (collaudi), and a new version of a live flow is one: say it on its row.
      trial: f.status === 'attivo' && flowTrialRunning(f, tests) ? t.versionOnTrial(testedVersion(f)) : undefined, // allow-italian: state value compared by value, not shown
      trigger: capitalize(f.trigger),
      today: runs && f.perMonth > 0 ? Math.max(1, Math.round(f.perMonth / 22)) : undefined,
      stuck: stuckLabel(ctx, f.id) ? { label: stuckLabel(ctx, f.id)! } : undefined,
      errors: runs ? (FLOW_FACTS[f.id]?.errors ?? 0) : undefined,
      owner: { label: ownerOf(f).owner, monogram: ownerOf(f).monogram, color: ownerOf(f).color },
      modified: modifiedLabel(ctx, created ?? FLOW_FACTS[f.id]?.modified ?? DEMO_TODAY),
    };
  });

  const tabs = [
    { value: 'all', label: t.tabs.all, count: flows.length },
    { value: 'active', label: t.tabs.active, count: flows.filter((f) => f.status === 'attivo').length },
    { value: 'testing', label: t.tabs.testing, count: flows.filter((f) => f.status === 'collaudo').length },
    { value: 'draft', label: t.tabs.draft, count: flows.filter((f) => f.status === 'bozza').length },
    { value: 'off', label: t.tabs.off, count: flows.filter((f) => f.status === 'spento').length },
  ];
  const offices = [
    { value: 'all', label: t.allOffices },
    ...[...new Set(flows.map((f) => f.office))].map((o) => ({ value: o, label: OFFICE_LABEL[o] })),
  ];

  const canEdit = ctx.can('edit:structure');
  const canTest = ctx.can('run:tests');
  const menuItems = (id: string): MenuItemModel[] => {
    const f = findFlow(slice, id)!;
    const off = f.status === 'spento';
    return [
      { id: 'open', label: t.menu.open, icon: FolderOpen },
      { id: 'duplicate', label: t.menu.duplicate, icon: Copy, disabled: !canEdit, title: canEdit ? undefined : ctx.deniedTitle('edit:structure') },
      { id: 'test', label: t.menu.test, icon: FlaskConical, disabled: !canTest, title: canTest ? undefined : ctx.deniedTitle('run:tests') },
      { id: 'sep', label: '', separator: true },
      { id: 'switch', label: off ? t.menu.turnOn : t.menu.turnOff, icon: Power, danger: !off, disabled: !canEdit, title: canEdit ? undefined : ctx.deniedTitle('edit:structure') },
    ];
  };
  const onMenu = (id: string, item: string) => {
    const f = findFlow(slice, id);
    if (!f) return;
    if (item === 'open') ctx.go(P.flow(id));
    else if (item === 'test') ctx.go(P.flowTest(id));
    else if (item === 'duplicate') duplicateFlow(ctx, slice, setSlice, f);
    else if (item === 'switch') askSwitch(ctx, setSlice, f, f.status === 'spento' ? 'attivo' : 'spento');
  };

  const suggestion = (id: string) => ctx.allow('edit:structure', () => {
    const s = SUGGESTIONS.find((x) => x.id === id)!;
    const template = TEMPLATES.find((x) => x.id === s.template)!;
    const exists = template.existing ? flows.find((f) => f.id === template.existing) : flows.find((f) => f.name === template.seed.name);
    if (exists) {
      ctx.go(P.flow(exists.id));
      return;
    }
    const newId = createFlow(ctx, slice, setSlice, { ...template.seed, origin: 'suggestion' });
    ctx.go(P.flow(newId));
  });

  return (
    <FlowListScreen
      copy={ctx.copy}
      crumbs={[{ label: ctx.copy.flows.root, detail: ORGS.find((o) => o.id === 'nocera')!.name }]}
      rows={rows}
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      query={query}
      onQuery={setQuery}
      offices={offices}
      office={office}
      onOffice={setOffice}
      onNew={ctx.allow('edit:structure', () => ctx.go(P.flowNew()))}
      newTitle={ctx.deniedTitle('edit:structure')}
      onTestAll={ctx.allow('run:tests', () => ctx.go(P.testAll()))}
      testTitle={ctx.deniedTitle('run:tests')}
      onOpen={(id) => ctx.go(P.flow(id))}
      onOpenStuck={() => ctx.go(P.inbox())}
      menuItems={menuItems}
      onMenu={onMenu}
      suggestions={SUGGESTIONS.map((s) => ({ id: s.id, title: s.title, body: s.body }))}
      onSuggestion={suggestion}
      onAllTemplates={() => ctx.go(P.flowNew())}
      onResetFilters={() => { setTab('all'); setQuery(''); setOffice('all'); }}
      phone={ctx.phone}
    />
  );
}
