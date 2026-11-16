/**
 * client/src/lib/i18n-dashboard-it.ts - the strings of the «Consumi» pane
 * without the hub: KPI cards, chart metrics, refresh line.
 *
 * Loaded with the pane's own chunk (`addCatalogue` in `DashboardPane`), not
 * with the entry: only that pane reads them. A leaf: it takes its type from
 * `i18n-types.ts`.
 */
import type { Dict } from './i18n-types';

const DASHBOARD_IT: Dict = {
  'dashboard.kpi.throughputDay': 'Completati (oggi)',
  'dashboard.kpi.throughputWeek': 'Completati (settimana)',
  'dashboard.kpi.cycleTime': 'Tempo medio di ciclo',
  'dashboard.kpi.wip': 'In corso',
  'dashboard.kpi.errorRate': 'Tasso di errore',
  'dashboard.kpi.spendDay': 'Spesa token (oggi)',
  'dashboard.kpi.spendWeek': 'Spesa token (settimana)',
  'dashboard.kpi.approvalTurnaround': 'Tempo di approvazione',
  'dashboard.kpi.pendingApprovals': 'Da approvare',
  'dashboard.unit.tasks': 'task',
  'dashboard.unit.hours': 'ore',
  'dashboard.metric.throughput': 'Completati',
  'dashboard.metric.tokens': 'Token',
  'dashboard.metric.cost': 'Costo',
  'dashboard.metric.errors': 'Errori',
  'dashboard.autoRefresh': 'Si aggiorna ogni 60 s',
  'dashboard.refreshFailed': 'Aggiornamento non riuscito: {error}',
  'dashboard.noData': 'Nessun dato nel periodo scelto',
};

export default DASHBOARD_IT;
