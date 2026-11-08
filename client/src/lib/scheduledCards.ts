/**
 * Board recurrences (D5f): a rule that creates a card at the right time, in the
 * zone written on it. The scheduler lives on the server
 * (`server/services/scheduled-cards.ts`); this is its client.
 */
import type { ScheduledCard, ScheduledCardInput } from '../../../shared/scheduled-cards';
import { req } from './board';

export type { ScheduledCard, ScheduledCardInput } from '../../../shared/scheduled-cards';

const encode = encodeURIComponent;
const base = (projectId: string) => `/boards/${encode(projectId)}/scheduled-cards`;

export const scheduledCardsApi = {
  list: (projectId: string) => req<{ schedules: ScheduledCard[] }>(base(projectId)).then(r => r.schedules),
  create: (projectId: string, body: ScheduledCardInput) =>
    req<ScheduledCard>(base(projectId), { method: 'POST', body: JSON.stringify(body) }),
  update: (projectId: string, id: string, body: ScheduledCardInput) =>
    req<ScheduledCard>(`${base(projectId)}/${encode(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setEnabled: (projectId: string, id: string, enabled: boolean) =>
    req<ScheduledCard>(`${base(projectId)}/${encode(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  remove: (projectId: string, id: string) =>
    req<{ ok: boolean }>(`${base(projectId)}/${encode(id)}`, { method: 'DELETE' }),
};
