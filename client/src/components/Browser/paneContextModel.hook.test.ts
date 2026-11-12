/**
 * `PANE_CONTEXT_HOOK_JS` runs inside the webview's page, not inside this app's
 * DOM — there is no real `window`/`document` to mount it on, so this installs
 * the minimal global surface it reads (`addEventListener`, `getSelection`,
 * `window`) and runs the script verbatim with `new Function`, exactly as the
 * Tauri host does.
 *
 * @covers paneContextModel preventDefault ordering
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PANE_CONTEXT_HOOK_JS } from './paneContextModel';

type Handler = (e: unknown) => void;

const g = globalThis as unknown as Record<string, unknown>;
const found = { window: g.window, addEventListener: g.addEventListener, getSelection: g.getSelection };

afterEach(() => {
  if (found.window === undefined) delete g.window; else g.window = found.window;
  if (found.addEventListener === undefined) delete g.addEventListener; else g.addEventListener = found.addEventListener;
  if (found.getSelection === undefined) delete g.getSelection; else g.getSelection = found.getSelection;
});

let fakeWindow: Record<string, unknown>;
let handler: Handler;

beforeEach(() => {
  fakeWindow = {};
  g.window = fakeWindow;
  g.addEventListener = (_type: string, h: Handler) => { handler = h; };
  g.getSelection = () => '';
  // Installs the hook on `fakeWindow` and captures the handler above.
  new Function(PANE_CONTEXT_HOOK_JS)();
});

function fakeEvent(target: unknown): { clientX: number; clientY: number; target: unknown; prevented: boolean; preventDefault: () => void } {
  const e = { clientX: 10, clientY: 20, target, prevented: false, preventDefault: () => { e.prevented = true; } };
  return e;
}

describe('right-click probe inside a native browser pane', () => {
  test('a normal click fills the buffer and suppresses the native menu', () => {
    const e = fakeEvent(null);
    handler(e);
    expect(e.prevented).toBe(true);
    expect(fakeWindow.__topicsCtx).toMatchObject({ x: 10, y: 20 });
  });

  test('a probe that throws leaves the native menu in place: preventDefault is NOT called', () => {
    // `el.closest` throws: the probe fails before it ever reaches the write
    // to `window.__topicsCtx` or the `preventDefault()` after it.
    const target = { nodeType: 1, closest: () => { throw new Error('boom'); } };
    const e = fakeEvent(target);
    handler(e);
    expect(e.prevented, 'a failed probe must not suppress the real menu').toBe(false);
    expect(fakeWindow.__topicsCtx).toBeNull();
  });
});
