/** @covers MSEL-02 */
import { describe, expect, test } from 'bun:test';
import { compareVersions, familyVersion, mergeKey } from './modelMergeKey';

describe('mergeKey: one row per model, whatever engine serves it (revision §3.3, AC-03)', () => {
  test.each([
    ['gpt-oss:20b', 'openai/gpt-oss-20b'],
    ['google/gemini-2.5-pro', 'gemini-2.5-pro'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-code:claude-opus-5-5', 'claude-opus-5-5'],
    ['llama3.3:latest', 'llama3-3'],
  ] as const)('%s ≡ %s', (a, b) => {
    expect(mergeKey(a)).toBe(mergeKey(b));
  });

  test('conservative: qwen3-coder:30b and the instruct build stay two rows', () => {
    expect(mergeKey('qwen3-coder:30b')).not.toBe(mergeKey('qwen/qwen3-coder-30b-a3b-instruct'));
  });

  test('the key of gpt-oss is gpt-oss-20b', () => {
    expect(mergeKey('gpt-oss:20b')).toBe('gpt-oss-20b');
  });
});

describe('familyVersion: the generation rule of the ids nobody declares (revision §3.4)', () => {
  test('the family is the key without its first run of numbers', () => {
    expect(familyVersion('claude-opus-4-8')).toEqual({ family: 'claude-opus', version: [4, 8] });
    expect(familyVersion('gemini-2-5-pro')).toEqual({ family: 'gemini-pro', version: [2, 5] });
    expect(familyVersion('o4-mini')).toEqual({ family: 'o4-mini', version: null });
  });

  test('a dated id compares on its version, not on its date', () => {
    expect(familyVersion('claude-sonnet-4-20250514')).toEqual({ family: 'claude-sonnet', version: [4] });
  });

  test('versions compare number by number', () => {
    expect(compareVersions([5, 1], [5])).toBeGreaterThan(0);
    expect(compareVersions([4, 8], [5])).toBeLessThan(0);
    expect(compareVersions([2, 5], [2, 5])).toBe(0);
  });
});
