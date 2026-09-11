/**
 * The option builder of the board's dispatch-model picker.
 *
 * @covers KANBAN-80
 */
import { describe, expect, test } from 'bun:test';
import { buildDispatchModelOptions } from './dispatchModelOptions';

describe('buildDispatchModelOptions', () => {
  test('a dispatch model present in the catalog appears once, no duplicate', () => {
    const opts = buildDispatchModelOptions(['claude-opus-5', 'claude-sonnet-5'], 'claude-sonnet-5', 'Auto');
    const matches = opts.filter((o) => o.value === 'claude-sonnet-5');
    expect(matches.length).toBe(1);
    expect(opts.map((o) => o.value)).toEqual(['auto', 'claude-opus-5', 'claude-sonnet-5']);
  });

  test('a dispatch model whose provider is down still appears, with a friendly label', () => {
    // The regression this guards: without it the trigger falls back to
    // `Select`'s own placeholder `-`, which reads as "nothing set" while the
    // dispatcher still runs on this exact value.
    const opts = buildDispatchModelOptions(['claude-opus-5'], 'claude-sonnet-5', 'Auto');
    const stored = opts.find((o) => o.value === 'claude-sonnet-5');
    expect(stored).toBeDefined();
    expect(stored?.label).toBe('Sonnet 5');
  });

  test('no dispatch model set adds nothing beyond auto', () => {
    const opts = buildDispatchModelOptions(['claude-opus-5'], null, 'Auto');
    expect(opts).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'claude-opus-5', label: 'Opus 5' },
    ]);
  });
});
