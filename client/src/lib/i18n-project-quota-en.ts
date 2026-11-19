/**
 * client/src/lib/i18n-project-quota-en.ts - the project quota texts
 * (project quota): the menu's 24h limit selector, the sidebar meter
 * and the Dashboard table. The mirror of `i18n-project-quota-it.ts`.
 */
import type { Dict } from './i18n-types';

const PROJECT_QUOTA_EN: Dict = {
  'projectQuota.limit': '24h limit',
  'projectQuota.limit.none': 'None',
  'projectQuota.limit.unknown': 'Limit not available: could not be read',
  'projectQuota.failed': 'Not saved: {why}',
  'projectQuota.meter': '{points} of {limit} quota points in the last 24 hours',
  'projectQuota.title': 'Quota by project',
  'projectQuota.unavailable': 'Quota by project not available.',
  'projectQuota.noHistory': 'No quota history on this machine: points cannot be computed.',
  'projectQuota.col.project': 'Project',
  'projectQuota.col.day': '24 hours',
  'projectQuota.col.week': '7 days',
  'projectQuota.col.limit': 'Limit',
  'projectQuota.col.surfaces': 'Where it went (24 hours)',
  'projectQuota.outside': 'Outside projects',
  'projectQuota.noLimit': 'none',
  'projectQuota.topChats': 'Heaviest chats',
  'projectQuota.surface.card': 'Cards',
  'projectQuota.surface.chat': 'Chats',
  'projectQuota.surface.cardSubagent': 'Card subagents',
  'projectQuota.surface.chatSubagent': 'Chat subagents',
  'projectQuota.surface.single': 'Single calls',
  'projectQuota.surface.outside': 'Outside Topics',
  'projectQuota.chatRow': '{title}: {day} in 24 hours, {week} in 7 days',
};

export default PROJECT_QUOTA_EN;
