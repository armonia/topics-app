/**
 * @covers SYSTEM-PAGE-01
 */
import { describe, expect, test } from 'bun:test';
import { harnessLayers, memoryIndexTokens } from './harnessLayers';

const persona = (agent: string, own: number) => ({
  agent, name: agent.toUpperCase(),
  layers: [{ name: 'base', tokens: 100 }, { name: 'rules', tokens: 30 }, { name: 'profile', tokens: 20 }, { name: 'identity', tokens: own }, { name: 'agent', tokens: 5 }],
});

describe('harnessLayers', () => {
  test('shared layers once, the agent layer one weight per agent', () => {
    const l = harnessLayers([persona('a', 10), persona('b', 40)], { alwaysOn: 700, onDemand: 90 }, 55);
    expect(l.base).toBe(100);
    expect(l.rules).toBe(50);
    expect(l.agents).toEqual([{ id: 'a', name: 'A', tokens: 15 }, { id: 'b', name: 'B', tokens: 45 }]);
    expect(l.tools).toEqual({ alwaysOn: 700, onDemand: 90 });
  });

  test('no agent at all is an empty harness, not an error', () => {
    expect(harnessLayers([], null, null)).toMatchObject({ base: 0, rules: 0, agents: [], tools: null });
  });

  test('only the indexes somebody receives weigh on a turn', () => {
    expect(memoryIndexTokens([{ index: { chars: 400 }, receivedBy: ['a'] }, { index: { chars: 4000 }, receivedBy: [] }, { index: null, receivedBy: ['a'] }])).toBe(100);
  });
});
