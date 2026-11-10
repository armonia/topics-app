/**
 * The numbers of the direction overview (n18), computed from the same lists
 * the rest of the preview uses: the flows of `org/flows.ts` give each row its
 * monthly volume, the cases give the ones waiting for a person (so confirming
 * in «Da fare» changes the tile and the column), and the day bars always sum (allow-italian: quotes the Italian interface)
 * to the month total. The week is a slice of the day bars; the year is twelve
 * months with October equal to the month.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { OverviewModel, OverviewPeriod, DayValueModel } from '../../../../ui/overview/model';
import { FLOW_STATS, OCTOBER_SHORT, MONTH_SHAPE, OVERVIEW_INSIGHT, OVERVIEW_TILE_WORDS, OVERVIEW_WORDS, WEEKDAY_SHORT, WEEK_START_INDEX, YEAR_MONTHS } from '../../../../ui/fixtures/overview';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { orgCases } from '../../store/cases';
import type { DemoState } from '../../store/state';
import { fmt } from './orbit-model';


/** Spreads `total` over `weights` in whole numbers that add up to exactly `total`. */
export function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

const AXIS_STEPS = [50, 100, 120, 160, 200, 300, 400, 500, 600, 800, 1000, 1200, 1600, 2000, 2400, 3000, 4000, 5000];
const niceMax = (v: number) => AXIS_STEPS.find((s) => s >= v * 1.02) ?? Math.ceil(v / 1000) * 1000;

export interface OverviewRow {
  id: string;
  flow: FlowSeed;
  volume: number;
  errors: number;
  stuck: Array<{ office: string; count: number }>;
}

export interface OverviewData {
  model: OverviewModel;
  volumeLabel: string;
  rows: OverviewRow[];
  total: number;
  stuckTotal: number;
  /** The CSV of what is on show. */
  csv: (headers: string[]) => string[][];
}

/** The records of one flow waiting for a person, by office, the busiest first. */
export function stuckOffices(waiting: Array<{ flow: string; office: string }>, flow: string): Array<{ office: string; count: number }> {
  const per: Record<string, number> = {};
  for (const c of waiting) if (c.flow === flow) per[c.office] = (per[c.office] ?? 0) + 1;
  return Object.entries(per).sort((a, b) => b[1] - a[1]).map(([office, count]) => ({ office: OFFICE_LABEL[office as keyof typeof OFFICE_LABEL] ?? office, count }));
}

/** What the «Ferme da persone» column says of one flow: «Legale · 1», or «4 in 4 uffici». n01 and n18 both use it. */
export function stuckLabelOf(offices: Array<{ office: string; count: number }>, copy: UiCopy): string | undefined {
  if (offices.length === 0) return undefined;
  if (offices.length === 1) return `${offices[0].office} · ${offices[0].count}`;
  return copy.orgs.overview.stuckSeveral(offices.reduce((a, x) => a + x.count, 0), offices.length);
}

/** The flows that run and have stats: the rows of the table, in the order of `FLOWS`. */
export function overviewFlows(): FlowSeed[] {
  return FLOWS.filter((f) => f.org === 'nocera' && f.status !== 'bozza' && f.status !== 'spento' && f.perMonth > 0 && FLOW_STATS[f.id]); // allow-italian: status code of the data, not shown
}

