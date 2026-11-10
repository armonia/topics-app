import type { AddFormModel, PcActionModel } from '../../../../ui/programs/AgentsScreen';
import { AgentsScreen } from '../../../../ui/programs/AgentsScreen';
import type { PcDetailModel, PcRowModel, PlaceCardModel } from '../../../../ui/programs/model';
import {
  AGENT_FOOTPRINT, AGENT_VERSION, COMPUTERS, PC_OFFICES, PROGRAMS, REMOTE_REASONS, SERVER_PC, programSeed,
} from '../../../../ui/fixtures/programs';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { INITIAL_PROGRAMS } from './state';
import { agentComputers, liveComputers, withDefaults, type LivePc } from './derive';
import { jobView, linkCode } from './util';

type Place = '' | 'browser' | 'pc' | 'remote';

interface FormState {
  open: boolean;
  name: string;
  office: string;
  system: string;
}

const INITIAL_FORM: FormState = { open: false, name: '', office: PC_OFFICES[0], system: '10' };
const updateJobId = (pc: string) => `programs.update.${pc}`;
const reinstallJobId = (pc: string) => `programs.reinstall.${pc}`;
const addJobId = 'programs.agents.add';

/** e01: where the agents run, the office PCs with their agent, and how to link one more. */
export function AgentsPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.programs;
  const e = c.agents;
  const [slice, update] = ctx.slice('programs', INITIAL_PROGRAMS);
  const st = withDefaults(slice);
  const [place, setPlace] = ctx.ui<Place>('programs.agents.place', '');
  const [selected, setSelected] = ctx.ui('programs.agents.pc', '');
  const [form, setForm] = ctx.ui<FormState>('programs.agents.form', INITIAL_FORM);
  const computers = liveComputers(st);

  const lastSeen = (p: LivePc) => (p.state === 'too-old' || p.state === 'removed' ? '-' : p.lastSeenMin === 0 ? c.common.now : c.common.minutesAgo(p.lastSeenMin));
  const stateOf = (p: LivePc): PcRowModel['state'] => {
    const updating = ctx.job(updateJobId(p.id))?.status === 'running' || ctx.job(reinstallJobId(p.id))?.status === 'running';
    if (updating) return { kind: 'updating', text: e.pcState.updating };
    return { kind: p.state, text: e.pcState[p.state] };
  };

  const browserPrograms = PROGRAMS.filter((p) => p.connection === 'browser').map((p) => p.name).join(', ');
  const serverRow: PcRowModel = {
    id: 'server', name: SERVER_PC.id, where: SERVER_PC.where, traits: SERVER_PC.traits, does: browserPrograms,
    state: { kind: 'working', text: e.pcState.working }, lastSeen: c.common.now, selected: false,
  };
  const pcRows: PcRowModel[] = computers.map((p) => ({
    id: p.id,
    name: p.id,
    where: p.office,
    traits: [p.os, `${p.ramGb} GB`, p.year ? String(p.year) : ''].filter(Boolean).join(' · '),
    does: p.does,
    state: stateOf(p),
    lastSeen: lastSeen(p),
    selected: selected === p.id,
    onOpen: () => setSelected(p.id),
  }));

  const agents = agentComputers(computers);
  const remoteReady = computers.filter((p) => p.state !== 'too-old');
  const visibleRows = place === 'browser' ? [serverRow]
    : place === 'pc' ? pcRows.filter((r) => agents.some((p) => p.id === r.id))
      : place === 'remote' ? pcRows.filter((r) => remoteReady.some((p) => p.id === r.id))
        : [...pcRows, serverRow];

  const press = (p: Place) => () => setPlace(place === p ? '' : p);
  const cards: PlaceCardModel[] = [
    {
      id: 'browser', kind: 'browser', tag: e.place.browser.tag, title: e.place.browser.title, description: e.place.browser.description,
      stateLabel: e.place.stateLabel, stateText: e.place.browser.state, stateTone: 'green', pressed: place === 'browser', onPress: press('browser'),
    },
    {
      id: 'pc', kind: 'pc', tag: e.place.pc.tag, title: e.place.pc.title, description: e.place.pc.description,
      stateLabel: e.place.stateLabel, stateText: agents.length ? e.place.activeOn(agents.length) : e.place.none, stateTone: agents.length ? 'green' : 'neutral', pressed: place === 'pc', onPress: press('pc'),
    },
    {
      id: 'remote', kind: 'remote', tag: e.place.remote.tag, title: e.place.remote.title, description: e.place.remote.description,
      stateLabel: e.place.stateLabel, stateText: e.place.remote.state, stateTone: 'neutral', pressed: place === 'remote', onPress: press('remote'),
    },
  ];

  const chosen = computers.find((p) => p.id === selected);
  const outdated = (p: LivePc) => Boolean(p.version) && p.version !== AGENT_VERSION && p.state !== 'removed' && p.state !== 'too-old';
  const detail: PcDetailModel | undefined = chosen && {
    id: chosen.id,
    name: chosen.id,
    tag: stateOf(chosen).text,
    rows: [
      { label: e.detail.system, value: e.detail.systemValue(chosen.os, chosen.ramGb, chosen.year) },
      { label: e.detail.version, value: chosen.version && chosen.state !== 'removed' && chosen.state !== 'too-old' ? (outdated(chosen) ? e.detail.versionOld(chosen.version, AGENT_VERSION) : e.detail.versionLatest(chosen.version)) : e.detail.none },
      { label: e.detail.memory, value: chosen.kind === 'agent' || chosen.kind === 'remote-only' ? e.detail.memoryValue(AGENT_FOOTPRINT.memoryMb) : e.detail.none },
      { label: e.detail.lastSignal, value: lastSeen(chosen) },
      { label: e.detail.programs, value: chosen.programs.length ? chosen.programs.map((id) => programSeed(id)?.name ?? id).join(', ') : e.detail.noProgramsValue },
    ],
    note: chosen.advice,
    noteTone: 'red',
  };

  const startUpdate = (p: LivePc) => ctx.startJob({
    id: updateJobId(p.id),
    title: e.updateJob(p.id),
    steps: e.updateSteps.map((label, i) => ({ label, ms: 600 + i * 120 })),
    onDone: () => {
      update((prev) => {
        const s = withDefaults(prev);
        return { ...s, versions: { ...s.versions, [p.id]: AGENT_VERSION } };
      });
      ctx.toast({ tone: 'ok', title: e.updateToast(p.id, AGENT_VERSION) });
      ctx.log(e.updateLog(p.id, AGENT_VERSION), 'structure', P.agents());
    },
  });
  const startReinstall = (p: LivePc) => ctx.startJob({
    id: reinstallJobId(p.id),
    title: e.reinstallJob(p.id),
    steps: e.updateSteps.map((label, i) => ({ label, ms: 600 + i * 120 })),
    onDone: () => {
      update((prev) => {
        const s = withDefaults(prev);
        return { ...s, removedAgents: s.removedAgents.filter((id) => id !== p.id), versions: { ...s.versions, [p.id]: AGENT_VERSION } };
      });
      ctx.toast({ tone: 'ok', title: e.reinstallToast(p.id) });
      ctx.log(e.reinstallLog(p.id), 'structure', P.agents());
    },
  });
  const goRemote = (p: LivePc) => {
    const reason = REMOTE_REASONS.find((r) => r.pc === p.id);
    update((prev) => {
      const s = withDefaults(prev);
      return s.remote.status === 'live' || s.remote.status === 'asked' ? s : { ...s, remote: { ...s.remote, status: 'idle', pc: p.id, reason: reason?.id ?? s.remote.reason, password: '' } };
    });
    ctx.go(P.remoteControl());
  };

  const actions: PcActionModel[] = [];
  if (chosen && chosen.state !== 'too-old') {
    const hasAgent = chosen.kind === 'agent' || chosen.kind === 'remote-only';
    if (hasAgent && outdated(chosen)) actions.push({ kind: 'update', label: e.detail.update, onClick: ctx.allow('edit:structure', () => startUpdate(chosen)), title: ctx.deniedTitle('edit:structure') });
    if (chosen.id === 'PC-RAGIONERIA-02') actions.push({ kind: 'agent', label: e.detail.openAgent, onClick: () => ctx.go(P.pcAgent()) });
    actions.push({ kind: 'control', label: e.detail.control, onClick: ctx.allow('edit:structure', () => goRemote(chosen)), title: ctx.deniedTitle('edit:structure') });
    if (hasAgent) {
      actions.push({
        kind: 'remove',
        label: e.detail.remove,
        title: ctx.deniedTitle('edit:structure'),
        onClick: ctx.allow('edit:structure', () => ctx.confirm({
          title: e.removeTitle(chosen.id),
          body: e.removeBody,
          confirmLabel: e.removeConfirm,
          tone: 'danger',
          onConfirm: () => {
            update((prev) => {
              const s = withDefaults(prev);
              return { ...s, removedAgents: [...s.removedAgents, chosen.id] };
            });
            ctx.toast({ tone: 'warn', title: e.removeToast(chosen.id) });
            ctx.log(e.removeLog(chosen.id), 'structure', P.agents());
          },
        })),
      });
    }
    if (chosen.state === 'removed') actions.push({ kind: 'reinstall', label: e.detail.reinstall, onClick: ctx.allow('edit:structure', () => startReinstall(chosen)), title: ctx.deniedTitle('edit:structure') });
  }
  const detailJob = chosen ? jobView(ctx.job(updateJobId(chosen.id)) ?? ctx.job(reinstallJobId(chosen.id))) : undefined;

  const nameClean = form.name.trim().toUpperCase();
  const taken = computers.some((p) => p.id === nameClean) || SERVER_PC.id.toUpperCase() === nameClean;
  const addJob = ctx.job(addJobId);
  const formModel: AddFormModel = {
    open: form.open,
    name: form.name,
    office: form.office,
    system: form.system,
    offices: PC_OFFICES.map((o) => ({ value: o, label: o })),
    nameError: addJob?.status === 'running' ? undefined : taken && addJob?.status !== 'done' ? e.form.nameTaken : undefined,
    job: jobView(addJob),
    code: nameClean ? linkCode(nameClean) : undefined,
  };
  const submit = () => {
    if (!nameClean) {
      ctx.toast({ tone: 'warn', title: e.form.nameError });
      return;
    }
    if (taken) {
      ctx.toast({ tone: 'warn', title: e.form.nameTaken });
      return;
    }
    const old = form.system === '7';
    const labels = e.form.steps;
    ctx.startJob({
      id: addJobId,
      title: e.form.jobTitle(nameClean),
      steps: labels.map((label, i) => ({ label, ms: 650 + i * 120, fails: old && i === 1 })),
      onDone: (ok) => {
        if (!ok) {
          ctx.toast({ tone: 'error', title: e.form.toastFailed, body: e.form.failedOld });
          return;
        }
        update((prev) => {
          const s = withDefaults(prev);
          return { ...s, addedPcs: [...s.addedPcs, { id: nameClean, office: form.office, os: `Windows ${form.system}`, version: AGENT_VERSION }] };
        });
        setSelected(nameClean);
        ctx.toast({ tone: 'ok', title: e.form.toast(nameClean) });
        ctx.log(e.form.log(nameClean), 'structure', P.agents());
      },
    });
  };

  return (
    <AgentsScreen
      copy={ctx.copy}
      footprint={AGENT_FOOTPRINT}
      cards={cards}
      rows={visibleRows}
      filterLabel={place ? e.filterTitle(place === 'browser' ? e.place.browser.title : place === 'pc' ? e.place.pc.title : e.place.remote.title) : undefined}
      onClearFilter={() => setPlace('')}
      detail={detail}
      actions={actions}
      detailJob={detailJob}
      notes={COMPUTERS.filter((p) => p.tooOld && p.advice).map((p) => ({ id: p.id, title: p.id, text: p.advice as string }))}
      form={formModel}
      onAdd={ctx.allow('edit:structure', () => setForm((f) => ({ ...f, open: !f.open })))}
      onForm={{
        name: (v) => setForm((f) => ({ ...f, name: v })),
        office: (v) => setForm((f) => ({ ...f, office: v })),
        system: (v) => setForm((f) => ({ ...f, system: v })),
        submit: ctx.allow('edit:structure', submit),
        cancel: () => setForm((f) => ({ ...f, open: false })),
      }}
      backLabel={c.common.programs}
      onBack={() => ctx.go(P.programs())}
      addTitle={ctx.deniedTitle('edit:structure')}
      phone={ctx.phone}
    />
  );
}
