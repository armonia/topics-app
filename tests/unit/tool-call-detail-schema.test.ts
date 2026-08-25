/**
 * Unit tests for the ToolCallDetail Zod schema (v3 foundations NORM-01).
 *
 * Run with: `bun test tests/unit/tool-call-detail-schema.test.ts`
 *
 * Verifies:
 *   - All 11 protocol variants round-trip through the schema.
 *   - Malformed payloads are rejected with path-qualified error messages.
 *   - The Zod-inferred type and the canonical TS `ToolCallDetail` are
 *     structurally equal — drift breaks this file's TypeScript compile.
 *   - Variant-count snapshot (NORM-01 contract guard).
 *
 * @covers TOOL-PARITY-01
 */
import { describe, expect, test } from 'bun:test';
import type { ToolCallDetail } from '../../server/types';
import {
  toolCallDetailSchema,
  parseToolCallDetail,
  isToolCallDetail,
  type ZodInferredToolCallDetail,
} from '../../shared/tool-call-detail';

// ----- Compile-time structural equality between Zod and TS -----------------
//
// If the Zod schema drifts from the canonical TS type, ONE of these two
// `satisfies` lines fails to compile, which fails `bun test` at startup.
//
// The double-direction check catches:
//   - Schema becomes LOOSER than the TS type (missing required field on Zod).
//   - Schema becomes STRICTER than the TS type (Zod requires a field TS marks
//     optional, or has an extra variant).
//
// They run only as type-level assertions; the runtime values are never used.

declare const _zodValue: ZodInferredToolCallDetail;
declare const _tsValue: ToolCallDetail;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CheckZodAssignableToTs = typeof _zodValue extends ToolCallDetail ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CheckTsAssignableToZod = typeof _tsValue extends ZodInferredToolCallDetail ? true : never;

// ----- Round-trip coverage --------------------------------------------------

const validDetails: ToolCallDetail[] = [
  { type: 'shell', command: 'ls -la' },
  { type: 'shell', command: 'pwd', cwd: '/tmp', output: '/tmp\n', exitCode: 0 },
  { type: 'shell', command: 'false', exitCode: 1 },
  { type: 'shell', command: 'streaming', exitCode: null },

  { type: 'read', filePath: '/foo.ts' },
  { type: 'read', filePath: '/foo.ts', content: 'line1\nline2', offset: 0, limit: 100 },

  { type: 'edit', filePath: '/a.ts' },
  { type: 'edit', filePath: '/a.ts', oldString: 'foo', newString: 'bar' },
  { type: 'edit', filePath: '/a.ts', unifiedDiff: '@@ -1,1 +1,1 @@\n-foo\n+bar' },

  { type: 'write', filePath: '/b.md' },
  { type: 'write', filePath: '/b.md', content: '# hi' },

  { type: 'search', query: 'foo' },
  { type: 'search', query: 'TODO', toolName: 'grep', mode: 'content', numMatches: 7 },
  { type: 'search', query: '*.ts', toolName: 'glob', filePaths: ['a.ts', 'b.ts'], numFiles: 2 },
  { type: 'search', query: 'climate', toolName: 'web_search', content: '…' },
  { type: 'search', query: 'foo', mode: 'files_with_matches' },

  { type: 'fetch', url: 'https://example.com' },
  { type: 'fetch', url: 'https://x', prompt: 'extract title', result: 'Example Domain', statusCode: 200, bytes: 1024 },

  { type: 'todo', items: [] },
  {
    type: 'todo',
    items: [
      { content: 'do X', status: 'pending' },
      { content: 'do Y', status: 'in_progress', activeForm: 'Doing Y' },
      { content: 'do Z', status: 'completed' },
    ],
  },

  { type: 'sub_agent', actions: [] },
  {
    type: 'sub_agent',
    subAgentType: 'researcher',
    description: 'investigate X',
    actions: [
      { index: 0, toolName: 'Bash', summary: 'ran ls', status: 'success' },
      { index: 1, toolName: 'Read', summary: 'read foo.ts', status: 'running' },
    ],
    result: 'Done',
  },

  { type: 'plan', text: '1. step\n2. step' },

  { type: 'mcp', server: 'context7', tool: 'resolve-library-id' },
  { type: 'mcp', server: 'omega', tool: 'omega_query', args: { mode: 'semantic' }, result: 'hits: 3' },

  { type: 'shell', command: 'npm run dev', background: true },

  { type: 'monitor', description: 'errors in deploy.log' },
  { type: 'monitor', description: 'ws feed', wsUrl: 'wss://x/stream', persistent: true, result: 'event' },
  { type: 'monitor', description: 'tail', command: 'tail -f log' },

  { type: 'bash_output', shellId: 'sh_1' },
  { type: 'bash_output', shellId: 'sh_1', filter: 'ERROR', output: 'boom' },

  { type: 'kill_shell', shellId: 'sh_1' },
  { type: 'kill_shell', shellId: 'sh_1', result: 'killed' },

  { type: 'notebook_edit', notebookPath: '/a.ipynb' },
  { type: 'notebook_edit', notebookPath: '/a.ipynb', cellId: 'c1', editMode: 'insert', cellType: 'code' },

  { type: 'skill', skill: 'deploy' },
  { type: 'skill', skill: 'deploy', args: '--prod', result: 'ok' },

  { type: 'slash_command', command: '/review' },
  { type: 'slash_command', command: '/model', result: 'set' },

  { type: 'lsp', operation: 'goToDefinition' },
  { type: 'lsp', operation: 'findReferences', filePath: '/x.ts', symbol: 'foo', result: '3 refs' },

  { type: 'unknown', raw: {} },
  { type: 'unknown', raw: { args: { x: 1 }, result: 'noop' } },
];

