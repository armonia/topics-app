/**
 * c03: who may change the structure. The switches write the permission of a
 * role (`{type:'permission'}`), and the container applies them to everything:
 * the sidebar, the buttons and the answers of the assistant. The table of
 * «chi fa cosa» on each part is read from the same permissions.
 */
import type { ReactNode } from 'react';
import { ROLES, type Permission } from '../../../../ui/fixtures/org/people';
import { ROLE_SHORT, STRUCTURE_AREAS } from '../../../../ui/fixtures/team';
import { flowsOf } from '../../../../ui/fixtures/org/flows';
import { StructurePage, type ProposalDraft } from '../../../../ui/team/StructurePage';
import type { MatrixRowModel, ProposalModel, RightsCell, RightsRowModel, YouRowModel } from '../../../../ui/team/model';
import type { ScreenCtx, ScreenDef } from '../../kit';
import { P } from '../../paths';
import { personaOf, rolePermissions } from '../../store/permissions';
import { settingsFrame } from '../settings-frame';
import { agoLabel, personName } from './format';
import { TEAM_INITIAL, effectivePeople, roleLabel, type TeamSlice } from './teamState';

type StructurePermission = keyof ReturnType<typeof copyRows>;
const copyRows = (ctx: ScreenCtx) => ctx.copy.team.structure.permissionRows;

const ROW_ORDER = [
  'view:flows', 'view:data', 'view:views', 'view:channels', 'view:programs', 'view:knowledge', 'edit:structure', 'run:tests', 'approve', 'admin',
] as const;

/** The permissions that lock a person out of this very page when taken from their own role. */
const LOCKS_OUT: Permission[] = ['admin', 'view:settings'];

/** A cell of the rights table: every role that qualifies, or «tutti» when all of them do. (allow-italian: quotes the Italian interface) */
function cell(roleIds: string[]): RightsCell {
  return roleIds.length === ROLES.length ? { all: true, items: [] } : { items: roleIds.map((r) => ROLE_SHORT[r] ?? r) };
}

