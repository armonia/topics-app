/**
 * A FAILED ATTACH MUST NOT POST A RESIZE.
 *
 * The server accepts the WebSocket upgrade for ANY session id and only then
 * decides whether the session exists, closing with 1008 if it does not. So
 * `ws.onopen` proves nothing, and the resize that used to sit there was fired
 * against dead ids too: `POST /api/terminal/sessions/:id/resize` answers 404,
 * the socket closes, the pane retries 3 s later, forever.
 *
 * Measured on 2026-09-07 in one server log: 54.147 lines of "Terminal session
 * not found" out of 241.188 (22,4%), in 15 storms, the last one 12.940 lines
 * long at a flat 84-90 per minute for 21 minutes - four orphaned terminal panes
 * persisted in the layout, none of them with a row in `terminal_sessions`.
 *
 * The fix is where the resize is sent, not a swallowed error: it rides
 * `replay-end`, the first frame only a LIVE session sends. Three fetches of
 * resize in this file are closed with `.catch(() => {})`, so the 404 left no
 * trace on the client at all - only the server log knew.
 *
 * Read the source, like `terminalRosterFetch.test.ts` next door: mounting the
 * pane would take a renderer, an xterm and a WebSocket server to prove where
 * one call sits.
 *
 * @covers TERM-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(import.meta.dir, 'SingleTerminalPane.tsx'), 'utf8');

/** The body of `ws.onopen`, up to its closing brace. */
function onOpenBody(): string {
  const start = SOURCE.indexOf('ws.onopen = () => {');
  expect(start, 'ws.onopen was renamed: update this test').toBeGreaterThan(0);
  const end = SOURCE.indexOf('\n      };', start);
  expect(end, 'the end of ws.onopen cannot be found').toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** The `replay-end` branch, from its guard to the `return` that closes it. */
function replayEndBranch(): string {
  const start = SOURCE.indexOf("msg.type === 'replay-end'");
  expect(start, "the replay-end branch was renamed: update this test").toBeGreaterThan(0);
  const end = SOURCE.indexOf('\n              return;', start);
  expect(end, 'the end of the replay-end branch cannot be found').toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

const RESIZE_CALL = 'fetch(`/api/terminal/sessions/${sessionId}/resize`';

describe('the attach resize waits for proof that the session is alive', () => {
  test('both regions are found (guard against a green on an empty string)', () => {
    expect(onOpenBody().length).toBeGreaterThan(200);
    expect(replayEndBranch().length).toBeGreaterThan(200);
  });

  test('ws.onopen sends no resize: an open is not an attach', () => {
    expect(onOpenBody()).not.toContain('/resize');
  });

  test('replay-end sends it: that frame only comes from a live session', () => {
    expect(replayEndBranch()).toContain(RESIZE_CALL);
  });

  test('the other resize call sites are untouched (they are user gestures)', () => {
    // The pane has more resize posts (fit on layout change, on font change,
    // on visibility). They fire from a pane already attached and were never
    // part of the storm; this pins that the move did not take them along.
    const total = [...SOURCE.matchAll(/\/resize`/g)].length;
    expect(total).toBeGreaterThanOrEqual(4);
  });
});
