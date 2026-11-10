import { ArrowRight, Plug, RotateCw, Unplug } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { KeyValue } from '../primitives/Panel';
import { Table } from '../primitives/Table';
import { Avatar } from '../shell/SidebarRows';
import type { ConnectionDetailModel, ConnectionRowModel, DataLinkModel, PersonRowModel } from './model';
import { JobCard, SectionHead, StateChip } from './parts';

/** One connection in detail: how it works, who made it, what depends on it, and what to do about it. */
function ConnectionDetail({ detail, copy }: { detail: ConnectionDetailModel; copy: UiCopy }) {
  const d = copy.team.connections.detail;
  return (
    <Card title={detail.name} icon={Plug} actions={<StateChip tone={detail.state.tone} icon={detail.state.icon}>{detail.state.text}</StateChip>}>
      <div className="flex flex-col gap-3 px-3.5 pb-4 pt-3">
        <p className="text-prose leading-5 text-app-text-secondary">{detail.what}</p>
        {detail.problem && (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-prose text-rose-800 dark:text-rose-300"><span className="font-medium">{d.problem}:</span> {detail.problem}</p>
        )}
        <div className="grid gap-x-6 md:grid-cols-2">
          <KeyValue label={d.how} value={detail.how} />
          <KeyValue label={d.by} value={detail.by} />
          <KeyValue label={d.last} value={detail.last} />
          <KeyValue label={d.rights} value={detail.rights} />
        </div>
        <div>
          <p className="mb-1 text-compact font-medium text-app-text-secondary">{d.usedBy}</p>
          {detail.usedBy.length === 0 ? (
            <p className="text-prose text-app-text-tertiary">{d.usedByNone}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {detail.usedBy.map((f) => (
                <button key={f.id} type="button" onClick={f.onOpen} className="inline-flex h-6 items-center gap-1 rounded-lg bg-black/[0.05] px-2 text-mini text-app-text hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:bg-white/[0.08] dark:hover:bg-white/[0.12]">
                  {f.name}
                  <ArrowRight size={11} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
        {detail.job && <JobCard job={detail.job} />}
        <div className="flex flex-wrap gap-2 border-t border-app-border pt-3">
          <Button variant={detail.primary.variant} icon={RotateCw} onClick={detail.primary.onClick}>{detail.primary.label}</Button>
          {detail.disconnect && <Button variant="danger" icon={Unplug} onClick={detail.disconnect.onClick}>{detail.disconnect.label}</Button>}
          <Button variant="ghost" onClick={detail.onOpenPrograms}>{d.openPrograms}</Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * People, roles and connections of the organization (n16): who works here,
 * which programs Topics is connected to and how each one is doing, with the
 * detail of the one picked and its controls. The invitation button is the
 * caller's, in the header.
 */
export function ConnectionsPage({ copy, intro, people, onOpenPeople, onManage, connections, summary, detail, dataLinks }: {
  copy: UiCopy;
  intro: string;
  people: PersonRowModel[];
  onOpenPeople: () => void;
  onManage: () => void;
  connections: ConnectionRowModel[];
  summary: string;
  detail?: ConnectionDetailModel;
  dataLinks: DataLinkModel[];
}) {
  const c = copy.team.connections;
  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionHead title={c.peopleTitle} aside={intro} actions={<Button size="sm" onClick={onManage}>{c.manage}</Button>} />
        <Table
          ariaLabel={c.peopleTitle}
          columns={[
            { id: 'person', label: c.peopleColumns.person, width: 300 },
            { id: 'office', label: c.peopleColumns.office, width: 150 },
            { id: 'role', label: c.peopleColumns.role, width: 150 },
            { id: 'sees', label: c.peopleColumns.sees },
          ]}
          rows={people.map((p) => ({
            id: p.id,
            onOpen: onOpenPeople,
            cells: {
              person: (
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar text={p.monogram} color={p.color} size={22} />
                  <span className="min-w-0 font-medium">{p.name}</span>
                </span>
              ),
              office: <span className="text-app-text-secondary">{p.offices.length ? p.offices.join(', ') : c.allOffices}</span>,
              role: <Chip>{p.roleLabel}</Chip>,
              sees: <span className="text-app-text-secondary">{p.sees}</span>,
            },
          }))}
        />
      </section>

      <section>
        <SectionHead title={c.title} aside={summary} />
        <Table
          ariaLabel={c.title}
          columns={[
            { id: 'program', label: c.columns.program },
            { id: 'how', label: c.columns.how },
            { id: 'state', label: c.columns.state, width: 120 },
            { id: 'by', label: c.columns.by, width: 150 },
            { id: 'last', label: c.columns.last, width: 110 },
          ]}
          rows={connections.map((r) => ({
            id: r.id,
            selected: r.selected,
            onOpen: r.selected ? undefined : r.onSelect,
            cells: {
              program: <span className="font-medium">{r.name}</span>,
              how: (
                <span className="flex min-w-0 flex-col items-start gap-1">
                  <Chip>{r.method}</Chip>
                  <span className="min-w-0 text-app-text-secondary">{r.how}</span>
                </span>
              ),
              state: <StateChip tone={r.state.tone} icon={r.state.icon}>{r.state.text}</StateChip>,
              by: <span className="text-app-text-secondary">{r.by}</span>,
              last: <span className="text-app-text-secondary">{r.last}</span>,
            },
          }))}
        />
      </section>

      {detail ? (
        <ConnectionDetail detail={detail} copy={copy} />
      ) : (
        <EmptyState icon={Plug} title={c.detail.emptyTitle} className="min-h-0 rounded-lg border border-dashed border-app-border py-6">{c.detail.emptyBody}</EmptyState>
      )}

      <Card title={c.dataTitle}>
        <ul className="px-3.5 pb-2 pt-1">
          {dataLinks.map((l) => (
            <li key={l.id} className="flex items-center gap-3 border-b border-app-border py-2 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-prose text-app-text">{l.label}</span>
              <Button size="sm" onClick={l.onOpen}>{c.dataOpen}</Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
