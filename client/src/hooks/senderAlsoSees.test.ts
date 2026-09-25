/**
 * A PERMISSION PANEL MUST ALSO SWITCH OFF, not only switch on.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A window that owns a session's SSE drops the WS events for that same session,
 * because it would receive them twice. The exceptions are the events that do
 * not exist on the SSE: dropping those means never receiving them.
 *
 * `stream:tool_permission_required` had been added to the exceptions for
 * exactly that reason, but its twin had not. Measured by reading the code: you
 * click "allow", the tool really starts and the answer scrolls underneath,
 * while the button stays a spinner and all four stay grey for the whole
 * duration of the tool. On a Bash or a sub-agent that is minutes.
 * `stream:tool_permission_resolved` is the ONLY writer of `permissionOutcome`,
 * there is no equivalent SSE frame, and the HTTP response does not carry the
 * verdict.
 *
 * The existing panel test (`tests/e2e/permission-panel.spec.ts`) is green on the
 * complementary case: it seeds over HTTP and opens with `goToApp` without ever
 * sending a message, so that window has no SSE and the filter never engages.
 * @covers PERM-08
 */
import { describe, expect, test } from 'bun:test';
import { senderAlsoSees, senderAlsoSeesFrame, SENDER_ALSO_SEES } from './senderAlsoSees';

describe('the events that also reach whoever owns the SSE', () => {
  test('a permission outcome gets through, or the panel never switches off', () => {
    expect(senderAlsoSees('stream:tool_permission_resolved')).toBe(true);
  });

  test('the request still gets through, as before', () => {
    // The earlier cure must not have been traded for this one.
    expect(senderAlsoSees('stream:tool_permission_required')).toBe(true);
    expect(senderAlsoSees('stream:usage')).toBe(true);
  });

  /**
   * Reported on 23/09 as "sometimes I have to refresh to see the real state of
   * a topic". The question panel (`ask_user_question`, a plan to approve from a
   * question) travels ONLY over WS (server/routes/chat.ts, the
   * `stream:tool_user_input_required` frames) and the SSE parser in `useChat`
   * reads only content, tool_calls and tool_result. The window you sent from
   * dropped it: the sidebar said "waiting for you" while the chat showed a
   * spinner, and only a reload painted the form. A sub-agent's live progress
   * (`stream:tool_detail`) and the compaction divider (`stream:compaction`) had
   * the same fate. All three write a FIXED state: a status plus a schema, a
   * whole snapshot replacing the previous one, an upsert by marker id.
   */
  test('the question panel, a sub-agent snapshot and the compaction divider reach the sender', () => {
    expect(senderAlsoSees('stream:tool_user_input_required')).toBe(true);
    expect(senderAlsoSees('stream:tool_detail')).toBe(true);
    expect(senderAlsoSees('stream:compaction')).toBe(true);
  });

  test('events that ACCUMULATE stay out', () => {
    // The rule of the list: whoever writes a fixed state may enter, whoever
    // adds up may not. A text delta delivered twice would double the answer on
    // the screen of the person who sent it.
    for (const t of ['stream:chunk', 'stream:tool_update', 'stream:thinking', 'stream:start', 'stream:end']) {
      expect(senderAlsoSees(t)).toBe(false);
    }
  });

  /**
   * A late answer: the watchdog closed T1 while its send waited in the
   * provider's queue, the person sent T2 from this window, and T1's answer
   * arrived. Its frames say `late` and name T1's row, and none of them is on
   * T2's SSE, so the gate dropped them all: the window you were working in
   * never showed T1's tools, and a question or a permission among them held
   * the CLI, and T2 behind it, on a panel nobody could see (review of PR #135).
   */
  test('every frame of a closed turn reaches the sender, deltas included: none of them is on its SSE', () => {
    for (const type of ['stream:tool_call', 'stream:tool_result', 'stream:content_chunk', 'stream:thinking_chunk']) {
      expect(senderAlsoSeesFrame({ type, late: true })).toBe(true);
      expect(senderAlsoSeesFrame({ type })).toBe(false);
    }
    expect(senderAlsoSeesFrame({ type: 'stream:usage' })).toBe(true);
  });

  test('the list is short and has no duplicates', () => {
    // If it grows, it grows for a written reason: every entry costs one event
    // delivered twice to someone who already receives it on the SSE.
    expect(new Set(SENDER_ALSO_SEES).size).toBe(SENDER_ALSO_SEES.length);
    expect(SENDER_ALSO_SEES.length).toBeLessThanOrEqual(6);
  });
});
