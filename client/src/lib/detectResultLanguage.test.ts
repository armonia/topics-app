/**
 * @covers CHAT-TOOL-04
 */
import { describe, expect, test } from 'bun:test';
import { detectResultLanguage } from './syntaxHighlight';

describe('detectResultLanguage', () => {
  test('json document', () => expect(detectResultLanguage('{"a": [1, 2]}')).toBe('json'));
  test('broken json stays plain', () => expect(detectResultLanguage('{"a": ')).toBe(''));
  test('unified diff', () => expect(detectResultLanguage('diff --git a/x b/x\n--- a/x')).toBe('diff'));
  test('plain log', () => expect(detectResultLanguage('[info] started')).toBe(''));
});
