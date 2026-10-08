/**
 * A view stays in sight: only a successful `show_view` becomes a block, it
 * leaves its tool run under both names it travels with, and a finished turn
 * never folds it behind «N actions».
 *
 * @covers GENUI-01
 */
import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../types';
import { viewOf } from './viewOpens';
import { partitionToolGroup } from './toolGrouping';
import { foldFinishedTurn, type FoldableGroup } from './turnFold';

const SPEC = {
  title: 'Sitges',
  options: [
    { title: 'Beach Haven', price: '184 €' },
    { title: 'Nautilus', price: 184, recommended: true },
  ],
};
const RESULT = 'shown in chat · compare · 2 options · page https://127.0.0.1:3333/v/0123456789abcdef';
const shown = (id: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  id, name: 'mcp__topics__show_view', args: SPEC, status: 'success', result: RESULT, ...extra,
});
const read = (id: string): ToolCall => ({ id, name: 'Read', args: { file_path: '/a.ts' }, status: 'success' });

describe('viewOf', () => {
  test('a successful call is a view, with the id read from its result', () => {
    const v = viewOf(shown('v1'))!;
    expect(v.viewId).toBe('0123456789abcdef');
    expect(v.spec.view).toBe('compare');
    expect(v.spec.options.map((o) => o.price?.amount)).toEqual([184, 184]);
  });

  test('the bare name of the native runtime is the same view', () => {
    expect(viewOf(shown('v1', { name: 'show_view' }))?.viewId).toBe('0123456789abcdef');
  });

  test('running, failed or malformed: a tool row, not a block', () => {
    expect(viewOf(shown('v1', { status: 'running', result: undefined }))).toBeNull();
    expect(viewOf(shown('v1', { status: 'error', result: 'show_view: invalid view' }))).toBeNull();
    expect(viewOf(shown('v1', { args: { title: 'T', options: [{ title: 'one' }] } }))).toBeNull();
    expect(viewOf(read('r1'))).toBeNull();
  });
});

test('the view leaves its tool run as its own segment', () => {
  const segs = partitionToolGroup([read('r1'), read('r2'), shown('v1'), read('r3')]);
  expect(segs.map((s) => s.kind)).toEqual(['aggregate', 'view', 'aggregate']);
});

test('a finished turn folds the work and keeps the view in sight, before the answer', () => {
  const tools = [read('r1'), read('r2'), read('r3')];
  const view = viewOf(shown('v1'))!;
  const groups: FoldableGroup[] = [
    { kind: 'tools', startIdx: 0, tools },
    { kind: 'view', idx: 3, tool: shown('v1'), view },
    { kind: 'text', idx: 4, text: 'Nautilus, per la suite tutta vostra.' },
  ];
  const fold = foldFinishedTurn(groups, false)!;
  expect(fold.tools.map((t) => t.id)).toEqual(['r1', 'r2', 'r3']);
  expect(fold.shown.map((g) => g.kind)).toEqual(['view', 'text']);
});
