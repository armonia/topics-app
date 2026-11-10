import type { CrumbModel, RichTextModel } from '../types';

export type StatIcon = 'folder' | 'gauge' | 'clock' | 'alert';

/** One headline number of the overview, with what it counts and how it was computed. */
export interface StatTileModel {
  id: string;
  value: string;
  label: string;
  detail?: string;
  icon: StatIcon;
  /** Amber when the number asks someone to act. */
  attention?: boolean;
}

/** One flow's month, as a row of the overview table. */
export interface FlowStatModel {
  id: string;
  name: string;
  perMonth: string;
  avgTime: string;
  /** Share decided by a person, 0..100. */
  toPerson: number;
  /** Missing when every record goes to a person anyway. */
  corrected?: string;
  errors: string;
  /** Where its records wait for a person right now, if any. */
  stuck?: string;
}

export interface DayValueModel {
  id: string;
  /** Full label for the tooltip and the table view ("lun 5 ott"). */
  label: string;
  value: number;
  weekend: boolean;
}

export interface DayChartModel {
  title: string;
  /** Draw the weekday and weekend legend (a chart by months has none). Default: true. */
  legend?: boolean;
  /** What the bars are, in the table view's header and each tooltip. Default: the title. */
  unit?: string;
  /** Marks the series as an example, after the legend. */
  note?: string;
  days: DayValueModel[];
  /** Upper bound of the value axis; ticks at 0, half, max. */
  max: number;
  /** Labels under some days, by index. */
  axis: Array<{ index: number; label: string }>;
}

export interface OverviewModel {
  crumbs: CrumbModel[];
  tiles: StatTileModel[];
  flows: FlowStatModel[];
  insight: RichTextModel;
  chart: DayChartModel;
}

export type OverviewPeriod = 'week' | 'month' | 'year';

/** The blocks of the overview a person can show, hide and reorder. */
export type OverviewBlockId = 'tiles' | 'flows' | 'insight' | 'chart';

export const OVERVIEW_BLOCKS: OverviewBlockId[] = ['tiles', 'flows', 'insight', 'chart'];
