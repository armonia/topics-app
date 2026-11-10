import { Bot, CalendarClock, CircleCheck, FileText, Link2, Scale, Sparkles, User, Workflow, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { PanelSection } from '../primitives/Panel';
import { Table } from '../primitives/Table';
import { Timeline, type TimelineItemModel } from '../primitives/Timeline';
import { FOCUS_RING } from '../shell/pressable';
import { PaneHeader } from '../shell/PaneHeader';
import { PhaseTrack } from '../record/PhaseTrack';
import type { SheetDeadlineModel, SheetHistoryModel, SheetModel } from './model';

const HISTORY_ICON: Record<SheetHistoryModel['kind'], LucideIcon> = {
  flow: Workflow,
  ai: Sparkles,
  person: User,
  program: Bot,
  receipt: CircleCheck,
};
const HISTORY_TONE = { flow: 'neutral', ai: 'pink', person: 'amber', program: 'green', receipt: 'green' } as const;

const DISTANCE_TONE: Record<SheetDeadlineModel['tone'], string> = {
  urgent: 'text-rose-600 dark:text-rose-400',
  soon: 'text-amber-700 dark:text-amber-400',
  later: 'text-app-text',
};

/**
 * One record with everything together (w05): where it stands, the facts that
 * matter, every value with the words it was read from, every deadline with its
 * calculation and rule, the whole history, the originals and the linked
 * records; on the side who has it now, where each thing lives and the action
 * that moves the record on. `assignee` is the slot for the control that hands
 * the record to someone else. Under 768px the side panel stacks below.
 */
export function RecordSheet({
  sheet, copy, onAsk, onOpenProgram, onPrimary, primaryVariant = 'confirm', primaryTitle, assignee,
  onOpenStep, onOpenFact, onOpenField, onOpenDeadline, onOpenHistory, onOpenDocument, onOpenRelated, onOpenSystem, onBackToRecord, notice, phone,
}: {
  sheet: SheetModel;
  copy: UiCopy;
  onAsk?: Action;
  onOpenProgram?: Action;
  onPrimary?: Action;
  primaryVariant?: 'confirm' | 'primary' | 'secondary';
  primaryTitle?: string;
  assignee?: ReactNode;
  onOpenStep?: (stepId: string) => void;
  onOpenFact?: (id: string) => void;
  onOpenField?: (id: string) => void;
  onOpenDeadline?: (id: string) => void;
  onOpenHistory?: (id: string) => void;
  onOpenDocument?: (id: string) => void;
  onOpenRelated?: (id: string) => void;
  onOpenSystem?: (id: string) => void;
  onBackToRecord?: () => void;
  notice?: ReactNode;
  /** On a phone the steps are dots that fit the width. */
  phone?: boolean;
}) {
  const s = copy.work.sheet;
  const timeline: TimelineItemModel[] = sheet.history.map((h) => ({
    id: h.id,
    at: h.at,
    title: h.what,
    who: h.who,
    tone: h.pending ? 'neutral' : HISTORY_TONE[h.kind],
    icon: h.pending ? undefined : HISTORY_ICON[h.kind],
    onOpen: h.linked && onOpenHistory ? () => onOpenHistory(h.id) : undefined,
  }));
  const headerButtons = (
    <>
      {notice}
      {onBackToRecord && <Button onClick={onBackToRecord}>{s.openWorkspace}</Button>}
      <Button icon={Sparkles} onClick={onAsk}>{s.ask}</Button>
      <Button onClick={onOpenProgram}>{s.openIn(sheet.programName)}</Button>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={sheet.crumbs}>
        <div className="hidden items-center gap-2 md:flex">{headerButtons}</div>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="min-w-0 flex-1 px-4 pb-8 pt-5 md:overflow-y-auto md:px-8">
          <div className="mb-4 flex flex-wrap items-center gap-2 md:hidden">{headerButtons}</div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Chip tone="violet" icon={Scale} strong>{sheet.kindLabel}</Chip>
            <h1 className="min-w-0 text-headline font-semibold leading-7 tracking-[-0.01em] text-app-text">{sheet.title}</h1>
            <Chip>{sheet.exampleTag}</Chip>
          </div>
          <div className="-mx-4 mb-4 md:-mx-8">
            <PhaseTrack label={sheet.phasesLabel} phases={sheet.phases} copy={copy} onOpenStep={onOpenStep} phone={phone} bare />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {sheet.facts.map((f) => (
              <Card key={f.id} onOpen={f.linked && onOpenFact ? () => onOpenFact(f.id) : undefined}>
                <div className="text-compact text-app-text-tertiary">{f.label}</div>
                <div className={clsx('mt-1 truncate text-body-lg font-semibold leading-6', f.tone === 'urgent' ? 'text-[22px] leading-7 text-rose-600 dark:text-rose-400' : 'text-app-text')}>{f.value}</div>
                {f.detail && <div className="mt-0.5 text-compact leading-4 text-app-text-secondary">{f.detail}</div>}
              </Card>
            ))}
          </div>

          <h2 className="mb-2 mt-6 text-body-lg font-semibold text-app-text">{s.fields}</h2>
          <div className="hidden md:block">
            <Table
              ariaLabel={s.fields}
              columns={[
                { id: 'label', label: s.colField, width: 190 },
                { id: 'value', label: s.colValue },
                { id: 'source', label: s.colSource, width: 220 },
                { id: 'confidence', label: s.colConfidence, width: 100, align: 'right' },
              ]}
              rows={sheet.fields.map((f) => ({
                id: f.id,
                onOpen: onOpenField ? () => onOpenField(f.id) : undefined,
                cells: {
                  label: <span className="text-app-text-secondary">{f.label}</span>,
                  value: <span className="font-medium text-app-text">{f.value}</span>,
                  source: <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-300"><FileText size={12} aria-hidden="true" />{f.source}</span>,
                  confidence: f.corrected
                    ? <span className="text-amber-700 dark:text-amber-400">{s.corrected}</span>
                    : <span className="tabular-nums text-app-text-secondary">{f.confidence}</span>,
                },
              }))}
              empty={<p className="px-3 py-4 text-prose text-app-text-secondary">{s.noFields}</p>}
            />
          </div>
          <ul className="divide-y divide-app-border rounded-lg border border-app-border md:hidden" aria-label={s.fields}>
            {sheet.fields.length === 0 && <li className="px-3 py-4 text-prose text-app-text-secondary">{s.noFields}</li>}
            {sheet.fields.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => onOpenField?.(f.id)} className={clsx('block w-full px-3 py-2.5 text-left hover:bg-app-hover', FOCUS_RING)}>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-compact text-app-text-secondary">{f.label}</span>
                    {f.corrected
                      ? <span className="text-compact text-amber-700 dark:text-amber-400">{s.corrected}</span>
                      : <span className="text-compact tabular-nums text-app-text-secondary">{f.confidence}</span>}
                  </span>
                  <span className="mt-0.5 block text-prose font-medium text-app-text">{f.value}</span>
                  <span className="mt-0.5 inline-flex items-center gap-1 text-compact text-sky-700 dark:text-sky-300"><FileText size={12} aria-hidden="true" />{f.source}</span>
                </button>
              </li>
            ))}
          </ul>

          <h2 className="mb-2 mt-6 text-body-lg font-semibold text-app-text">{s.deadlines}</h2>
          {sheet.deadlines.length === 0 ? (
            <p className="rounded-lg border border-app-border px-4 py-3 text-prose text-app-text-secondary">{s.noDeadlines}</p>
          ) : (
            <ul className="space-y-2">
              {sheet.deadlines.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onOpenDeadline?.(d.id)}
                    className={clsx('block w-full rounded-lg border border-app-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-app-hover', FOCUS_RING)}
                  >
                    <span className="flex items-baseline gap-3">
                      <CalendarClock size={14} className="mt-0.5 shrink-0 self-center text-app-text-secondary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-prose font-semibold text-app-text">{d.label}</span>
                      <span className="shrink-0 text-prose font-semibold tabular-nums text-app-text">{d.date}</span>
                      <span className={clsx('shrink-0 text-prose font-semibold tabular-nums', DISTANCE_TONE[d.tone])}>{d.distance}</span>
                    </span>
                    <span className="mt-1 block pl-[26px] text-compact leading-5 text-app-text-secondary">{d.calc}{d.rollsOver ? ` · ${d.rollsOver}` : ''}</span>
                    <span className="block pl-[26px] text-compact leading-5 text-app-text-tertiary">{d.rule}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card title={s.history} icon={Workflow}>
              <Timeline items={timeline} ariaLabel={s.history} />
            </Card>
            <div className="min-w-0 space-y-4">
              <Card title={s.documents} icon={FileText}>
                {sheet.documents.length === 0 ? <p>{s.noDocuments}</p> : (
                  <ul>
                    {sheet.documents.map((d) => (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => onOpenDocument?.(d.id)}
                          className={clsx('-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}
                        >
                          <FileText size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-prose text-app-text">{d.name}</span>
                            <span className="block truncate text-mini text-app-text-tertiary">{d.detail}</span>
                          </span>
                          {d.badge && <Chip tone={d.badge.tone}>{d.badge.text}</Chip>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title={s.related} icon={Link2}>
                {sheet.related.length === 0 ? <p>{s.noRelated}</p> : (
                  <ul>
                    {sheet.related.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => onOpenRelated?.(r.id)}
                          className={clsx('-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}
                        >
                          <span className="min-w-0 flex-1 truncate text-prose text-app-text">{r.title}</span>
                          <span className="shrink-0 text-mini text-app-text-tertiary">{r.detail}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </div>

        <aside className="flex shrink-0 flex-col border-t border-app-border bg-surface md:w-[340px] md:border-l md:border-t-0">
          <div className="min-h-0 flex-1 md:overflow-y-auto">
            <div className="border-b border-app-border px-4 pb-4 pt-4">
              <span className="mb-2 inline-flex h-5 items-center rounded bg-black/[0.05] px-1.5 text-mini text-app-text-secondary dark:bg-white/10">{sheet.whoLabel}</span>
              <h3 className="text-body-lg font-semibold leading-5 text-app-text">{sheet.who.headline}</h3>
              <p className="mt-1 text-prose leading-5 text-app-text-secondary">{sheet.who.detail}</p>
            </div>
            <PanelSection>
              <ul>
                {sheet.who.rows.map((r) => (
                  <li key={r.id} className="flex min-h-7 items-center gap-2 py-0.5 text-prose">
                    <span className="shrink-0 text-app-text">{r.label}</span>
                    <span className="ml-auto min-w-0 truncate text-right text-app-text">{r.id === 'assignee' && assignee ? assignee : r.value}</span>
                  </li>
                ))}
              </ul>
            </PanelSection>
            <PanelSection label={s.whereIsEach}>
              <ul>
                {sheet.systems.map((x) => (
                  <li key={x.id}>
                    <button
                      type="button"
                      onClick={() => onOpenSystem?.(x.id)}
                      className={clsx('-mx-2 flex min-h-7 w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-0.5 text-left text-prose hover:bg-app-hover', FOCUS_RING)}
                    >
                      <span className="min-w-0 truncate text-app-text">{x.what}</span>
                      <span className="ml-auto text-right font-medium text-app-text">{x.where}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </PanelSection>
          </div>
          <div className="shrink-0 border-t border-app-border px-4 py-3">
            <Button variant={primaryVariant} size="lg" onClick={onPrimary} title={primaryTitle}>{sheet.primaryLabel}</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
