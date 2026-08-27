/**
 * The three Windows window commands: WHERE they come out and IN WHICH ORDER.
 *
 * Reported from a Windows build (board card 7aff3fd9): the window commands
 * "should come out of the Topics button like on the Mac and not there", "there"
 * being the far end of the same row, next to search and "+". Two systems, two
 * places, and whoever moves between them has to relearn where a window closes.
 *
 * What no compiler checks, and what a reader of the diff would call cosmetic:
 * 1. THE ORDER IS THE MAC'S: close, minimise, maximise. Under the Mac's anchor,
 *    the Windows 11 order would put close exactly where the Mac minimises.
 * 2. THEY ARE OUT OF THE FLOW. The chrome row is `h-10` and derives its height
 *    from its own buttons: three cells in the flow can push the title, make the
 *    row taller, or (measured, and it is why they were moved once already)
 *    reserve their width while switched off and push the bell underneath.
 * 3. THEY ARE MOUNTED ON THE TOPICS BUTTON. The component can be perfect and
 *    mounted in the wrong place, which is precisely the defect being fixed.
 *
 * @covers WINCTL-01
 *
 * Geometry in pixels (that 12px is really 12px on screen) needs layout, and
 * layout needs a browser: it belongs to the Windows harness in
 * `tests/manual/ui12-windows.js`, not here.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType } from 'react';

// The shell facade decides Tauri-on-Windows ONCE, when its module is evaluated
// (`shellKind` is a module constant), so the fake host has to be in place before
// the import: hence the dynamic import inside `beforeAll` and not at the top.
let WindowControls: ComponentType<{ visible: boolean }>;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: {} };
  // A WHOLE fake navigator, not a patched property. `isTauriWindows` reads
  // `userAgentData.platform` FIRST and only falls back to `platform`, so faking
  // just the second one leaves the verdict to whatever the host carries: on a
  // Mac (Bun leaves `userAgentData` undefined) the fake won and the test passed,
  // on ubuntu-latest the real `userAgentData` won and the component rendered
  // nothing — the same commit green here and red in CI. Replacing the object
  // closes both doors.
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'Win32', userAgentData: { platform: 'Windows' } },
    configurable: true,
  });
  // Destructured on purpose: `(await import(…)).member` makes the module OPAQUE
  // to knip, which then reports every export of it as used — that is exactly the
  // blind spot `check:deadcode-blindspots` refuses.
  const { WindowControls: Loaded } = await import('./WindowControls');
  WindowControls = Loaded;
});

const order = (html: string) =>
  (html.match(/data-testid="win-(close|minimize|maximize)"/g) || [])
    .map((m) => m.replace(/.*win-/, '').replace('"', ''));

describe('WindowControls on Windows', () => {
  test('same items as the Mac, in the same order: close, minimise, maximise', () => {
    expect(order(renderToStaticMarkup(<WindowControls visible />))).toEqual([
      'close',
      'minimize',
      'maximize',
    ]);
  });

  test('out of the flow, anchored 6px into the Topics button', () => {
    const html = renderToStaticMarkup(<WindowControls visible />);
    const root = html.slice(0, html.indexOf('<button'));
    expect(root).toContain('absolute');
    expect(root).toContain('left-[6px]');
    // `w-0` was the old dodge for a group that DID take part in the flow. An
    // absolute box reserves nothing, so if that class comes back it means the
    // group is back in the row.
    expect(root).not.toContain('w-0');
  });

  test('switched off it is invisible, unclickable and out of the Tab order', () => {
    const html = renderToStaticMarkup(<WindowControls visible={false} />);
    expect(html).toContain('opacity-0');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('tabindex="0"');
  });
});

describe('where they are mounted', () => {
  const app = () => readFileSync(join(import.meta.dir, '..', '..', 'App.tsx'), 'utf8');

  test('inside the Topics button wrapper, which is the positioning context', () => {
    const s = app();
    const wrapper = s.indexOf('ref={topicsMenuRef}');
    const mount = s.indexOf('<WindowControls visible={showTopicsMenu} />');
    expect(wrapper).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(wrapper);
    // The wrapper closes right after the mount: no other block between them, so
    // the commands cannot drift back to the end of the row unnoticed.
    expect(s.slice(mount).indexOf('</div>')).toBeLessThan(200);
    expect(s).toContain('className="app-no-drag relative"');
  });

  test('the "Topics" label makes room for them, as it does for the traffic lights', () => {
    expect(app()).toContain("(isTauriMac || isTauriWindows) && showTopicsMenu ? 'invisible' : ''");
  });
});
