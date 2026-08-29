/**
 * The one thing worth pinning without a browser: WHEN the two version numbers
 * count as a drift and when they do not. The pixels (is the mark visible, does
 * the popover row read) are a different question and live in the e2e.
 *
 * The cases that are not "they differ" are the whole point. A signal that fires
 * on a missing fact is a signal nobody reads by the second week, which is how
 * the stale bundle stayed invisible for forty days in the first place.
 *
 * @covers STATUSLINE-03
 */
import { describe, expect, test } from 'bun:test';
import { bundleDrift } from './bundleDrift';

describe('bundle drift', () => {
  test('a bundle behind the repo is a drift, and it names both numbers', () => {
    expect(bundleDrift('2.2.211', '2.2.215')).toEqual({ bundle: '2.2.211', repo: '2.2.215' });
  });

  test('the same number is not a drift', () => {
    expect(bundleDrift('2.2.215', '2.2.215')).toBeNull();
  });

  // Direction is deliberately not part of the verdict: a bundle AHEAD of the
  // repo (a checkout rolled back under a running server) is just as much a
  // "what you read is not what you see", and semver string ordering is not a
  // comparison anybody should be doing here.
  test('a bundle ahead of the repo is a drift too', () => {
    expect(bundleDrift('2.2.220', '2.2.215')).toEqual({ bundle: '2.2.220', repo: '2.2.215' });
  });

  test('a missing fact is not a drift', () => {
    expect(bundleDrift('', '2.2.215')).toBeNull();
    expect(bundleDrift('2.2.215', '')).toBeNull();
    expect(bundleDrift(undefined, undefined)).toBeNull();
  });

  // `0.0.0` is the server saying it could not read a version, not a version.
  test('the shrug version is not a drift', () => {
    expect(bundleDrift('2.2.215', '0.0.0')).toBeNull();
    expect(bundleDrift('0.0.0', '2.2.215')).toBeNull();
  });

  test('under the dev server the frozen define is not staleness', () => {
    expect(bundleDrift('2.2.211', '2.2.215', { hmr: true })).toBeNull();
  });

  test('whitespace around a number does not invent a drift', () => {
    expect(bundleDrift(' 2.2.215 ', '2.2.215')).toBeNull();
  });
});
