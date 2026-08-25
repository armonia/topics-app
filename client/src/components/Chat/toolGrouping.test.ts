/**
 * @covers CHAT-TOOL-02
 *
 * Partial: aggregation of tool-call groups, as pure grouping. The rendered
 * strip is elsewhere.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../types';
import {
  GROUP_MIN,
  formatCostCents,
  formatDurationMs,
  formatTokensCompact,
  formatToolCounts,
  isActiveTool,
  isSoloTool,
  isWhollyFailed,
  partitionToolGroup,
  summarizeToolGroup,
} from './toolGrouping';

let seq = 0;
function tc(partial: Partial<ToolCall> & { name: string }): ToolCall {
  return { id: `tc-${++seq}`, args: {}, status: 'success', ...partial };
}

describe('isSoloTool / isActiveTool', () => {
  test('waiting_for_input is solo', () => {
    expect(isSoloTool(tc({ name: 'AskUserQuestion', status: 'waiting_for_input' }))).toBe(true);
  });

  test('sub-agent (Task) is solo', () => {
    expect(isSoloTool(tc({ name: 'Task', args: { subagent_type: 'Explore' } }))).toBe(true);
  });

  test('regular tools are not solo, errors are not solo', () => {
    expect(isSoloTool(tc({ name: 'Read' }))).toBe(false);
    expect(isSoloTool(tc({ name: 'Bash', status: 'error' }))).toBe(false);
  });

  test('pending/running are active, terminal states are not', () => {
    expect(isActiveTool(tc({ name: 'Read', status: 'running' }))).toBe(true);
    expect(isActiveTool(tc({ name: 'Read', status: undefined }))).toBe(true);
    expect(isActiveTool(tc({ name: 'Read', status: 'success' }))).toBe(false);
    expect(isActiveTool(tc({ name: 'Read', status: 'error' }))).toBe(false);
  });
});

describe('partitionToolGroup', () => {
  test('all-aggregatable run stays one segment', () => {
    const tools = [tc({ name: 'Read' }), tc({ name: 'Edit' }), tc({ name: 'Bash' })];
    const segs = partitionToolGroup(tools);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('aggregate');
    expect(segs[0].kind === 'aggregate' && segs[0].tools).toHaveLength(3);
  });

  test('solo splits the run and order is preserved', () => {
    const tools = [
      tc({ name: 'Read' }),
      tc({ name: 'Grep' }),
      tc({ name: 'Task', args: { subagent_type: 'Explore' } }),
      tc({ name: 'Edit' }),
    ];
    const segs = partitionToolGroup(tools);
    expect(segs.map((s) => s.kind)).toEqual(['aggregate', 'solo', 'aggregate']);
    expect(segs[0].kind === 'aggregate' && segs[0].tools.map((t) => t.name)).toEqual(['Read', 'Grep']);
    expect(segs[2].kind === 'aggregate' && segs[2].tools.map((t) => t.name)).toEqual(['Edit']);
  });

  test('GROUP_MIN threshold is 3', () => {
    expect(GROUP_MIN).toBe(3);
  });
});

describe('summarizeToolGroup', () => {
  test('counts by canonical display name, sorted by count desc', () => {
    const tools = [
      tc({ name: 'Read', args: { file_path: '/a.ts' } }),
      tc({ name: 'Read', args: { file_path: '/b.ts' } }),
      tc({ name: 'Bash', args: { command: 'ls' } }),
      tc({ name: 'Read', args: { file_path: '/c.ts' } }),
      tc({ name: 'Edit', args: { file_path: '/a.ts' } }),
    ];
    const s = summarizeToolGroup(tools);
    expect(s.total).toBe(5);
    expect(s.counts[0]).toEqual({ name: 'Read', count: 3 });
    // Bash canonicalizes to "Shell" via the detail layer.
    expect(s.counts.map((c) => c.name).sort()).toEqual(['Edit', 'Read', 'Shell']);
    expect(s.errors).toBe(0);
    expect(s.running).toBe(0);
  });

  test('errors and running are counted', () => {
    const tools = [
      tc({ name: 'Read', status: 'error' }),
      tc({ name: 'Read', status: 'running' }),
      tc({ name: 'Read', status: 'pending' }),
      tc({ name: 'Read' }),
    ];
    const s = summarizeToolGroup(tools);
    expect(s.errors).toBe(1);
    expect(s.running).toBe(2);
  });

  test('duration is the wall-clock span of the run', () => {
    const tools = [
      tc({ name: 'Read', startedAt: 1_000, endedAt: 2_000 }),
      tc({ name: 'Edit', startedAt: 2_500, endedAt: 41_000 }),
    ];
    expect(summarizeToolGroup(tools).durationMs).toBe(40_000);
  });

  test('duration absent without timestamps (legacy rows)', () => {
    expect(summarizeToolGroup([tc({ name: 'Read' })]).durationMs).toBeUndefined();
  });

  test('costCents/tokens summed across the group', () => {
    const s = summarizeToolGroup([
      tc({ name: 'Read', costCents: 3, tokens: 1200 }),
      tc({ name: 'Bash', costCents: 5, tokens: 800 }),
      tc({ name: 'Edit' }), // no usage — contributes nothing
    ]);
    expect(s.costCents).toBe(8);
    expect(s.tokens).toBe(2000);
  });

  test('cost/tokens absent when no row carries usage (legacy rows)', () => {
    const s = summarizeToolGroup([tc({ name: 'Read' }), tc({ name: 'Edit' })]);
    expect(s.costCents).toBeUndefined();
    expect(s.tokens).toBeUndefined();
  });
});

describe('isWhollyFailed', () => {
  test('una corsa senza errori non è rossa', () => {
    expect(isWhollyFailed({ errors: 0, total: 5 })).toBe(false);
  });

  test('UNA fallita su cinque non tinge la corsa intera', () => {
    expect(isWhollyFailed({ errors: 1, total: 5 })).toBe(false);
  });

  test('il confine: quattro su cinque no, cinque su cinque sì', () => {
    expect(isWhollyFailed({ errors: 4, total: 5 })).toBe(false);
    expect(isWhollyFailed({ errors: 5, total: 5 })).toBe(true);
  });

  test('un gruppo vuoto non è una corsa fallita', () => {
    expect(isWhollyFailed({ errors: 0, total: 0 })).toBe(false);
  });

  test('sul riepilogo vero: 1 su 5 neutra, 3 su 3 rossa', () => {
    const parziale = summarizeToolGroup([
      tc({ name: 'Read', status: 'error' }),
      tc({ name: 'Read' }),
      tc({ name: 'Edit' }),
      tc({ name: 'Bash' }),
      tc({ name: 'Read' }),
    ]);
    expect(parziale.errors).toBe(1);
    expect(isWhollyFailed(parziale)).toBe(false);

    const tutta = summarizeToolGroup([
      tc({ name: 'Read', status: 'error' }),
      tc({ name: 'Edit', status: 'error' }),
      tc({ name: 'Bash', status: 'error' }),
    ]);
    expect(tutta.errors).toBe(3);
    expect(isWhollyFailed(tutta)).toBe(true);
  });
});

describe('formatters', () => {
  test('formatToolCounts joins with ×N only above 1', () => {
    expect(
      formatToolCounts([
        { name: 'Read', count: 5 },
        { name: 'Edit', count: 1 },
      ]),
    ).toBe('Read ×5 · Edit');
  });

  test('formatDurationMs tiers', () => {
    expect(formatDurationMs(840)).toBe('0.8s');
    expect(formatDurationMs(9_400)).toBe('9.4s');
    expect(formatDurationMs(41_000)).toBe('41s');
    expect(formatDurationMs(65_000)).toBe('1m 05s');
    expect(formatDurationMs(59 * 60_000 + 30_000)).toBe('59m 30s');
    expect(formatDurationMs(60 * 60_000)).toBe('1h 00m');
    expect(formatDurationMs(3600_000 + 125_000)).toBe('1h 02m');
    expect(formatDurationMs(-5)).toBe('');
  });

  test('formatCostCents: 4 decimali sotto $1, 2 sopra, vuoto per zero', () => {
    expect(formatCostCents(0.12)).toBe('$0.0012');
    expect(formatCostCents(150)).toBe('$1.50');
    expect(formatCostCents(0)).toBe('');
    expect(formatCostCents(-3)).toBe('');
  });

  test('formatTokensCompact: k/M con soglie', () => {
    expect(formatTokensCompact(340)).toBe('340');
    expect(formatTokensCompact(1200)).toBe('1.2k');
    expect(formatTokensCompact(48000)).toBe('48k');
    expect(formatTokensCompact(1_500_000)).toBe('1.5M');
    expect(formatTokensCompact(0)).toBe('');
  });
});

describe('summarizeToolGroup · quando la corsa è COMINCIATA', () => {
  const tc = (id: string, over: Partial<ToolCall> = {}): ToolCall =>
    ({ id, name: 'Read', args: {}, status: 'success', ...over }) as ToolCall;

  test('è il primo startedAt della corsa, non l\'ultimo', () => {
    const s = summarizeToolGroup([
      tc('b', { startedAt: 2000, endedAt: 2500 }),
      tc('a', { startedAt: 1000, endedAt: 1500 }),
      tc('c', { startedAt: 3000, endedAt: 3500 }),
    ]);
    expect(s.startedAt).toBe(1000);
    expect(s.durationMs).toBe(2500);
  });

  test('a corsa VIVA il numero buono è l\'inizio: `durationMs` copre solo i conclusi', () => {
    const s = summarizeToolGroup([
      tc('a', { startedAt: 1000, endedAt: 1500 }),
      tc('b', { status: 'running', startedAt: 2000 }),
    ]);
    expect(s.running).toBe(1);
    expect(s.startedAt).toBe(1000);
    // 1500 − 1000: l'azione ancora in corso non ha un `endedAt`, quindi questa
    // NON è la durata della corsa — è la ragione per cui la riga la mostra solo
    // a corsa finita, e mentre è viva fa ticchettare `startedAt`.
    expect(s.durationMs).toBe(500);
  });

  test('righe vecchie senza timestamp: nessun inizio inventato', () => {
    const s = summarizeToolGroup([tc('a'), tc('b')]);
    expect(s.startedAt).toBeUndefined();
    expect(s.durationMs).toBeUndefined();
  });
});
