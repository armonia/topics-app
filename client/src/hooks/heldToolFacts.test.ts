/**
 * A QUESTION THAT REACHES THE WINDOW BEFORE ITS ROW STILL OPENS THE FORM.
 *
 * The window that sent the message builds its rows from its own SSE and takes
 * the question (`stream:tool_user_input_required`) from WS. Measured on 04/10
 * in `chat-native-tool-phases.spec.ts`, sender timeline of a failing run: the
 * WS question landed while WebKit still held the SSE burst that announces the
 * row, so it found no row and was dropped; the burst then gave birth to the row
 * as `pending` and `running`, and the SSE copy of the question stayed held for
 * good (it was the last byte before the turn paused). The row spun with no form.
 *
 * Here the reducers `useChat` uses are fed every arrival order of the frames
 * one question produces in that window: the four SSE announcements of the row
 * (`pending`, `pending`, `running`, `waiting_for_input` with the form) and the
 * WS question, in any order and with any of them held back.
 *
 * @covers CHAT-NTOOL-05
 */
import { describe, expect, test } from 'bun:test';
import type { ChatMessage, ToolCall } from '../types';
import { toolCallFromSse, type SseToolCallDelta } from './sseToolFrames';
import {
  HeldToolFacts,
  patchToolCallInMessages,
  patchToolCallOrHold,
  withAnnouncedToolCall,
  withPermissionAsked,
  withQuestionAsked,
} from './heldToolFacts';

const SK = 'topic:askq';
const ID = 'toolu_ask';
const SCHEMA = { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'One' }, { label: 'Two' }], multiSelect: false }] } as unknown as ToolCall['userInputSchema'];

type Frame =
  | { via: 'sse'; name: string; delta: SseToolCallDelta }
  | { via: 'ws'; name: string; fact: 'question' };

const fn = { name: 'ask_user_question', arguments: '{}' };
const FRAMES: Frame[] = [
  { via: 'sse', name: 'S1 pending', delta: { id: ID, function: fn, status: 'pending' } },
  { via: 'sse', name: 'S2 pending', delta: { id: ID, function: fn, status: 'pending', inputStreaming: false } },
  { via: 'sse', name: 'S3 running', delta: { id: ID, function: fn, status: 'running', startedAt: 1000 } },
  { via: 'sse', name: 'S4 waiting', delta: { id: ID, function: fn, status: 'waiting_for_input', startedAt: 1000, userInputSchema: SCHEMA } },
  { via: 'ws', name: 'WS question', fact: 'question' },
];

function openTurn(): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'SCEN:askq go', timestamp: 't' },
    { id: 'a1', role: 'assistant', content: '', timestamp: 't', partial: true, toolCalls: [], blocks: [] },
  ];
}

/** What `useChat` does with each frame in the sender window. */
function apply(msgs: ChatMessage[], held: HeldToolFacts, frame: Frame): ChatMessage[] {
  if (frame.via === 'ws') return patchToolCallOrHold(msgs, held, SK, ID, withQuestionAsked(SCHEMA));
  const announced = toolCallFromSse(frame.delta, () => 'generated')!;
  const out = msgs.slice();
  out[out.length - 1] = withAnnouncedToolCall(out[out.length - 1]!, announced, held, SK);
  return out;
}

function row(msgs: ChatMessage[]): { inCalls?: ToolCall; inBlocks?: ToolCall } {
  const last = msgs[msgs.length - 1]!;
  return {
    inCalls: last.toolCalls?.find((t) => t.id === ID),
    inBlocks: last.blocks?.flatMap((b) => (b.kind === 'tool' && b.toolCall.id === ID ? [b.toolCall] : []))[0],
  };
}

/** Every ordering of every subset: a frame left out is one WebKit held back. */
function* arrivals(frames: Frame[]): Generator<Frame[]> {
  const n = frames.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset = frames.filter((_, i) => mask & (1 << i));
    yield* permutations(subset);
  }
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i]!, ...p];
  }
}

