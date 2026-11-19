import { Download, Fingerprint, Lock, ScrollText, ShieldCheck } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Table } from '../primitives/Table';
import { FilterBar } from '../filters/FilterBar';
import type { FilterBarModel } from '../filters/model';
import { Avatar } from '../shell/SidebarRows';
import type { LogActorModel, LogRowModel } from '../team/model';

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

/**
 * The log of SARIM that cannot be edited: what anybody or anything did, who,
 * about what, with the fingerprint that chains each line to the one before.
 * The lines are narrowed with the one filter bar of every list (who, which
 * person or agent, what kind of action, which day), not with tabs; the
 * caller owns the filters and the lines.
 */
export function SarimLogPage({ rows, filters, chain, copy, onVerify, onExport, exportTitle, phone }: {
  rows: LogRowModel[];
  filters: FilterBarModel;
  chain: { checked: boolean; text: string; last: string };
  copy: UiCopy;
  onVerify: Action;
  onExport: Action;
  /** Why the export is off, when it is. */
  exportTitle?: string;
  phone?: boolean;
}) {
  const l = copy.team.log;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip icon={Lock}>{l.sealed}</Chip>
        <Chip icon={ShieldCheck} tone={chain.checked ? 'green' : 'neutral'}>{chain.text}</Chip>
        <span className="text-mini text-app-text-tertiary" data-tip={l.chain.tip}>{l.chain.last} <span className="font-mono">{chain.last}</span></span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button icon={Fingerprint} onClick={onVerify} title={l.chain.tip}>{l.verify}</Button>
          <Button icon={Download} onClick={onExport} title={exportTitle}>{l.export}</Button>
        </span>
      </div>
      <FilterBar copy={copy} {...filters} placeholder={copy.filters.on.log} phone={phone} />
      <Table
        ariaLabel={copy.sarimAdmin.settings.sections.registro}
        dense
        columns={[
          { id: 'when', label: l.columns.when, width: 120 },
          { id: 'who', label: l.columns.who, width: 150 },
          { id: 'what', label: l.columns.what, width: 190 },
          { id: 'subject', label: l.columns.subject, width: 170 },
          { id: 'detail', label: l.columns.detail },
          { id: 'hash', label: l.columns.hash, width: 80 },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          onOpen: r.onOpen,
          cells: {
            when: <span className="font-mono text-compact text-app-text-secondary" data-tip={r.when}>{r.when}</span>,
            who: <Actor actor={r.actor} copy={copy} />,
            what: <span data-tip={r.what}>{r.what}</span>,
            subject: <span className="text-app-text-secondary" data-tip={r.subject || undefined}>{r.subject || copy.sarimAdmin.common.blank}</span>,
            detail: <span className="text-app-text-secondary" data-tip={r.detail || undefined}>{r.detail || copy.sarimAdmin.common.blank}</span>,
            hash: <span className="font-mono text-mini text-app-text-faint" data-tip={r.hash}>{r.hash.slice(0, 8)}</span>,
          },
        }))}
        empty={(
          <EmptyState icon={ScrollText} title={l.emptyTitle} className="min-h-0 py-4" action={<Button onClick={filters.onClear}>{l.clear}</Button>} />
        )}
      />
      <p className="text-mini text-app-text-tertiary">{l.footnote}</p>
    </div>
  );
}
