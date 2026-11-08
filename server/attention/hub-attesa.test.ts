/**
 * @covers shared/hub-attesa.ts
 */
import { describe, expect, test } from 'bun:test';
import { hubTaskId, splitHubWaits } from '../../shared/hub-attesa';

const item = (id: string, taskId: string | null) => ({ id, taskId });

describe('splitHubWaits', () => {
  test('an item tied to a card that waits for the person is merged: one row', () => {
    const { merged, outside } = splitHubWaits([item('h1', 'card-a')], new Set(['card-a']));
    expect(outside).toEqual([]);
    expect(merged.get('card-a')?.map((i) => i.id)).toEqual(['h1']);
  });

  test('an item without a card goes to its own section', () => {
    const { merged, outside } = splitHubWaits([item('h2', null)], new Set(['card-a']));
    expect(merged.size).toBe(0);
    expect(outside.map((i) => i.id)).toEqual(['h2']);
  });

  test('an item tied to a card that waits for nothing stays outside', () => {
    expect(splitHubWaits([item('h3', 'card-b')], new Set(['card-a'])).outside).toHaveLength(1);
  });

  test('the outside list keeps the hub order', () => {
    const { outside } = splitHubWaits([item('x', null), item('y', 'card-a'), item('z', null)], new Set(['card-a']));
    expect(outside.map((i) => i.id)).toEqual(['x', 'z']);
  });
});

describe('hubTaskId', () => {
  test('keeps a non-empty string and drops anything else', () => {
    expect(hubTaskId(' abc ')).toBe('abc');
    expect(hubTaskId('')).toBeNull();
    expect(hubTaskId(7)).toBeNull();
    expect(hubTaskId(undefined)).toBeNull();
  });
});
