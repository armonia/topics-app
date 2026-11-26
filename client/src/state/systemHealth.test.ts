/**
 * @covers SYSTEM-PAGE-01
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import { highestSeverity, parseHealth, useSystemHealth } from './systemHealth';
import type { HealthProblem } from '../../../shared/agents-health';

const p = (severity: HealthProblem['severity']): HealthProblem => ({ id: severity, type: 't', severity, sentence: 's', destination: { section: 'memory' } });

describe('systemHealth', () => {
  test('no problem shows no colour, the worst severity wins otherwise', () => {
    expect(highestSeverity([])).toBeNull();
    expect(highestSeverity([p('warning')])).toBe('warning');
    expect(highestSeverity([p('warning'), p('error')])).toBe('error');
  });

  test('an answer without a list is no answer', () => {
    expect(parseHealth(null)).toBeNull();
    expect(parseHealth({ problems: [p('error')] })).toHaveLength(1);
  });

  test('two readers share one reading: a reload from one updates the other', async () => {
    let list: HealthProblem[] = [p('error'), p('warning')];
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ problems: list })); }) as unknown as typeof fetch;
    try {
      const reader = { reload: async (): Promise<void> => {} };
      const A = () => {
        const h = useSystemHealth();
        // eslint-disable-next-line react-hooks/immutability -- the test only needs the reader's reload
        reader.reload = h.reload;
        return createElement('i', null, h.problems?.length ?? 'none');
      };
      const B = () => createElement('b', null, useSystemHealth().problems?.length ?? 'none');
      const render = () => [renderToStaticMarkup(createElement(A)), renderToStaticMarkup(createElement(B))];
      expect(render()).toEqual(['<i>none</i>', '<b>none</b>']);
      await Promise.all([reader.reload(), reader.reload()]);
      expect(calls).toBe(1); // concurrent reloads share one fetch
      expect(render()).toEqual(['<i>2</i>', '<b>2</b>']);
      list = [p('warning')];
      await reader.reload();
      expect(render()).toEqual(['<i>1</i>', '<b>1</b>']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
