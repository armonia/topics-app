import { History, Lock, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiCopy } from '../copy/types';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { KeyValue } from '../primitives/Panel';
import { Tabs } from '../primitives/Tabs';
import { Timeline, type TimelineItemModel } from '../primitives/Timeline';
import type { InviteRowModel, MatrixRoleModel, MatrixRowModel, OptionModel, PersonRowModel } from './model';
import { PermissionMatrix } from './PermissionMatrix';
import { InvitesTable, PeopleFilters, PeopleTable, type PersonEdit } from './PeopleTable';
import { SectionHead } from './parts';
import type { Action } from '../types';

export type SquadTab = 'people' | 'data' | 'invites';

/**
 * Team and permissions on data (t01): the people with their role and offices,
 * the role matrix of what each sees and does (every switch is real), and the
 * invitations still waiting. The «Invita» control is the caller's, in the
 * header of the page.
 */
export function SquadPage({
  copy, tab, onTab, people, roles, offices, orgs, onSave, canEdit, deniedTitle, query, onQuery, roleFilter, onRoleFilter, onClear,
  matrixRoles, matrixRows, onToggle, matrixDisabledTitle, recent, invites, onInviteNew, intro,
}: {
  copy: UiCopy;
  tab: SquadTab;
  onTab: (t: SquadTab) => void;
  people: PersonRowModel[];
  roles: OptionModel[];
  offices: OptionModel[];
  orgs: OptionModel[];
  onSave: (personId: string, edit: PersonEdit) => void;
  canEdit: boolean;
  deniedTitle?: string;
  query: string;
  onQuery: (q: string) => void;
  roleFilter: string;
  onRoleFilter: (r: string) => void;
  onClear: () => void;
  matrixRoles: MatrixRoleModel[];
  matrixRows: MatrixRowModel[];
  onToggle: (roleId: string, rowId: string, next: boolean) => void;
  matrixDisabledTitle?: string;
  recent: TimelineItemModel[];
  invites: InviteRowModel[];
  onInviteNew?: Action;
  intro?: ReactNode;
}) {
  const s = copy.team.squad;
  return (
    <div className="flex flex-col gap-4">
      {intro ?? <p className="text-prose leading-6 text-app-text-secondary">{s.intro}</p>}
      <Tabs<SquadTab>
        ariaLabel={s.tabsLabel}
        value={tab}
        onChange={onTab}
        options={[
          { value: 'people', label: s.tabs.people, count: people.length },
          { value: 'data', label: s.tabs.data },
          { value: 'invites', label: s.tabs.invites, count: invites.length },
        ]}
      />
      {tab === 'people' && (
        <div className="flex flex-col gap-3">
          <PeopleFilters query={query} onQuery={onQuery} role={roleFilter} onRole={onRoleFilter} roles={roles} copy={copy} />
          <PeopleTable
            people={people}
            roles={roles}
            offices={offices}
            orgs={orgs}
            copy={copy}
            onSave={onSave}
            canEdit={canEdit}
            deniedTitle={deniedTitle}
            onClear={onClear}
            filtered={query !== '' || roleFilter !== ''}
          />
        </div>
      )}
      {tab === 'data' && (
        <div className="flex flex-col gap-5">
          <section>
            <SectionHead title={s.dataTitle} aside={s.dataBody} />
            <PermissionMatrix
              ariaLabel={s.dataLabel}
              permissionColumn={copy.team.structure.permissionColumn}
              roles={matrixRoles}
              rows={matrixRows}
              onToggle={onToggle}
              toggleTitle={(role, row) => `${role}: ${row}`}
              disabledTitle={matrixDisabledTitle}
              changedTitle={copy.team.structure.toggles.changed}
            />
          </section>
          <div className="grid items-start gap-3 md:grid-cols-2">
            <Card title={s.everywhereTitle} icon={Lock}>
              <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-2">
                <Chip>{s.everywhereTag}</Chip>
                <p className="text-prose leading-5 text-app-text-secondary">{s.everywhereBody}</p>
                <div className="mt-1 border-t border-app-border pt-2">
                  <KeyValue lead={<ShieldCheck size={14} className="text-app-text-tertiary" aria-hidden="true" />} label={s.control.beyond} value={s.control.beyondValue} />
                  <KeyValue label={s.control.review} value={s.control.reviewValue} />
                </div>
              </div>
            </Card>
            <Card title={s.recentTitle} icon={History}>
              <div className="px-3.5 pb-3 pt-3">
                {recent.length === 0 ? <p className="text-prose text-app-text-tertiary">{s.recentEmpty}</p> : <Timeline items={recent} ariaLabel={s.recentTitle} />}
              </div>
            </Card>
          </div>
        </div>
      )}
      {tab === 'invites' && <InvitesTable rows={invites} copy={copy} onInviteNew={onInviteNew} />}
    </div>
  );
}
