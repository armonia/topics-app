/**
 * The notifications the SARIM edition starts with, built from its example
 * world so each one opens the thing it talks about: the oldest stopped card,
 * the last card an agent handed to a person, the variations waiting for an
 * approval, the obligations past their date and the nearest notice of a
 * contract. Actions in the preview add more (`ctx.notify`).
 */
import { world } from './world';
import { DEMO_TODAY } from '../../ui/fixtures/org/clock';
import type { NotificationEntry } from '../app/store/state';
import { contractAlerts } from './model/contracts';
import { stageOf, stageSince } from './model/live';
import { SP } from './paths';

const morning = `${DEMO_TODAY}T07:00:00+01:00`;

/** Who a notification is for: the person it concerns, and the direction, which sees everything. */
const forWhom = (id: string) => [...new Set([id, world().people.directorId])];

export function sarimNotifications(): NotificationEntry[] {
  const out: NotificationEntry[] = [];

  const stopped = world().cards.filter((c) => c.blocked && stageOf(c) !== 'fatto') // allow-italian: stage id, compared by value
    .sort((a, b) => (a.blocked?.since ?? '').localeCompare(b.blocked?.since ?? ''))[0];
  if (stopped?.blocked) {
    out.push({ id: 'seed-stopped', at: stopped.blocked.since, tone: 'warn', title: `Card ferma: ${stopped.title}`, body: `${stopped.id} · ${stopped.blocked.reason}`, path: SP.card(stopped.id), to: forWhom(stopped.reviewer) }); // allow-italian: fixture data, shown as written
  }

  const handed = world().cards.filter((c) => stageOf(c) === 'verifica' && c.history[c.history.length - 1]?.by.startsWith('agent:')) // allow-italian: stage id, compared by value
    .sort((a, b) => stageSince(b).localeCompare(stageSince(a)))[0];
  if (handed) {
    const agent = world().people.agents.find((a) => `agent:${a.id}` === handed.history[handed.history.length - 1]?.by);
    out.push({ id: 'seed-handed', at: stageSince(handed), tone: 'info', title: `Pronta da verificare: ${handed.title}`, body: `${handed.id} · preparata da ${agent?.name ?? 'un agente'}. ${handed.proposal}`, path: SP.card(handed.id), to: forWhom(handed.reviewer) }); // allow-italian: fixture data, shown as written
  }

  for (const card of world().cards.filter((c) => c.flow === world().flowRoles.variants && stageOf(c) === 'approvazione')) { // allow-italian: stage id, compared by value
    const contract = card.links?.contract;
    out.push({ id: `seed-approve-${card.id}`, at: stageSince(card), tone: 'info', title: `Da approvare: ${card.title}`, body: `${card.id} · ${card.detail}`, path: contract ? SP.signatures(contract) : SP.card(card.id), to: forWhom(card.reviewer) }); // allow-italian: fixture data, shown as written
  }

  const alerts = world().contracts.flatMap((contract) => contractAlerts(contract).map((alert) => ({ contract, alert })));
  for (const { contract, alert } of alerts.filter((x) => x.alert.kind === 'obbligo')) { // allow-italian: alert kind, compared by value
    out.push({ id: `seed-${alert.id}`, at: morning, tone: 'error', title: `${contract.counterparty}: ${alert.title}`, body: alert.body, path: alert.clause ? SP.clause(contract.id, alert.clause) : SP.contract(contract.id), to: forWhom(contract.owner) });
  }
  const notice = alerts.filter((x) => x.alert.kind === 'preavviso')[0]; // allow-italian: alert kind, compared by value
  if (notice) {
    out.push({ id: `seed-${notice.alert.id}`, at: morning, tone: notice.alert.tone === 'error' ? 'error' : 'warn', title: `${notice.contract.title}: ${notice.alert.title}`, body: notice.alert.body, path: notice.alert.clause ? SP.clause(notice.contract.id, notice.alert.clause) : SP.contract(notice.contract.id), to: forWhom(notice.contract.owner) });
  }

  return out;
}
