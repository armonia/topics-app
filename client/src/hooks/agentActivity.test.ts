/**
 * THE SPINNER ON A BROWSER TAB MUST NOT OUTLIVE ITS SOCKET.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Found by a sweep looking for UI states that switch on and that nothing
 * switches off, then confirmed by a sceptic who tried to demolish it.
 *
 * "The agent is driving this pane" had one input, the `agent_active` frame, and
 * therefore one way off: the server sending `false`. That `false` comes out of
 * the delegation lock's `try/finally`, so on a healthy socket it always
 * arrives - and on a dead one it never does. `setAgentActive` had exactly two
 * sites in the whole repo, the initial `useState(false)` and that frame; the
 * socket had no `close`, no `error` and no reconnection. The spinner kept
 * turning on a page idle for hours.
 *
 * Both real causes close the socket rather than dropping one frame: the server
 * restarting (SIGTERM from the file watcher on every save under `server/`, many
 * times a day) and the 90s reaper on sleep or a network drop. The server caps a
 * delegated op at 30s, so a pill lit for longer is a lie by construction.
 * @covers BROWSER-AGENT-PILL-01
 */
import { describe, expect, test } from 'bun:test';
import { nextAgentActive } from './agentActivity';

describe('is the agent driving this browser pane', () => {
  test('a dead socket switches the pill off, whatever it was saying', () => {
    // The defect: this case did not exist, so the pill stayed lit forever.
    expect(nextAgentActive({ kind: 'disconnected' })).toBe(false);
  });

  test('the frame still decides, both ways', () => {
    expect(nextAgentActive({ kind: 'frame', active: true })).toBe(true);
    expect(nextAgentActive({ kind: 'frame', active: false })).toBe(false);
  });

  test('a disconnection outranks a frame that said true', () => {
    // Sequence of the real failure: the server says "driving", the socket dies
    // before the closing `false`. Reading the previous value here would let the
    // lost frame outlive its socket, which is the defect itself.
    const afterFrame = nextAgentActive({ kind: 'frame', active: true });
    expect(afterFrame).toBe(true);
    expect(nextAgentActive({ kind: 'disconnected' })).toBe(false);
  });
});
