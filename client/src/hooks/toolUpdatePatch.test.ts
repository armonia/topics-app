/**
 * AN ANSWERED QUESTION HAS TO STOP LOOKING LIKE ONE STILL BEING SENT.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Reported, in the user's own words:
 * "graficamente le domande restano in invio anche se vanno avanti" // allow-italian: quoted report
 *
 * You press send. The button goes grey with a spinner and the word "Invio…",
 * the options stay disabled, the row keeps its amber "waiting for you" dot.
 * Underneath, the new turn scrolls normally. It only clears on reload.
 *
 * The form has a single off switch and it lives in another process:
 * `ToolInputForm` resets `submitting` only in its `catch`, because it counts on
 * being UNMOUNTED when the row leaves `waiting_for_input`. Three server sites
 * announce exactly that transition with a `stream:tool_update`, and all three
 * send no `partialResult` because there is no output to show - while the client
 * entered that handler only when a partial was present. The announcement was
 * dropped on the floor.
 *
 * On the plan branch there was no second chance: that panel hangs off a tool the
 * server back-marks at the end of the turn, so no provider will ever emit a
 * `stream:tool_result` for that id.
 *
 * Note what is NOT the cure: adding a `finally` that clears `submitting`. The
 * message list is virtualised, so a row that scrolls out and remounts would come
 * back with the panel RE-ARMED on a question already answered - the same stuck
 * row inviting a second answer. The state has to arrive from the server, which
 * is what this reads.
 *
 * The other half of the event, the partial output, has its own guard at the
 * bottom (CHAT-TOOL-09): in the window you sent from the result arrives on the
 * SSE and the partial on WS, two channels with no order between them.
 * @covers ASK-09, CHAT-TOOL-09, CHAT-NTOOL-05
 */
import { describe, expect, test } from 'bun:test';
import { toolUpdatePatch, withPartialResult, withToolAnnouncement, withToolUpdate } from './toolUpdatePatch';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ToolCall } from '@/types';

describe('what a tool-update event changes on the row', () => {
  test('an announced transition produces a patch', () => {
    // The exact shape the three server sites now send: an id and a status, no
    // partial. Before the cure this event changed nothing at all.
    const patch = toolUpdatePatch({ toolCallId: 'tu_1', status: 'running' });
    expect(patch).not.toBeNull();
    expect(patch?.status).toBe('running');
  });

  test('the plan branch, whose only announcement this is', () => {
    const patch = toolUpdatePatch({ toolCallId: 'tu_2', status: 'success' });
    expect(patch?.status).toBe('success');
  });

  test('the answer travels with it, so the row shows it without a reload', () => {
    const answer = { kind: 'questions', answers: [{ header: 'x', selected: ['a'] }] };
    const patch = toolUpdatePatch({ toolCallId: 'tu_3', status: 'running', userResponse: answer });
    expect(patch?.userResponse).toEqual(answer as never);
  });

  test('a pure output frame still changes no state', () => {
    // The streaming case this event was originally written for: the partial is
    // handled elsewhere, and it must not drag a status with it.
    expect(toolUpdatePatch({ toolCallId: 'tu_4', partialResult: 'riga di output' })).toBeNull();
  });

  test('an unknown status is refused, not written through', () => {
    // Writing it through would park the row in a state no renderer knows, which
    // is the same stuck panel by another door.
    expect(toolUpdatePatch({ toolCallId: 'tu_5', status: 'nonesiste' })).toBeNull();
    expect(toolUpdatePatch({ toolCallId: 'tu_6', status: 42 })).toBeNull();
  });

  test('no id, no patch', () => {
    expect(toolUpdatePatch({ status: 'running' })).toBeNull();
  });
});

describe('a partial output writes only on a row still running', () => {
  const row = (status: ToolCall['status'], result: string): ToolCall =>
    ({ id: 'tu_bash', name: 'Bash', args: { command: 'bun test' }, status, result });

  test('a late partial does not overwrite the result', () => {
    // The final result came on the SSE, the partial was still on the wire.
    const closed = row('success', '400 pass, 0 fail');
    expect(withPartialResult(closed, 'test 3 of 400').result).toBe('400 pass, 0 fail');
    expect(withPartialResult(row('error', 'exit 1'), 'test 3 of 400').result).toBe('exit 1');
  });

  test('a running row takes the partial whole, replacing the one before', () => {
    expect(withPartialResult(row('running', 'test 1'), 'test 1\ntest 2').result).toBe('test 1\ntest 2');
    // No status yet reads as pending, which is running for the row too.
    expect(withPartialResult(row(undefined, ''), 'test 1').result).toBe('test 1');
  });
});

