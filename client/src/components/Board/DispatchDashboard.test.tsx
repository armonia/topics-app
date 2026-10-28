/**
 * Il cruscotto in testa al pannello auto-dispatch dice quante card lavorano,
 * quali aspettano e in che ordine, e chi tiene la memoria: con i testi neutri
 * del server e nessun gergo.
 *
 * @covers KANBAN-79
 */
import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DispatchDashboardView, DispatchMachines, MemoryChart, waitingLabel, type QueuedCard } from './DispatchDashboard';
import type { DispatchCapacity } from '../../lib/board';
import type { DispatchMemoryQueueSnapshot } from '../../../../shared/board';

const capacity = { running: 2, availableMemGB: 2.8, totalMemGB: 32 } as DispatchCapacity;
const snapshot: DispatchMemoryQueueSnapshot = {
  reading: { freeGB: 2.8, at: null },
  threshold: { startGB: 3.5 },
  queue: [], running: [],
  consumers: [{ label: 'App aperte', gb: 10.3 }, { label: 'macOS', gb: 6.6 }],
  history: [],
};
const NOW = Date.parse('2026-10-28T12:00:00Z');
const queue: QueuedCard[] = [
  { id: 'a', title: 'Comando usage-hub', waitingMs: 19 * 60_000, reason: 'In coda · aspetta memoria libera' },
  { id: 'b', title: 'Tray del PC', waitingMs: 4 * 60_000, reason: null },
];

describe('cruscotto auto-dispatch', () => {
  test('hero, coda in ordine con testo neutro, memoria e chi la tiene', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} />);
    expect(html).toContain('2 al lavoro · 2 in coda');
    expect(html).toContain('3,5 GB liberi');
    expect(html.indexOf('Comando usage-hub')).toBeLessThan(html.indexOf('Tray del PC'));
    expect(html).toContain('aspetta memoria libera');
    expect(html).toContain('da 19 min');
    expect(html).toContain('title="In coda · aspetta memoria libera"');
    expect(html).not.toMatch(/ferma · la macchina|0x[0-9a-f]+|Sonnet 4/i);
  });
  test('se frena la CPU non dice «parte a 3,5 GB»', () => {
    const cpu = { ...capacity, admission: { admit: false, blockedBy: 'cpu' } } as unknown as DispatchCapacity;
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={cpu} snapshot={snapshot} queue={queue} now={NOW} />);
    expect(html).toContain('meno occupato');
    expect(html).not.toContain('3,5 GB');
  });
  test('senza coda lo dice, senza memoria misurata non inventa numeri', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={null} snapshot={null} queue={[]} now={NOW} />);
    expect(html).toContain('Nessuna card in coda');
    expect(html).not.toContain('GB');
  });
  test('il grafico disegna la serie vera con la soglia, e dice quando non c\'è', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ at: new Date(NOW - (29 - i) * 60_000).toISOString(), freeGB: 4 - i / 20, running: i > 15 ? 1 : 0 }));
    const html = renderToStaticMarkup(<MemoryChart history={history} startGB={3.5} now={NOW} />);
    expect(html).toContain('data-testid="dispatch-chart"');
    expect(html).toContain('3,5 GB liberi: ne parte un’altra');
    expect(html).toContain('29 min fa');
    const empty = renderToStaticMarkup(<MemoryChart history={[]} startGB={3.5} now={NOW} />);
    expect(empty).toContain('dispatch-chart-empty');
  });
  test('le macchine mostrano chi tiene la memoria', () => {
    const html = renderToStaticMarkup(<DispatchMachines capacity={capacity} snapshot={snapshot} />);
    expect(html).toContain('10,3');
    expect(html).toContain('Questo Mac');
  });
  test('quanto aspetta', () => {
    expect(waitingLabel(10_000)).toBe('1 min');
    expect(waitingLabel(125 * 60_000)).toBe('2 h 5 min');
  });
});
