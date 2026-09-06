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
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType } from 'react';
import { TITLE_INSET_PX, TITLE_INSET_WITH_CONTROLS } from '../../lib/shell/windowControlsGeometry';

// ONE EXPORT IS OVERRIDDEN, and the rest of the facade is left ALONE. Faking the
// host is not enough: `isTauriWindows` is a module CONSTANT, computed the first
// time `lib/shell` is evaluated, and in a full `test:unit` run four other files
// import that module before this one (`windowAwake`, `useRemoteBrowser.leak`,
// `useTauriBrowser.polls`, `notificationPermission`). By then the constant is
// already `false` and the component renders nothing: the file passed on its own
// and failed in the suite, which is how it reached CI green-here-red-there twice.
//
// The spread is not decoration. `mock.module` REPLACES the module, so stubbing it
// with a single key made every other importer fail with «Export named 'isTauri'
// not found» - measured, four reds in the same run. Only the one export this file
// needs to lie about is overridden.
const shell = await import('../../lib/shell');
mock.module('../../lib/shell', () => ({ ...shell, isTauriWindows: true }));

let WindowControls: ComponentType<{ visible: boolean }>;

beforeAll(async () => {
  // Destructured on purpose: `(await import(…)).member` makes the module OPAQUE
  // to knip, which then reports every export of it as used - exactly the blind
  // spot `check:deadcode-blindspots` refuses.
  const { WindowControls: Loaded } = await import('./WindowControls');
  WindowControls = Loaded;
});

// `mock.module` is process-wide, so the override would follow this file into
// every later one. `shortcutLabel.ts` reads the same export, and its test is on
// its way in: leaving `isTauriWindows` stuck on `true` would make that file pass
// or fail depending on which order bun happened to pick.
afterAll(() => { mock.restore(); });

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
    const mount = s.indexOf('<WindowControls visible />');
    expect(wrapper).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(wrapper);
    // The wrapper closes right after the mount: no other block between them, so
    // the commands cannot drift back to the end of the row unnoticed.
    expect(s.slice(mount).indexOf('</div>')).toBeLessThan(200);
    // THE THREE CLASSES, one at a time and not as one literal string: pinning
    // the whole `className` made this test fail on a class ADDED next to them,
    // which is not what it is here to catch. Each one is load-bearing and each
    // is the kind a tidy-up drops — `app-no-drag` (the row is a drag region,
    // this island is not), `relative` (the commands are absolute inside it) and
    // `min-w-0`, without which this flex child never goes below its content:
    // the label stops truncating, the left group grows past its share and, the
    // row being `justify-between`, it runs INTO the notification bell. Measured
    // on CI 2026-08-31: bell at 113-141 with the Search button painted over it
    // at 127-184, so a click on the bell opened Search.
    const tag = s.slice(s.lastIndexOf('<div', wrapper), wrapper);
    for (const c of ['app-no-drag', 'relative', 'min-w-0']) expect(tag).toContain(c);
  });

  test('the "Topics" label sits next to them, on both systems', () => {
    expect(app()).toContain('isTauriMac || isTauriWindows ? TITLE_INSET_WITH_CONTROLS');
  });
});

/**
 * THE ROOM BETWEEN THE TWO GROUPS, which is a number and not an impression.
 *
 * The commands are absolute: they reserve nothing, so what keeps them off the
 * Topics chevron is the width of the word underneath - a system font, i.e. not a
 * layout contract. On Windows 11 (Segoe UI) it left two or three pixels and the
 * two groups read as one (card 3198947b). The width is now DECLARED, and these
 * three facts are what the declaration is computed from: change a cell size or
 * the anchor and the arithmetic has to be redone here first.
 */
describe('the reserved room', () => {
  test('the inset and its class say the same number', () => {
    expect(TITLE_INSET_WITH_CONTROLS).toBe(`pl-[${TITLE_INSET_PX}px]`);
  });

  test('cells and anchor are the ones the arithmetic assumes', () => {
    const html = renderToStaticMarkup(<WindowControls visible />);
    // 3 cells of 18 anchored at 6 = the group ends at 60 inside the wrapper.
    expect((html.match(/h-\[18px\] w-\[18px\]/g) || []).length).toBe(3);
    expect(html).toContain('left-[6px]');
    expect(TITLE_INSET_PX).toBe(72);
  });

  test('the title wrapper reserves it whenever the commands are on screen', () => {
    const s = readFileSync(join(import.meta.dir, '..', '..', 'App.tsx'), 'utf8');
    expect(s).toContain('isTauriMac || isTauriWindows ? TITLE_INSET_WITH_CONTROLS');
    // Not conditioned on a menu: the commands are permanent now, so is the room.
    expect(s).not.toContain('showTopicsMenu ? TITLE_INSET_WITH_CONTROLS');
  });
});
