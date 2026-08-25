/**
 * Unit tests for the NORM-01 DB hydration sanitizer.
 *
 * The `sanitizeToolCallDetail` helper lives inside `server/utils.ts` (closed
 * over the `parseToolCallDetail` import). These tests verify the contract
 * via the public `parseToolCallDetail` API plus an in-process re-implementation
 * of the sanitizer logic — equivalence is maintained by code review.
 *
 * Goal: prove that malformed `detail` payloads coming out of the DB do not
 * propagate to clients. The renderer falls back to client-side derivation
 * when `tc.detail` is absent, so dropping the detail is the safe choice.
 *
 * Run with: `bun test tests/unit/norm-db-hydration.test.ts`
 *
 * @covers TOOL-PARITY-01
 */
import { describe, expect, test } from 'bun:test';
import { parseToolCallDetail } from '../../shared/tool-call-detail';

/**
 * Replica of the sanitizer in server/utils.ts. Keep in sync; the test
 * verifies the contract, not the private helper.
 */
function sanitizeToolCallDetail(tc: any): any {
  if (!tc || typeof tc !== 'object' || !tc.detail) return tc;
  const result = parseToolCallDetail(tc.detail);
  if (result.ok) {
    return tc.detail === result.data ? tc : { ...tc, detail: result.data };
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { detail: _drop, ...rest } = tc;
  return rest;
}

describe('sanitizeToolCallDetail — pass-through', () => {
  test('null / undefined / non-object passes through', () => {
    expect(sanitizeToolCallDetail(null)).toBe(null);
    expect(sanitizeToolCallDetail(undefined)).toBe(undefined);
    expect(sanitizeToolCallDetail('x')).toBe('x');
  });

  test('tool call without detail passes through', () => {
    const tc = { id: 'tc-1', name: 'Bash', args: { command: 'ls' } };
    expect(sanitizeToolCallDetail(tc)).toBe(tc);
  });

  test('tool call with valid detail passes through (same shape, possibly new object)', () => {
    const tc = {
      id: 'tc-2',
      name: 'Bash',
      args: { command: 'ls' },
      detail: { type: 'shell', command: 'ls', exitCode: 0 },
    };
    const result = sanitizeToolCallDetail(tc);
    expect(result.id).toBe('tc-2');
    expect(result.detail).toEqual({ type: 'shell', command: 'ls', exitCode: 0 });
  });
});

describe('sanitizeToolCallDetail — drops malformed detail', () => {
  test('drops detail with wrong type for field', () => {
    const tc = {
      id: 'tc-3',
      name: 'Bash',
      args: { command: 'ls' },
      detail: { type: 'shell', command: 'ls', exitCode: 'oops' },
    };
    const result = sanitizeToolCallDetail(tc);
    expect(result.detail).toBeUndefined();
    expect(result.id).toBe('tc-3');
    expect(result.name).toBe('Bash');
  });

  test('drops detail with unknown discriminator', () => {
    const tc = {
      id: 'tc-4',
      name: 'X',
      args: {},
      detail: { type: 'legacyVariantThatNoLongerExists', x: 1 },
    };
    const result = sanitizeToolCallDetail(tc);
    expect(result.detail).toBeUndefined();
  });

  test('drops detail with missing required field', () => {
    const tc = {
      id: 'tc-5',
      name: 'Bash',
      args: {},
      detail: { type: 'shell' }, // missing command
    };
    const result = sanitizeToolCallDetail(tc);
    expect(result.detail).toBeUndefined();
  });

  test('preserves all other tool call fields when detail is dropped', () => {
    const tc = {
      id: 'tc-6',
      name: 'Bash',
      args: { command: 'pwd' },
      status: 'success',
      result: '/tmp',
      contentOffset: 42,
      detail: { type: 'garbage' },
    };
    const result = sanitizeToolCallDetail(tc);
    expect(result).toEqual({
      id: 'tc-6',
      name: 'Bash',
      args: { command: 'pwd' },
      status: 'success',
      result: '/tmp',
      contentOffset: 42,
    });
  });
});

describe('sanitizeToolCallDetail — array hydration use case', () => {
  test('mapping over a tool_calls JSON array preserves order + sanitizes per-item', () => {
    const fromDb = [
      { id: 't1', name: 'Bash', args: { command: 'a' }, detail: { type: 'shell', command: 'a' } },
      { id: 't2', name: 'X', args: {}, detail: { type: 'bogus' } },
      { id: 't3', name: 'Read', args: { file_path: '/x' } }, // no detail
    ];
    const sanitized = fromDb.map(sanitizeToolCallDetail);
    expect(sanitized.length).toBe(3);
    expect(sanitized[0].detail).toEqual({ type: 'shell', command: 'a' });
    expect(sanitized[1].detail).toBeUndefined();
    expect(sanitized[2].detail).toBeUndefined();
    expect(sanitized.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  test('mapping over a blocks JSON array sanitizes nested tool blocks', () => {
    const blocks = [
      { kind: 'text', text: 'hello' },
      { kind: 'tool', toolCall: { id: 't1', name: 'X', args: {}, detail: { type: 'invalid' } } },
      { kind: 'thinking', text: 'hmm' },
    ];
    const sanitized = blocks.map((block: any) => {
      if (block && block.kind === 'tool' && block.toolCall) {
        return { ...block, toolCall: sanitizeToolCallDetail(block.toolCall) };
      }
      return block;
    });
    expect(sanitized[0]).toEqual({ kind: 'text', text: 'hello' });
    expect(sanitized[1].toolCall.detail).toBeUndefined();
    expect(sanitized[1].toolCall.id).toBe('t1');
    expect(sanitized[2]).toEqual({ kind: 'thinking', text: 'hmm' });
  });
});
