/**
 * t01: the team and the permissions on data. People with their role and
 * offices (changed here, kept in the slice `team`), the role matrix whose
 * switches really change what a role sees, and the invitations that wait.
 */
import type { ReactNode } from 'react';
import type { Office, OrgKey } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL, ORGS, ROLES, type Permission } from '../../../../ui/fixtures/org/people';
import { OFFICE_ORDER } from '../../../../ui/fixtures/team';
import type { InviteRowModel, MatrixRowModel, OptionModel, PersonRowModel } from '../../../../ui/team/model';
import { InviteButton, type PersonEdit } from '../../../../ui/team/PeopleTable';
import { SquadPage, type SquadTab } from '../../../../ui/team/SquadPage';
import type { TimelineItemModel } from '../../../../ui/primitives/Timeline';
import type { ScreenCtx, ScreenDef } from '../../kit';
import { P } from '../../paths';
import { rolePermissions } from '../../store/permissions';
import { settingsFrame } from '../settings-frame';
import { agoLabel, personName, whenLabel } from './format';
import { TEAM_INITIAL, effectivePeople, roleLabel, type TeamSlice } from './teamState';

const DATA_ORDER = [
  'view:today', 'view:inbox', 'view:data', 'view:knowledge', 'view:views', 'view:overview', 'view:board', 'view:callcenter', 'edit:data', 'export',
] as const;

export const roleOptions = (): OptionModel[] => ROLES.map((r) => ({ value: r.id, label: r.label }));
export const orgOptions = (): OptionModel[] => ORGS.map((o) => ({ value: o.id, label: o.name }));
const orgName = (id: string) => ORGS.find((o) => o.id === id)?.name ?? id;

/** The invite flow shared with n16: a job with visible progress, a receipt, a log line. */
export function inviteActions(ctx: ScreenCtx, setTeam: (fn: (prev: TeamSlice) => TeamSlice) => void) {
  const i = ctx.copy.team.squad.invites;
  const send = (email: string, role: string, orgs: OrgKey[], resend: boolean) => {
    ctx.startJob({
      id: `invite:${email}`,
      title: i.jobTitle(email),
      steps: [{ label: i.jobStep, ms: 900 }],
      onDone: () => {
        setTeam((prev) => {
          const exists = prev.invites.some((x) => x.email === email);
          const entry = { id: `inv-${prev.invites.length + 1}-${email}`, email, role, orgs, sentAt: ctx.now, by: ctx.persona.id };
          return {
            ...prev,
            invites: exists ? prev.invites.map((x) => (x.email === email ? { ...x, sentAt: ctx.now } : x)) : [entry, ...prev.invites],
          };
        });
        ctx.log(resend ? i.logResent(email) : i.logSent(email, roleLabel(role)), 'permission', P.settings('squadra'));
        ctx.toast({
          tone: 'ok',
          title: resend ? i.resentToast : i.sentToast,
          body: resend ? i.resentBody(email) : i.sentBody(email),
          action: { label: i.receiptTitle, path: P.settings('squadra') },
        });
      },
    });
  };
  return { send };
}

