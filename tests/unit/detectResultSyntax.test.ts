/**
 * A tool result has no file extension, so its language is read from the content:
 * valid JSON or a git diff gets highlighted, anything else (or anything oversized)
 * stays plain text.
 *
 * @covers CHAT-TOOL-04
 */
import { describe, expect, test } from 'bun:test';
import { detectResultSyntax } from '../../client/src/lib/syntaxHighlight';

describe('detectResultSyntax', () => {
  test('valid JSON object and array', () => {
    expect(detectResultSyntax('{"a": 1}')).toBe('json');
    expect(detectResultSyntax('  [1, 2]')).toBe('json');
  });
  test('broken JSON stays plain', () => {
    expect(detectResultSyntax('{not json')).toBe('');
    expect(detectResultSyntax('[INFO] started')).toBe('');
  });
  test('unified diff', () => {
    expect(detectResultSyntax('diff --git a/x b/x\n--- a/x\n+++ b/x')).toBe('diff');
    expect(detectResultSyntax('@@ -1,2 +1,2 @@\n-a\n+b')).toBe('diff');
  });
  test('plain text', () => {
    expect(detectResultSyntax('hello world')).toBe('');
  });
});
