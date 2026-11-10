import { CheckCircle2, ChevronRight, CircleAlert, FlaskConical, Plug, Repeat2, SquareTerminal } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { FieldChip } from '../primitives/Chip';
import { PanelHeading, PanelSection } from '../primitives/Panel';
import { FOCUS_RING } from '../shell/pressable';
import type { ConnectionFamily, JobViewModel, ProgramDetailModel } from './model';
import { FAMILY_OF } from './model';
import { CONNECTION_ICON } from './icons';
import { JobProgress } from './Shared';

/**
 * One program in the side panel of the list: what it is, how Topics reaches
 * it and the controls to test that, what it reads, which flows use it and
 * what access it was given. The reader's actions are props: without them
 * the panel is a picture.
 */
export function ProgramDetail({ detail, copy, job, onTest, testTitle, testLabel, onOpenAgent, openAgentLabel, onMigration }: {
  detail: ProgramDetailModel;
  copy: UiCopy;
  job?: JobViewModel;
  onTest?: Action;
  /** Why the test is off for this person, when it is. */
  testTitle?: string;
  testLabel: string;
  onOpenAgent?: Action;
  openAgentLabel?: string;
  onMigration?: Action;
}) {
  const c = copy.programs;
  const d = c.list.detail;
  const family: ConnectionFamily = FAMILY_OF[detail.connectionKind];
  const Icon = CONNECTION_ICON[detail.connectionKind];
  const busy = job?.status === 'running';
  return (
    <>
      <PanelHeading tag={detail.connectionLabel} tagIcon={Icon} title={detail.name}>{detail.description}</PanelHeading>
      <PanelSection label={d.tag[family]}>
        <div className="flex flex-wrap items-center gap-2">
          {!busy && <Button variant="primary" icon={FlaskConical} onClick={onTest} title={testTitle}>{testLabel}</Button>}
          {onOpenAgent !== undefined && openAgentLabel && <Button icon={SquareTerminal} onClick={onOpenAgent}>{openAgentLabel}</Button>}
        </div>
        {/* A test in progress shows its steps; once over, its result line (with the advice when it failed) takes over. */}
        {busy && job && <JobProgress job={job} copy={copy} className="mt-3" />}
        {!busy && detail.lastCheck && (
          <p className={clsx('mt-3 flex items-start gap-1.5 text-prose leading-5', detail.lastCheck.tone === 'red' ? 'text-rose-600 dark:text-rose-400' : 'text-app-text-secondary')}>
            {detail.lastCheck.tone === 'red'
              ? <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />}
            <span>
              {detail.lastCheck.text}
              {detail.lastCheck.lines.length > 0 && <span className="block text-mini text-app-text-tertiary">{detail.lastCheck.lines.join(' · ')}</span>}
            </span>
          </p>
        )}
      </PanelSection>
      <PanelSection label={d.reads}>
        {detail.reads.length === 0 && <p className="text-prose text-app-text-tertiary">{d.noReads}</p>}
        <div className="space-y-1">
          {detail.reads.map((r) => (
            <div key={r.field.name} className="flex min-h-7 items-center gap-2 text-prose leading-5">
              <FieldChip field={r.field} />
              <span className="ml-auto min-w-0 text-right text-app-text">{r.value}</span>
            </div>
          ))}
        </div>
      </PanelSection>
      <PanelSection label={d.usedBy}>
        {detail.usedBy.length === 0 && <p className="text-prose text-app-text-tertiary">{c.list.noFlows}</p>}
        <div className="-mx-1.5">
          {detail.usedBy.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={u.onOpen || undefined}
              className={clsx('group flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-prose leading-5 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING)}
            >
              <span className="min-w-0 text-app-text [overflow-wrap:break-word]">{u.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums text-app-text-secondary">
                {u.value}
                <ChevronRight size={12} className="text-app-text-faint group-hover:text-app-text-secondary" aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      </PanelSection>
      <PanelSection label={d.access}>
        {detail.access.map((a) => (
          <div key={a.label} className="flex min-h-7 items-center gap-2 py-0.5 text-prose leading-5">
            <span className="text-app-text">{a.label}</span>
            <span className="ml-auto min-w-0 text-right tabular-nums text-app-text">{a.value}</span>
          </div>
        ))}
      </PanelSection>
      {onMigration !== undefined && (
        <div className="px-4 py-3.5">
          <Button icon={Repeat2} onClick={onMigration}>{d.migration}</Button>
        </div>
      )}
    </>
  );
}

/** The panel when no program is chosen yet: how the programs connect, as numbers that filter the list. */
export function ProgramsSummary({ copy, rows, onPick }: {
  copy: UiCopy;
  rows: Array<{ family: ConnectionFamily; count: number; active: boolean }>;
  onPick?: (family: ConnectionFamily) => void;
}) {
  const c = copy.programs;
  return (
    <>
      <PanelHeading tag={c.list.title} tagIcon={Plug} title={c.list.detail.selectHint}>{c.list.detail.selectBody}</PanelHeading>
      <PanelSection label={c.list.columns.connection}>
        {rows.map((r) => (
          <button
            key={r.family}
            type="button"
            aria-pressed={r.active}
            onClick={onPick ? () => onPick(r.family) : undefined}
            className={clsx('flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-prose hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING)}
          >
            <span className="text-app-text">{c.common.family[r.family]}</span>
            <span className="ml-auto tabular-nums text-app-text-secondary">{r.count}</span>
          </button>
        ))}
      </PanelSection>
    </>
  );
}
