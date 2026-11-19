/**
 * client/src/lib/i18n-project-quota-it.ts - the project menu's own "Limite
 * nelle 24 ore" selector (limiti-consumo-progetto, USAGE-29), in Italian: the
 * mirror of `i18n-project-quota-en.ts`. Native to Topics, loaded unconditionally
 * (not tied to the hub's own chunk).
 */
import type { Dict } from './i18n-types';

const PROJECT_QUOTA_IT: Dict = {
  'projectQuota.limit': 'Limite nelle 24 ore',
  'projectQuota.limit.none': 'Nessuno',
  'projectQuota.failed': 'Non salvato: {why}',
};

export default PROJECT_QUOTA_IT;
