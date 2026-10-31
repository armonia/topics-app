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
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DispatchDashboardView, DispatchDetailsView, DispatchSummaryView, MemoryChart } from './DispatchDashboard';
import { GlobalSettingsSection } from './BoardSettingsSections';
import { adoptDispatchCapacity, adoptGlobalCap } from '../../state/globalDispatchCap';
import { rowReason, brokenCards, chartMax, overflowedCards, queuedCards, waitingLabel, type QueuedCard } from './dispatchDashboardModel';
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
/** The element tree a component returns, captured inside a real render (hooks work); there is no DOM to click in bun test. */
function treeOf(render: () => ReactElement): ReactNode {
  let out: ReactNode = null;
  const Probe = () => { out = render(); return null; };
  renderToStaticMarkup(<Probe />);
  return out;
}
/** The props of the first element carrying this data-testid. */
function propsByTestId(node: ReactNode, id: string): Record<string, unknown> | null {
  if (Array.isArray(node)) { for (const n of node) { const f = propsByTestId(n, id); if (f) return f; } return null; }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  return props['data-testid'] === id ? props : propsByTestId(props.children as ReactNode, id);
}

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
  test('l\'ordine: riepilogo, risposta, coda, grafico, chi tiene la memoria', () => {
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} />);
    const at = (s: string) => html.indexOf(s);
    expect(at('dispatch-dashboard-hero')).toBeLessThan(at('dispatch-dashboard-answer'));
    expect(at('dispatch-dashboard-answer')).toBeLessThan(at('dispatch-dashboard-queue"'));
    expect(at('dispatch-dashboard-queue"')).toBeLessThan(at('dispatch-chart-block'));
    expect(at('dispatch-chart-block')).toBeLessThan(at('dispatch-dashboard-holders'));
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
    // One reason per state, in plain words: the row says state AND why ("head: detail"), the long text is the tooltip.
    const withReason = { ...base, id: 'r', text: 'r', status: 'todo', dispatchState: 'queued', queueReason: { key: 'k', tone: 'waiting' } } as unknown as BoardTask;
    const [why] = queuedCards([withReason], (k: string) => k.split('.').pop()!, NOW);
    expect(why!.reason).toBe('head: detail');
    expect(why!.detail).toBe('title');
    // A head with nothing after it stays the head alone (no dangling colon).
    const [bare] = queuedCards([withReason], (k: string) => (k.endsWith('.detail') ? '' : k.split('.').pop()!), NOW);
    expect(bare!.reason).toBe('head');
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
  test('un solo motivo per card: la riga lo scrive in chiaro, la spiegazione lunga sta nel tooltip', () => {
    const long = card({ id: 'r', title: 'Una card', reason: 'ferma: dispatch spento', detail: 'Idonea, ma l\'auto-dispatch è spento' });
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={[long]} now={NOW} />);
    const reason = html.match(/data-testid="dispatch-dashboard-queue-reason"[^>]*>([^<]*)</)?.[1];
    // the generic state word is not repeated on every row
    expect(reason).toBe('dispatch spento');
    expect(html).toContain('title="Idonea, ma l&#x27;auto-dispatch è spento"');
    expect(text(html)).not.toContain('Idonea, ma');
  });
  test('nessuna riga della coda resta alla sola testa generica («ferma», «in coda», «rinviata», «in attesa»)', () => {
    const it = readFileSync(join(import.meta.dir, '../../lib/i18n-it.ts'), 'utf8');
    const GENERIC = new Set(['ferma', 'in coda', 'rinviata', 'in attesa']);
    const heads = [...it.matchAll(/'(board\.queue\.[^']+)\.head': '([^']*)'/g)].filter((m) => GENERIC.has(m[2]!));
    expect(heads.length).toBeGreaterThan(10);
    const tr = (k: string) => it.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`))?.[1] ?? '';
    for (const [, key] of heads) {
      const [c] = queuedCards([{ id: 'g', text: 'g', status: 'todo', dispatchState: 'queued', parentTaskId: null, priority: 1, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T11:00:00Z', projectId: 'p', queueReason: { key, tone: 'waiting' } } as unknown as BoardTask], tr, NOW);
      expect(GENERIC.has(c!.reason ?? ''), `${key}: la riga dice solo «${c!.reason}»`).toBe(false);
    }
  });
  test('«Accendi» è cablato: il clic chiama onTurnOn, anche con un guasto', () => {
    const b = brokenCards([{ id: 'f0', text: 'rotta', status: 'todo', dispatchState: 'failed', projectId: 'p-1' } as unknown as BoardTask]);
    for (const withFault of [false, true]) {
      let turned = 0;
      const tree = treeOf(() => DispatchSummaryView({ capacity, snapshot, queue, broken: withFault ? b.total : 0, brokenList: withFault ? b : undefined, dispatchOn: false, onTurnOn: () => { turned++; } }));
      const btn = propsByTestId(tree, 'dispatch-dashboard-turn-on');
      expect(btn, withFault ? 'con guasto' : 'senza guasto').not.toBeNull();
      (btn!.onClick as () => void)();
      expect(turned).toBe(1);
    }
  });
  test('spento + guasto: il riquadro rosso resta, e un riquadro giallo dice che è spento con «Accendi»', () => {
    const b = brokenCards([{ id: 'f0', text: 'rotta', status: 'todo', dispatchState: 'failed', projectId: 'p-1' } as unknown as BoardTask]);
    const html = renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} broken={b.total} brokenList={b} dispatchOn={false} onTurnOn={() => {}} />);
    expect(html).toContain('data-testid="dispatch-dashboard-ok" data-tone="bad"');
    expect(html).toContain('data-testid="dispatch-dashboard-off" data-tone="warn"');
    expect(text(html)).toContain('Auto-dispatch spento: le 2 in coda partono quando lo accendi.');
    expect(html.indexOf('dispatch-dashboard-turn-on')).toBeGreaterThan(html.indexOf('dispatch-dashboard-off'));
    expect(html.match(/dispatch-dashboard-turn-on/g)?.length).toBe(1);
    // on, or state unknown: no amber box
    for (const dispatchOn of [true, null] as const) {
      expect(renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} broken={b.total} brokenList={b} dispatchOn={dispatchOn} onTurnOn={() => {}} />)).not.toContain('dispatch-dashboard-off');
    }
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
    test('ordine: risposta, coda, grafico, quante card insieme, Avanzate', () => {
      const html = panel();
      const at = (s: string) => html.indexOf(s);
      expect(at('dispatch-dashboard-answer')).toBeLessThan(at('dispatch-dashboard-details'));
      expect(at('dispatch-dashboard-details')).toBeLessThan(at('global-cap-control'));
      expect(at('global-cap-control')).toBeLessThan(at('settings-advanced'));
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
  test('card in coda senza motivo dal server: la riga dice perché e il tooltip non è vuoto', () => {
    const it = readFileSync(join(import.meta.dir, '../../lib/i18n-it.ts'), 'utf8');
    const tr = (k: string) => it.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`))?.[1] ?? '';
    const [c] = queuedCards([{ id: 'n', text: 'n', status: 'in_progress', dispatchState: 'queued', parentTaskId: null, priority: 1, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T11:00:00Z', projectId: 'p', queueReason: null } as unknown as BoardTask], tr, NOW);
    expect(c!.reason).toBe('in coda: aspetta un posto libero');
    expect(c!.detail).toBeTruthy();
  });
  test('chip progetto e motivo possono restringersi e spezzare una parola lunga (min-w-0 overflow-wrap:anywhere)', () => {
    const long = card({ id: 'w', title: 'Una card', project: 'p'.repeat(90), reason: 'r'.repeat(90), detail: 'd' });
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={[long]} now={NOW} />);
    for (const id of ['dispatch-dashboard-queue-project', 'dispatch-dashboard-queue-reason']) {
      const tag = html.match(new RegExp(`<span[^>]*${id}[^>]*>`))?.[0] ?? '';
      expect(tag, id).toMatch(/class="[^"]*\bmin-w-0\b/);
      expect(tag, id).toContain('[overflow-wrap:anywhere]');
      expect(tag, id).not.toMatch(/\bbreak-all\b/);
    }
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
  test('riga della coda: titolo e sotto una sola riga, senza clessidra e senza «ferma:» ripetuto', () => {
    expect(rowReason('ferma: dispatch spento')).toBe('dispatch spento');
    expect(rowReason('aspetta memoria: servono 3,5 GB')).toBe('aspetta memoria: servono 3,5 GB');
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={[card({ id: 'z', reason: 'ferma: dispatch spento' })]} now={NOW} />);
    expect(html).not.toContain('lucide-hourglass');
    expect(html).not.toContain('ferma:');
  });
  test('un solo interruttore in testa; i dettagli sono nell\'ordine coda, grafico', () => {
    const html = renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn onToggle={() => {}} />);
    expect(html.match(/dispatch-dashboard-switch/g)?.length).toBe(1);
    expect(html).toContain('Le card partono da sole');
    expect(renderToStaticMarkup(<DispatchSummaryView capacity={capacity} snapshot={snapshot} queue={queue} dispatchOn />)).not.toContain('dispatch-dashboard-switch');
    const d = renderToStaticMarkup(<DispatchDetailsView capacity={capacity} snapshot={snapshot} queue={queue} now={NOW} withHolders={false} />);
    expect(d.indexOf('dispatch-dashboard-queue')).toBeLessThan(d.indexOf('dispatch-chart'));
    expect(d).not.toContain('dispatch-dashboard-holders-fold');
  });
  test('il pannello: ordine unico e Avanzate chiuso con spesa e memoria', () => {
    const src = readFileSync(join(import.meta.dir, 'BoardSettingsSections.tsx'), 'utf8');
    const at = (k: string) => src.indexOf(k);
    expect(at('<DispatchSummary ')).toBeLessThan(at('<DispatchDetails '));
    expect(at('<DispatchDetails ')).toBeLessThan(at('<GlobalCapControl quiet'));
    expect(at('<GlobalCapControl quiet')).toBeLessThan(at('data-testid="settings-advanced"'));
    const advancedSrc = src.slice(at('data-testid="settings-advanced"'));
    expect(advancedSrc.indexOf('<SpendCapControl')).toBeGreaterThan(0);
    expect(advancedSrc.indexOf('<DispatchHolders')).toBeGreaterThan(0);
    expect(src.slice(at('data-testid="settings-advanced"') - 40, at('data-testid="settings-advanced"'))).not.toContain(' open');
  });
  test('quante card insieme: nel cruscotto il secondo livello è dentro un blocco chiuso', () => {
    const src = readFileSync(join(import.meta.dir, 'GlobalCapControl.tsx'), 'utf8');
    expect(src).toMatch(/quiet \? \(\s*<details className="group" data-testid="global-cap-mode-fold">/);
  });
});

describe('cruscotto auto-dispatch: le card spostate perché il Mac era pieno', () => {
  test('una riga sola per card: dove è andata e perché', () => {
    const tasks = [
      { id: 'm', text: 'Sistema il login', status: 'in_progress', machineId: 'cloud', runComputerName: 'Cloud Claude', overflowedAt: '2026-10-30T10:02:00Z' },
      { id: 'n', text: 'Scelta a mano', status: 'todo', machineId: 'pc', runComputerName: 'PC Windows' },
      { id: 'd', text: 'Già chiusa', status: 'done', machineId: 'cloud', runComputerName: 'Cloud Claude', overflowedAt: '2026-10-30T09:00:00Z' },
    ] as unknown as BoardTask[];
    const moved = overflowedCards(tasks);
    expect(moved).toEqual([{ id: 'm', title: 'Sistema il login', node: 'Cloud Claude' }]);
    const html = renderToStaticMarkup(<DispatchDashboardView capacity={capacity} snapshot={snapshot} queue={[]} moved={moved} now={NOW} />);
    expect(text(html)).toContain('Sistema il login· spostata su Cloud Claude: Mac pieno');
    expect(html.match(/data-testid="dispatch-dashboard-moved-row"/g)).toHaveLength(1);
  });
});
