import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { DayChartModel } from './model';

/*
 * Colours validated with the dataviz palette checker: light #2563eb/#60a5fa,
 * dark #4f93f2/#1f56c4 (lightness band, chroma, CVD and normal-vision
 * separation pass). The weekend shade is below 3:1 against the surface, so the
 * values also live in a visually hidden table and in each column's tooltip.
 */
const WEEKDAY_FILL = 'bg-[#2563eb] dark:bg-[#4f93f2]';
const WEEKEND_FILL = 'bg-[#60a5fa] dark:bg-[#1f56c4]';

function LegendSwatch({ weekend, children }: { weekend?: boolean; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('h-2.5 w-2.5 rounded-[3px]', weekend ? WEEKEND_FILL : WEEKDAY_FILL)} aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * Records per day over a month, weekdays and weekends in two shades of the
 * same hue. Plain CSS columns instead of a measured SVG, so the chart fills any
 * width without reading the DOM: each column is a full-height hit target with
 * its value in the tooltip, the bar sits on the baseline with a 4px rounded top.
 */
export function DayBars({ chart, copy }: { chart: DayChartModel; copy: UiCopy }) {
  const o = copy.overview;
  const ticks = [chart.max, Math.round(chart.max / 2), 0];
  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 text-body-lg font-semibold text-app-text">{chart.title}</span>
        <span className="flex shrink-0 items-center gap-3 text-compact text-app-text-secondary">
          {chart.legend !== false && (
            <>
              <LegendSwatch>{o.weekday}</LegendSwatch>
              <LegendSwatch weekend>{o.weekend}</LegendSwatch>
            </>
          )}
          {chart.note && <span className="text-app-text-tertiary">{chart.note}</span>}
        </span>
      </figcaption>
      <div className="flex gap-2" aria-hidden="true">
        <div className="flex h-[112px] w-7 shrink-0 flex-col justify-between text-right text-mini tabular-nums leading-none text-app-text-tertiary">
          {ticks.map((t) => <span key={t} className="-translate-y-px">{t}</span>)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-[112px]">
            {ticks.map((t, i) => (
              <div key={t} className={clsx('absolute inset-x-0 border-t', i === ticks.length - 1 ? 'border-app-border' : 'border-dashed border-app-border-light')} style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} />
            ))}
            <div className="absolute inset-0 flex items-end gap-[3px]">
              {chart.days.map((d) => (
                <div key={d.id} data-tip={`${d.label}: ${d.value}`} className="flex h-full min-w-0 flex-1 items-end hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                  <div className={clsx('w-full rounded-t-[4px]', d.weekend ? WEEKEND_FILL : WEEKDAY_FILL)} style={{ height: `${(d.value / chart.max) * 100}%` }} />
                </div>
              ))}
            </div>
          </div>
          <div className="relative mt-1.5 h-3 text-mini leading-none text-app-text-tertiary">
            {chart.axis.map((a) => {
              const center = ((a.index + 0.5) / chart.days.length) * 100;
              const edge = a.index === chart.days.length - 1 ? 'right-0' : '';
              return (
                <span key={a.index} className={clsx('absolute whitespace-nowrap', edge || '-translate-x-1/2')} style={edge ? undefined : { left: `${center}%` }}>
                  {a.label}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>{chart.title}</caption>
        <thead><tr><th scope="col">{o.day}</th><th scope="col">{chart.unit ?? chart.title}</th></tr></thead>
        <tbody>
          {chart.days.map((d) => <tr key={d.id}><th scope="row">{d.label}</th><td>{d.value}</td></tr>)}
        </tbody>
      </table>
    </figure>
  );
}
