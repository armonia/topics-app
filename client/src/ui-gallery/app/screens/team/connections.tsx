/**
 * n16: people, roles and connections. The connections are the programs the
 * Consorzio uses (`DATI-VERI.md`) with how each is connected and how it is
 * doing; «Ricollega» and «Collega» are jobs with visible progress (the portal (allow-italian: quotes the Italian interface)
 * of Traspare refuses the first attempt, to show the failure and the retry),
 * «Scollega» asks first and says which flows stop. The state lives in the
 * slice `connections`, which the test of a robot (c02) reads.
 */
import type { ReactNode } from 'react';
import { flowsOf } from '../../../../ui/fixtures/org/flows';
import { OFFICE_LABEL, ORGS, type Permission } from '../../../../ui/fixtures/org/people';
import { CONNECTIONS, type ConnectionSeed } from '../../../../ui/fixtures/team';
import { ConnectionsPage } from '../../../../ui/team/ConnectionsPage';
import { InviteButton } from '../../../../ui/team/PeopleTable';
import type { ConnectionDetailModel, ConnectionRowModel, DataLinkModel, PersonRowModel } from '../../../../ui/team/model';
import type { JobCardModel } from '../../../../ui/team/parts';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx, ScreenDef } from '../../kit';
import { P } from '../../paths';
import { rolePermissions } from '../../store/permissions';
import { settingsFrame } from '../settings-frame';
import {
  CONNECTIONS_INITIAL, connectionState, type ConnectionStateId, type ConnectionsSlice,
} from './connectionState';
import { agoLabel, personName } from './format';
import { inviteActions, orgOptions, roleOptions } from './squad';
import { TEAM_INITIAL, effectivePeople, roleLabel, type TeamSlice } from './teamState';
import { vaultSlice } from '../../store/vault';
import { saveHalleyPassword } from '../programs/halley-password';

const STATE: Record<ConnectionStateId, { tone: Tone; icon: 'ok' | 'bad' | 'todo' }> = {
  connected: { tone: 'green', icon: 'ok' },
  error: { tone: 'red', icon: 'bad' },
  todo: { tone: 'neutral', icon: 'todo' },
};

/** The surfaces a role opens, by the permission that opens them, named as the sidebar names them. */
const SURFACE: Array<[Permission, 'today' | 'inbox' | 'flows' | 'data' | 'knowledge' | 'views' | 'channels' | 'programs' | 'overview' | 'settings' | 'callcenter']> = [
  ['view:today', 'today'], ['view:inbox', 'inbox'], ['view:flows', 'flows'], ['view:data', 'data'], ['view:knowledge', 'knowledge'],
  ['view:views', 'views'], ['view:channels', 'channels'], ['view:programs', 'programs'], ['view:overview', 'overview'],
  ['view:settings', 'settings'], ['view:callcenter', 'callcenter'],
];

/** The program a connection serves, as the flows name it: the first word of its name. */
const programOf = (c: ConnectionSeed) => c.name.split(',')[0].trim();

