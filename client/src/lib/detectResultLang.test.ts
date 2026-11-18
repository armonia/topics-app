import { describe, expect, test } from 'bun:test';
import { sniffResultLang } from './syntaxHighlight';

describe('sniffResultLang', () => {
  test('json document', () => expect(sniffResultLang('{"a": [1, 2]}')).toBe('json'));
  test('broken json stays plain', () => expect(sniffResultLang('{"a": ')).toBe(''));
  test('unified diff', () => expect(sniffResultLang('diff --git a/x b/x\n--- a/x')).toBe('diff'));
  test('plain log', () => expect(sniffResultLang('[info] started')).toBe(''));
});