describe('a stale answer does not reopen a tool that returned', () => {
  const ask = (status: ToolCall['status']): ToolCall =>
    ({ id: 'tu_ask', name: 'AskUserQuestion', args: {}, status });

  test('a second submission after the result leaves the row settled', () => {
    // The phone reconnects with its form still open and answers again; the
    // route broadcasts `running` although the tool has already returned. The
    // row already carries the first answer, and keeps it.
    const first = { kind: 'questions', answers: { q: 'first' }, submittedAt: 't1' } as const;
    const answered = (status: ToolCall['status']): ToolCall => ({ ...ask(status), userResponse: first });
    const patch = toolUpdatePatch({ toolCallId: 'tu_ask', status: 'running', userResponse: { kind: 'questions', answers: { q: 'second' }, submittedAt: 't2' } })!;
    expect(withToolUpdate(answered('success'), patch)).toEqual(answered('success'));
    expect(withToolUpdate(answered('error'), patch)).toEqual(answered('error'));
    // An announcement with nothing but the status leaves the row untouched.
    const bare = toolUpdatePatch({ toolCallId: 'tu_ask', status: 'running' })!;
    const settled = ask('success');
    expect(withToolUpdate(settled, bare)).toBe(settled);
  });

  test('the first answer arriving AFTER the result is kept, and the row stays settled', () => {
    // The model's result (SSE) overtook the answer route's broadcast (WS): the
    // answer is not stale, it is late, and dropping it hid the choice until a
    // reload.
    const answer = { kind: 'questions', answers: { q: 'OAuth' }, submittedAt: 't1' } as const;
    const patch = toolUpdatePatch({ toolCallId: 'tu_ask', status: 'running', userResponse: answer })!;
    expect(withToolUpdate(ask('success'), patch)).toEqual({ ...ask('success'), userResponse: answer });
  });

  test('the first answer still moves a waiting row back to running', () => {
    const patch = toolUpdatePatch({ toolCallId: 'tu_ask', status: 'running' })!;
    expect(withToolUpdate(ask('waiting_for_input'), patch).status).toBe('running');
  });

  test('a question a person ended carries how, so the panel can say it', () => {
    const patch = toolUpdatePatch({ toolCallId: 'tu_ask', status: 'error', askEnded: 'superseded' })!;
    expect(withToolUpdate(ask('waiting_for_input'), patch)).toMatchObject({ status: 'error', askEnded: 'superseded' });
    // An unknown reason is refused, like an unknown status.
    expect(toolUpdatePatch({ toolCallId: 'tu_ask', askEnded: 'bogus' })).toBeNull();
  });

  test('the stream handler goes through the guard', () => {
    const src = readFileSync(join(import.meta.dir, 'useChat.ts'), 'utf8');
    expect(src).toContain('(tc) => withToolUpdate(tc, patch)');
  });
});

describe('an announcement does not move a row back', () => {
  const row = (status: ToolCall['status'], extra: Partial<ToolCall> = {}): ToolCall =>
    ({ id: 'tu_q', name: 'ask_user_question', args: {}, status, ...extra });
  const announced = (status: ToolCall['status']): ToolCall =>
    ({ id: 'tu_q', name: 'ask_user_question', args: { questions: [] }, status, startedAt: 1000 });

  test('a running announcement landing after the form keeps the form', () => {
    // The native runtime starts the call and asks in the same tick: `running`
    // on the SSE, the form on WS, and the SSE came second.
    const schema = { kind: 'questions', questions: [] } as unknown as ToolCall['userInputSchema'];
    const merged = withToolAnnouncement(row('waiting_for_input', { userInputSchema: schema }), announced('running'));
    expect(merged.status).toBe('waiting_for_input');
    expect(merged.userInputSchema).toBe(schema);
    // The rest of the announcement is still taken.
    expect(merged.startedAt).toBe(1000);
    expect(merged.args).toEqual({ questions: [] });
  });

  test('a permission prompt and a closed row keep their status too', () => {
    for (const status of ['awaiting_permission', 'success', 'error'] as const) {
      expect(withToolAnnouncement(row(status), announced('running')).status).toBe(status);
      expect(withToolAnnouncement(row(status), announced('pending')).status).toBe(status);
    }
  });

  test('a started call does not go back to queued', () => {
    expect(withToolAnnouncement(row('running'), announced('pending')).status).toBe('running');
  });

  test('a step forward is taken', () => {
    expect(withToolAnnouncement(row('pending'), announced('running')).status).toBe('running');
    expect(withToolAnnouncement(row(undefined), announced('pending')).status).toBe('pending');
    expect(withToolAnnouncement(row('running'), announced('running')).status).toBe('running');
  });

  test('the question on the SSE opens the form on a row the WS frame missed', () => {
    // WebKit held the SSE burst, so the WS form frame came before the row
    // existed and patched nothing; the SSE now carries the question in order.
    const schema = { kind: 'questions', questions: [] } as unknown as ToolCall['userInputSchema'];
    const merged = withToolAnnouncement(row('running'), { ...announced('waiting_for_input'), userInputSchema: schema });
    expect(merged.status).toBe('waiting_for_input');
    expect(merged.userInputSchema).toBe(schema);
  });

  test('a question already answered or closed is not asked again', () => {
    const answer = { kind: 'questions', answers: { q: 'One' }, submittedAt: 't1' } as const;
    const asked = { ...announced('waiting_for_input'), userInputSchema: { kind: 'questions', questions: [] } as unknown as ToolCall['userInputSchema'] };
    expect(withToolAnnouncement(row('running', { userResponse: answer }), asked).status).toBe('running');
    expect(withToolAnnouncement(row('success'), asked).status).toBe('success');
    expect(withToolAnnouncement(row('error'), asked).status).toBe('error');
  });

  test('the announcement handler goes through the guard', () => {
    // `useChat` merges through `withAnnouncedToolCall`, which applies the guard to a row it already has.
    const src = readFileSync(join(import.meta.dir, 'useChat.ts'), 'utf8');
    expect(src).toContain('withAnnouncedToolCall(lastMsg, toolCall, heldToolFactsRef.current, sessionKey)');
    const merge = readFileSync(join(import.meta.dir, 'heldToolFacts.ts'), 'utf8');
    expect(merge).toContain('withToolAnnouncement(msg.toolCalls![existingIdx]!, announced)');
  });
});
