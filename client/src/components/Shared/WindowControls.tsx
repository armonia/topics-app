/**
 * The three window commands on Windows: minimise, maximise/restore, close.
 *
 * They exist because on Windows the system title bar is OFF: the app draws its
 * own (`app-drag-region` in App.tsx) and leaving the native one as well meant
 * having two, which is the defect reported on 2026-08-26 ("the Windows build has
 * the system bar we had removed"). But removing the frame also removes its three
 * buttons: without these, the window could no longer be minimised, maximised or
 * closed except through the taskbar. Removing the trim must not mean removing the
 * controls.
 *
 * NOT mounted on macOS or on the web: there the frame exists (on macOS it is the
 * three traffic lights, which Tauri paints over our own row via
 * `TitleBarStyle::Overlay`), and a second set would be the same mistake mirrored.
 *
 * The shape is Windows 11's own, not an invention: three 46×32 cells at the top
 * right, thin glyphs, the close one turning red. A Windows user finds them where
 * they look for them and recognises them without having to read.
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

  // 46×32 with 10px glyphs: the measurements of the Windows 11 bar. The
  // background is transparent and lights up on hover, except for close, which goes
  // to the system red — it is the one of the three that cannot be undone, and it
  // shows.
  const cellClass =
    'h-8 w-[46px] inline-flex items-center justify-center text-app-text/80 ' +
    'transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer';
  // `-1` while invisible: `aria-hidden` removes the name, but on its own it does
  // not take the button out of the Tab order — and focus landing on something
  // invisible is how a keyboard gets lost.
  const tab = visible ? 0 : -1;

  return (
    <div
      // `w-0 overflow-hidden` WHILE HIDDEN, and this is the part that matters on
      // a narrow sidebar. `opacity-0` hides the ink but keeps the BOX: these
      // three cells are 138px that stay reserved even when nobody can see or
      // click them. Measured on Windows at a 255px sidebar: the z-50 group asked
      // for 210px and had 204, so the notification bell was pushed under this
      // group and `elementFromPoint` at its centre answered "New (Ctrl+N)" — the
      // bell was unclickable again, the same defect as the Ctrl+K row arriving
      // through a different door.
      //
      // The node stays mounted (not `hidden`, not unmounted) so the fade still
      // plays and the keyboard order stays governed by `tabIndex` above.
      className={`app-no-drag flex items-center flex-shrink-0 -mr-[6px] transition-opacity duration-150 ${
        visible ? 'opacity-100' : 'w-0 overflow-hidden opacity-0 pointer-events-none'
      }`}
      aria-hidden={!visible}
      {...NO_DRAG_REGION}
      // Not decoration: without a name, to assistive technology these are three
      // empty cells at the top of the window.
      role="group"
      aria-label="Window controls"
    >
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
      <button type="button"
              className={`${cellClass} hover:!bg-[#c42b1c] hover:text-white`}
              onClick={() => command('close')}
              aria-label="Close" title="Close" data-testid="win-close" tabIndex={tab}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
