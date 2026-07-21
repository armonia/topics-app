import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../types';
import {
  GROUP_MIN,
  formatDurationMs,
  formatToolCounts,
  isActiveTool,
  isSoloTool,
  partitionToolGroup,
  summarizeToolGroup,
  toolCallDigest,
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
});

describe('toolCallDigest / highlights', () => {
  test('shell digest is the command, whitespace collapsed and truncated', () => {
    expect(toolCallDigest(tc({ name: 'Bash', args: { command: '  bun   test ' } }))).toBe('bun test');
    const long = 'x'.repeat(50);
    expect(toolCallDigest(tc({ name: 'Bash', args: { command: long } }))!.length).toBe(36);
  });

  test('file tools digest to the basename, search to the pattern, fetch to the host', () => {
    expect(toolCallDigest(tc({ name: 'Read', args: { file_path: '/src/components/App.tsx' } }))).toBe('App.tsx');
    expect(toolCallDigest(tc({ name: 'Edit', args: { file_path: '/a/b/utils.ts' } }))).toBe('utils.ts');
    expect(toolCallDigest(tc({ name: 'Grep', args: { pattern: 'onToolStart' } }))).toBe('onToolStart');
    expect(toolCallDigest(tc({ name: 'WebFetch', args: { url: 'https://api.github.com/x' } }))).toBe('api.github.com');
  });

  test('digest is undefined when nothing is scannable', () => {
    expect(toolCallDigest(tc({ name: 'TodoWrite', args: { todos: [] } }))).toBeUndefined();
  });

  test('summary highlights dedupe in run order and cap at 8', () => {
    const tools = [
      tc({ name: 'Read', args: { file_path: '/a.ts' } }),
      tc({ name: 'Bash', args: { command: 'bun test' } }),
      tc({ name: 'Read', args: { file_path: '/a.ts' } }), // dup
      ...Array.from({ length: 10 }, (_, i) => tc({ name: 'Read', args: { file_path: `/f${i}.ts` } })),
    ];
    const s = summarizeToolGroup(tools);
    expect(s.highlights[0]).toBe('a.ts');
    expect(s.highlights[1]).toBe('bun test');
    expect(s.highlights).toHaveLength(8);
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
});
