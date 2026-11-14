/**
 * client/src/lib/i18n-dashboard-en.ts - the strings of the «Usage» pane
 * without the hub: KPI cards, chart metrics, refresh line.
 *
 * Loaded with the pane's own chunk (`addCatalogue` in `DashboardPane`), not
 * with the entry: only that pane reads them. A leaf: it takes its type from
 * `i18n-types.ts`.
 */
import type { Dict } from './i18n-types';

const DASHBOARD_EN: Dict = {
  'dashboard.kpi.throughputDay': 'Throughput (today)',
  'dashboard.kpi.throughputWeek': 'Throughput (week)',
  'dashboard.kpi.cycleTime': 'Avg cycle time',
  'dashboard.kpi.wip': 'Work in progress',
  'dashboard.kpi.errorRate': 'Error rate',
  'dashboard.kpi.spendDay': 'Token spend (today)',
  'dashboard.kpi.spendWeek': 'Token spend (week)',
  'dashboard.kpi.approvalTurnaround': 'Approval turnaround',
  'dashboard.kpi.pendingApprovals': 'Pending approvals',
  'dashboard.unit.tasks': 'tasks',
  'dashboard.unit.hours': 'hrs',
  'dashboard.metric.throughput': 'Throughput',
  'dashboard.metric.tokens': 'Tokens',
  'dashboard.metric.cost': 'Cost',
  'dashboard.metric.errors': 'Errors',
  'dashboard.autoRefresh': 'Refreshes every 60s',
  'dashboard.refreshFailed': 'Refresh failed: {error}',
  'dashboard.noData': 'No data for the selected range',
};

export default DASHBOARD_EN;
