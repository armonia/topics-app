/**
 * The notifications the preview starts with, built from the example data so
 * each one opens the thing it talks about: an urgent report, a stopped run, a
 * procedure to approve, a test in progress, a value in quarantine, the next
 * deadline. Actions in the preview add more (`ctx.notify`).
 */
import { CASES } from '../../ui/fixtures/org/cases';
import { DEMO_TODAY, daysFromToday, formatDay } from '../../ui/fixtures/org/clock';
import type { NotificationEntry } from './store/state';
import { P } from './paths';

export function seedNotifications(): NotificationEntry[] {
  const out: NotificationEntry[] = [];
  const report = CASES.find((c) => c.kind === 'segnalazione' && c.urgent);
  if (report) {
    out.push({ id: 'seed-report', at: report.arrivedAt, tone: 'warn', title: `Segnalazione urgente: ${report.title}`, body: report.proposal, path: P.inbox(report.id) }); // allow-italian: fixture data, shown as written
  }
  out.push({ id: 'seed-run', at: `${DEMO_TODAY}T09:50:00+01:00`, tone: 'error', title: 'Esecuzione ferma: il robot non entra in Halley', body: 'Dopo il cambio della password del 05/11. Topics ha riprovato 3 volte.', path: P.flowRun('pec', 'e-0412') }); // allow-italian: fixture data, shown as written
  out.push({ id: 'seed-procedure', at: `${DEMO_TODAY}T08:40:00+01:00`, tone: 'info', title: 'Procedura da approvare: Concessione di attraversamento', body: "Scritta dall'AI da 6 pratiche e dal R.D. 368/1904.", path: P.procedure('concessione-attraversamento') }); // allow-italian: fixture data, shown as written
  out.push({ id: 'seed-test', at: '2026-11-05T18:00:00+01:00', tone: 'info', title: 'Collaudo della versione 5 del flusso PEC: giorno 4 di 7', body: 'Nessuna differenza sui casi di ieri.', path: P.flowTest('pec') }); // allow-italian: fixture data, shown as written
  out.push({ id: 'seed-quarantine', at: '2026-11-05T15:25:00+01:00', tone: 'warn', title: 'Dato in quarantena: IBAN del fornitore cambiato', body: 'La fattura resta ferma finché qualcuno non conferma.', path: P.qualityItem('q-iban') }); // allow-italian: fixture data, shown as written
  const next = CASES.flatMap((c) => c.deadlines.map((d) => ({ c, d })))
    .filter(({ c, d }) => c.org === 'nocera' && daysFromToday(d.date) >= 0)
    .sort((a, b) => a.d.date.localeCompare(b.d.date))[0];
  if (next) {
    const days = daysFromToday(next.d.date);
    out.push({ id: 'seed-deadline', at: `${DEMO_TODAY}T07:00:00+01:00`, tone: days <= 3 ? 'warn' : 'info', title: `${next.d.label}: ${formatDay(next.d.date)}`, body: `Pratica ${next.c.id} · ${next.c.title}`, path: P.record(next.c.id) }); // allow-italian: fixture data, shown as written
  }
  const call = CASES.find((c) => c.org === 'sarim');
  if (call) {
    out.push({ id: 'seed-sarim', at: call.arrivedAt, tone: 'info', title: `SARIM: ${call.title}`, body: call.proposal, path: P.sarimRecord(call.id) });
  }
  return out;
}