export function structureScreen(_p: Record<string, string>, ctx: ScreenCtx): ReactNode {
  const s = ctx.copy.team.structure;
  const [team, setTeam] = ctx.slice<TeamSlice>('team', TEAM_INITIAL);
  const canAdmin = ctx.can('admin');
  const rows = copyRows(ctx);

  const has = (roleId: string, perm: Permission) => rolePermissions(ctx.state, roleId).has(perm);
  const roleIds = (pred: (id: string) => boolean) => ROLES.map((r) => r.id).filter(pred);

  const matrixRows: MatrixRowModel[] = ROW_ORDER.map((perm) => ({
    id: perm,
    label: rows[perm].label,
    hint: rows[perm].hint,
    values: Object.fromEntries(ROLES.map((r) => [r.id, has(r.id, perm)])),
    changed: Object.fromEntries(ROLES.map((r) => [r.id, has(r.id, perm) !== r.permissions.includes(perm)])),
  }));

  const toggle = (roleId: string, permId: string, next: boolean) => {
    const perm = permId as Permission;
    const role = ROLES.find((r) => r.id === roleId);
    if (!role) return;
    const apply = () => {
      ctx.dispatch({ type: 'permission', role: roleId, permission: perm, value: next === role.permissions.includes(perm) ? undefined : next });
      const label = rows[permId as StructurePermission]?.label ?? permId;
      ctx.log(next ? s.toggles.logOn(role.label, label) : s.toggles.logOff(role.label, label), 'permission', P.settings('struttura'));
      ctx.toast({ tone: 'ok', title: next ? s.toggles.toastOn(role.label, label) : s.toggles.toastOff(role.label, label) });
    };
    if (!next && roleId === ctx.persona.role && LOCKS_OUT.includes(perm)) {
      ctx.confirm({
        title: s.toggles.selfTitle,
        body: s.toggles.selfBody(rows[permId as StructurePermission]?.label ?? permId),
        confirmLabel: s.toggles.selfConfirm,
        tone: 'danger',
        onConfirm: apply,
      });
      return;
    }
    apply();
  };

  /* Who does what on each part, from the permissions as they stand. */
  const rights: RightsRowModel[] = STRUCTURE_AREAS.map((a) => {
    const sees = roleIds((r) => has(r, a.view));
    const edits = roleIds((r) => has(r, a.edit) && (a.edit === 'admin' || has(r, 'run:tests')) && has(r, a.view));
    const proposes = roleIds((r) => has(r, a.view) && has(r, 'edit:data') && !edits.includes(r));
    const approves = roleIds((r) => has(r, 'approve') && has(r, a.view));
    return { id: a.id, name: a.name, sees: cell(sees), proposes: cell(proposes), edits: cell(edits), approves: cell(approves) };
  });

  /* What the current person does on each part. */
  const me = personaOf(ctx.state);
  const youRows: YouRowModel[] = STRUCTURE_AREAS.map((a) => ({
    id: a.id,
    name: a.name,
    level: has(me.role, a.edit) && has(me.role, a.view) ? 'edit' : has(me.role, a.view) && has(me.role, 'edit:data') ? 'propose' : has(me.role, a.view) ? 'see' : 'none',
  }));

  const editors = roleIds((r) => has(r, 'edit:structure')).map((r) => ROLE_SHORT[r] ?? r).join(', ') || s.nobody;
  const approvers = roleIds((r) => has(r, 'approve')).map((r) => ROLE_SHORT[r] ?? r).join(', ') || s.nobody;
  const proposals: ProposalModel[] = team.proposals.map((p) => ({
    id: p.id,
    title: p.title,
    reason: p.reason,
    asked: s.proposals.askedBy(personName(p.by), agoLabel(ctx.copy.team, `${p.on}T12:00:00+01:00`, ctx.now)),
    stage: ['proposta', 'modifica', 'collaudo', 'approvazione'].indexOf(p.stage), // allow-italian: state value compared by value, not shown
    stageLabels: [s.proposals.stages.proposta, s.proposals.stages.modifica, s.proposals.stages.collaudo, s.proposals.stages.approvazione],
    edits: editors,
    approves: approvers,
    onOpen: () => ctx.go(p.flow ? P.flowVersions(p.flow) : P.flows()),
  }));

  const onPropose = (d: ProposalDraft) => {
    const n = team.proposals.length + 1;
    setTeam((prev) => ({
      ...prev,
      proposals: [{ id: `prop-${n}`, title: d.title, reason: d.reason, by: ctx.persona.id, on: ctx.now.slice(0, 10), flow: d.flow || undefined, stage: 'proposta' }, ...prev.proposals], // allow-italian: state value compared by value, not shown
    }));
    ctx.log(s.proposals.logAdded(d.title), 'structure', P.settings('struttura'));
    ctx.notify({ title: s.proposals.notifyTitle, body: d.title, path: P.settings('struttura'), tone: 'info', to: effectivePeople(team).filter((p) => has(p.role, 'edit:structure')).map((p) => p.id) });
    ctx.toast({ tone: 'ok', title: s.proposals.sentToast });
  };

  return settingsFrame(ctx, 'struttura', {
    children: (
      <StructurePage
        copy={ctx.copy}
        roles={ROLES.map((r) => ({ id: r.id, label: r.label }))}
        rows={matrixRows}
        onToggle={toggle}
        disabledTitle={canAdmin ? undefined : ctx.deniedTitle('admin') ?? s.onlyAdmin}
        rights={rights}
        proposals={proposals}
        you={{ role: roleLabel(me.role), rows: youRows }}
        flows={flowsOf('nocera').map((f) => ({ value: f.id, label: f.name }))}
        onPropose={onPropose}
        canPropose={ctx.can('edit:data')}
        proposeTitle={ctx.deniedTitle('edit:data')}
        phone={ctx.phone}
      />
    ),
  });
}

export const STRUCTURE_SCREEN: ScreenDef = {
  id: 'c03',
  path: '/impostazioni/struttura',
  org: 'nocera',
  nav: 'settings',
  needs: 'view:settings',
  samples: [P.settings('struttura')],
  title: (_p, ctx) => ctx.copy.app.settingsSections.struttura,
  render: structureScreen,
};

