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
 * @covers ASK-09
 */
import { describe, expect, test } from 'bun:test';
import { toolUpdatePatch } from './toolUpdatePatch';

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