describe('a question asked before its row exists (sender window)', () => {
  test('the order measured on 04/10: WS question first, then the held burst without the SSE question', () => {
    const held = new HeldToolFacts();
    let msgs = openTurn();
    for (const name of ['WS question', 'S1 pending', 'S2 pending', 'S3 running']) {
      msgs = apply(msgs, held, FRAMES.find((f) => f.name === name)!);
    }
    const { inCalls, inBlocks } = row(msgs);
    expect(inCalls?.status).toBe('waiting_for_input');
    expect(inCalls?.userInputSchema).toEqual(SCHEMA);
    // `startedAt` from the `running` announcement is still taken.
    expect(inCalls?.startedAt).toBe(1000);
    expect(inBlocks).toBe(inCalls);
  });

  test('every arrival order of every subset: the form is there whenever the row is and the question arrived', () => {
    let checked = 0;
    for (const order of arrivals(FRAMES)) {
      const held = new HeldToolFacts();
      let msgs = openTurn();
      for (const f of order) msgs = apply(msgs, held, f);
      const { inCalls, inBlocks } = row(msgs);
      const label = order.map((f) => f.name).join(' > ');
      const rowBorn = order.some((f) => f.via === 'sse');
      const asked = order.some((f) => f.via === 'ws' || f.name === 'S4 waiting');
      if (!rowBorn) {
        expect(inCalls, label).toBeUndefined();
      } else if (asked) {
        expect({ label, status: inCalls?.status, schema: inCalls?.userInputSchema })
          .toEqual({ label, status: 'waiting_for_input', schema: SCHEMA });
        expect(inBlocks, label).toBe(inCalls);
      } else {
        expect(inCalls?.status, label).not.toBe('waiting_for_input');
      }
      checked++;
    }
    // 5 frames: sum over k of C(5,k)·k! = 325 orders.
    expect(checked).toBe(325);
  });

  test('the row is born once: no duplicate however the frames arrive', () => {
    for (const order of arrivals(FRAMES)) {
      const held = new HeldToolFacts();
      let msgs = openTurn();
      for (const f of order) msgs = apply(msgs, held, f);
      const last = msgs[msgs.length - 1]!;
      const n = order.some((f) => f.via === 'sse') ? 1 : 0;
      expect(last.toolCalls!.filter((t) => t.id === ID)).toHaveLength(n);
      expect(last.blocks!.filter((b) => b.kind === 'tool')).toHaveLength(n);
    }
  });
});

describe('HeldToolFacts', () => {
  test('a fact is applied once, at birth, and is gone afterwards', () => {
    const held = new HeldToolFacts();
    held.hold(SK, ID, withQuestionAsked(SCHEMA));
    const born = held.bear(SK, { id: ID, name: 'ask_user_question', args: {}, status: 'pending' });
    expect(born.status).toBe('waiting_for_input');
    const again = held.bear(SK, { id: ID, name: 'ask_user_question', args: {}, status: 'pending' });
    expect(again.status).toBe('pending');
  });

  test('facts are per session: another session with the same id is born untouched', () => {
    const held = new HeldToolFacts();
    held.hold(SK, ID, withQuestionAsked(SCHEMA));
    expect(held.bear('topic:other', { id: ID, name: 'x', args: {}, status: 'pending' }).status).toBe('pending');
  });

  test('a cleared session holds nothing: its turn ended and the history reload carries the state', () => {
    const held = new HeldToolFacts();
    held.hold(SK, ID, withQuestionAsked(SCHEMA));
    held.clear(SK);
    expect(held.bear(SK, { id: ID, name: 'x', args: {}, status: 'pending' }).status).toBe('pending');
  });

  test('two facts for the same row apply in arrival order', () => {
    const held = new HeldToolFacts();
    held.hold(SK, ID, withQuestionAsked(SCHEMA));
    held.hold(SK, ID, withPermissionAsked({ kind: 'tool' } as unknown as ToolCall['permissionRequest']));
    expect(held.bear(SK, { id: ID, name: 'x', args: {}, status: 'pending' }).status).toBe('awaiting_permission');
  });

  test('a permission asked before its row is there when the row is born, and a later announcement keeps it', () => {
    const held = new HeldToolFacts();
    const request = { kind: 'tool' } as unknown as ToolCall['permissionRequest'];
    let msgs = patchToolCallOrHold(openTurn(), held, SK, ID, withPermissionAsked(request));
    msgs = apply(msgs, held, FRAMES[0]!);
    msgs = apply(msgs, held, FRAMES[2]!);
    expect(row(msgs).inCalls).toMatchObject({ status: 'awaiting_permission', permissionRequest: request });
  });

  test('a row already on screen is patched, not held', () => {
    const held = new HeldToolFacts();
    let msgs = apply(openTurn(), held, FRAMES[0]!);
    msgs = patchToolCallOrHold(msgs, held, SK, ID, withQuestionAsked(SCHEMA));
    expect(row(msgs).inCalls?.status).toBe('waiting_for_input');
    expect(held.bear(SK, { id: ID, name: 'x', args: {}, status: 'pending' }).status).toBe('pending');
  });
});

describe('patchToolCallInMessages', () => {
  test('a row that lives only in `blocks` (a message loaded from the API) is patched too', () => {
    const tc: ToolCall = { id: ID, name: 'x', args: {}, status: 'running' };
    const msgs: ChatMessage[] = [{ id: 'a', role: 'assistant', content: '', timestamp: 't', blocks: [{ kind: 'tool', toolCall: tc }] }];
    const out = patchToolCallInMessages(msgs, ID, withQuestionAsked(SCHEMA));
    expect(out[0]!.blocks![0]).toMatchObject({ kind: 'tool', toolCall: { status: 'waiting_for_input' } });
  });

  test('an unknown id returns the same array', () => {
    const msgs = openTurn();
    expect(patchToolCallInMessages(msgs, 'nope', withQuestionAsked(SCHEMA))).toBe(msgs);
  });
});
