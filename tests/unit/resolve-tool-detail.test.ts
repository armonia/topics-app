/**
 * Unit tests for client-side `resolveToolDetail` — the renderer entry point
 * that decides whether to use the server-emitted `tc.detail` payload or
 * fall back to `deriveToolDetail(name, args, result)`.
 *
 * Covers the v3 foundations NORM-01 wire-in: server detail is validated
 * via Zod, and malformed payloads gracefully degrade to client derivation
 * instead of crashing or rendering broken UI.
 *
 * Run with: `bun test tests/unit/resolve-tool-detail.test.ts`
 *
 * @covers TOOL-PARITY-01
 */
import { describe, expect, test } from 'bun:test';
import { resolveToolDetail } from '../../client/src/components/Chat/toolDetail';
import type { ToolCall } from '../../client/src/types';

describe('resolveToolDetail — server-emitted detail path', () => {
  test('passes through a valid server detail unchanged', () => {
    const tc: ToolCall = {
      id: 'tc-1',
      name: 'Bash',
      args: { command: 'ls' },
      detail: { type: 'shell', command: 'ls', exitCode: 0 },
    };
    const detail = resolveToolDetail(tc);
    expect(detail).toEqual({ type: 'shell', command: 'ls', exitCode: 0 });
  });

  test('passes through a valid sub_agent detail with actions', () => {
    const tc: ToolCall = {
      id: 'tc-2',
      name: 'Task',
      args: {},
      detail: {
        type: 'sub_agent',
        subAgentType: 'researcher',
        actions: [{ index: 0, toolName: 'Bash', status: 'running' }],
      },
    };
    const detail = resolveToolDetail(tc);
    expect(detail.type).toBe('sub_agent');
    if (detail.type === 'sub_agent') {
      expect(detail.actions).toHaveLength(1);
    }
  });
});

describe('resolveToolDetail — graceful degradation on schema drift', () => {
  test('falls back to deriveToolDetail when server detail has wrong shape', () => {
    // Server somehow emits a malformed shell detail (e.g., wrong type on exitCode)
    const tc: ToolCall = {
      id: 'tc-3',
      name: 'Bash',
      args: { command: 'ls' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detail: { type: 'shell', command: 'ls', exitCode: 'oops' as any },
    };
    const detail = resolveToolDetail(tc);
    // Validation rejects → falls back to client-side derivation, which
    // produces a shell detail from `args` (no exitCode since args has none).
    expect(detail.type).toBe('shell');
    if (detail.type === 'shell') {
      expect(detail.command).toBe('ls');
      // The malformed exitCode was dropped (client deriver doesn't know it)
      expect(detail.exitCode).toBeUndefined();
    }
  });

  test('falls back when server emits an unknown discriminator', () => {
    const tc: ToolCall = {
      id: 'tc-4',
      name: 'Bash',
      args: { command: 'pwd' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detail: { type: 'nonsense' } as any,
    };
    const detail = resolveToolDetail(tc);
    expect(detail.type).toBe('shell');
    if (detail.type === 'shell') {
      expect(detail.command).toBe('pwd');
    }
  });
});

describe('resolveToolDetail — client derivation when detail absent', () => {
  test('derives shell detail from Bash tool args', () => {
    const tc: ToolCall = {
      id: 'tc-5',
      name: 'Bash',
      args: { command: 'echo hi' },
    };
    const detail = resolveToolDetail(tc);
    expect(detail).toMatchObject({ type: 'shell', command: 'echo hi' });
  });

  test('derives read detail from Read tool args', () => {
    const tc: ToolCall = {
      id: 'tc-6',
      name: 'Read',
      args: { file_path: '/foo.ts' },
    };
    const detail = resolveToolDetail(tc);
    expect(detail).toMatchObject({ type: 'read', filePath: '/foo.ts' });
  });

  test('produces unknown variant for unrecognized tool name', () => {
    const tc: ToolCall = {
      id: 'tc-7',
      name: 'SomeUnknownTool',
      args: { x: 1 },
      result: 'ok',
    };
    const detail = resolveToolDetail(tc);
    expect(detail.type).toBe('unknown');
  });
});
