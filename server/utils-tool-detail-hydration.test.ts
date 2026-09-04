/**
 * DB hydration of `toolCall.detail` (NORM-01 boundary, `sanitizeToolCallDetail`).
 *
 * The shapes below are the ones the production error log counted as dropped
 * over a single file: 2736 `ask_user_question`, 835 `list_agents`, 82
 * `ToolSearch`. They were not exotic -- the deriver on both sides builds them
 * and the renderer draws them; only the shared Zod schema had never learned
 * them, so hydration threw the detail away and the question the agent asked
 * reached the chat with no text and no options.
 *
 * Card 34f799e4.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeToolCallDetail } from './utils';
import { deriveToolDetail } from './providers/claude/tool-detail';

describe('sanitizeToolCallDetail — the three names from the log', () => {
  test('ask_user keeps question text and options through hydration', () => {
    // Same shape the CLI emits for AskUserQuestion: options are objects with a
    // label, which the deriver flattens to strings.
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
    const tc = { id: 'toolu_1', name: 'ask_user_question', detail };

    const out = sanitizeToolCallDetail(tc);

    expect(out.detail).toBeDefined();
    expect(out.detail.type).toBe('ask_user');
    expect(out.detail.questions[0].question).toBe('Which route do we take for the fix?');
    expect(out.detail.questions[0].header).toBe('Route');
    expect(out.detail.questions[0].options).toEqual(['Schema', 'Renderer']);
  });

  test('list_agents survives as agent_control', () => {
    const tc = {
      id: 'toolu_2',
      name: 'list_agents',
      detail: deriveToolDetail('list_agents', {}, '2 agents running'),
    };
    const out = sanitizeToolCallDetail(tc);
    expect(out.detail).toEqual({ type: 'agent_control', op: 'list', result: '2 agents running' });
  });

  test('ToolSearch survives as a search row', () => {
    const tc = {
      id: 'toolu_3',
      name: 'ToolSearch',
      detail: deriveToolDetail('ToolSearch', { query: 'browser' }, 'browser_act, browser_observe'),
    };
    const out = sanitizeToolCallDetail(tc);
    expect(out.detail.type).toBe('search');
    expect(out.detail.toolName).toBe('tool_search');
    expect(out.detail.query).toBe('browser');
  });
});

describe('sanitizeToolCallDetail — the two failure modes', () => {
  test('a type the schema never heard of degrades instead of vanishing', () => {
    const detail = { type: 'teleport_user', destination: 'Mars', result: 'arrived' };
    const out = sanitizeToolCallDetail({ id: 'toolu_4', name: 'Teleport', detail });

    expect(out.detail).toEqual({ type: 'unknown', raw: { args: detail } });
  });

  test('a known type with a broken shape is still dropped, so the client re-derives', () => {
    // `shell` without `command`: the row is corrupt, and a generic JSON card
    // would be worse than the card the renderer builds back from `args`.
    const out = sanitizeToolCallDetail({
      id: 'toolu_5',
      name: 'Bash',
      args: { command: 'ls' },
      detail: { type: 'shell', exitCode: 0 },
    });

    expect(out.detail).toBeUndefined();
    expect(out.args).toEqual({ command: 'ls' });
  });

  test('a tool call with no detail is returned untouched', () => {
    const tc = { id: 'toolu_6', name: 'Bash', args: { command: 'ls' } };
    expect(sanitizeToolCallDetail(tc)).toBe(tc);
  });
});
