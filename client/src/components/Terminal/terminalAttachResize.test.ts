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
 * The attach resize rides `replay-end`, the first frame only a LIVE session
 * sends. Later gesture resizes also require that proven attach; otherwise a
 * focus or layout change could still post against the dead id.
 *
 * The five hand-written `fetch(...)/resize` calls have since become one call to
 * `postTerminalResize` (`lib/terminalRosterRetry.ts`), which waits out the
 * server's boot window instead of dropping the answer. WHERE the attach resize
 * sits is unchanged and is still what this file pins: the helper cures a false
 * 404 from the reconcile race, not a resize aimed at a genuinely dead id.
 *
 * Read the source, like `terminalRosterFetch.test.ts` next door: mounting the
 * pane would take a renderer, an xterm and a WebSocket server to prove where
 * one call sits.
 *
 * @covers TERM-01, TERM-09
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

/** The dormant close branch must discard input from the session that stopped. */
function dormantCloseBranch(): string {
  const start = SOURCE.indexOf('if (event.code === TERMINAL_WS_CLOSE_DORMANT)');
  expect(start, 'the dormant close branch was renamed: update this test').toBeGreaterThan(0);
  const end = SOURCE.indexOf('\n        // 1008 ("session not found")', start);
  expect(end, 'the end of the dormant close branch cannot be found').toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** Every way this file can tell the shared PTY its size, in one spelling. */
const RESIZE_CALL = 'postTerminalResize(sessionId,';

describe('the attach resize waits for proof that the session is alive', () => {
  test('both regions are found (guard against a green on an empty string)', () => {
    expect(onOpenBody().length).toBeGreaterThan(200);
    expect(replayEndBranch().length).toBeGreaterThan(200);
  });

  test('ws.onopen sends no resize: an open is not an attach', () => {
    // Both spellings: the literal fetch this file used to hold, and the helper
    // that replaced it. Checking only one would go green the day someone puts
    // the other back into `onopen`.
    expect(onOpenBody()).not.toContain('/resize');
    expect(onOpenBody()).not.toContain('postTerminalResize');
  });

  test('replay-end sends it: that frame only comes from a live session', () => {
    expect(replayEndBranch()).toContain(RESIZE_CALL);
  });

  test('every later resize gesture is gated on a proven live attach', () => {
    const resizeHandler = SOURCE.slice(
      SOURCE.indexOf('term.onResize('),
      SOURCE.indexOf('termRef.current = { term, fit: fitAddon, ws: initialWs }'),
    );
    const focusHandler = SOURCE.slice(
      SOURCE.indexOf('const handleFocus = () => {'),
      SOURCE.indexOf("window.addEventListener('focus', handleFocus)"),
    );
    const activeTabHandler = SOURCE.slice(
      SOURCE.indexOf('// When this pane becomes the ACTIVE/visible tab'),
      SOURCE.indexOf('// Touch devices: when the PWA returns to the foreground'),
    );
    const touchHandler = SOURCE.slice(
      SOURCE.indexOf('// Touch devices: when the PWA returns to the foreground'),
      SOURCE.indexOf('const flashCopied ='),
    );
    for (const handler of [resizeHandler, focusHandler, activeTabHandler, touchHandler]) {
      expect(handler.includes('attachedRef.current')).toBe(true);
    }
  });

  test('a dormant verdict exposes Resting and its action calls revive', () => {
    expect(SOURCE.includes('data-testid="terminal-resting-overlay"')).toBe(true);
    expect(SOURCE.includes("t('terminal.resting.title')")).toBe(true);
    expect(SOURCE.includes("`/api/terminal/sessions/${encodeURIComponent(sessionId)}/revive`")).toBe(true);
  });

  test('a dormant verdict clears held input and input is ignored until Resume', () => {
    expect(dormantCloseBranch()).toContain('inputQueue.clear()');
    expect(dormantCloseBranch()).toContain('inputHeldRef.current = false');
    expect(dormantCloseBranch()).toContain('setInputHeld(false)');
    const physicalInput = SOURCE.slice(SOURCE.indexOf('term.onData((data) => {'), SOURCE.indexOf('\n    });', SOURCE.indexOf('term.onData((data) => {')));
    expect(physicalInput).toContain('if (restingRef.current) return;');
    const virtualInput = SOURCE.slice(SOURCE.indexOf('const sendToTerminal = (data: string) => {'), SOURCE.indexOf('\n  };', SOURCE.indexOf('const sendToTerminal = (data: string) => {')));
    expect(virtualInput).toContain('if (restingRef.current) return;');
    expect(SOURCE).toContain('inputHeld && !inputDropped && !inputLost && !stale && !resting');
  });

  test('only the attach post and four guarded gesture posts remain', () => {
    const total = [...SOURCE.matchAll(/postTerminalResize\(/g)].length;
    expect(total).toBe(5);
  });

  test('no hand-written resize fetch is left: the boot window is waited out in ONE place', () => {
    // The five copies were five chances to drop the server's answer, and that
    // is exactly what they did. A new one would reintroduce the false-404 noise
    // this pane is measured on.
    expect(SOURCE).not.toContain('/resize`');
  });
});
