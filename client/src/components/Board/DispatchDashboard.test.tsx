/**
 * The dashboard at the top of the auto-dispatch panel says how many cards work,
 * which wait and in what order, and who holds the memory: with the server's
 * neutral texts and no jargon. On top of the first version, the three design
 * improvements: memory chart, live status row, queue with project,
 * age and Start anyway on the first card.
 *
 * @covers KANBAN-79
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { DispatchDashboardView, DispatchSummaryView, MemoryChart } from './DispatchDashboard';
import { GlobalSettingsSection } from './BoardSettingsSections';
import { adoptDispatchCapacity, adoptGlobalCap } from '../../state/globalDispatchCap';
import { brokenCards, chartMax, queuedCards, waitingLabel, type QueuedCard } from './dispatchDashboardModel';
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
    // «Chi tiene la memoria» is closed until asked for.
    expect(html).toMatch(/<details class="group" data-testid="dispatch-dashboard-holders-fold">/);
    expect(html).not.toMatch(/<details[^>]*data-testid="dispatch-dashboard-holders-fold"[^>]*\bopen/);
    expect(html.indexOf('Comando usage-hub')).toBeLessThan(html.indexOf('Tray del PC'));
    expect(html).toContain('title="Il Mac ha poca memoria libera adesso"');
    expect(html).not.toMatch(/ferma · la macchina|0x[0-9a-f]+|Sonnet 4/i);
  });
  test('l\'ordine: riepilogo, risposta, grafico, coda, chi tiene la memoria', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} />);
    const at = (s: string) => html.indexOf(s);
    expect(at('dispatch-dashboard-hero')).toBeLessThan(at('dispatch-dashboard-answer'));
    expect(at('dispatch-dashboard-answer')).toBeLessThan(at('dispatch-chart-block'));
    expect(at('dispatch-chart-block')).toBeLessThan(at('dispatch-dashboard-queue"'));
    expect(at('dispatch-dashboard-queue"')).toBeLessThan(at('dispatch-dashboard-holders'));
  });
  test('riga di stato dal vivo: nessun guasto, o quante ferme per un guasto', () => {
    // With room in memory the answer is the all-well sentence (below the start line it is a wait).
    const roomy = { ...capacity, availableMemGB: 8 } as DispatchCapacity;
    const ok = text(renderToStaticMarkup(<DispatchDashboardView capacity={roomy} snapshot={snapshot} queue={queue} dispatchOn now={NOW} />));
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
    // Below the start line the answer is the memory wait, in amber.
    const mem = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn now={NOW} />);
    expect(text(mem)).toContain('Ne parte un’altra quando il Mac ha 3,5 GB liberi (adesso 2,8 GB).');
    expect(mem).toContain('data-tone="warn"');
    // With the switch still unread it promises nothing.
    const unknown = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={null} now={NOW} />));
    expect(unknown).not.toContain('partono da sole');
    const off = text(renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={false} now={NOW} />));
    expect(off).toContain('Auto-dispatch spento: le 2 in coda partono quando lo accendi.');
    expect(off).not.toContain('partono da sole');
    // and with dispatch off the memory row does not promise that another one starts
    expect(off).not.toContain('Ne parte un’altra');
    // Off with an empty queue still says so: the switch is what to turn back on.
    expect(text(renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={[]} dispatchOn={false} />))).toContain('Auto-dispatch spento');
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
    // One answer: the gate's verdict, not the memory threshold.
    expect(text(html)).toContain('In attesa: il Mac è occupato');
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

  test('«Accendi» sta nella riga gialla solo quando l\'auto-dispatch è spento', () => {
    let turned = 0;
    const off = renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={false} onTurnOn={() => { turned++; }} />);
    expect(off).toContain('data-testid="dispatch-dashboard-turn-on"');
    expect(text(off)).toContain('Accendi');
    expect(off).toContain('data-tone="warn"');
    // the button is INSIDE the warning box, not a row of its own
    expect(off.indexOf('dispatch-dashboard-turn-on')).toBeGreaterThan(off.indexOf('dispatch-dashboard-answer'));
    expect(off.match(/data-testid="dispatch-dashboard-ok"/g)?.length).toBe(1);
    expect(turned).toBe(0);
    for (const dispatchOn of [true, null] as const) {
      expect(renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={dispatchOn} onTurnOn={() => {}} />)).not.toContain('dispatch-dashboard-turn-on');
    }
    // no handler = no dead button
    expect(renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn={false} />)).not.toContain('dispatch-dashboard-turn-on');
  });
  test('un solo motivo per card: la riga dice la testa, il dettaglio sta nel tooltip', () => {
    const long = card({ id: 'r', title: 'Una card', reason: 'In coda', detail: 'aspetta memoria libera' });
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={[long]} now={NOW} />);
    const reason = html.match(/data-testid="dispatch-dashboard-queue-reason"[^>]*>([^<]*)</)?.[1];
    expect(reason).toBe('In coda');
    expect(html).toContain('title="aspetta memoria libera"');
    expect(text(html)).not.toContain('aspetta memoria libera');
  });
  test('la coda va a capo: niente troncamenti con il pannello stretto', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} onStartNow={() => {}} />);
    const rows = html.slice(html.indexOf('dispatch-dashboard-queue"'), html.indexOf('dispatch-dashboard-holders-fold'));
    expect(rows).not.toMatch(/\btruncate\b/);
    expect(rows).toContain('break-words');
    expect(rows).toContain('flex-wrap');
  });

  describe('Mac pieno, nessun guasto: il rosso è solo dei guasti', () => {
    const RED = /\b(?:dark:)?(?:text|bg|border)-(?:red|rose)-\d+/;
    const tasks = [
      { id: 'q1', text: 'Una card', status: 'todo', dispatchState: 'queued', priority: 2, parentTaskId: null, projectId: 'attilio-1a2b3c', createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T11:41:00Z', queueReason: null },
    ] as unknown as BoardTask[];
    const full = (over: Partial<DispatchCapacity> = {}) => ({ ...capacity, running: 1, machineCpuPct: 87, machineMemPct: 87, cores: 12, recommended: 1,
      admission: { admit: false, blockedBy: 'floor', firstAgentExempt: false }, ...over }) as unknown as DispatchCapacity;
    beforeEach(() => {
      adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 1, maxAgentsMode: 'count' });
      adoptDispatchCapacity(full());
    });
    const panel = () => renderToStaticMarkup(<GlobalSettingsSection dispatchOn tasks={tasks} onToggleDispatch={() => {}} />);
    test('barra, scritta, chip e frase sono ambra, mai rossi', () => {
      const html = panel();
      expect(text(html).replace(/&#x27;/g, '’')).toMatch(/occupato all.87%/);
      expect(html).toContain('bg-amber-400');
      expect(html).not.toMatch(RED);
      expect(html).not.toContain('bg-rose-400');
    });
    test('anche sopra il tetto (a numero e a risorse) nessun rosso e nessun verdetto ripetuto', () => {
      // Count brake, over the cap but the gate admits: the chip is an 'over' wait.
      adoptDispatchCapacity(full({ running: 3, admission: { admit: true, blockedBy: null, firstAgentExempt: false } as never }));
      let html = panel();
      expect(html).not.toMatch(RED);
      expect(html).not.toContain('global-cap-verdict');
      // Resources brake, Topics over its ceiling: the live band is red on the wire, amber on screen.
      adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 1, maxAgentsMode: 'resources' });
      adoptDispatchCapacity(full({ cores: 12, usedCoreUnits: 7.4, usableCoreUnits: 6, budgetCoreUnits: 7.2, running: 2,
        admission: { admit: false, blockedBy: 'cpu', firstAgentExempt: false } as never }));
      html = panel();
      expect(html).toContain('data-band="red"');
      expect(html).not.toMatch(RED);
      expect(html).not.toContain('global-cap-verdict');
    });
    test('una sola frase in cima, la stessa non si ripete in fondo', () => {
      const html = panel();
      expect(text(html).match(/In attesa: il Mac è quasi pieno/g)?.length).toBe(1);
      expect(text(html)).not.toContain('fermo: niente spazio');
      expect(html.indexOf('dispatch-dashboard-answer')).toBeLessThan(html.indexOf('global-cap-control'));
    });
    test('con un guasto il rosso c\'è, ed è solo il riquadro', () => {
      const html = renderToStaticMarkup(<DispatchSummaryView capacity={full()} snapshot={snapshot} queue={queue} broken={2} dispatchOn />);
      expect(html).toMatch(RED);
      expect(html).toContain('data-tone="bad"');
      expect(text(html)).toContain('2 card sono ferme per un guasto');
    });
    test('le impostazioni vengono prima di grafico e coda', () => {
      const html = panel();
      const at = (s: string) => html.indexOf(s);
      expect(at('dispatch-dashboard-answer')).toBeLessThan(at('global-cap-control'));
      expect(at('global-cap-control')).toBeLessThan(at('dispatch-dashboard-details'));
    });
  });
});

describe('le card ferme per un guasto nel riquadro rosso', () => {
  const failed = (n: number): BoardTask[] => Array.from({ length: n }, (_, i) => ({
    id: `f${i}`, text: `Card guasta numero ${i + 1}`, status: 'todo', dispatchState: 'failed', projectId: 'p-1',
  })) as unknown as BoardTask[];
  test('2 guasti → 2 titoli, nessun «+N»', () => {
    const b = brokenCards(failed(2));
    expect(b.listed.map((c) => c.title)).toEqual(['Card guasta numero 1', 'Card guasta numero 2']);
    expect(b.total).toBe(2);
    expect(b.more).toBe(0);
  });
  test('5 guasti → 3 titoli + «+2»', () => {
    const b = brokenCards(failed(5));
    expect(b.listed).toHaveLength(3);
    expect(b.total).toBe(5);
    expect(b.more).toBe(2);
    const html = renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} broken={b.total} brokenList={b} dispatchOn />);
    expect(html.match(/dispatch-dashboard-broken-card/g)).toHaveLength(3);
    expect(text(html)).toContain('+2');
  });
  test('un titolo lungo è accorciato su una riga', () => {
    const [c] = brokenCards([{ ...failed(1)[0]!, text: 'x'.repeat(80) + '\n seconda riga' } as BoardTask]).listed;
    expect(c!.title.length).toBeLessThanOrEqual(40);
    expect(c!.title.endsWith('…')).toBe(true);
  });
  test('le card finite o figlie non contano', () => {
    const t = failed(2);
    (t[0] as { status: string }).status = 'done';
    (t[1] as { parentTaskId?: string }).parentTaskId = 'p';
    expect(brokenCards(t).total).toBe(0);
  });
});

describe('regressioni della verifica avversaria', () => {
  test('la lista del riquadro rosso può restringersi (min-w-0): un titolo lungo non sfora', () => {
    const b = brokenCards([{ id: 'f0', text: 'x'.repeat(200), status: 'todo', dispatchState: 'failed', projectId: 'p-1' } as unknown as BoardTask]);
    const html = renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} broken={b.total} brokenList={b} dispatchOn />);
    const ul = html.match(/<ul[^>]*dispatch-dashboard-broken-list[^>]*>/)?.[0] ?? '';
    expect(ul).toMatch(/class="[^"]*\bmin-w-0\b/);
  });
  test('il titolo è un bottone cablato su onOpenTask con l\'id della card', () => {
    const src = readFileSync(join(import.meta.dir, 'DispatchDashboard.tsx'), 'utf8');
    expect(src).toMatch(/data-testid="dispatch-dashboard-broken-card"[\s\S]{0,120}onClick=\{\(\) => onOpenTask\?\.\(c\.id\)\}/);
  });
  test.each(['it', 'en'])('i18n-%s: nessuna chiave duplicata (TS1117 rompe tsc -b)', (loc) => {
    const src = readFileSync(join(import.meta.dir, '../../lib', `i18n-${loc}.ts`), 'utf8');
    const keys = [...src.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]!);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dup).toEqual([]);
  });
});
