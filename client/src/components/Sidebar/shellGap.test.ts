/**
 * The number in the status bar has to admit which of the three versions it is.
 *
 * Reported twice, from two doors: "locally I think it is not in development and
 * it brings me a new version 211 but I have 211" and "locally I should be in
 * development mode but I do not see any indication of it".
 *
 * The verdict is here and not in the pixels because it is a decision about
 * facts: which number is missing, which one is a shrug, and when there is
 * nothing to say at all. A signal that fires on a missing fact is a signal
 * nobody reads by the second week.
 *
 * @covers STATUSLINE-03c
 */
import { describe, expect, test } from 'bun:test';
import { shellGap, versionBadgeText } from './shellGap';

describe('shell gap', () => {
  test('the shell behind the client is a divergence, and it names both numbers', () => {
    expect(shellGap('2.2.214', '2.2.179')).toEqual({ client: '2.2.214', shell: '2.2.179' });
  });

  test('same number, nothing to say', () => {
    expect(shellGap('2.2.214', '2.2.214')).toBeNull();
  });

  // Direction is not part of the verdict, same as bundleDrift: a shell AHEAD of
  // the client (an update installed with the bundle hot-delivered from an older
  // checkout) is just as much a "what you read is not what you run".
  test('a shell ahead of the client is a divergence too', () => {
    expect(shellGap('2.2.179', '2.2.214')).toEqual({ client: '2.2.179', shell: '2.2.214' });
  });

  test('in the browser there is no shell to disagree with', () => {
    expect(shellGap('2.2.214', '2.2.179', { desktop: false })).toBeNull();
  });

  test('a missing fact is not a divergence', () => {
    expect(shellGap('2.2.214', '')).toBeNull();
    expect(shellGap('', '2.2.179')).toBeNull();
    expect(shellGap(undefined, undefined)).toBeNull();
  });

  test('the shrug version is not a divergence', () => {
    expect(shellGap('2.2.214', '0.0.0')).toBeNull();
    expect(shellGap('0.0.0', '2.2.179')).toBeNull();
  });
});

describe('badge text', () => {
  test('a dev install whose shell is behind says both things', () => {
    const badge = versionBadgeText({ client: '2.2.214', shell: '2.2.179' }, true);
    expect(badge).toBe('dev \u00b7 v2.2.179');
  });

  test('an installed app whose shell is behind names the shell number', () => {
    expect(versionBadgeText({ client: '2.2.214', shell: '2.2.179' }, false)).toBe('v2.2.179');
  });

  test('a dev install in agreement still says it is a dev install', () => {
    // This is the second half of the report: the state was true, known to the
    // client, and visible nowhere without opening a panel.
    expect(versionBadgeText(null, true)).toBe('dev');
  });

  test('under the dev server the build age rides inside the same badge', () => {
    expect(versionBadgeText(null, true, '12m')).toBe('dev \u00b7 12m');
  });

  test('an ordinary installed app carries no badge at all', () => {
    expect(versionBadgeText(null, false)).toBeNull();
    expect(versionBadgeText(null, false, '12m')).toBeNull();
  });
});
