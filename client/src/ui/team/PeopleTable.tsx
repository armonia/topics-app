import { useState } from 'react';
import { Mail, Pencil, Plus, RotateCw, Search, UserX } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { Dialog } from '../primitives/Dialog';
import { EmptyState } from '../primitives/EmptyState';
import { Checkbox, Select, TextField } from '../primitives/Field';
import { Table } from '../primitives/Table';
import { Avatar } from '../shell/SidebarRows';
import type { InviteRowModel, OptionModel, PersonRowModel } from './model';
import { TitleButton } from './parts';

export interface PersonEdit {
  role: string;
  offices: string[];
  orgs: string[];
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** The window that changes one person's role, offices and organizations. */
function PersonEditDialog({ person, roles, offices, orgs, copy, onSave, onClose }: {
  person: PersonRowModel;
  roles: OptionModel[];
  offices: OptionModel[];
  orgs: OptionModel[];
  copy: UiCopy;
  onSave: (edit: PersonEdit) => void;
  onClose: () => void;
}) {
  const s = copy.team.squad;
  const [role, setRole] = useState(person.roleId);
  const [off, setOff] = useState(person.officeIds);
  const [org, setOrg] = useState(person.orgIds);
  return (
    <Dialog
      title={s.editTitle(person.name)}
      onClose={onClose}
      closeLabel={copy.team.common.close}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{copy.team.common.cancel}</Button>
          <Button variant="primary" onClick={() => onSave({ role, offices: off, orgs: org })}>{copy.team.common.save}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Select label={s.roleField} value={role} options={roles} onChange={setRole} />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-compact font-medium text-app-text-secondary">{s.officesField}</legend>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {offices.map((o) => (
              <Checkbox key={o.value} label={o.label} checked={off.includes(o.value)} onChange={() => setOff((v) => toggle(v, o.value))} />
            ))}
          </div>
          <p className="text-mini text-app-text-tertiary">{s.officesHint}</p>
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-compact font-medium text-app-text-secondary">{s.orgsField}</legend>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {orgs.map((o) => (
              <Checkbox key={o.value} label={o.label} checked={org.includes(o.value)} onChange={() => setOrg((v) => toggle(v, o.value))} />
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

/**
 * The people of the organization with their role, offices and organizations.
 * A row's name and its «Modifica» button open the same window. `canEdit` (allow-italian: quotes the Italian interface)
 * false draws the buttons off (the reason is the caller's `deniedTitle`).
 */
