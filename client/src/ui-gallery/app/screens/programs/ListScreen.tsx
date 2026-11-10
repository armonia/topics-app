import { ProgramDetail, ProgramsSummary } from '../../../../ui/programs/ProgramDetail';
import { ProgramsScreen } from '../../../../ui/programs/ProgramsScreen';
import { FAMILIES, FAMILY_OF, type ConnectionFamily, type ProgramDetailModel, type ProgramGroupModel } from '../../../../ui/programs/model';
import { PROGRAMS, PROGRAM_AREAS, programSeed, type ProgramSeed } from '../../../../ui/fixtures/programs';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { INITIAL_PROGRAMS } from './state';
import { accessLinesOf, alternativesOf, channelsUsing, flowsUsing, liveComputers, programState, viewOf } from './derive';
import { vaultSlice } from '../../store/vault';
import { jobView, matchesAll } from './util';
import { runTest, testJobId } from './test';

/** w06: the programs by area, with the one chosen open in the panel. */
export function ProgramsListScreen({ ctx, selectedId }: { ctx: ScreenCtx; selectedId?: string }) {
  const c = ctx.copy.programs;
  const l = c.list;
  const [slice] = ctx.slice('programs', INITIAL_PROGRAMS);
  const [vault] = vaultSlice(ctx);
  const st = viewOf(slice, vault);
  const [query, setQuery] = ctx.ui('programs.q', '');
  const [family, setFamily] = ctx.ui<ConnectionFamily | 'all'>('programs.family', 'all');
  const [, setMode] = ctx.ui('programs.search.mode', 'catalog');
  const [, setSearchQuery] = ctx.ui('programs.search.q.catalog', '');
  const computers = liveComputers(st);
  const [, setSelection] = ctx.ui('programs.migration.program', 'halley');

  const stateText = (seed: ProgramSeed) => {
    const s = programState(seed, st, computers);
    if (s.agentGone) return l.agentRemoved;
    if (seed.id === 'halley' && !st.halleyPasswordAt) return l.passwordExpired;
    if (s.kind === 'ok' && seed.id === 'halley') return l.passwordNew(st.halleyPasswordAt);
    return c.common.state[s.kind];
  };

  // A program that is not connected yet is only planned in its flows; never say a flow uses it.
  const usageText = (seed: ProgramSeed, flowCount: number, kind: string) => {
    if (kind === 'to-connect') return flowCount ? l.flowsPlanned(flowCount) : l.notUsed;
    if (flowCount) return l.flows(flowCount);
    const channelCount = channelsUsing(seed).length;
    return channelCount ? l.channels(channelCount) : l.notUsed;
  };

  const rowOf = (seed: ProgramSeed) => {
    const flows = flowsUsing(seed);
    const alt = alternativesOf(seed.id);
    const s = programState(seed, st, computers);
    const job = ctx.job(testJobId(seed.id));
    return {
      id: seed.id,
      name: seed.name,
      sub: seed.sub,
      holds: seed.holds.map((h) => ({ kind: h.kind, name: h.name })),
      connection: { kind: seed.connection, label: c.common.connection[seed.connection] },
      usage: usageText(seed, flows.length, s.kind),
      state: job?.status === 'running' ? { kind: 'testing' as const, text: c.common.state.testing } : { kind: s.kind, text: stateText(seed) },
      alternatives: alt && alt.count > 0 ? `${alt.count} · ${c.common.verdict[alt.verdict]}` : undefined,
      selected: selectedId === seed.id,
      onOpen: () => ctx.go(P.program(seed.id)),
    };
  };

  const matches = (seed: ProgramSeed) => {
    if (family !== 'all' && FAMILY_OF[seed.connection] !== family) return false;
    if (!query.trim()) return true;
    const area = PROGRAM_AREAS.find((a) => a.id === seed.area)?.label ?? '';
    return matchesAll(`${seed.name} ${seed.sub ?? ''} ${seed.maker ?? ''} ${seed.description} ${seed.holds.map((h) => h.name).join(' ')} ${area}`, query);
  };

  const groups: ProgramGroupModel[] = PROGRAM_AREAS.map((a) => ({ id: a.id, label: a.label, rows: PROGRAMS.filter((p) => p.area === a.id && matches(p)).map(rowOf) }));

  const countOf = (f: ConnectionFamily) => PROGRAMS.filter((p) => FAMILY_OF[p.connection] === f).length;
  const families = [
    { id: 'all' as const, label: l.filterAll, count: PROGRAMS.length, active: family === 'all' },
    ...FAMILIES.map((f) => ({ id: f, label: c.common.family[f], count: countOf(f), active: family === f })),
  ];

  const seed = selectedId ? programSeed(selectedId) : undefined;
  let panel;
  if (seed) {
    const s = programState(seed, st, computers);
    const flows = flowsUsing(seed);
    const check = st.checks[seed.id];
    const job = jobView(ctx.job(testJobId(seed.id)));
    const connecting = s.kind === 'to-connect';
    const detail: ProgramDetailModel = {
      id: seed.id,
      connectionKind: seed.connection,
      connectionLabel: c.common.connection[seed.connection],
      name: seed.name,
      description: seed.description,
      reads: seed.reads.map((r) => ({ field: { kind: r.kind, name: r.name }, value: r.value })),
      usedBy: flows.map((f) => ({
        id: f.id,
        label: f.name,
        value: f.perMonth > 0 ? l.perMonth(f.perMonth) : l.flowStatus(f.status),
        onOpen: () => ctx.go(P.flow(f.id)),
      })).concat(channelsUsing(seed).map((ch) => ({
        id: `channel-${ch.id}`,
        label: ch.name,
        value: l.channelWord,
        onOpen: () => ctx.go(P.channels(ch.id)),
      }))),
      access: accessLinesOf(seed, st, c),
      lastCheck: check
        ? check.ok
          ? { tone: 'green', text: l.checkOk(seed.name, check.at), lines: l.checkLines[seed.connection] }
          : { tone: 'red', text: check.why ?? '', lines: [seed.id === 'halley' && !st.halleyPasswordAt ? l.passwordAdvice : l.failedAdvice] }
        : undefined,
    };
    const agentHost = seed.connection === 'browser' || seed.connection === 'pc-agent';
    panel = (
      <ProgramDetail
        detail={detail}
        copy={ctx.copy}
        job={job}
        testLabel={connecting ? l.detail.connect : l.detail.test}
        onTest={ctx.allow('run:tests', () => runTest(ctx, seed, connecting))}
        testTitle={ctx.deniedTitle('run:tests')}
        onOpenAgent={agentHost ? () => ctx.go(P.pcAgent()) : undefined}
        openAgentLabel={seed.connection === 'browser' ? l.detail.openAgentBrowser : l.detail.openAgentPc}
        onMigration={() => {
          setSelection(seed.id);
          ctx.go(P.migration());
        }}
      />
    );
  } else {
    panel = (
      <ProgramsSummary
        copy={ctx.copy}
        rows={FAMILIES.map((f) => ({ family: f, count: countOf(f), active: family === f }))}
        onPick={(f) => setFamily(family === f ? 'all' : f)}
      />
    );
  }

  return (
    <ProgramsScreen
      copy={ctx.copy}
      groups={groups}
      total={PROGRAMS.length}
      query={query}
      onQuery={setQuery}
      families={families}
      onFamily={setFamily}
      onAdd={ctx.allow('edit:structure', () => {
        setMode('catalog');
        ctx.go(P.programSearch());
      })}
      onAddQuery={ctx.allow('edit:structure', () => {
        setMode('catalog');
        setSearchQuery(query.trim());
        ctx.go(P.programSearch());
      })}
      panel={panel}
      phone={ctx.phone}
    />
  );
}
