/**
 * Styles shared by the feature map's parts (FeaturesPane, FeaturesPyramid):
 * kept apart so each component file exports components only.
 */
import type { PlanKind } from '../../lib/hubFeatures';

/** The plan's colours, shared with the chip on a feature's row. */
export const PLAN_CHIP: Record<PlanKind, string> = {
  sviluppo: 'bg-primary/[0.12] text-primary',
  topics: 'bg-sky-500/[0.12] text-sky-700 dark:text-sky-400',
  altro: 'bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400',
  scelta: 'bg-app-hover text-app-text-secondary',
  fatto: 'bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400',
};