export function squadScreen(_p: Record<string, string>, ctx: ScreenCtx): ReactNode {
  const s = ctx.copy.team.squad;
  const [team, setTeam] = ctx.slice<TeamSlice>('team', TEAM_INITIAL);
  const [tab, setTab] = ctx.ui<SquadTab>('team.squad.tab', 'people');
  const [query, setQuery] = ctx.ui<string>('team.squad.query', '');
  const [roleFilter, setRoleFilter] = ctx.ui<string>('team.squad.role', '');
  const canAdmin = ctx.can('admin');
  const denied = canAdmin ? undefined : ctx.deniedTitle('admin') ?? ctx.copy.team.structure.onlyAdmin;
  const { send } = inviteActions(ctx, setTeam);

  /* People, with their changes. */
  const people = effectivePeople(team);
  const q = query.trim().toLowerCase();
  const rows: PersonRowModel[] = people
    .map((p) => ({
      id: p.id,
      name: p.name,
      monogram: p.monogram,
      color: p.color,
      roleId: p.role,
      roleLabel: roleLabel(p.role),
      offices: p.offices.map((o) => OFFICE_LABEL[o]),
      officeIds: p.offices as string[],
      orgs: p.orgs.map(orgName),
      orgIds: p.orgs as string[],
      you: p.id === ctx.persona.id,
      example: p.example,
      sees: '',
    }))
    .filter((r) => (roleFilter === '' || r.roleId === roleFilter) && (q === '' || `${r.name} ${r.roleLabel} ${r.offices.join(' ')}`.toLowerCase().includes(q)));

  const onSave = (personId: string, edit: PersonEdit) => {
    const p = people.find((x) => x.id === personId);
    if (!p) return;
    const apply = () => {
      setTeam((prev) => ({ ...prev, overrides: { ...prev.overrides, [personId]: { role: edit.role, offices: edit.offices as Office[], orgs: edit.orgs as OrgKey[] } } }));
      if (edit.role !== p.role) ctx.log(s.logRole(p.name, roleLabel(p.role), roleLabel(edit.role)), 'permission', P.settings('squadra'));
      if (edit.offices.join() !== p.offices.join()) ctx.log(s.logOffices(p.name), 'permission', P.settings('squadra'));
      if (edit.orgs.join() !== p.orgs.join()) ctx.log(s.logOrgs(p.name), 'permission', P.settings('squadra'));
      ctx.toast({ tone: 'ok', title: s.saved, body: s.savedBody });
    };
    if (personId === ctx.persona.id && edit.role !== p.role && !rolePermissions(ctx.state, edit.role).has('admin')) {
      ctx.confirm({ title: s.selfRoleTitle, body: s.selfRoleBody, confirmLabel: s.selfRoleConfirm, tone: 'danger', onConfirm: apply });
      return;
    }
    apply();
  };

  /* The matrix of permissions on data. */
  const dataRows: MatrixRowModel[] = DATA_ORDER.map((perm) => ({
    id: perm,
    label: s.dataRows[perm].label,
    hint: s.dataRows[perm].hint,
    values: Object.fromEntries(ROLES.map((r) => [r.id, rolePermissions(ctx.state, r.id).has(perm)])),
    changed: Object.fromEntries(ROLES.map((r) => [r.id, rolePermissions(ctx.state, r.id).has(perm) !== r.permissions.includes(perm)])),
  }));
  const toggle = (roleId: string, permId: string, next: boolean) => {
    const perm = permId as Permission;
    const role = ROLES.find((r) => r.id === roleId);
    if (!role) return;
    const t = ctx.copy.team.structure.toggles;
    const label = s.dataRows[permId as (typeof DATA_ORDER)[number]]?.label ?? permId;
    ctx.dispatch({ type: 'permission', role: roleId, permission: perm, value: next === role.permissions.includes(perm) ? undefined : next });
    ctx.log(next ? t.logOn(role.label, label) : t.logOff(role.label, label), 'permission', P.settings('squadra'));
    ctx.toast({ tone: 'ok', title: next ? t.toastOn(role.label, label) : t.toastOff(role.label, label) });
  };

  /* The last changes of permissions, from the log. */
  const recent: TimelineItemModel[] = ctx.state.audit
    .filter((a) => a.kind === 'permission')
    .slice(0, 4)
    .map((a) => ({ id: a.id, at: whenLabel(ctx.copy.team, a.at, ctx.now), title: a.what, who: personName(a.who), tone: 'neutral' as const }));

  /* Invitations. */
  const inviteRows: InviteRowModel[] = team.invites.map((inv) => {
    const sending = ctx.job(`invite:${inv.email}`)?.status === 'running';
    return {
      id: inv.id,
      email: inv.email,
      role: roleLabel(inv.role),
      orgs: inv.orgs.map(orgName),
      sent: agoLabel(ctx.copy.team, inv.sentAt, ctx.now),
      sending,
      onResend: ctx.allow('admin', () => send(inv.email, inv.role, inv.orgs, true)),
      onCancel: ctx.allow('admin', () => {
        ctx.confirm({
          title: s.invites.cancelTitle,
          body: s.invites.cancelBody(inv.email),
          confirmLabel: s.invites.cancelConfirm,
          tone: 'danger',
          onConfirm: () => {
            setTeam((prev) => ({ ...prev, invites: prev.invites.filter((x) => x.id !== inv.id) }));
            ctx.log(s.invites.logCancelled(inv.email), 'permission', P.settings('squadra'));
            ctx.toast({ tone: 'info', title: s.invites.cancelledToast });
          },
        });
      }),
    };
  });

  const inviteControl = (
    <InviteButton
      label={s.invite}
      copy={ctx.copy}
      roles={roleOptions()}
      orgs={orgOptions()}
      existing={team.invites.map((i) => i.email)}
      allowed={canAdmin}
      deniedTitle={denied}
      onInvite={(inv) => {
        setTab('invites');
        send(inv.email, inv.role, inv.orgs as OrgKey[], false);
      }}
    />
  );

  return settingsFrame(ctx, 'squadra', {
    actions: inviteControl,
    children: (
      <SquadPage
        copy={ctx.copy}
        tab={tab}
        onTab={setTab}
        people={rows}
        roles={roleOptions()}
        offices={OFFICE_ORDER.map((o) => ({ value: o, label: OFFICE_LABEL[o] }))}
        orgs={orgOptions()}
        onSave={onSave}
        canEdit={canAdmin}
        deniedTitle={denied}
        query={query}
        onQuery={setQuery}
        roleFilter={roleFilter}
        onRoleFilter={setRoleFilter}
        onClear={() => {
          setQuery('');
          setRoleFilter('');
        }}
        matrixRoles={ROLES.map((r) => ({ id: r.id, label: r.label }))}
        matrixRows={dataRows}
        onToggle={toggle}
        matrixDisabledTitle={denied}
        recent={recent}
        invites={inviteRows}
      />
    ),
  });
}

export const SQUAD_SCREEN: ScreenDef = {
  id: 't01',
  path: '/impostazioni/squadra',
  org: 'nocera',
  nav: 'settings',
  needs: 'view:settings',
  samples: [P.settings('squadra')],
  title: (_p, ctx) => ctx.copy.app.settingsSections.squadra,
  render: squadScreen,
};