export function buildOverview(state: DemoState, period: OverviewPeriod, copy: UiCopy): OverviewData {
  const flows = overviewFlows();
  const weights = flows.map((f) => f.perMonth);
  const monthTotal = weights.reduce((a, b) => a + b, 0);
  const monthDays = distribute(monthTotal, MONTH_SHAPE);

  // Volume of each row and the bars, by period.
  let volumes: number[];
  let chartDays: DayValueModel[];
  const dayOf = (i: number): DayValueModel => {
    const weekday = new Date(2026, 9, i + 1).getDay();
    return { id: `d${i + 1}`, label: `${WEEKDAY_SHORT[weekday]} ${i + 1} ${OCTOBER_SHORT}`, value: monthDays[i], weekend: weekday === 0 || weekday === 6 };
  };
  let axis: Array<{ index: number; label: string }>;
  let legend = true;
  if (period === 'month') {
    volumes = weights;
    chartDays = monthDays.map((_, i) => dayOf(i));
    axis = [{ index: 0, label: `1 ${OCTOBER_SHORT}` }, { index: 7, label: '8' }, { index: 14, label: '15' }, { index: 21, label: '22' }, { index: 30, label: `31 ${OCTOBER_SHORT}` }];
  } else if (period === 'week') {
    chartDays = monthDays.slice(WEEK_START_INDEX).map((_, k) => dayOf(WEEK_START_INDEX + k));
    volumes = distribute(chartDays.reduce((a, d) => a + d.value, 0), weights);
    axis = chartDays.map((d, k) => ({ index: k, label: d.label.replace(` ${OCTOBER_SHORT}`, '') }));
  } else {
    const monthTotals = YEAR_MONTHS.map((m) => Math.round(monthTotal * m.factor));
    chartDays = YEAR_MONTHS.map((m, k) => ({ id: m.id, label: m.label, value: monthTotals[k], weekend: false }));
    volumes = distribute(monthTotals.reduce((a, b) => a + b, 0), weights);
    axis = YEAR_MONTHS.map((m, k) => ({ index: k, label: m.label }));
    legend = false;
  }
  const total = volumes.reduce((a, b) => a + b, 0);
  const ratio = monthTotal === 0 ? 0 : total / monthTotal;

  // Who waits for a person right now: the cases to confirm, by flow and office.
  const waiting = orgCases(state, 'nocera').filter((c) => c.status === 'da-confermare');
  const stuckTotal = waiting.length;
  const byOffice: Record<string, number> = {};
  for (const c of waiting) byOffice[c.office] = (byOffice[c.office] ?? 0) + 1;

  const rows: OverviewRow[] = flows.map((f, i) => {
    return {
      id: f.id,
      flow: f,
      volume: volumes[i],
      errors: Math.round(FLOW_STATS[f.id].errors * ratio),
      stuck: stuckOffices(waiting, f.id),
    };
  });

  const personShare = total === 0 ? 0 : Math.round(rows.reduce((a, r) => a + r.volume * FLOW_STATS[r.id].toPerson, 0) / total);
  const hours = Math.round(rows.reduce((a, r) => a + r.volume * FLOW_STATS[r.id].manualMinutes, 0) / 60);
  const w = OVERVIEW_WORDS[period];
  const t = OVERVIEW_TILE_WORDS;
  const stuckDetail = Object.entries(byOffice).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${OFFICE_LABEL[o as keyof typeof OFFICE_LABEL] ?? o} ${n}`).join(', ');

  const maxValue = Math.max(...chartDays.map((d) => d.value), 1);
  const model: OverviewModel = {
    crumbs: [{ label: t.rootLabel, detail: w.detail }],
    tiles: [
      { id: 'k-volume', value: fmt(total), label: w.volume, detail: t.volumeDetail, icon: 'folder' },
      { id: 'k-person', value: `${personShare}%`, label: t.person.label, detail: t.person.detail, icon: 'gauge' },
      { id: 'k-hours', value: fmt(hours), label: w.hours, detail: t.hoursDetail, icon: 'clock' },
      { id: 'k-stuck', value: String(stuckTotal), label: t.stuck.label, detail: stuckDetail || undefined, icon: 'alert', attention: stuckTotal > 0 },
    ],
    flows: rows.map((r) => {
      const s = FLOW_STATS[r.id];
      return {
        id: r.id,
        name: r.flow.name,
        perMonth: fmt(r.volume),
        avgTime: s.avgTime,
        toPerson: s.toPerson,
        corrected: s.corrected,
        errors: String(r.errors),
        stuck: stuckLabelOf(r.stuck, copy),
      };
    }),
    insight: OVERVIEW_INSIGHT,
    chart: {
      title: w.chart,
      note: t.chartNote,
      days: chartDays,
      max: niceMax(maxValue),
      axis,
      legend,
    },
  };

  const csv = (headers: string[]): string[][] => [
    headers,
    ...model.flows.map((f) => [f.name, f.perMonth, f.avgTime, `${f.toPerson}%`, f.corrected ?? '', f.errors, f.stuck ?? '']),
    [model.tiles[0].label, model.tiles[0].value],
  ];

  return { model, volumeLabel: w.volumeColumn, rows, total, stuckTotal, csv };
}
