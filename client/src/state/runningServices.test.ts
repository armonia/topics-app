/**
 * The chat's servers as the client keeps them (BGVIS-08): an unchanged poll
 * keeps every reference, so no row renders for nothing.
 * @covers BGVIS-08
 */
import { describe, expect, test } from 'bun:test';
import { mergeServices, setRunningServices, topicRunningServices, SERVICE_ENDED_SHOWN_MS } from './runningServices';
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

  test('an ended server is told for a few seconds from the first poll that says so, then stays gone while later polls still carry it', () => {
    // The row used to keep this clock itself: a footer remounted inside the
    // server's window (the transcript's footer is Virtuoso's, it remounts)
    // started it again and «Server stopped» came back for another 5 s.
    const t0 = 1_000_000;
    const ended = (id: string): TopicServices[] => [{ topicId: 'e', sessionKey: 'topic:e', services: [{ processId: id, description: 'srv', command: 'srv', listen: [{ host: '127.0.0.1', port: 8777 }], ended: { at: t0, exitCode: null, stopped: true } }] }];
    setRunningServices(ended('gone'), t0);
    expect(topicRunningServices('e')?.map((s) => s.processId)).toEqual(['gone']);
    setRunningServices(ended('gone'), t0 + SERVICE_ENDED_SHOWN_MS - 1);
    expect(topicRunningServices('e')?.map((s) => s.processId)).toEqual(['gone']);
    // The next poll, still inside the server's own window, carries it again.
    setRunningServices(ended('gone'), t0 + SERVICE_ENDED_SHOWN_MS + 3_000);
    expect(topicRunningServices('e')).toBeUndefined();
    // Another server that ends later gets its own few seconds.
    setRunningServices(ended('later'), t0 + SERVICE_ENDED_SHOWN_MS + 4_000);
    expect(topicRunningServices('e')?.map((s) => s.processId)).toEqual(['later']);
    setRunningServices([], t0 + 20_000);
    expect(topicRunningServices('e')).toBeUndefined();
  });
});
