/**
 * The three window commands on Windows, drawn ON THE TOPICS BUTTON: close,
 * minimise, maximise/restore.
 *
 * They exist because on Windows the system title bar is OFF: the app draws its
 * own (`app-drag-region` in App.tsx) and leaving the native one as well meant
 * having two, which is the defect reported on 2026-08-26 ("the Windows build has
 * the system bar we had removed"). But removing the frame also removes its three
 * buttons: without these, the window could no longer be minimised, maximised or
 * closed except through the taskbar. Removing the trim must not mean removing the
 * controls.
 *
 * WHERE THEY SIT, and this is the whole point of the file. On macOS the three
 * traffic lights are hidden and come out over the word "Topics" when the Topics
 * menu opens (`trafficLightPosition { x: 12, y: 12 }` in tauri.conf.json, the
 * label going `invisible` in App.tsx). These used to come out at the OTHER end of
 * the same row, next to search and "+", so the same app closed its window on the
 * left on one system and on the right on the other, and whoever moves between the
 * two had to relearn it. Reported on the board (card 7aff3fd9): the commands
 * should come out of the Topics button, like on the Mac. So the geometry here is
 * copied from the Mac and not from Windows 11: same anchor (12px from the left
 * edge of the row), same trigger (the Topics menu), and the SAME ORDER —
 * close, minimise, maximise. The glyphs stay Windows' own, because a Windows user
 * reads those and not three coloured dots.
 *
 * ABSOLUTELY POSITIONED, deliberately: the chrome row is `h-10` and its height is
 * derived from its buttons, so these three must not be in the flow of that row —
 * out of the flow they can neither make it taller nor push the title, the bell or
 * the two commands on the right by a single pixel, whether they are showing or
 * not.
 *
 * NOT mounted on macOS or on the web: there the frame exists (on macOS it is the
 * three traffic lights, which Tauri paints over our own row via
 * `TitleBarStyle::Overlay`), and a second set would be the same mistake mirrored.
 */
import { useEffect, useState } from 'react';
import { isTauriWindows } from '../../lib/shell';
import { tauriInvoke } from '../../lib/shell/tauri';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';

export function WindowControls({ visible }: { visible: boolean }) {
  const [maximized, setMaximized] = useState(false);

  // The maximised state is ASKED of the window, never remembered: it can also be
  // maximised with a double-click on the bar, by dragging against the top edge or
  // with Win+Up, and a flag remembered here would drift in silence, leaving the
  // wrong glyph on the button.
  useEffect(() => {
    if (!isTauriWindows) return;
    let alive = true;
    const read = () => {
      void tauriInvoke<boolean>('window_is_maximized')
        .then((v) => { if (alive) setMaximized(Boolean(v)); })
        .catch(() => { /* the window is closing: there is nothing to update */ });
    };
    read();
    // `resize` covers every route: mouse, keyboard, snap, display change.
    window.addEventListener('resize', read);
    return () => { alive = false; window.removeEventListener('resize', read); };
  }, []);

  if (!isTauriWindows) return null;

  // THESE SHOW WHEN THE macOS TRAFFIC LIGHTS SHOW — i.e. with the Topics menu open.
  //
  // On macOS the three lights stay hidden and appear only there
  // (`useSidebarAndLayout`, show/hideTrafficLights): the top row is clean, and
  // window commands are asked for. Keeping the three Windows buttons permanently
  // visible was an inconsistency between the two platforms — the same app
  // behaving in two ways depending on the system.
  //
  // They are NOT unmounted: they stay in the DOM with `aria-hidden` and out of
  // the keyboard focus order, so appearing does not reflow the row (the "Topics"
  // title would slide under the pointer mid-click) and Tab navigation does not
  // land on them while they are invisible.

  const command = (action: 'minimize' | 'maximize' | 'close') => {
    void tauriInvoke<boolean>('window_control', { action }).catch(() => {});
    if (action === 'maximize') setMaximized((v) => !v);
  };

  // 18×18 with 10px glyphs, three in a row: 54px, which is what the word "Topics"
  // measures underneath (15px semibold) and what the three traffic lights measure
  // on the Mac. The Windows 11 cell is 46×32 and it was right at the end of the
  // row; over a label it would be a 138px slab covering the chevron as well. The
  // background is transparent and lights up on hover, except for close, which goes
  // to the system red — it is the one of the three that cannot be undone, and it
  // shows.
  const cellClass =
    'h-[18px] w-[18px] rounded inline-flex items-center justify-center text-app-text/80 ' +
    'transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer';
  // `-1` while invisible: `aria-hidden` removes the name, but on its own it does
  // not take the button out of the Tab order — and focus landing on something
  // invisible is how a keyboard gets lost.
  const tab = visible ? 0 : -1;

  return (
    <div
      // OUT OF THE FLOW, always: `absolute` over the Topics button, anchored at
      // ROW_INSET from its left edge, which puts the first cell at x=12 — the
      // Mac's `trafficLightPosition.x`. This also settles, by construction, the
      // defect measured on Windows at a 255px sidebar when these three sat in the
      // row: switched OFF they still reserved 138px, the z-50 group asked for
      // 210px and had 204, the notification bell ended up underneath and
      // `elementFromPoint` at its centre answered "New (Ctrl+N)". An absolute box
      // reserves nothing, lit or unlit.
      //
      // The node stays mounted (not `hidden`, not unmounted) so the fade still
      // plays and the keyboard order stays governed by `tabIndex` above.
      className={`app-no-drag absolute left-[6px] top-1/2 -translate-y-1/2 z-10 flex items-center transition-opacity duration-150 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      aria-hidden={!visible}
      {...NO_DRAG_REGION}
      // Not decoration: without a name, to assistive technology these are three
      // empty cells at the top of the window.
      role="group"
      aria-label="Window controls"
    >
      {/* CLOSE FIRST, and it is the one line of this file that will look wrong to
          whoever knows Windows 11. It is where the Mac puts it, these three come
          out where the Mac's come out, and the point of the whole change is that
          the window closes in the same place on both systems. Order and position
          are one decision, not two: keeping the Windows order under the Mac
          anchor would put close under the pointer that on the Mac minimises. */}
      <button type="button"
              className={`${cellClass} hover:!bg-[#c42b1c] hover:text-white`}
              onClick={() => command('close')}
              aria-label="Close" title="Close" data-testid="win-close" tabIndex={tab}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className={cellClass} onClick={() => command('minimize')}
              aria-label="Minimize" title="Minimize" data-testid="win-minimize" tabIndex={tab}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className={cellClass} onClick={() => command('maximize')}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'} data-testid="win-maximize" tabIndex={tab}>
        {maximized ? (
          // Restore: two offset rectangles, the way Windows draws them.
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5V0.5h7v7h-2" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
    </div>
  );
}
