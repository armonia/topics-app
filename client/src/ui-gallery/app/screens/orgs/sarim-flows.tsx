/**
 * w07 for SARIM: the list of its flows and one flow as steps and paths. The
 * report flow has five lanes by type of report, side by side; the others are
 * plain steps.
 */
import { Workflow } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { SarimFlowScreen } from '../../../../ui/sarim/SarimFlowScreen';
import { SarimFlowsList } from '../../../../ui/sarim/SarimFlowsList';
import type { FlowView, FlowModel } from '../../../../ui/flows/model';
import { PLAIN_FLOWS, SARIM_FLOWS, REPORTS_AFTER, REPORTS_FLOW } from '../../../../ui/fixtures/sarim';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { fmt, modelFromListed, sarimFlow, sarimFlows, sarimStuck } from './sarim-model';
import { SARIM_INITIAL, type SarimState } from './sarim-state';

const REPORTS_FLOW_ID = 'sarim-segnalazioni';
const NO_BRANCH: FlowModel['branch'] = { marker: '', count: 0, paths: [] };
const STATUS_TONE = { attivo: 'green', collaudo: 'amber', bozza: 'neutral', spento: 'neutral' } as const;

export function renderSarimFlows(ctx: ScreenCtx) {
  const s = ctx.copy.orgs.sarim;
  const [query, setQuery] = ctx.ui<string>('sarim.flows.q', '');
  const [area, setArea] = ctx.ui<string>('sarim.flows.area', 'all');
  const [st] = ctx.slice<SarimState>('sarim', SARIM_INITIAL);
  const stuck = sarimStuck(st, ctx.copy);
  const q = query.trim().toLowerCase();
  const rows = sarimFlows()
    .filter((f) => area === 'all' || f.seed.area === area)
    .filter((f) => !q || `${f.name} ${f.seed.area} ${f.trigger}`.toLowerCase().includes(q))
    .map((f) => ({
      id: f.seed.id,
      name: f.name,
      area: f.seed.area,
      trigger: f.trigger,
      status: { text: s.statusLabel(f.status, f.version), tone: STATUS_TONE[f.status] },
      perMonth: fmt(f.perMonth),
      waiting: stuck[f.seed.id] ? `${stuck[f.seed.id]!.place} · ${stuck[f.seed.id]!.count}` : undefined,
      onOpen: () => ctx.go(P.sarimFlow(f.seed.id)),
    }));
  const areas = [{ value: 'all', label: s.allAreas }, ...Array.from(new Set(SARIM_FLOWS.map((f) => f.area))).map((a) => ({ value: a, label: a }))];
  return (
    <SarimFlowsList
      rows={rows}
      areas={areas}
      area={area}
      onArea={setArea}
      query={query}
      onQuery={setQuery}
      onNew={ctx.allow('edit:structure', () => ctx.go(P.flowNew()))}
      newTitle={ctx.deniedTitle('edit:structure')}
      onClear={() => { setQuery(''); setArea('all'); }}
      copy={ctx.copy}
    />
  );
}

export const sarimFlowTitle = (id: string, ctx: ScreenCtx) => sarimFlow(id)?.name ?? ctx.copy.orgs.sarim.flowNotFound;

export function renderSarimFlow(id: string, ctx: ScreenCtx) {
  const s = ctx.copy.orgs.sarim;
  const info = sarimFlow(id);
  const isReport = id === REPORTS_FLOW_ID;
  const status = info ? { text: s.statusLabel(info.status, info.version), tone: STATUS_TONE[info.status] } : undefined;
  const plain = info && status && !isReport ? (PLAIN_FLOWS[id]?.model ? { ...PLAIN_FLOWS[id].model, status, branch: NO_BRANCH } : modelFromListed(info, ctx.copy, status)) : undefined;
  const base: FlowModel | undefined = isReport && status ? { ...REPORTS_FLOW, status } : plain;
  const model = base && info ? { ...base, crumbs: [{ label: ctx.copy.flows.root }, { label: info.name }] } : undefined;
  if (!info || !status || !model) {
    return (
      <EmptyState icon={Workflow} title={s.flowNotFound} action={<Button onClick={() => ctx.go(P.sarimFlows())}>{s.backToFlows}</Button>}>
        {s.flowNotFoundBody}
      </EmptyState>
    );
  }
  const toView = (v: FlowView) => {
    const to: Record<FlowView, string | undefined> = {
      steps: undefined,
      byOffice: P.flowOffices(id),
      runs: P.flowRuns(id),
      tests: P.flowTest(id),
      versions: P.flowVersions(id),
      log: P.settings('registro'),
    };
    const target = to[v];
    if (target) ctx.go(target);
  };
  return (
    <SarimFlowScreen
      flow={model}
      after={isReport ? REPORTS_AFTER : undefined}
      collected={model.collected}
      copy={ctx.copy}
      onViewChange={toView}
      onTry={ctx.allow('run:tests', () => ctx.go(P.flowTest(id)))}
      tryTitle={ctx.deniedTitle('run:tests')}
      onOpenView={() => ctx.go(P.sarimCallCenter())}
      phone={ctx.phone}
    />
  );
}
