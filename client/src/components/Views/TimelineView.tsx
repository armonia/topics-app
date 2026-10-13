/**
 * The `timeline` view (GENUI-07): a plan in order, grouped by day.
 *
 * One column on every width: time on the left in tabular figures, a rail with
 * the means of each leg, and the leg itself (what, how long, how much, and the
 * alternatives for the same leg). A deadline is drawn as a limit: a flag and
 * the time in the danger tone, not one more thing to do.
 */
import { useMemo } from 'react';
import {
  BedDouble, Bus, Car, CircleDot, Flag, Footprints, Hourglass, Plane, Ship, TrainFront, TramFront, type LucideIcon,
} from 'lucide-react';
import { useT } from '../../hooks/useT';
import { groupStepsByDay, type StepMode, type TimelineStep, type TimelineViewSpec } from '../../../../shared/views-timeline';
import type { ViewPrice } from '../../../../shared/views-util';
import { formatPriceNote } from '../../../../shared/views-format';
import { ViewHeader, ViewLink, type ViewVariant } from './ViewChrome';

const MODE_ICON: Record<StepMode, LucideIcon> = {
  walk: Footprints, bus: Bus, train: TrainFront, metro: TramFront, plane: Plane, taxi: Car,
  car: Car, boat: Ship, wait: Hourglass, stay: BedDouble, other: CircleDot,
};

function facts(duration: string | undefined, price: ViewPrice | undefined, locale: string): string[] {
  const out: string[] = [];
  if (duration) out.push(duration);
  if (price) out.push(formatPriceNote(price, locale));
  return out;
}

export function TimelineView({ spec, variant, locale }: { spec: TimelineViewSpec; variant: ViewVariant; locale: string }) {
  const groups = useMemo(() => groupStepsByDay(spec.steps), [spec.steps]);
  return (
    <section data-testid="timeline-view" data-variant={variant} data-steps={spec.steps.length} className="min-w-0">
      <ViewHeader kind="timeline" title={spec.title} subtitle={spec.subtitle} verdict={spec.verdict} variant={variant} />
      <div className="space-y-4">
        {groups.map((g, gi) => (
          <div key={gi} data-testid="timeline-day">
            {g.day && <h3 className="mb-1.5 text-compact font-semibold uppercase tracking-wide text-app-text-secondary">{g.day}</h3>}
            <ol className="relative">
              {g.steps.map((s, i) => (
                <Step key={i} step={s} last={i === g.steps.length - 1} variant={variant} locale={locale} />
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function Step({ step, last, variant, locale }: { step: TimelineStep; last: boolean; variant: ViewVariant; locale: string }) {
  const tr = useT();
  const Icon = step.deadline ? Flag : MODE_ICON[step.mode ?? 'other'];
  const meta = facts(step.duration, step.price, locale);
  return (
    <li data-testid="timeline-step" data-deadline={step.deadline ? 'true' : 'false'} className="grid grid-cols-[3.25rem_1.75rem_minmax(0,1fr)] gap-x-2">
      <span
        data-testid="timeline-time"
        className={`pt-0.5 text-right text-compact font-semibold tabular-nums ${step.deadline ? 'text-red-700 dark:text-red-400' : 'text-app-text-heading'}`}
      >
        {step.time ?? ''}
      </span>
      {/* The rail: the icon, and a line down to the next step of the same day. */}
      <span className="relative flex justify-center" aria-hidden>
        <span className={`z-10 flex size-7 items-center justify-center rounded-full border ${step.deadline ? 'border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-400' : 'border-app-border bg-surface text-app-text-secondary'}`}>
          <Icon size={14} />
        </span>
        {!last && <span className="absolute bottom-0 top-7 w-px bg-app-border" />}
      </span>
      <div className={`min-w-0 ${last ? 'pb-1' : 'pb-4'}`}>
        <p className="text-body-lg font-semibold leading-snug text-app-text-heading">
          <span className="sr-only">{step.deadline ? tr('views.timeline.deadline') : tr(`views.mode.${step.mode ?? 'other'}`)}: </span>
          {step.title}
        </p>
        {meta.length > 0 && (
          <p data-testid="timeline-facts" className="text-compact tabular-nums text-app-text-secondary">{meta.join(' · ')}</p>
        )}
        {step.detail && <p className="mt-0.5 text-compact leading-snug text-app-text">{step.detail}</p>}
        {step.alternatives && step.alternatives.length > 0 && (
          <ul data-testid="timeline-alternatives" className="mt-1.5 space-y-1">
            {step.alternatives.map((a, k) => {
              const AltIcon = MODE_ICON[a.mode ?? 'other'];
              const altMeta = [...facts(a.duration, a.price, locale), ...(a.detail ? [a.detail] : [])];
              return (
                <li key={k} className="flex items-baseline gap-1.5 rounded border border-dashed border-app-border px-2 py-1 text-compact text-app-text">
                  <AltIcon size={13} className="shrink-0 translate-y-0.5 text-app-text-secondary" aria-hidden />
                  <span className="min-w-0">
                    <span className="font-medium text-app-text-secondary">{tr('views.timeline.or')} </span>
                    <span className="font-semibold text-app-text-heading">{a.title}</span>
                    {altMeta.length > 0 && <span className="tabular-nums text-app-text-secondary"> · {altMeta.join(' · ')}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {step.link && (
          <ViewLink
            url={step.link.url}
            variant={variant}
            testId="timeline-link"
            className="-ml-1.5 mt-0.5 inline-flex min-h-9 items-center gap-1 rounded px-1.5 text-compact font-medium text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:min-h-11"
          >
            {step.link.label ?? tr('views.openLink')}
          </ViewLink>
        )}
      </div>
    </li>
  );
}
