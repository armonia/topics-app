/**
 * Unit tests for the NORM-01 DB hydration sanitizer.
 *
 * These used to run against a REPLICA of `sanitizeToolCallDetail` copied into
 * this file, with a comment saying "keep in sync; equivalence is maintained by
 * code review". It was not: the copy tested a contract nobody was running,
 * while the real one silently threw away every detail whose type the shared
 * schema had not learned yet -- 3653 of them in one production log file, 2736
 * of which were the question an agent puts to the human. The function is
 * exported now and this file drives THAT one.
 *
 * Run with: `bun test tests/unit/norm-db-hydration.test.ts`
 *
 * @covers TOOL-PARITY-01
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeToolCallDetail } from '../../server/utils';
import { deriveToolDetail } from '../../server/providers/claude/tool-detail';

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

/**
 * The three tool names the production log counted as dropped, in the shape the
 * provider boundary really builds for them.
 */
describe('sanitizeToolCallDetail — the three names from the log', () => {
  test('ask_user keeps question text and options through hydration', () => {
    // Same shape the CLI emits for AskUserQuestion: the options are objects
    // with a label, which the deriver flattens to strings.
    const detail = deriveToolDetail('AskUserQuestion', {
      questions: [
        {
          question: 'Which route do we take for the fix?',
          header: 'Route',
          multiSelect: false,
          options: [
            { label: 'Schema', description: 'Add the variants to the shared schema' },
            { label: 'Renderer', description: 'Patch the renderer only' },
          ],
        },
      ],
    });

    const out = sanitizeToolCallDetail({ id: 'toolu_1', name: 'ask_user_question', detail });

    expect(out.detail).toBeDefined();
    expect(out.detail.type).toBe('ask_user');
    expect(out.detail.questions[0].question).toBe('Which route do we take for the fix?');
    expect(out.detail.questions[0].header).toBe('Route');
    expect(out.detail.questions[0].options).toEqual(['Schema', 'Renderer']);
  });

  test('list_agents survives as agent_control', () => {
    const out = sanitizeToolCallDetail({
      id: 'toolu_2',
      name: 'list_agents',
      detail: deriveToolDetail('list_agents', {}, '2 agents running'),
    });
    expect(out.detail).toEqual({ type: 'agent_control', op: 'list', result: '2 agents running' });
  });

  test('ToolSearch survives as a search row', () => {
    const out = sanitizeToolCallDetail({
      id: 'toolu_3',
      name: 'ToolSearch',
      detail: deriveToolDetail('ToolSearch', { query: 'browser' }, 'browser_act, browser_observe'),
    });
    expect(out.detail.type).toBe('search');
    expect(out.detail.toolName).toBe('tool_search');
    expect(out.detail.query).toBe('browser');
  });
});

describe('sanitizeToolCallDetail — a type the schema never heard of degrades', () => {
  test('an unknown discriminator keeps the payload as raw', () => {
    const detail = { type: 'teleport_user', destination: 'Mars', result: 'arrived' };
    const out = sanitizeToolCallDetail({ id: 'tc-4', name: 'Teleport', args: {}, detail });

    expect(out.detail).toEqual({ type: 'unknown', raw: { args: detail } });
  });

  test('every other field of the tool call is left alone', () => {
    const out = sanitizeToolCallDetail({
      id: 'tc-6',
      name: 'X',
      args: { a: 1 },
      status: 'success',
      contentOffset: 42,
      detail: { type: 'garbage' },
    });

    expect(out.id).toBe('tc-6');
    expect(out.args).toEqual({ a: 1 });
    expect(out.status).toBe('success');
    expect(out.contentOffset).toBe(42);
    expect(out.detail.type).toBe('unknown');
  });
});

describe('sanitizeToolCallDetail — a known type with a broken shape is dropped', () => {
  // Here the renderer rebuilds a real card from `args`, which beats showing
  // the broken object as a JSON blob.
  test('drops detail with wrong type for field', () => {
    const result = sanitizeToolCallDetail({
      id: 'tc-3',
      name: 'Bash',
      args: { command: 'ls' },
      detail: { type: 'shell', command: 'ls', exitCode: 'oops' },
    });
    expect(result.detail).toBeUndefined();
    expect(result.id).toBe('tc-3');
    expect(result.name).toBe('Bash');
  });

  test('drops detail with missing required field', () => {
    const result = sanitizeToolCallDetail({
      id: 'tc-5',
      name: 'Bash',
      args: {},
      detail: { type: 'shell' }, // missing command
    });
    expect(result.detail).toBeUndefined();
  });

  test('preserves all other tool call fields when detail is dropped', () => {
    const result = sanitizeToolCallDetail({
      id: 'tc-6',
      name: 'Bash',
      args: { command: 'pwd' },
      status: 'success',
      result: '/tmp',
      contentOffset: 42,
      detail: { type: 'read' }, // known type, no filePath
    });
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
      { id: 't2', name: 'X', args: {}, detail: { type: 'shell' } }, // broken shell
      { id: 't3', name: 'Read', args: { file_path: '/x' } }, // no detail
      { id: 't4', name: 'Y', args: {}, detail: { type: 'bogus', keep: 'me' } }, // new kind
    ];
    const sanitized = fromDb.map(sanitizeToolCallDetail);
    expect(sanitized.length).toBe(4);
    expect(sanitized[0].detail).toEqual({ type: 'shell', command: 'a' });
    expect(sanitized[1].detail).toBeUndefined();
    expect(sanitized[2].detail).toBeUndefined();
    expect(sanitized[3].detail).toEqual({ type: 'unknown', raw: { args: { type: 'bogus', keep: 'me' } } });
    expect(sanitized.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
  });

  test('mapping over a blocks JSON array sanitizes nested tool blocks', () => {
    const blocks = [
      { kind: 'text', text: 'hello' },
      { kind: 'tool', toolCall: { id: 't1', name: 'X', args: {}, detail: { type: 'todo' } } },
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
