/**
 * orbit-permissions: what each team of ORBIT may do, as a matrix. Rows are the
 * sections, the eight flows and four actions; columns are the eight teams; a
 * cell is one of the four levels or, for an action, a yes or
 * no. Every change is real: it is written in the slice `orbit.access`, which
 * the container reads (`canDo`, `sectionLevel`, `flowLevel`), so the sidebar,
 * the buttons and the cards of the to-do list follow at once, and it leaves a line
 * in the log. Exceptions give one person another level than their team. The
 * agents are one fixed row: no switch gives them the pen.
 */
import { useState } from 'react';
import { Bot, Eye, History, Plus, RotateCcw, Trash2, UserRoundCog } from 'lucide-react';
import { personaById, world } from '../../world';
import type { OrbitTeam } from '../../../../ui/fixtures/orbit-org/people';
import { Button, IconButton } from '../../../../ui/primitives/Button';
import { Card } from '../../../../ui/primitives/Card';
import { Chip } from '../../../../ui/primitives/Chip';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { Select, Toggle, type SelectOption } from '../../../../ui/primitives/Field';
import { ScrollFade } from '../../../../ui/primitives/ScrollFade';
import { Timeline } from '../../../../ui/primitives/Timeline';
import { Block } from '../../../../ui/settings/Block';
import { Avatar } from '../../../../ui/shell/SidebarRows';
import type { ScreenCtx } from '../../../app/kit';
import { ACCESS_INITIAL, ACCESS_LEVELS, ACCESS_SLICE, ACCESS_ACTIONS, accessSlice, type AccessLevel, type AccessSlice } from '../../../app/store/access-grants';
import { canDo } from '../../../app/store/permissions';
import {
  defaultTeamValue, flowLevel, handRows, handValue, parseRowKey, rowKey, teamOfPersona, teamValue, withHandValue,
  type AccessRow, type AccessScope, type AccessSection, type AccessValue,
} from '../../model/access';
import { flowLabel } from '../../model/flows';
import { liveCards } from '../../model/live';
import { nameOf, when } from '../../model/words';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { canOpenNav, ORBIT_NAV } from '../../sidebar';
import { TeamFrame } from './TeamFrame';

const SECTIONS: AccessSection[] = ['inbox', 'flows', 'documents', 'contracts', 'data', 'rules', 'programs'];

const ROWS: AccessRow[] = [
  ...SECTIONS.map((id): AccessRow => ({ kind: 'section', id })),
  ...world().opsFlows.map((f): AccessRow => ({ kind: 'flow', id: f.id })),
  ...ACCESS_ACTIONS.map((id): AccessRow => ({ kind: 'action', id })),
];

/* The eight teams and the row names fit in the page at 1440px (about 1100px of block): the columns share what is left, the names wrap in two lines. Narrower, the table scrolls with its right edge faded. */
const FIRST_MIN = 168;
const CELL_MIN = 100;
const TEMPLATE = `minmax(${FIRST_MIN}px, 1.6fr) repeat(${world().people.teams.length}, minmax(${CELL_MIN}px, 1fr))`;
const MATRIX_MIN = FIRST_MIN + world().people.teams.length * CELL_MIN;

/** Whether a value is the yes/no of an action rather than a level. */
const isAction = (row: AccessRow) => row.kind === 'action';

