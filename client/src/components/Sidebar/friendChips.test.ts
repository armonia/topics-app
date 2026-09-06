/**
 * Who earns a chip at the foot of the column, and what is written on it.
 *
 * @covers STATUSLINE-04
 */
import { describe, expect, test } from 'bun:test';
import { firstName, friendChips } from './friendChips';
import type { PresenceRow } from './orgPresence';

function row(id: string, nome: string, presente: boolean): PresenceRow {
  return { id, nome, avatarUrl: null, iniziali: nome.slice(0, 1), presente, vistoA: presente ? 1 : null };
}

describe('friendChips', () => {
  test('only the people who are here right now get a chip', () => {
    const chips = friendChips([row('a', 'Ada', true), row('b', 'Bo', false), row('c', 'Cy', true)]);
    expect(chips.map((c) => c.id)).toEqual(['a', 'c']);
  });

  test('nobody around means no row at all: the caller gets an empty list', () => {
    expect(friendChips([row('a', 'Ada', false)])).toEqual([]);
  });

  test('the same person arriving twice is one chip', () => {
    const chips = friendChips([row('a', 'Ada', true), row('a', 'Ada', true)]);
    expect(chips).toHaveLength(1);
  });

  test('the order it is given is the order it keeps', () => {
    const chips = friendChips([row('z', 'Zoe', true), row('a', 'Ada', true)]);
    expect(chips.map((c) => c.id)).toEqual(['z', 'a']);
  });

  test('the chip carries the first name, the tooltip carries the whole one', () => {
    const [chip] = friendChips([row('a', 'Ada Lovelace', true)]);
    expect(chip?.name).toBe('Ada');
    expect(chip?.fullName).toBe('Ada Lovelace');
  });
});

describe('firstName', () => {
  test('drops the surname', () => {
    expect(firstName('Ada Lovelace')).toBe('Ada');
  });

  test('a single word is already the first name', () => {
    expect(firstName('Ada')).toBe('Ada');
  });

  test('no name gives no name: it does not invent one', () => {
    expect(firstName('   ')).toBe('');
  });
});
