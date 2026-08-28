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
import { senderAlsoSees, SENDER_ALSO_SEES } from './senderAlsoSees';

describe('the events that also reach whoever owns the SSE', () => {
  test('a permission outcome gets through, or the panel never switches off', () => {
    expect(senderAlsoSees('stream:tool_permission_resolved')).toBe(true);
  });

  test('the request still gets through, as before', () => {
    // The earlier cure must not have been traded for this one.
    expect(senderAlsoSees('stream:tool_permission_required')).toBe(true);
    expect(senderAlsoSees('stream:usage')).toBe(true);
  });

  test('events that ACCUMULATE stay out', () => {
    // The rule of the list: whoever writes a fixed state may enter, whoever
    // adds up may not. A text delta delivered twice would double the answer on
    // the screen of the person who sent it.
    for (const t of ['stream:chunk', 'stream:tool_update', 'stream:thinking', 'stream:start', 'stream:end']) {
      expect(senderAlsoSees(t)).toBe(false);
    }
  });

  test('the list is short and has no duplicates', () => {
    // If it grows, it grows for a written reason: every entry costs one event
    // delivered twice to someone who already receives it on the SSE.
    expect(new Set(SENDER_ALSO_SEES).size).toBe(SENDER_ALSO_SEES.length);
    expect(SENDER_ALSO_SEES.length).toBeLessThanOrEqual(4);
  });
});
