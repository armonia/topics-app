/**
 * The dashboard at the top of the auto-dispatch panel says how many cards work,
 * which wait and in what order, and who holds the memory: with the server's
 * neutral texts and no jargon. On top of the first version, the three design
 * improvements: memory chart, live status row, queue with project,
 * age and Start anyway on the first card.
 *
 * @covers KANBAN-79
 */
import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DispatchDashboardView, MemoryChart } from './DispatchDashboard';
import { chartMax, queuedCards, waitingLabel, type QueuedCard } from './dispatchDashboardModel';
import type { BoardTask, DispatchCapacity } from '../../lib/board';
import type { DispatchMemoryQueueSnapshot } from '../../../../shared/board';

const capacity = { running: 2, availableMemGB: 2.8, totalMemGB: 32 } as DispatchCapacity;
const history = Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.parse('2026-10-28T12:00:00Z') - (29 - i) * 60_000).toISOString(), freeGB: 4 - i / 20, running: i > 15 ? 1 : 0 }));
const snapshot: DispatchMemoryQueueSnapshot = {
  reading: { freeGB: 2.8, at: null },
  threshold: { startGB: 3.5 },
  queue: [], running: [],
  consumers: [{ label: 'App aperte', gb: 10.3 }, { label: 'macOS', gb: 6.6 }],
  history,
};
const NOW = Date.parse('2026-10-28T12:00:00Z');
const card = (over: Partial<QueuedCard>): QueuedCard => ({ id: 'x', title: 't', project: null, waitingMs: 60_000, reason: null, memoryWaiter: true, stalled: false, projectId: 'p-1', ...over });
const queue: QueuedCard[] = [
  card({ id: 'a', title: 'Comando usage-hub', project: 'attilio', waitingMs: 19 * 60_000, reason: 'aspetta memoria libera', detail: 'Il Mac ha poca memoria libera adesso' }),
  card({ id: 'b', title: 'Tray del PC', project: 'topics-app', waitingMs: 4 * 60_000 }),
];
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('cruscotto auto-dispatch', () => {
  test('la prima versione resta: riepilogo, memoria, coda, chi tiene la memoria', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} />);
    expect(text(html)).toContain('2 al lavoro · 2 in coda');
    expect(text(html)).toContain('Ne parte un’altra quando il Mac ha 3,5 GB liberi (adesso 2,8 GB).');
    expect(text(html)).toContain('Chi tiene la memoria del Mac · 32 GB');
    expect(html).toContain('data-testid="dispatch-dashboard-holders"');
    expect(html.indexOf('Comando usage-hub')).toBeLessThan(html.indexOf('Tray del PC'));
    expect(html).toContain('title="Il Mac ha poca memoria libera adesso"');
    expect(html).not.toMatch(/ferma · la macchina|0x[0-9a-f]+|Sonnet 4/i);
  });
  test('l\'ordine: riepilogo, grafico, coda, chi tiene la memoria', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} />);
    const at = (s: string) => html.indexOf(s);
    expect(at('dispatch-dashboard-memory')).toBeLessThan(at('dispatch-chart-block'));
    expect(at('dispatch-chart-block')).toBeLessThan(at('dispatch-dashboard-queue"'));
    expect(at('dispatch-dashboard-queue"')).toBeLessThan(at('dispatch-dashboard-holders'));
  });
  test('riga di stato dal vivo: nessun guasto, o quante ferme per un guasto', () => {
    const ok = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn now={NOW} />));
    expect(ok).toContain('dal vivo');
    expect(ok).toContain('Nessuna card è ferma per un guasto: le 2 in coda partono da sole.');
    const ko = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} broken={1} now={NOW} />));
    expect(ko).toContain('1 card è ferma per un guasto');
    const ko2 = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} broken={2} now={NOW} />));
    expect(ko2).toContain('2 card sono ferme per un guasto');
    // A card the server considers stuck does not "start by itself".
    const st = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={[{ ...queue[0]!, stalled: true }, queue[1]!]} dispatchOn now={NOW} />));
    expect(st).toContain('1 card in coda non parte da sola');
    expect(st).not.toContain('partono da sole');
    // With the switch still unread it promises nothing.
    const unknown = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={null} now={NOW} />));
    expect(unknown).not.toContain('partono da sole');
    const off = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={false} now={NOW} />));
    expect(off).toContain('Auto-dispatch spento: le 2 in coda partono quando lo accendi.');
    expect(off).not.toContain('partono da sole');
    // and with dispatch off the memory row does not promise that another one starts
    expect(off).not.toContain('Ne parte un’altra');
    const none = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={[]} now={NOW} />));
    expect(none).toContain('Nessuna card è ferma per un guasto.');
  });
  test('coda: progetto, età, e «Avvia comunque» solo sulla prima e solo se aspetta memoria', () => {
    const idle = { ...capacity, running: 0 } as DispatchCapacity;
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={idle} snapshot={snapshot} queue={queue} now={NOW} onStartNow={() => {}} />);
    expect(html.match(/data-testid="dispatch-dashboard-queue-project"/g)?.length).toBe(2);
    expect(text(html)).toContain('attilio');
    expect(text(html)).toContain('da 19 min');
    expect(html.match(/data-testid="dispatch-dashboard-start-now"/g)?.length).toBe(1);
    expect(html.indexOf('dispatch-dashboard-start-now')).toBeLessThan(html.indexOf('Tray del PC'));
    // Outside the memory wait the server answers 409: there is no button.
    const other = renderToStaticMarkup(<DispatchDashboardView capacity={idle} snapshot={snapshot} queue={[{ ...queue[0]!, memoryWaiter: false }, queue[1]!]} now={NOW} onStartNow={() => {}} />);
    expect(other).not.toContain('dispatch-dashboard-start-now');
    // With a card at work the server refuses (seat taken): the button is disabled and says why.
    const busy = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} onStartNow={() => {}} />);
    expect(busy).toMatch(/data-testid="dispatch-dashboard-start-now"[^>]*disabled=""/);
    expect(busy).toContain('C’è già una card al lavoro sul Mac');
  });
  test('un rifiuto si dice in italiano dal code, sotto la card giusta, e sparisce se la card è uscita', () => {
    const idle = { ...capacity, running: 0 } as DispatchCapacity;
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={idle} snapshot={snapshot} queue={queue} now={NOW} onStartNow={() => {}} startFailure={{ id: 'a', code: 'start_rejected' }} />);
    expect(text(html)).toContain('Non è partita: il Mac non la regge adesso (disco, spesa o CPU)');
    expect(html).not.toContain('task cannot be started');
    expect(html.indexOf('dispatch-dashboard-start-error')).toBeLessThan(html.indexOf('Tray del PC'));
    const gone = renderToStaticMarkup(<DispatchDashboardView capacity={idle} snapshot={snapshot} queue={[queue[1]!]} now={NOW} onStartNow={() => {}} startFailure={{ id: 'a', code: 'start_rejected' }} />);
    expect(gone).not.toContain('dispatch-dashboard-start-error');
  });
  test('«dal vivo» solo con una lettura fresca', () => {
    expect(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} live />)).toContain('dal vivo');
    expect(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} live={false} />)).not.toContain('dal vivo');
  });
  test('una card è «in attesa di memoria» solo col test del server', () => {
    const base = { parentTaskId: null, updatedAt: '2026-10-28T11:41:00Z', createdAt: '2026-10-28T10:00:00Z', priority: 2, queueReason: null, projectId: 'attilio-1a2b3c' } as unknown as BoardTask;
    const tr = (k: string) => k;
    const [mem] = queuedCards([{ ...base, id: 'm', text: 'm', status: 'todo', dispatchState: 'queued', dispatchError: 'waiting-memory' } as BoardTask], tr, NOW);
    expect(mem!.memoryWaiter).toBe(true);
    const [cpu] = queuedCards([{ ...base, id: 'c', text: 'c', status: 'todo', dispatchState: 'queued', dispatchError: null } as BoardTask], tr, NOW);
    expect(cpu!.memoryWaiter).toBe(false);
    // The dispatcher's order: priority, then the oldest (not the last update).
    const order = queuedCards([
      { ...base, id: 'old-low', text: 'old-low', status: 'todo', dispatchState: 'queued', priority: 1, createdAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T11:59:00Z' } as BoardTask,
      { ...base, id: 'new-high', text: 'new-high', status: 'todo', dispatchState: 'queued', priority: 4, createdAt: '2026-10-28T11:00:00Z', updatedAt: '2026-10-28T11:00:00Z' } as BoardTask,
      { ...base, id: 'older-low', text: 'older-low', status: 'todo', dispatchState: 'queued', priority: 1, createdAt: '2026-10-28T08:00:00Z', updatedAt: '2026-10-28T11:59:30Z' } as BoardTask,
    ], tr, NOW).map((q) => q.id);
    expect(order).toEqual(['new-high', 'older-low', 'old-low']);
    const [named] = queuedCards([{ ...base, id: 'n', text: 'n', status: 'todo', dispatchState: 'queued', dispatchError: null } as BoardTask], tr, NOW, () => 'attilio');
    expect(named!.project).toBe('attilio');
    // One reason per state: the row carries the head only, the detail goes to the tooltip.
    const withReason = { ...base, id: 'r', text: 'r', status: 'todo', dispatchState: 'queued', queueReason: { key: 'k', tone: 'waiting' } } as unknown as BoardTask;
    const [why] = queuedCards([withReason], (k: string) => k.split('.').pop()!, NOW);
    expect(why!.reason).toBe('head');
    expect(why!.detail).toBe('detail');
  });
  test('se frena la CPU non dice «parte a 3,5 GB»', () => {
    const cpu = { ...capacity, admission: { admit: false, blockedBy: 'cpu' } } as unknown as DispatchCapacity;
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={cpu} snapshot={snapshot} queue={queue} now={NOW} />);
    expect(html).toContain('meno occupato');
    expect(text(html)).not.toContain('Ne parte un’altra');
  });
  test('senza coda lo dice, senza memoria misurata non inventa numeri', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={null} snapshot={null} queue={[]} now={NOW} />);
    expect(html).toContain('Nessuna card in coda');
    expect(html).not.toContain('GB');
  });
  test('il grafico disegna la serie vera con la soglia e la fascia delle card, e dice quando non c\'è', () => {
    const html = renderToStaticMarkup(<MemoryChart history={history} startGB={3.5} now={NOW} />);
    expect(html).toContain('data-testid="dispatch-chart"');
    expect(html).toContain('3,5 GB liberi: ne parte un’altra');
    expect(html).toContain('stroke-dasharray="4 3"');
    expect(html).toContain('1 card');
    expect(html).toContain('29 min fa');
    // The written card count is the real one, even beyond the 2 that set the height.
    const three = history.map((p, i) => ({ ...p, running: i > 15 ? 3 : 0 }));
    expect(renderToStaticMarkup(<MemoryChart history={three} startGB={3.5} now={NOW} />)).toContain('3 card');
    // The CPU is the brake: the threshold is drawn but does not promise another one will start.
    expect(renderToStaticMarkup(<MemoryChart history={history} startGB={3.5} now={NOW} cpuHolds />)).not.toContain('ne parte un’altra');
    // "now" is now: with the sampler stopped for 20 minutes the scale still reaches 49 min ago.
    expect(renderToStaticMarkup(<MemoryChart history={history} startGB={3.5} now={NOW + 20 * 60_000} />)).toContain('49 min fa');
    const empty = renderToStaticMarkup(<MemoryChart history={[]} startGB={3.5} now={NOW} />);
    expect(empty).toContain('dispatch-chart-empty');
  });
  test('l\'asse Y si allarga sopra i 6 GB invece di schiacciare la curva', () => {
    expect(chartMax([2.8, 4.6], 3.5)).toBe(6);
    expect(chartMax([14.2, 18], 3.5)).toBe(18);
    expect(chartMax([7], 3.5)).toBe(9);
  });
  test('quanto aspetta', () => {
    expect(waitingLabel(10_000)).toBe('1 min');
    expect(waitingLabel(125 * 60_000)).toBe('2 h 5 min');
  });
  test('un solo motivo per stato: la riga dice il perche, il dettaglio solo nel suggerimento', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} />);
    expect(text(html)).toContain('aspetta memoria libera');
    expect(text(html)).not.toContain('Il Mac ha poca memoria libera adesso');
    expect(text(html)).not.toContain('In coda · aspetta');
  });
  test('Accendi sta nella riga gialla solo se spento; i colori non si mescolano', () => {
    const off = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={false} onTurnOn={() => {}} now={NOW} />);
    expect(off).toContain('data-testid="dispatch-dashboard-turn-on"');
    expect(off).toContain('data-tone="warn"');
    expect(off).not.toContain('rose');
    const on = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn onTurnOn={() => {}} now={NOW} />);
    expect(on).not.toContain('dispatch-dashboard-turn-on');
    const bad = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} broken={1} now={NOW} />);
    expect(bad).toContain('data-tone="bad"');
  });
  test('chi tiene la memoria e chiuso di default', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} />);
    expect(html).toMatch(/<details data-testid="dispatch-dashboard-holders-details">/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });
});