export function PermissionsPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.orbitTeam;
  const p = c.permissions;
  const state = ctx.state;
  const [, setAccess] = ctx.slice<AccessSlice>(ACCESS_SLICE, ACCESS_INITIAL);
  const slice = accessSlice(state);
  const canAdmin = ctx.can('admin');
  const denied = canAdmin ? undefined : ctx.deniedTitle('admin') ?? p.onlyAdmin;
  const myTeam = teamOfPersona(ctx.persona);
  const [pickedTeam, setPickedTeam] = ctx.ui<string>('orbit.permissions.team', myTeam);
  const [previewId, setPreviewId] = ctx.ui<string>('orbit.permissions.preview', ctx.persona.id);
  const [dialog, setDialog] = useState<{ person: string; row: string; value: string } | null>(null);

  const rowLabel = (row: AccessRow) => (row.kind === 'section' ? p.sections[row.id] : row.kind === 'flow' ? flowLabel(row.id) : p.actions[row.id].label);
  const levelLabel = (v: AccessValue) => (typeof v === 'boolean' ? (v ? p.yes : p.no) : c.levels[v].label);
  const rowName = (row: AccessRow) => p.exceptions.rowOf(row.kind, rowLabel(row));
  const write = (scope: AccessScope, row: AccessRow, value: AccessValue | undefined) => setAccess((prev) => withHandValue({ ...ACCESS_INITIAL, ...prev }, scope, row, value));

  /* ---------- the teams ---------- */

  const setTeam = (team: OrbitTeam, row: AccessRow, value: AccessValue) => {
    const initial = defaultTeamValue(state, team.id, row);
    const apply = () => {
      write({ team: team.id }, row, value === initial ? undefined : value);
      if (typeof value === 'boolean') {
        ctx.log(p.logAction(team.label, rowLabel(row), value), 'permission', SP.teamPermissions());
        ctx.toast({ tone: 'ok', title: p.toastAction(team.label, rowLabel(row), value) });
      } else {
        ctx.log(p.logLevel(team.label, rowLabel(row), c.levels[value].label), 'permission', SP.teamPermissions());
        ctx.toast({ tone: 'ok', title: p.toastLevel(team.label, rowLabel(row), c.levels[value].label) });
      }
    };
    if (row.kind === 'action' && row.id === 'admin' && value === false && team.id === myTeam) {
      ctx.confirm({ title: p.selfAdminTitle, body: p.selfAdminBody, confirmLabel: p.selfAdminConfirm, tone: 'danger', onConfirm: apply });
      return;
    }
    apply();
  };

  const changes = world().people.teams.reduce((n, t) => n + handRows(slice, { team: t.id }).length, 0) + world().people.personas.reduce((n, x) => n + handRows(slice, { person: x.id }).length, 0);
  const resetAll = () => ctx.confirm({
    title: p.resetTitle,
    body: p.resetBody(changes),
    confirmLabel: p.resetConfirm,
    tone: 'danger',
    onConfirm: () => {
      setAccess(() => ACCESS_INITIAL);
      ctx.log(p.resetLog(changes), 'permission', SP.teamPermissions());
      ctx.toast({ tone: 'ok', title: p.resetToast });
    },
  });
  const resetButton = (
    <Button icon={RotateCcw} onClick={changes && canAdmin ? resetAll : false} title={denied ?? (changes ? undefined : p.resetNone)}>{p.reset}</Button>
  );

  const levelOptions: SelectOption[] = ACCESS_LEVELS.map((l) => ({ value: l, label: c.levels[l].label, hint: c.levels[l].hint }));
  const yesNo: SelectOption[] = [{ value: 'yes', label: p.yes }, { value: 'no', label: p.no }];

  /* ---------- the matrix ---------- */

  const cell = (team: OrbitTeam, row: AccessRow) => {
    const value = teamValue(state, team.id, row);
    const changed = handValue(slice, { team: team.id }, row) !== undefined;
    const title = p.cellTitle(team.label, rowLabel(row));
    return (
      <div
        key={team.id}
        role="cell"
        data-team={team.id}
        data-row={rowKey(row)}
        data-value={String(value)}
        data-changed={changed || undefined}
        className="relative flex items-center justify-center px-1.5 py-1.5"
      >
        {typeof value === 'boolean' ? (
          <Toggle checked={value} onChange={(next) => setTeam(team, row, next)} disabled={denied !== undefined} title={denied ?? title} />
        ) : (
          <Select
            size="sm"
            className="w-full"
            value={value}
            onChange={(v) => setTeam(team, row, v as AccessLevel)}
            options={levelOptions}
            disabled={denied !== undefined}
            title={title}
          />
        )}
        {changed && <span aria-hidden="true" data-tip={p.changed} className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
      </div>
    );
  };

  const groupRow = (label: string) => (
    <div key={label} role="row" className="border-b border-app-border bg-app-inset px-3 py-1 text-compact font-medium text-app-text-tertiary">
      <span role="rowheader">{label}</span>
    </div>
  );
  const matrixRow = (row: AccessRow) => (
    <div key={rowKey(row)} role="row" data-row={rowKey(row)} style={{ gridTemplateColumns: TEMPLATE }} className="grid items-center border-b border-app-border last:border-b-0">
      <div role="rowheader" className="sticky left-0 z-[1] min-w-0 self-stretch bg-surface px-3 py-1.5">
        <span className="block font-medium text-app-text">{rowLabel(row)}</span>
        {row.kind === 'action' && <span className="block text-mini leading-4 text-app-text-tertiary">{p.actions[row.id].hint}</span>}
      </div>
      {world().people.teams.map((t) => cell(t, row))}
    </div>
  );

  const matrix = (
    <ScrollFade className="w-full min-w-0 rounded-lg border border-app-border bg-surface">
      <div role="table" aria-label={c.permissions.matrixLabel} style={{ minWidth: MATRIX_MIN }} className="text-prose">
        <div role="row" style={{ gridTemplateColumns: TEMPLATE }} className="grid items-end border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
          <span role="columnheader" className="sticky left-0 z-[1] flex items-end self-stretch bg-app-inset px-3 py-2 leading-4">{p.rowColumn}</span>
          {world().people.teams.map((t) => <span key={t.id} role="columnheader" data-team={t.id} className="px-1.5 py-2 text-center leading-4">{t.label}</span>)}
        </div>
        {groupRow(p.groups.sections)}
        {ROWS.filter((r) => r.kind === 'section').map(matrixRow)}
        {groupRow(p.groups.flows)}
        {ROWS.filter((r) => r.kind === 'flow').map(matrixRow)}
        {groupRow(p.groups.actions)}
        {ROWS.filter((r) => r.kind === 'action').map(matrixRow)}
        <div role="row" data-row="agents" className="flex items-center gap-3 border-t border-app-border px-3 py-2.5">
          <span role="rowheader" className="inline-flex shrink-0 items-center gap-1.5 font-medium text-app-text"><Bot size={14} className="text-violet-600 dark:text-violet-300" aria-hidden="true" />{p.agentsRow.label}</span>
          <span role="cell" className="min-w-0 text-prose leading-5 text-app-text-secondary">{p.agentsRow.does} {p.agentsRow.never}</span>
        </div>
      </div>
    </ScrollFade>
  );

  /* On a phone the eight columns do not fit: one team at a time, its levels one under the other. */
  const picked = world().people.teams.find((t) => t.id === pickedTeam) ?? world().people.teams[0];
  const phoneRow = (row: AccessRow) => (
    <div key={rowKey(row)} role="row" data-row={rowKey(row)} className="flex items-center gap-3 border-b border-app-border px-3 py-1.5 last:border-b-0">
      <div role="rowheader" className="min-w-0 flex-1">
        <span className="block font-medium text-app-text">{rowLabel(row)}</span>
        {row.kind === 'action' && <span className="block text-mini leading-4 text-app-text-tertiary">{p.actions[row.id].hint}</span>}
      </div>
      <div className="w-[140px] shrink-0">{cell(picked, row)}</div>
    </div>
  );
  const phoneMatrix = (
    <div className="flex flex-col gap-3">
      <Select label={p.teamPick} value={picked.id} onChange={setPickedTeam} options={world().people.teams.map((t) => ({ value: t.id, label: t.label }))} />
      <div role="table" aria-label={c.permissions.matrixLabel} className="w-full min-w-0 overflow-hidden rounded-lg border border-app-border bg-surface text-prose">
        {groupRow(p.groups.sections)}
        {ROWS.filter((r) => r.kind === 'section').map(phoneRow)}
        {groupRow(p.groups.flows)}
        {ROWS.filter((r) => r.kind === 'flow').map(phoneRow)}
        {groupRow(p.groups.actions)}
        {ROWS.filter((r) => r.kind === 'action').map(phoneRow)}
        <div role="row" data-row="agents" className="border-t border-app-border px-3 py-2.5">
          <span role="rowheader" className="mb-0.5 inline-flex items-center gap-1.5 font-medium text-app-text"><Bot size={14} className="text-violet-600 dark:text-violet-300" aria-hidden="true" />{p.agentsRow.label}</span>
          <span role="cell" className="block text-prose leading-5 text-app-text-secondary">{p.agentsRow.does} {p.agentsRow.never}</span>
        </div>
      </div>
    </div>
  );

  /* ---------- exceptions ---------- */

  const exceptionPeople = world().people.personas.filter((x) => handRows(slice, { person: x.id }).length > 0);
  const setException = (personId: string, row: AccessRow, value: AccessValue | undefined, kind: 'add' | 'change' | 'remove') => {
    const person = personaById(personId);
    if (!person) return;
    write({ person: personId }, row, value);
    const ex = p.exceptions;
    if (kind === 'remove') {
      ctx.log(ex.logRemove(person.name, rowName(row)), 'permission', SP.teamPermissions());
      ctx.toast({ tone: 'ok', title: ex.toastRemove(person.short) });
    } else if (value !== undefined) {
      ctx.log((kind === 'add' ? ex.logAdd : ex.logChange)(person.name, rowName(row), levelLabel(value)), 'permission', SP.teamPermissions());
      if (kind === 'add') ctx.toast({ tone: 'ok', title: ex.toastAdd(person.short) });
    }
  };
  const valueOptions = (row: AccessRow) => (isAction(row) ? yesNo : levelOptions);
  const toValue = (row: AccessRow, v: string): AccessValue => (isAction(row) ? v === 'yes' : (v as AccessLevel));
  const fromValue = (v: AccessValue) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : v);

  const dialogRow = dialog ? parseRowKey(dialog.row) : undefined;
  const duplicate = dialog && dialogRow ? handValue(slice, { person: dialog.person }, dialogRow) !== undefined : false;
  const openDialog = () => setDialog({ person: world().people.personas[0].id, row: rowKey(ROWS[0]), value: 'view' });
  const pickRow = (key: string) => {
    const row = parseRowKey(key);
    if (!dialog || !row) return;
    setDialog({ ...dialog, row: key, value: isAction(row) ? 'yes' : dialogRow && isAction(dialogRow) ? 'view' : dialog.value });
  };
  const confirmDialog = () => {
    if (!dialog || !dialogRow || duplicate) return;
    setException(dialog.person, dialogRow, toValue(dialogRow, dialog.value), 'add');
    setDialog(null);
  };

  /* ---------- the preview: what a chosen person sees now ---------- */

  const previewed = personaById(previewId) ?? world().people.personas[0];
  const can = (perm: Parameters<typeof canDo>[2]) => canDo(state, previewed, perm);
  const sees = ORBIT_NAV.filter(([kind]) => canOpenNav(kind, can));
  const allCards = liveCards(state);
  const visible = allCards.filter((card) => flowLevel(state, previewed, card.flow) !== 'none').length;
  const may = ACCESS_ACTIONS.filter((a) => can(a));
  const recent = state.audit.filter((a) => a.kind === 'permission').slice(0, 6);

  return (
    <TeamFrame ctx={ctx} place="permissions" wide crumbs={orgCrumbs(ctx, [{ label: c.title, to: SP.team() }, { label: p.crumb }])}>
      <Block title={p.matrixTitle} actions={resetButton}>
        {ctx.phone ? phoneMatrix : matrix}
      </Block>

      <Block
        title={p.exceptions.title}
        actions={<Button icon={Plus} onClick={canAdmin ? openDialog : false} title={denied}>{p.exceptions.add}</Button>}
      >
        {exceptionPeople.length === 0 ? (
          <p className="text-prose text-app-text-tertiary">{p.exceptions.empty}</p>
        ) : (
          <div data-exceptions="true" className="flex flex-col">
            {exceptionPeople.flatMap((person) => handRows(slice, { person: person.id }).map(({ row, value }) => (
              <div key={`${person.id}-${rowKey(row)}`} data-person={person.id} data-row={rowKey(row)} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-app-border py-2 first:border-t-0 first:pt-0 last:pb-0">
                <span className="flex min-w-[220px] flex-1 items-center gap-2">
                  <Avatar text={person.monogram} color={person.color} size={22} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-app-text">{person.name}</span>
                    <span className="block text-mini leading-4 text-app-text-tertiary">{rowName(row)}</span>
                  </span>
                </span>
                <Select
                  size="sm"
                  className="w-[150px]"
                  value={fromValue(value)}
                  onChange={(v) => setException(person.id, row, toValue(row, v), 'change')}
                  options={valueOptions(row)}
                  disabled={denied !== undefined}
                  title={p.exceptions.rowLabel(person.short, rowLabel(row))}
                />
                <IconButton icon={Trash2} label={p.exceptions.remove(person.short, rowLabel(row))} onClick={canAdmin ? () => setException(person.id, row, undefined, 'remove') : false} />
              </div>
            )))}
          </div>
        )}
      </Block>

      <div className="grid items-start gap-3 md:grid-cols-2">
        <Card title={p.previewTitle} icon={Eye}>
          <div className="flex flex-col gap-3">
            <Select label={p.previewPerson} value={previewed.id} onChange={setPreviewId} options={world().people.personas.map((x) => ({ value: x.id, label: x.name }))} />
            <div data-preview="sees">
              <div className="mb-1 text-mini font-medium text-app-text-secondary">{p.previewSees}</div>
              <div className="flex flex-wrap gap-1">
                {sees.length ? sees.map(([kind]) => <Chip key={kind} tone="green">{ctx.copy.shell.nav[kind]}</Chip>) : <span className="text-prose text-app-text-tertiary">{p.previewNothing}</span>}
              </div>
              <p className="mt-1.5 text-mini text-app-text-secondary">{p.previewCards(visible, allCards.length)}</p>
            </div>
            <div data-preview="can">
              <div className="mb-1 text-mini font-medium text-app-text-secondary">{p.previewCan}</div>
              <div className="flex flex-wrap gap-1">
                {may.length ? may.map((a) => <Chip key={a} tone="blue">{p.actions[a].label}</Chip>) : <span className="text-prose text-app-text-tertiary">{p.previewNothing}</span>}
              </div>
            </div>
          </div>
        </Card>
        <Card title={p.recentTitle} icon={History}>
          {recent.length === 0 ? <p className="text-prose text-app-text-tertiary">{p.recentEmpty}</p> : (
            <Timeline ariaLabel={p.recentTitle} items={recent.map((a) => ({ id: a.id, at: when(ctx, a.at), title: a.what, who: nameOf(a.who), tone: 'neutral' as const }))} />
          )}
        </Card>
      </div>

      {dialog && (
        <Dialog
          title={p.exceptions.dialogTitle}
          closeLabel={ctx.copy.common.close}
          size="sm"
          onClose={() => setDialog(null)}
          footer={<><Button onClick={() => setDialog(null)}>{p.exceptions.cancel}</Button><Button variant="primary" icon={UserRoundCog} onClick={duplicate ? false : confirmDialog}>{p.exceptions.confirm}</Button></>}
        >
          <div className="flex flex-col gap-3">
            <Select label={p.exceptions.person} value={dialog.person} onChange={(v) => setDialog({ ...dialog, person: v })} options={world().people.personas.map((x) => ({ value: x.id, label: x.name }))} />
            <Select label={p.exceptions.row} value={dialog.row} onChange={pickRow} options={ROWS.map((r) => ({ value: rowKey(r), label: rowName(r) }))} />
            <Select label={p.exceptions.level} value={dialog.value} onChange={(v) => setDialog({ ...dialog, value: v })} options={dialogRow ? valueOptions(dialogRow) : levelOptions} />
            {duplicate && <p className="text-mini text-rose-600 dark:text-rose-400">{p.exceptions.duplicate}</p>}
          </div>
        </Dialog>
      )}
    </TeamFrame>
  );
}
