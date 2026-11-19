/**
 * client/src/lib/i18n-project-quota-it.ts - the project quota texts (the
 * menu's 24h limit selector, the sidebar meter, the Dashboard table), in
 * Italian: the mirror of `i18n-project-quota-en.ts`. Native to Topics, loaded
 * unconditionally (not tied to the hub's own chunk).
 */
import type { Dict } from './i18n-types';

const PROJECT_QUOTA_IT: Dict = {
  'projectQuota.limit': 'Limite nelle 24 ore',
  'projectQuota.limit.none': 'Nessuno',
  'projectQuota.limit.unknown': 'Limite non disponibile: lettura fallita',
  'projectQuota.failed': 'Non salvato: {why}',
  'projectQuota.meter': '{points} punti quota su {limit} nelle ultime 24 ore',
  'projectQuota.title': 'Quota per progetto',
  'projectQuota.unavailable': 'Quota per progetto non disponibile.',
  'projectQuota.noHistory': 'Nessuno storico della quota su questa macchina: i punti non si possono calcolare.',
  'projectQuota.col.project': 'Progetto',
  'projectQuota.col.day': '24 ore',
  'projectQuota.col.week': '7 giorni',
  'projectQuota.col.limit': 'Limite',
  'projectQuota.col.surfaces': 'Dove è andata (24 ore)',
  'projectQuota.outside': 'Fuori dai progetti',
  'projectQuota.noLimit': 'nessuno',
  'projectQuota.topChats': 'Chat più pesanti',
  'projectQuota.surface.card': 'Card',
  'projectQuota.surface.chat': 'Chat',
  'projectQuota.surface.cardSubagent': 'Sottoagenti di card',
  'projectQuota.surface.chatSubagent': 'Sottoagenti di chat',
  'projectQuota.surface.single': 'Chiamate singole',
  'projectQuota.surface.outside': 'Fuori da Topics',
  'projectQuota.chatRow': '{title}: {day} in 24 ore, {week} in 7 giorni',
};

export default PROJECT_QUOTA_IT;
