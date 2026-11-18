import { describe, expect, test } from 'bun:test';
import { detectResultLang } from './syntaxHighlight';

describe('detectResultLang', () => {
  test('json document', () => expect(detectResultLang('{"a": [1, 2]}')).toBe('json'));
  test('broken json stays plain', () => expect(detectResultLang('{"a": ')).toBe(''));
  test('unified diff', () => expect(detectResultLang('diff --git a/x b/x\n--- a/x')).toBe('diff'));
  test('plain log', () => expect(detectResultLang('[info] started')).toBe(''));
});
