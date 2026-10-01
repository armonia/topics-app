/**
 * The chat's servers as the client keeps them (BGVIS-08): an unchanged poll
 * keeps every reference, so no row renders for nothing.
 * @covers BGVIS-08
 */
import { describe, expect, test } from 'bun:test';
import { mergeServices } from './runningServices';
import type { TopicServices } from '../../../shared/background-work';

const services = (port: number): TopicServices[] => [
  { topicId: 'a', sessionKey: 'topic:a', services: [{ processId: 'p', description: 'srv', command: 'srv', listen: [{ host: '127.0.0.1', port }] }] },
];

describe('runningServices', () => {
  test('an unchanged poll keeps the map, a change replaces only its entry, an empty one clears it', () => {
    const first = mergeServices(new Map(), services(8777));
    expect(first.get('a')?.[0]?.listen[0]?.port).toBe(8777);
    expect(mergeServices(first, services(8777))).toBe(first);
    const moved = mergeServices(first, services(9000));
    expect(moved).not.toBe(first);
    expect(moved.get('a')?.[0]?.listen[0]?.port).toBe(9000);
    expect(mergeServices(moved, []).size).toBe(0);
    // An older server sends no `services`: no servers.
    expect(mergeServices(moved, undefined).size).toBe(0);
  });
});
