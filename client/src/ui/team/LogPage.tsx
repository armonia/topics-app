import { Download, Fingerprint, Lock, ScrollText, Search, ShieldCheck } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Select, TextField } from '../primitives/Field';
import { Table } from '../primitives/Table';
import { Tabs } from '../primitives/Tabs';
import { Avatar } from '../shell/SidebarRows';
import type { LogActorModel, LogFilter, LogModel } from './model';

function Actor({ actor, copy }: { actor: LogActorModel; copy: UiCopy }) {
  const a = copy.team.log.actor;
  if (actor.kind === 'person') {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar text={actor.monogram ?? ''} color={actor.color ?? '#64748b'} size={18} />
        <span className="min-w-0">{actor.label}</span>
      </span>
    );
  }
  const tone = actor.kind === 'ai' ? 'violet' : actor.kind === 'robot' ? 'pink' : 'neutral';
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Chip tone={tone}>{a[actor.kind]}</Chip>
      <span className="min-w-0">{actor.label}</span>
    </span>
  );
}

/** The log that cannot be edited: what anybody or anything did, who, where, with the fingerprint that chains each line to the one before. */
export function LogPage({ model, copy, onFilter, onQuery, onPerson, onDay, onClear, onVerify, onExport, exportTitle }: {
  model: LogModel;
  copy: UiCopy;
  onFilter: (f: LogFilter) => void;
  onQuery: (q: string) => void;
  onPerson: (p: string) => void;
  onDay: (d: string) => void;
  onClear: () => void;
  onVerify: Action;
  onExport: Action;
  /** Why the export is off, when it is. */
  exportTitle?: string;
}) {
  const l = copy.team.log;
  const filtered = model.filter !== 'all' || model.query !== '' || model.person !== '' || model.day !== '';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip icon={Lock}>{l.sealed}</Chip>
        <Chip icon={ShieldCheck} tone={model.chain.checked ? 'green' : 'neutral'}>{model.chain.text}</Chip>
        <span className="text-mini text-app-text-tertiary" data-tip={l.chain.tip}>{l.chain.last} <span className="font-mono">{model.chain.last}</span></span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button icon={Fingerprint} onClick={onVerify} title={l.chain.tip}>{l.verify}</Button>
          <Button icon={Download} onClick={onExport} title={exportTitle}>{l.export}</Button>
        </span>
      </div>
      <Tabs<LogFilter>
        ariaLabel={l.filterLabel}
        value={model.filter}
        onChange={onFilter}
        options={([
          ['all', l.filters.all], ['people', l.filters.people], ['ai', l.filters.ai], ['robot', l.filters.robot], ['structure', l.filters.structure], ['access', l.filters.access],
        ] as Array<[LogFilter, string]>).map(([value, label]) => ({ value, label, count: value === 'all' ? model.counts.all : undefined }))}
      />
      <div className="flex flex-wrap items-end gap-3">
        <TextField className="min-w-[220px] flex-1" type="search" icon={Search} value={model.query} onChange={onQuery} placeholder={l.search} />
        <Select className="w-[200px]" value={model.person} onChange={onPerson} title={l.person} options={model.people} />
        <Select className="w-[170px]" value={model.day} onChange={onDay} title={l.day} options={model.days} />
      </div>
      <Table
        ariaLabel={copy.app.settingsSections.registro}
        dense
        columns={[
          { id: 'when', label: l.columns.when, width: 120 },
          { id: 'who', label: l.columns.who, width: 150 },
          { id: 'what', label: l.columns.what, width: 190 },
          { id: 'subject', label: l.columns.subject, width: 170 },
          { id: 'detail', label: l.columns.detail },
          { id: 'hash', label: l.columns.hash, width: 80 },
        ]}
        rows={model.rows.map((r) => ({
          id: r.id,
          onOpen: r.onOpen,
          cells: {
            when: <span className="font-mono text-compact text-app-text-secondary" data-tip={r.when}>{r.when}</span>,
            who: <Actor actor={r.actor} copy={copy} />,
            what: <span data-tip={r.what}>{r.what}</span>,
            subject: <span className="text-app-text-secondary" data-tip={r.subject || undefined}>{r.subject || copy.team.common.blank}</span>,
            detail: <span className="text-app-text-secondary" data-tip={r.detail}>{r.detail}</span>,
            hash: <span className="font-mono text-mini text-app-text-faint" data-tip={r.hash}>{r.hash.slice(0, 8)}</span>,
          },
        }))}
        empty={
          <EmptyState icon={ScrollText} title={l.emptyTitle} className="min-h-0 py-4" action={filtered ? <Button onClick={onClear}>{l.clear}</Button> : undefined}>
            {l.emptyBody}
          </EmptyState>
        }
      />
      <p className="text-mini text-app-text-tertiary">
        {l.count(model.rows.length, model.total)} · {l.footnote}
      </p>
    </div>
  );
}