export function PeopleTable({ people, roles, offices, orgs, copy, onSave, canEdit, deniedTitle, onClear, filtered }: {
  people: PersonRowModel[];
  roles: OptionModel[];
  offices: OptionModel[];
  orgs: OptionModel[];
  copy: UiCopy;
  onSave: (personId: string, edit: PersonEdit) => void;
  canEdit: boolean;
  deniedTitle?: string;
  /** Clears the filters; shown on the empty state when `filtered`. */
  onClear: () => void;
  filtered: boolean;
}) {
  const s = copy.team.squad;
  const [editing, setEditing] = useState<string | null>(null);
  const person = people.find((p) => p.id === editing);
  return (
    <>
      <Table
        ariaLabel={s.tabs.people}
        columns={[
          { id: 'person', label: s.columns.person, width: 290 },
          { id: 'role', label: s.columns.role, width: 140 },
          { id: 'offices', label: s.columns.offices },
          { id: 'orgs', label: s.columns.orgs },
          { id: 'actions', label: s.columns.actions, width: 124 },
        ]}
        rows={people.map((p) => ({
          id: p.id,
          cells: {
            person: (
              <span className="flex min-w-0 items-center gap-2">
                <Avatar text={p.monogram} color={p.color} size={22} />
                <TitleButton onClick={canEdit ? () => setEditing(p.id) : undefined} title={deniedTitle}>{p.name}</TitleButton>
                {p.you && <Chip tone="blue">{s.you}</Chip>}
              </span>
            ),
            role: <Chip>{p.roleLabel}</Chip>,
            offices: <span className="text-app-text-secondary">{p.offices.length ? p.offices.join(', ') : s.allOffices}</span>,
            orgs: <span className="text-app-text-secondary">{p.orgs.join(', ')}</span>,
            actions: <Button size="sm" icon={Pencil} onClick={canEdit ? () => setEditing(p.id) : false} title={deniedTitle}>{s.edit}</Button>,
          },
        }))}
        empty={
          <EmptyState icon={UserX} title={s.emptyTitle} className="min-h-0 py-4" action={filtered ? <Button onClick={onClear}>{s.clear}</Button> : undefined}>
            {s.emptyBody}
          </EmptyState>
        }
      />
      {person && (
        <PersonEditDialog
          person={person}
          roles={roles}
          offices={offices}
          orgs={orgs}
          copy={copy}
          onClose={() => setEditing(null)}
          onSave={(edit) => {
            onSave(person.id, edit);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** The search and the role filter above the people. */
export function PeopleFilters({ query, onQuery, role, onRole, roles, copy }: {
  query: string;
  onQuery: (q: string) => void;
  role: string;
  onRole: (r: string) => void;
  roles: OptionModel[];
  copy: UiCopy;
}) {
  const s = copy.team.squad;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <TextField className="min-w-[220px] flex-1" type="search" icon={Search} value={query} onChange={onQuery} placeholder={s.search} />
      <Select className="w-[200px]" label={undefined} value={role} onChange={onRole} title={s.roleFilter} options={[{ value: '', label: s.allRoles }, ...roles]} />
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** «Invita una persona»: a button and the window it opens. `allowed` false draws it off. (allow-italian: quotes the Italian interface) */
export function InviteButton({ label, copy, roles, orgs, existing, allowed, deniedTitle, onInvite, variant = 'primary' }: {
  label: string;
  copy: UiCopy;
  roles: OptionModel[];
  orgs: OptionModel[];
  /** Addresses that already have an invitation. */
  existing: string[];
  allowed: boolean;
  deniedTitle?: string;
  onInvite: (invite: { email: string; role: string; orgs: string[] }) => void;
  variant?: 'primary' | 'secondary';
}) {
  const i = copy.team.squad.invites;
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles[0]?.value ?? '');
  const [org, setOrg] = useState<string[]>(orgs.slice(0, 1).map((o) => o.value));
  const [tried, setTried] = useState(false);
  const trimmed = email.trim().toLowerCase();
  const error = !EMAIL.test(trimmed) ? i.emailInvalid : existing.includes(trimmed) ? i.emailTaken : undefined;
  const close = () => {
    setOpen(false);
    setTried(false);
    setEmail('');
  };
  const submit = () => {
    setTried(true);
    if (error) return;
    onInvite({ email: trimmed, role, orgs: org.length ? org : orgs.slice(0, 1).map((o) => o.value) });
    close();
  };
  return (
    <>
      <Button variant={variant} icon={Plus} onClick={allowed ? () => setOpen(true) : false} title={deniedTitle}>{label}</Button>
      {open && (
        <Dialog
          title={i.dialogTitle}
          onClose={close}
          closeLabel={copy.team.common.close}
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={close}>{copy.team.common.cancel}</Button>
              <Button variant="primary" icon={Mail} onClick={submit}>{i.send}</Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4">
            <TextField label={i.emailField} type="email" value={email} onChange={setEmail} placeholder={i.emailPlaceholder} error={tried ? error : undefined} autoFocus onEnter={submit} />
            <Select label={i.roleField} value={role} options={roles} onChange={setRole} />
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-compact font-medium text-app-text-secondary">{i.orgsField}</legend>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {orgs.map((o) => (
                  <Checkbox key={o.value} label={o.label} checked={org.includes(o.value)} onChange={() => setOrg((v) => toggle(v, o.value))} />
                ))}
              </div>
            </fieldset>
            <p className="text-mini text-app-text-tertiary">{i.accessNote}</p>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** The invitations waiting for an answer: send again, or cancel. */
export function InvitesTable({ rows, copy, onInviteNew }: { rows: InviteRowModel[]; copy: UiCopy; onInviteNew?: Action }) {
  const i = copy.team.squad.invites;
  return (
    <Table
      ariaLabel={i.title}
      columns={[
        { id: 'email', label: i.columns.email },
        { id: 'role', label: i.columns.role, width: 130 },
        { id: 'orgs', label: i.columns.orgs, width: 150 },
        { id: 'sent', label: i.columns.sent, width: 110 },
        { id: 'actions', label: i.columns.actions, width: 230 },
      ]}
      rows={rows.map((r) => ({
        id: r.id,
        cells: {
          email: <span className="font-medium">{r.email}</span>,
          role: <Chip>{r.role}</Chip>,
          orgs: <span className="text-app-text-secondary">{r.orgs.join(', ')}</span>,
          sent: <span className="text-app-text-secondary">{r.sent}</span>,
          actions: r.sending ? (
            <Chip tone="blue" icon={RotateCw}>{i.sending}</Chip>
          ) : (
            <span className="flex gap-1.5">
              <Button size="sm" icon={RotateCw} onClick={r.onResend}>{i.resend}</Button>
              <Button size="sm" variant="danger" onClick={r.onCancel}>{i.cancel}</Button>
            </span>
          ),
        },
      }))}
      empty={
        <EmptyState icon={Mail} title={i.empty} className="min-h-0 py-4" action={onInviteNew ? <Button variant="primary" icon={Plus} onClick={onInviteNew}>{copy.team.squad.invite}</Button> : undefined}>
          {i.emptyBody}
        </EmptyState>
      }
    />
  );
}