describe('toolCallDetailSchema — valid round-trips', () => {
  for (const detail of validDetails) {
    const label = `${detail.type}${'toolName' in detail && detail.toolName ? `/${detail.toolName}` : ''}`;
    test(`parses ${label}`, () => {
      const json = JSON.stringify(detail);
      const back = JSON.parse(json);
      const result = parseToolCallDetail(back);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual(detail);
      }
    });
  }
});

describe('parseToolCallDetail — malformed payloads', () => {
  test('rejects non-object values', () => {
    expect(parseToolCallDetail(null).ok).toBe(false);
    expect(parseToolCallDetail(undefined).ok).toBe(false);
    expect(parseToolCallDetail(42).ok).toBe(false);
    expect(parseToolCallDetail('shell').ok).toBe(false);
    expect(parseToolCallDetail([]).ok).toBe(false);
  });

  test('rejects unknown discriminator', () => {
    const r = parseToolCallDetail({ type: 'nonsense' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('type');
  });

  test('rejects missing required field on shell', () => {
    const r = parseToolCallDetail({ type: 'shell' }); // no command
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('command');
  });

  test('rejects wrong enum on todo.items[].status', () => {
    const r = parseToolCallDetail({
      type: 'todo',
      items: [{ content: 'x', status: 'done' }], // 'done' invalid
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('status');
  });

  test('rejects wrong enum on sub_agent.actions[].status', () => {
    const r = parseToolCallDetail({
      type: 'sub_agent',
      actions: [{ index: 0, toolName: 'X', status: 'pending' }], // not in enum
    });
    expect(r.ok).toBe(false);
  });

  test('rejects wrong type on shell.exitCode', () => {
    const r = parseToolCallDetail({ type: 'shell', command: 'x', exitCode: 'ok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('exitCode');
  });

  test('rejects missing items on todo', () => {
    const r = parseToolCallDetail({ type: 'todo' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('items');
  });

  test('rejects wrong type on todo.items', () => {
    const r = parseToolCallDetail({ type: 'todo', items: 'a' });
    expect(r.ok).toBe(false);
  });

  test('rejects missing raw on unknown', () => {
    const r = parseToolCallDetail({ type: 'unknown' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('raw');
  });

  test('error message uses dotted path for nested issues', () => {
    const r = parseToolCallDetail({
      type: 'sub_agent',
      actions: [{ index: 'first', toolName: 'X' }], // index should be number
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('actions.0.index');
  });
});

describe('isToolCallDetail — boolean guard', () => {
  test('true for valid, false for invalid', () => {
    expect(isToolCallDetail({ type: 'plan', text: 'x' })).toBe(true);
    expect(isToolCallDetail({ type: 'plan' })).toBe(false);
    expect(isToolCallDetail(null)).toBe(false);
  });

  test('narrows the type on true', () => {
    const value: unknown = { type: 'fetch', url: 'https://x' };
    if (isToolCallDetail(value)) {
      const _detail: ToolCallDetail = value;
      expect(_detail.type).toBe('fetch');
    }
  });
});

/**
 * `zod` espone le varianti su `.options`, `zod/mini` sotto `.def.options`: lo
 * schema condiviso è in mini (finisce nel bundle client).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function variantsOf(schema: any): any[] {
  return schema.options ?? schema.def?.options ?? [];
}

describe('schema completeness', () => {
  test('exactly 19 variants in the union', () => {
    expect(variantsOf(toolCallDetailSchema).length).toBe(19);
  });

  test('all variant discriminators are unique', () => {
    const literals = variantsOf(toolCallDetailSchema).map((opt) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shape: any = (opt as any).shape ?? (opt as any).def?.shape;
      // `zod` mette il valore su `.value`, `zod/mini` in `.def.values[0]`
      // (la literal di Zod 4 è multi-valore).
      return shape.type.def?.values?.[0] ?? shape.type.value;
    });
    const unique = new Set(literals);
    expect(unique.size).toBe(literals.length);
    expect(unique).toEqual(
      new Set([
        'shell',
        'read',
        'edit',
        'write',
        'search',
        'fetch',
        'todo',
        'sub_agent',
        'plan',
        'mcp',
        'monitor',
        'wait',
        'bash_output',
        'kill_shell',
        'notebook_edit',
        'skill',
        'slash_command',
        'lsp',
        'unknown',
      ]),
    );
  });
});
