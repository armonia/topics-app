/**
 * @covers PATHUTIL-01
 */
import { describe, expect, test } from 'bun:test';
import { basename } from './path-utils';

describe('basename', () => {
  test('returns the last segment of an absolute path', () => {
    expect(basename('/Users/a/foo.txt')).toBe('foo.txt');
  });

  test('returns the input unchanged when there is no separator', () => {
    expect(basename('foo.txt')).toBe('foo.txt');
  });

  test('handles trailing slashes by returning the parent dir name', () => {
    expect(basename('/Users/a/')).toBe('a');
    expect(basename('/Users/a///')).toBe('a');
  });

  test('returns empty string for empty input', () => {
    expect(basename('')).toBe('');
  });

  test('handles root path', () => {
    // After stripping trailing slashes "/" → "" which has no /, so we
    // return the trimmed string. Acceptable — root has no useful display
    // name anyway.
    expect(basename('/')).toBe('');
  });

  test('handles a path with only the leading slash', () => {
    expect(basename('/foo')).toBe('foo');
  });
});