export function connectionsScreen(_p: Record<string, string>, ctx: ScreenCtx): ReactNode {
  const c = ctx.copy.team.connections;
  const [team, setTeam] = ctx.slice<TeamSlice>('team', TEAM_INITIAL);
  const [conns, setConns] = ctx.slice<ConnectionsSlice>('connections', CONNECTIONS_INITIAL);
  const [sel, setSel] = ctx.ui<string>('team.connections.sel', '');
  const canAdmin = ctx.can('admin');
  const denied = canAdmin ? undefined : ctx.deniedTitle('admin') ?? ctx.copy.team.structure.onlyAdmin;
  const { send } = inviteActions(ctx, setTeam);

  /* The state of each connection now. */
  const stateOf = (x: ConnectionSeed) => connectionState(x, conns, vaultSlice(ctx)[0]);
  const lastUse = (x: ConnectionSeed) => conns.states[x.id]?.at ?? x.lastUse;
  const by = (x: ConnectionSeed) => (conns.states[x.id] ? conns.states[x.id].by : x.by);
  const stateText = (st: ConnectionStateId) => c.states[st];
  const usedBy = (x: ConnectionSeed) => flowsOf('nocera').filter((f) => f.steps.some((s) => s.program === programOf(x)));

  const connect = (x: ConnectionSeed) => {
    const was = stateOf(x);
    const attempt = conns.attempts[x.id] ?? 0;
    /* The portal refuses the first attempt after its login changed. */
    const refuses = was === 'error' && attempt === 0;
    ctx.startJob({
      id: `conn:${x.id}`,
      title: was === 'todo' ? c.job.connect(x.name) : c.job.reconnect(x.name),
      steps: [
        { label: c.job.steps.open, ms: 700 },
        { label: c.job.steps.read, ms: 800, fails: refuses },
        { label: c.job.steps.save, ms: 500 },
      ],
      onDone: (ok) => {
        if (!ok) {
          setConns((prev) => ({ ...prev, attempts: { ...prev.attempts, [x.id]: (prev.attempts[x.id] ?? 0) + 1 } }));
          ctx.log(c.log.failed(x.name), 'setting', P.settings('persone'));
          ctx.toast({ tone: 'error', title: c.failedToast(x.name) });
          return;
        }
        setConns((prev) => ({ ...prev, states: { ...prev.states, [x.id]: { state: 'connected', at: ctx.now, by: ctx.persona.id } } }));
        // Reconnecting Halley puts the robot's new login in the vault: the stopped run and Programmi read it from there.
        const went = x.id === 'halley' ? saveHalleyPassword(ctx, { resume: true }) : 0;
        ctx.log(was === 'todo' ? c.log.connected(x.name) : c.log.reconnected(x.name), 'setting', P.settings('persone'));
        ctx.toast({ tone: 'ok', title: c.reconnectedToast(x.name), body: `${c.receipt(x.name)} ${went > 0 ? c.reconnectedResumed : c.reconnectedBody}`, action: { label: ctx.copy.team.common.open, path: P.testAll() } });
      },
    });
  };

  const disconnect = (x: ConnectionSeed) => {
    const flows = usedBy(x);
    ctx.confirm({
      title: c.disconnectTitle(x.name),
      body: flows.length ? c.disconnectBody(x.name, flows.map((f) => f.name).join(', ')) : c.disconnectBodyNone,
      confirmLabel: c.disconnectConfirm,
      tone: 'danger',
      onConfirm: () => {
        setConns((prev) => ({ ...prev, states: { ...prev.states, [x.id]: { state: 'todo', at: ctx.now, by: ctx.persona.id } } }));
        ctx.log(c.log.disconnected(x.name), 'setting', P.settings('persone'));
        if (flows.length) ctx.notify({ title: c.notifyTitle(x.name), body: c.notifyBody, path: P.settings('persone'), tone: 'warn', to: ['direzione', 'attilio'].filter((p) => p !== ctx.persona.id) });
        ctx.toast({ tone: 'info', title: c.disconnectedToast(x.name) });
      },
    });
  };

  /* Rows. */
  const rowOf = (x: ConnectionSeed): ConnectionRowModel => {
    const st = stateOf(x);
    const running = ctx.job(`conn:${x.id}`)?.status === 'running';
    const last = lastUse(x);
    return {
      id: x.id,
      name: x.name,
      how: x.how,
      method: c.methods[x.method],
      state: running ? { tone: 'blue', icon: 'todo', text: c.states.working } : { ...STATE[st], text: stateText(st) },
      by: by(x) ? personName(by(x) as string) : ctx.copy.team.common.blank,
      last: last ? agoLabel(ctx.copy.team, last, ctx.now) : c.lastNever,
      selected: false,
      onSelect: () => setSel(x.id),
    };
  };
  const firstProblem = CONNECTIONS.find((x) => stateOf(x) === 'error') ?? CONNECTIONS[0];
  const selected = CONNECTIONS.find((x) => x.id === sel) ?? firstProblem;
  const rows = CONNECTIONS.map((x) => ({ ...rowOf(x), selected: x.id === selected.id }));
  const counts = { connected: 0, error: 0, todo: 0 };
  for (const x of CONNECTIONS) counts[stateOf(x)] += 1;

  /* The detail of the one picked. */
  const job = ctx.job(`conn:${selected.id}`);
  const st = stateOf(selected);
  // A failed attempt stops showing once the connection is on again (the Halley password saved elsewhere).
  const jobModel: JobCardModel | undefined = job && (job.status === 'running' || (job.status === 'failed' && st !== 'connected'))
    ? {
      title: st === 'todo' ? c.job.connect(selected.name) : c.job.reconnect(selected.name),
      status: job.status,
      progress: job.progress,
      current: job.current,
      detail: `${job.done.length}/3`,
      done: job.done,
      failedTitle: c.failedTitle,
      failedBody: c.failedBody(selected.name),
      retryLabel: c.failedRetry,
      onRetry: ctx.allow('admin', () => connect(selected)),
    }
    : undefined;
  const running = job?.status === 'running';
  const detail: ConnectionDetailModel = {
    id: selected.id,
    name: selected.name,
    what: selected.what,
    how: `${c.methods[selected.method]} · ${selected.how}`,
    state: running ? { tone: 'blue', icon: 'todo', text: c.states.working } : { ...STATE[st], text: stateText(st) },
    problem: st === 'error' ? selected.problem : undefined,
    by: by(selected) ? personName(by(selected) as string) : ctx.copy.team.common.blank,
    last: lastUse(selected) ? agoLabel(ctx.copy.team, lastUse(selected) as string, ctx.now) : c.lastNever,
    rights: c.rights[selected.rights],
    usedBy: usedBy(selected).map((f) => ({ id: f.id, name: f.name, onOpen: () => ctx.go(P.flow(f.id)) })),
    job: jobModel,
    primary: {
      label: st === 'todo' ? c.detail.connect : c.detail.reconnect,
      variant: st === 'connected' ? 'secondary' : 'primary',
      onClick: running ? false : ctx.allow('admin', () => connect(selected)),
    },
    disconnect: st === 'todo' ? undefined : { label: c.detail.disconnect, onClick: ctx.allow('admin', () => disconnect(selected)) },
    onOpenPrograms: () => ctx.go(P.programs()),
  };

  /* People, as t01 reads them. */
  const surfaces = (roleId: string) => {
    const perms = rolePermissions(ctx.state, roleId);
    return SURFACE.filter(([perm]) => perms.has(perm)).map(([, nav]) => ctx.copy.shell.nav[nav]);
  };
  const people: PersonRowModel[] = effectivePeople(team).map((p) => ({
    id: p.id,
    name: p.name,
    monogram: p.monogram,
    color: p.color,
    roleId: p.role,
    roleLabel: roleLabel(p.role),
    offices: p.offices.map((o) => OFFICE_LABEL[o]),
    officeIds: p.offices,
    orgs: p.orgs.map((o) => ORGS.find((x) => x.id === o)?.name ?? o),
    orgIds: p.orgs,
    you: p.id === ctx.persona.id,
    example: p.example,
    sees: surfaces(p.role).join(', '),
  }));

  const dataLinks: DataLinkModel[] = [
    { id: 'where', label: c.dataRows.where, onOpen: () => ctx.go(P.settings('dove-gira')) },
    { id: 'ai', label: c.dataRows.ai, onOpen: () => ctx.go(P.settings('sicurezza')) },
    { id: 'log', label: c.dataRows.log, onOpen: () => ctx.go(P.settings('registro')) },
    { id: 'anon', label: c.dataRows.anon, onOpen: () => ctx.go(P.settings('anonimizzazione')) },
    { id: 'compliance', label: c.dataRows.compliance, onOpen: () => ctx.go(P.settings('conformita')) },
  ];

  const m365 = CONNECTIONS.find((x) => x.id === 'microsoft-365')?.name ?? '';
  return settingsFrame(ctx, 'persone', {
    actions: (
      <InviteButton
        label={c.invite}
        copy={ctx.copy}
        roles={roleOptions()}
        orgs={orgOptions()}
        existing={team.invites.map((i) => i.email)}
        allowed={canAdmin}
        deniedTitle={denied}
        onInvite={(inv) => send(inv.email, inv.role, inv.orgs as never, false)}
      />
    ),
    children: (
      <ConnectionsPage
        copy={ctx.copy}
        intro={c.intro(m365)}
        people={people}
        onOpenPeople={() => ctx.go(P.settings('squadra'))}
        onManage={() => ctx.go(P.settings('squadra'))}
        connections={rows}
        summary={c.summary(counts.connected, counts.error, counts.todo)}
        detail={detail}
        dataLinks={dataLinks}
      />
    ),
  });
}

export const CONNECTIONS_SCREEN: ScreenDef = {
  id: 'n16',
  path: '/impostazioni/persone',
  org: 'nocera',
  nav: 'settings',
  needs: 'view:settings',
  samples: [P.settings('persone')],
  title: (_p, ctx) => ctx.copy.app.settingsSections.persone,
  render: connectionsScreen,
};

