/**
 * EVERY PREFERENCE HAS ONE DOOR.
 *
 * `SETTINGS_HOMES` names, for each key of `AppSettings`, the surfaces where a
 * person can SEE it and change it back. A contextual command that only adds
 * (the pause card's «keep always», a project's «mute») is not a home: a value
 * you can set and never read or undo is the defect this table exists to catch.
 *
 * Two homes are the other defect: the same value drawn twice, by two copies
 * that one day disagree.
 *
 * @covers USERMENU-06
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from './settings';
import { SETTINGS_HOMES } from './settingsHomes';

describe('settings homes (USERMENU-06)', () => {
  test('the table lists exactly the keys of AppSettings', () => {
    expect(Object.keys(SETTINGS_HOMES).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  test('every key has exactly one home', () => {
    const offenders = Object.entries(SETTINGS_HOMES)
      .filter(([, homes]) => homes.length !== 1)
      .map(([key, homes]) => `${key}: ${homes.length === 0 ? 'no home' : homes.join(' + ')}`);
    expect(offenders).toEqual([]);
  });
});
