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
import { toolCallFromSse, withSseToolResult, type SseToolCallDelta } from './sseToolFrames';
import { toolUpdatePatch, withPartialResult, withToolUpdate } from './toolUpdatePatch';
import {
  HeldToolFacts,
  patchToolCallInMessages,
  patchToolCallOrFollow,
  patchToolCallOrHold,
  withAnnouncedToolCall,
  withPermissionAsked,
  withPermissionResolved,
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

/**
 * THE FRAME THAT CLOSES THE PANEL, WHEN IT TOO COMES BEFORE THE ROW.
 *
 * The person can answer the question, or decide on the permission, in another
 * window while this one still has its SSE burst held: the phone shows the panel
 * at once over WS. The closing frame (`stream:tool_update` with the answer,
 * `stream:tool_permission_resolved`) then reaches a row that does not exist
 * either. It used to be dropped while the opening frame was held, so the row
 * was born on a panel already closed, and `withToolAnnouncement` kept it there:
 * a permission panel over a command already allowed, refusing its live output,
 * or a form over a question already answered.
 *
 * Each channel keeps its own order (WS is one socket; SSE is one stream that
 * WebKit can delay but not reorder) and either may stop short (a frame held
 * back for good). Every interleaving of every pair of prefixes is fed to the
 * same reducers `useChat` uses, `applyToolPatch` included.
 */
type Step =
  | { via: 'sse'; name: string; delta: SseToolCallDelta }
  | { via: 'sse-result'; name: string }
  | { via: 'ws-open'; name: string; fact: ToolFactOf }
  | { via: 'ws-close'; name: string; fact: ToolFactOf }
  | { via: 'ws-partial'; name: string };
type ToolFactOf = (tc: ToolCall) => ToolCall;

const REQUEST = { kind: 'bash', command: 'npm run build' } as unknown as ToolCall['permissionRequest'];
const ANSWER = { kind: 'questions', answers: { 'Which one?': 'One' } } as unknown as ToolCall['userResponse'];
const bash = { name: 'bash', arguments: '{"command":"npm run build"}' };

const answerFact: ToolFactOf = (tc) => withToolUpdate(tc, toolUpdatePatch({ toolCallId: ID, status: 'running', userResponse: ANSWER })!);
// What `useChat` writes for `stream:tool_permission_resolved`.
const ALLOWED: ToolCall['permissionOutcome'] = { decision: 'allow', decidedAt: '2026-10-04T20:00:00.000Z' };
const allowFact: ToolFactOf = withPermissionResolved(ALLOWED);

const QUESTION_SSE: Step[] = [
  { via: 'sse', name: 'S pending', delta: { id: ID, function: fn, status: 'pending' } },
  { via: 'sse', name: 'S running', delta: { id: ID, function: fn, status: 'running', startedAt: 1000 } },
  { via: 'sse', name: 'S waiting', delta: { id: ID, function: fn, status: 'waiting_for_input', startedAt: 1000, userInputSchema: SCHEMA } },
  { via: 'sse-result', name: 'S result' },
];
const QUESTION_WS: Step[] = [
  { via: 'ws-open', name: 'WS question', fact: withQuestionAsked(SCHEMA) },
  { via: 'ws-close', name: 'WS answer', fact: answerFact },
];
const PERMISSION_SSE: Step[] = [
  { via: 'sse', name: 'S pending', delta: { id: ID, function: bash, status: 'pending' } },
  { via: 'sse', name: 'S running', delta: { id: ID, function: bash, status: 'running', startedAt: 1000 } },
  { via: 'sse-result', name: 'S result' },
];
const PERMISSION_WS: Step[] = [
  { via: 'ws-open', name: 'WS permission', fact: withPermissionAsked(REQUEST) },
  { via: 'ws-close', name: 'WS allowed', fact: allowFact },
  { via: 'ws-partial', name: 'WS partial' },
];

/** What `useChat` does with each step in the sender window. */
function applyStep(msgs: ChatMessage[], held: HeldToolFacts, step: Step): ChatMessage[] {
  switch (step.via) {
    case 'sse': {
      const out = msgs.slice();
      out[out.length - 1] = withAnnouncedToolCall(out[out.length - 1]!, toolCallFromSse(step.delta, () => 'generated')!, held, SK);
      return out;
    }
    // The SSE result is applied by id on the row the same stream announced.
    case 'sse-result': return patchToolCallInMessages(msgs, ID, (tc) => withSseToolResult(tc, { id: ID, status: 'success', result: 'done' }));
    case 'ws-open': return patchToolCallOrHold(msgs, held, SK, ID, step.fact);
    // `applyToolPatch` and the partial flush.
    case 'ws-close': return patchToolCallOrFollow(msgs, held, SK, ID, step.fact);
    case 'ws-partial': return patchToolCallOrFollow(msgs, held, SK, ID, (tc) => withPartialResult(tc, 'building...'));
  }
}

/** Every interleaving of `a` and `b` that keeps the order inside each. */
function* interleavings<T>(a: T[], b: T[]): Generator<T[]> {
  if (a.length === 0) { yield b; return; }
  if (b.length === 0) { yield a; return; }
  for (const rest of interleavings(a.slice(1), b)) yield [a[0]!, ...rest];
  for (const rest of interleavings(a, b.slice(1))) yield [b[0]!, ...rest];
}

/** Every interleaving of every prefix of the two channels. */
function* channelOrders(sse: Step[], ws: Step[]): Generator<Step[]> {
  for (let i = 0; i <= sse.length; i++) {
    for (let j = 0; j <= ws.length; j++) yield* interleavings(sse.slice(0, i), ws.slice(0, j));
  }
}

function run(order: Step[]): ToolCall | undefined {
  const held = new HeldToolFacts();
  let msgs = openTurn();
  for (const step of order) msgs = applyStep(msgs, held, step);
  const { inCalls, inBlocks } = row(msgs);
  expect(inBlocks, order.map((s) => s.name).join(' > ')).toBe(inCalls);
  return inCalls;
}

describe('a panel closed before its row exists (sender window)', () => {
  test('the order of the report: permission asked and allowed on the phone, then the held burst', () => {
    let msgs = openTurn();
    const held = new HeldToolFacts();
    for (const step of [PERMISSION_WS[0]!, PERMISSION_WS[1]!, PERMISSION_SSE[1]!, PERMISSION_WS[2]!, PERMISSION_SSE[1]!]) {
      msgs = applyStep(msgs, held, step);
    }
    // Running with its decision, and its live output is taken.
    expect(row(msgs).inCalls).toMatchObject({ status: 'running', permissionOutcome: ALLOWED, result: 'building...' });
  });

  test('the order of the report: question asked and answered elsewhere, then the held burst', () => {
    let msgs = openTurn();
    const held = new HeldToolFacts();
    for (const step of [QUESTION_WS[0]!, QUESTION_WS[1]!, QUESTION_SSE[0]!, QUESTION_SSE[1]!, QUESTION_SSE[2]!]) {
      msgs = applyStep(msgs, held, step);
    }
    expect(row(msgs).inCalls).toMatchObject({ status: 'running', userResponse: ANSWER });
  });

  test('every order of a question: the form is up exactly while the question is asked and not answered', () => {
    let checked = 0;
    for (const order of channelOrders(QUESTION_SSE, QUESTION_WS)) {
      const label = order.map((s) => s.name).join(' > ');
      const tc = run(order);
      const has = (name: string) => order.some((s) => s.name === name);
      if (!order.some((s) => s.via === 'sse')) {
        expect(tc, label).toBeUndefined();
      } else if (has('S result')) {
        expect(tc?.status, label).toBe('success');
      } else if (has('WS answer')) {
        expect({ label, status: tc?.status, answer: tc?.userResponse }).toEqual({ label, status: 'running', answer: ANSWER });
      } else if (has('WS question') || has('S waiting')) {
        expect(tc?.status, label).toBe('waiting_for_input');
      } else {
        expect(tc?.status, label).not.toBe('waiting_for_input');
      }
      checked++;
    }
    // Prefixes of 4 SSE and 2 WS frames: sum over i, j of C(i+j, i) = 55 orders.
    expect(checked).toBe(55);
  });

  test('every order of a permission: the panel is up exactly while the permission is asked and not decided', () => {
    let checked = 0;
    for (const order of channelOrders(PERMISSION_SSE, PERMISSION_WS)) {
      const label = order.map((s) => s.name).join(' > ');
      const tc = run(order);
      const has = (name: string) => order.some((s) => s.name === name);
      if (!order.some((s) => s.via === 'sse')) {
        expect(tc, label).toBeUndefined();
      } else if (has('S result')) {
        expect({ label, status: tc?.status, result: tc?.result }).toEqual({ label, status: 'success', result: 'done' });
      } else if (has('WS allowed')) {
        expect({ label, status: tc?.status, outcome: tc?.permissionOutcome }).toEqual({ label, status: 'running', outcome: ALLOWED });
        // The live output reaches a row that is running.
        if (has('WS partial')) expect(tc?.result, label).toBe('building...');
      } else if (has('WS permission')) {
        expect(tc?.status, label).toBe('awaiting_permission');
      } else {
        expect(tc?.status, label).not.toBe('awaiting_permission');
      }
      checked++;
    }
    // Prefixes of 3 SSE and 3 WS frames: 69 orders.
    expect(checked).toBe(69);
  });

  test('a frame for a row not born and with nothing held is dropped, as before', () => {
    const held = new HeldToolFacts();
    const msgs = openTurn();
    expect(patchToolCallOrFollow(msgs, held, SK, ID, allowFact)).toBe(msgs);
    expect(held.has(SK, ID)).toBe(false);
  });
});
