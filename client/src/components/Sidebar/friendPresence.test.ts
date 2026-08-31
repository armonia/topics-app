/**
 * The join between the friendship graph and the presence rows the band draws.
 *
 * @covers STATUSLINE-01
 */
import { describe, expect, test } from 'bun:test';
import type { FriendPerson } from '@/lib/api';
import { friendFaces, friendRows } from './friendPresence';
import { PRESENZA_MS } from './orgPresence';

const ORA = 1_700_000_000_000;

function friend(id: string, name: string, seen: number | null): FriendPerson {
  return {
    id,
    displayName: name,
    email: null,
    githubLogin: null,
    github: null,
    stats: null,
    isMe: false,
    counts: null,
    viewerFollows: false,
    followsViewer: false,
    lastSeenAt: seen,
    since: ORA,
  };
}

describe('friendRows', () => {
  test('seen inside the window is present, outside it is not', () => {
    const rows = friendRows([
      friend('a', 'Anna', ORA - 1_000),
      friend('b', 'Bruno', ORA - PRESENZA_MS - 1),
    ], ORA);
    expect(rows.map((r) => [r.id, r.presente])).toEqual([['a', true], ['b', false]]);
  });

  test('a friend who publishes no presence is absent, not invented', () => {
    expect(friendRows([friend('a', 'Anna', null)], ORA)[0]!.presente).toBe(false);
  });

  test('a clock ahead of ours counts as present rather than hiding somebody', () => {
    expect(friendRows([friend('a', 'Anna', ORA + 30_000)], ORA)[0]!.presente).toBe(true);
  });

  test('present first, then most recently seen, then the name', () => {
    const rows = friendRows([
      friend('c', 'Carla', null),
      friend('b', 'Bruno', ORA - 60_000),
      friend('a', 'Anna', ORA - 1_000),
    ], ORA);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  test('the initials come from the name, at most two', () => {
    expect(friendRows([friend('a', 'anna maria rossi', ORA)], ORA)[0]!.iniziali).toBe('AM');
  });
});

describe('friendFaces', () => {
  test('only who is online, in the order the panel shows them', () => {
    const rows = friendRows([
      friend('b', 'Bruno', ORA - 120_000),
      friend('a', 'Anna', ORA - 1_000),
      friend('z', 'Zoe', null),
    ], ORA);
    expect(friendFaces(rows).map((f) => f.id)).toEqual(['a', 'b']);
  });
});
