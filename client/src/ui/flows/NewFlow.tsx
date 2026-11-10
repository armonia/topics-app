import { ArrowRight, Check, MessageSquare, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { Action, Tone } from '../types';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { Select } from '../primitives/Field';
import { pressable } from '../shell/pressable';
import { PaneHeader } from '../shell/PaneHeader';
import type { ActorKind } from './model';
import { ActorChip } from './FlowStep';

export interface FirstStepModel {
  id: string;
  title: string;
  detail: string;
  state: 'done' | 'current' | 'todo';
  /** The number shown while it is not done. */
  number: number;
  /** The button of the current step, e.g. «Invita le altre 12». (allow-italian: quotes the Italian interface) */
  action?: { label: string; onClick: Action; title?: string };
  /** Something under the detail, e.g. the progress of the invitations. */
  extra?: ReactNode;
  /** What pressing the card does (open the place the step is about). */
  onOpen: () => void;
}

export interface TemplateCardModel {
  id: string;
  title: string;
  description: string;
  /** Who works in it, as the chips on the card: start, AI, rule, person, robot. */
  actors: Array<{ kind: ActorKind; name?: string; tone?: Tone }>;
  blocks: string;
  /** The state of the flow it already is: `in prova`, `attivo`; none for a template not used yet. (allow-italian: quotes the Italian interface) */
  state?: string;
}

/**
 * Starting a flow (n02): on the left the first steps of an organization with
 * what is done and what is next, on the right the question «which flow do we
 * add?», a line to describe a work in words, and the templates of the sector
 * (a template the organization already runs opens that flow). Everything
 * pressable is the caller's.
 */
export function NewFlowScreen({
  copy, crumbs, steps, describe, onDescribe, onDescribeChange, sector, sectors, onSector, templates, onPick, phone,
}: {
  copy: UiCopy;
  crumbs: Array<{ label: string; detail?: string }>;
  steps: FirstStepModel[];
  describe: string;
  onDescribe: Action;
  onDescribeChange: (v: string) => void;
  sector: string;
  sectors: Array<{ value: string; label: string }>;
  onSector: (v: string) => void;
  templates: TemplateCardModel[];
  onPick: (id: string) => void;
  phone?: boolean;
}) {
  const t = copy.flowBuild.start;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={crumbs} />
      <div className={clsx('min-h-0 flex-1', phone ? 'overflow-y-auto' : 'flex')}>
        <aside className={clsx('shrink-0 p-5', phone ? 'border-b border-app-border' : 'w-[380px] overflow-y-auto border-r border-app-border')}>
          <h2 className="text-title font-semibold text-app-text">{t.firstSteps}</h2>
          <p className="mt-2 text-prose leading-6 text-app-text-secondary">{t.firstStepsBody}</p>
          <ol className="mt-4 space-y-3">
            {steps.map((s) => (
              <li
                key={s.id}
                {...pressable(s.onOpen)}
                role="button"
                aria-current={s.state === 'current' ? 'step' : undefined}
                className={clsx(
                  'flex cursor-pointer items-start gap-3 rounded-lg border bg-surface px-3.5 py-3 transition-colors hover:bg-app-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  s.state === 'current' ? 'border-primary shadow-[0_0_0_3px_rgba(0,102,255,0.12)]' : 'border-app-border',
                )}
              >
                <span
                  className={clsx(
                    'mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-mini font-medium tabular-nums',
                    s.state === 'done' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-black/[0.06] text-app-text-secondary dark:bg-white/10',
                  )}
                >
                  {s.state === 'done' ? <Check size={13} aria-hidden="true" /> : s.number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-prose font-semibold text-app-text">{s.title}</span>
                  <span className="block text-prose leading-5 text-app-text-secondary">{s.detail}</span>
                  {s.extra && <span className="mt-2 block">{s.extra}</span>}
                  {s.action && (
                    <span className="mt-2 block" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <Button variant="primary" onClick={s.action.onClick} title={s.action.title}>{s.action.label}</Button>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </aside>
        <div className={clsx('min-w-0 flex-1 p-5', !phone && 'overflow-y-auto')}>
          <h2 className="text-title font-semibold text-app-text">{t.question}</h2>
          <form
            className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-black/[0.04] px-4 py-3 dark:bg-white/[0.06]"
            onSubmit={(e) => {
              e.preventDefault();
              if (onDescribe) onDescribe();
            }}
          >
            <MessageSquare size={15} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
            <input
              value={describe}
              onChange={(e) => onDescribeChange(e.target.value)}
              placeholder={t.describePlaceholder}
              aria-label={t.describePlaceholder}
              className="h-8 min-w-[200px] flex-1 bg-transparent text-prose text-app-text outline-none placeholder:text-app-placeholder"
            />
            <Button variant="primary" icon={Plus} onClick={onDescribe}>{t.createDraft}</Button>
          </form>

          <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
            <h3 className="text-body-lg font-semibold text-app-text">{t.sectorTemplates}</h3>
            <Select value={sector} onChange={onSector} options={sectors} title={t.sectorLabel} className="w-[210px]" />
            <span className="text-compact text-app-text-tertiary">{t.sectorHint}</span>
          </div>
          {templates.length === 0 ? (
            <p className="mt-4 text-prose text-app-text-tertiary">{t.noTemplates}</p>
          ) : (
            <div className={clsx('mt-4 grid gap-3', phone ? 'grid-cols-1' : 'grid-cols-2 xl:grid-cols-3')}>
              {templates.map((c) => (
                <div
                  key={c.id}
                  {...pressable(() => onPick(c.id))}
                  role="button"
                  className="flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border border-app-border bg-surface px-4 py-3.5 transition-colors hover:border-primary/50 hover:bg-black/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.05]"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {c.actors.map((a, i) => <ActorChip key={i} actor={a} copy={copy} />)}
                  </div>
                  <h4 className="text-prose font-semibold text-app-text">{c.title}</h4>
                  <p className="flex-1 text-prose leading-5 text-app-text-secondary">{c.description}</p>
                  <div className="flex items-center gap-2 text-compact text-app-text-tertiary">
                    {c.state && <Chip tone="green">{c.state}</Chip>}
                    <span>{c.blocks}</span>
                    <ArrowRight size={13} className="ml-auto" aria-hidden="true" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
