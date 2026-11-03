import { describe, expect, test } from 'bun:test';
import { isSystemNote, progressLine } from './progressLine';

describe('progressLine', () => {
  test('takes the first non-empty line, as plain text', () => {
    expect(progressLine('\n\n**Fatto** il parser\npoi il resto')).toBe('Fatto il parser');
  });

  test('empty word gives an empty line', () => {
    expect(progressLine('')).toBe('');
  });
});

describe('isSystemNote', () => {
  test('machine authors are system notes, the user and the agent are not', () => {
    expect(isSystemNote('system')).toBe(true);
    expect(isSystemNote('dispatcher')).toBe(true);
    expect(isSystemNote('user')).toBe(false);
    expect(isSystemNote('agent:3188d440')).toBe(false);
    expect(isSystemNote(null)).toBe(false);
  });
});
