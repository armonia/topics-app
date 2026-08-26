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
import { isTauri } from '../../lib/shell';
import { tauriInvoke } from '../../lib/shell/tauri';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';

/** True only inside the Tauri shell on Windows: that is where the frame is gone. */
export const isTauriWindows =
  isTauri &&
  typeof navigator !== 'undefined' &&
  // `userAgentData.platform` is the modern way and `platform` the deprecated but
  // still present one: both are read because WebView2 exposes both, and relying
  // on a single one means being wrong on one of the two versions.
  /Win/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      '',
  );

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  // The maximised state is ASKED of the window, never remembered: it can also be
  // maximised with a double-click on the bar, by dragging against the top edge or
  // with Win+Up, and a flag remembered here would drift in silence, leaving the
  // wrong glyph on the button.
  useEffect(() => {
    if (!isTauriWindows) return;
    let vivo = true;
    const leggi = () => {
      void tauriInvoke<boolean>('window_is_maximized')
        .then((v) => { if (vivo) setMaximized(Boolean(v)); })
        .catch(() => { /* the window is closing: there is nothing to update */ });
    };
    leggi();
    // `resize` covers every route: mouse, keyboard, snap, display change.
    window.addEventListener('resize', leggi);
    return () => { vivo = false; window.removeEventListener('resize', leggi); };
  }, []);

  if (!isTauriWindows) return null;

  const comanda = (action: 'minimize' | 'maximize' | 'close') => {
    void tauriInvoke<boolean>('window_control', { action }).catch(() => {});
    if (action === 'maximize') setMaximized((v) => !v);
  };

  // 46×32 with 10px glyphs: the measurements of the Windows 11 bar. The
  // background is transparent and lights up on hover, except for close, which goes
  // to the system red — it is the one of the three that cannot be undone, and it
  // shows.
  const bottone =
    'h-8 w-[46px] inline-flex items-center justify-center text-app-text/80 ' +
    'transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer';

  return (
    <div
      className="app-no-drag flex items-center flex-shrink-0 -mr-[6px]"
      {...NO_DRAG_REGION}
      // Not decoration: without a name, to assistive technology these are three
      // empty cells at the top of the window.
      role="group"
      aria-label="Window controls"
    >
      <button type="button" className={bottone} onClick={() => comanda('minimize')}
              aria-label="Minimize" title="Minimize" data-testid="win-minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className={bottone} onClick={() => comanda('maximize')}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'} data-testid="win-maximize">
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
              className={`${bottone} hover:!bg-[#c42b1c] hover:text-white`}
              onClick={() => comanda('close')}
              aria-label="Close" title="Close" data-testid="win-close">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
