/**
 * THE TAB *IS* THE BROWSER CHROME.
 *
 * A browser pane used to spend a full 40px row on a toolbar whose left half
 * (favicon + address) said exactly what the tab above it could say, and whose
 * right half (console, downloads, zoom, device, DevTools, session, forget-site)
 * was a row of glyphs that are looked at once an hour. On a split layout with
 * three browser panes that is 120px of vertical space spent on chrome.
 *
 * So the two pieces move onto the tab, which was already being drawn:
 *
 *  - `BrowserTabIcon`: the site favicon in the tab's icon slot, and on hover
 *    the reload button IN ITS PLACE. Reload is the single most used browser
 *    command and it now costs no width at all: at rest the slot shows where you
 *    are, under the pointer it shows what you want to do to it.
 *  - `BrowserTabMenuButton`: the three dots, which OPEN THE TAB SHEET
 *    (`BrowserTabSheet`) where everything else lives in plain sight. They carry
 *    the console-error count as a badge, because an error nobody surfaces is an
 *    error nobody fixes.
 *
 * Both read the pane's live state from `state/browserPaneChrome`, which the
 * panel publishes. Both degrade to nothing when the panel has not mounted yet
 * (a restored tab whose pane is still cold): the tab keeps its favicon slot,
 * and the dots stay away until there is something behind them.
 */
import { useCallback, useEffect, useState } from 'react';
import { RotateCw, MoreVertical, AlertCircle, Download } from 'lucide-react';
import { BrowserFavicon } from './BrowserFavicon';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { prefersReducedMotion } from '../../lib/reducedMotion';
import { useT } from '../../hooks/useT';

/** Stop the tab underneath from also handling the gesture. A click on the
 *  reload button must reload, not activate-and-reload; a pointerdown must not
 *  start dragging the tab. */
function swallow(e: React.SyntheticEvent): void {
  e.stopPropagation();
  e.preventDefault();
}

/**
 * The icon slot of a browser tab: favicon at rest, reload under the pointer.
 *
 * The swap is CSS-only (`group-hover` on the tab root) so it costs no state and
 * no re-render, and it is keyboard-reachable: the button also reveals itself on
 * `focus-visible`, otherwise reload would be a mouse-only command.
 */
export function BrowserTabIcon({ paneId, url }: { paneId: string; url: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const shown = chrome?.url || url;
  const canReload = !!chrome?.commands.reload;

  const act = useCallback((e: React.MouseEvent) => {
    swallow(e);
    chrome?.commands.reload?.();
  }, [chrome]);

  // BIGGER THAN THE OTHER TAB GLYPHS, on purpose: 16 against 14.
  //
  // The other tabs' 14x14 box exists to line their labels up; this slot is not
  // a decoration but the pane's identity AND its reload button, i.e. the most
  // pressed command of a browser, and at 14 the target was 14. The tab is 200px
  // wide (300 when active) for a label that rarely fills it, so the two extra
  // pixels come out of slack, not out of the address.
  return (
    <span
      className="relative flex items-center justify-center w-4 h-4 flex-shrink-0"
      data-testid="browser-tab-icon"
    >
      <BrowserFavicon
        url={shown}
        faviconUrl={chrome?.faviconUrl}
        size={16}
        className={canReload ? 'transition-opacity group-hover:opacity-0' : ''}
      />
      {canReload && (
        <button
          type="button"
          onClick={act}
          onPointerDown={swallow}
          onDoubleClick={swallow}
          className="absolute inset-0 flex items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none text-app-text-secondary hover:text-app-text"
          title={t('browser.tab.reload')}
          aria-label={t('browser.tab.reload')}
          data-testid="browser-tab-reload"
        >
          <RotateCw size={14} className={chrome?.loading ? 'animate-spin' : ''} />
        </button>
      )}
    </span>
  );
}

/**
 * The quiet cue that says "this page is logging errors".
 *
 * It sits in the tab's quiet rail, with the pin and the cloud glyph, and not on
 * the three dots: the dots only exist under the pointer, and a notification you
 * have to hover to discover is not a notification. Red is spent deliberately
 * here (every other cue in that rail is muted) because this one is the only one
 * that reports something BROKEN.
 */
export function BrowserTabConsoleCue({ paneId, onFill }: { paneId: string; onFill?: boolean }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const errors = chrome?.consoleErrors ?? 0;
  if (errors <= 0) return null;
  return (
    <span
      className={`flex items-center gap-0.5 tabular-nums text-micro font-medium ${onFill ? 'text-white' : DANGER_TEXT}`}
      title={t('browser.tab.consoleErrors', { n: String(errors) })}
      aria-label={t('browser.tab.consoleErrors', { n: String(errors) })}
      data-testid="browser-tab-console-cue"
    >
      <AlertCircle size={11} />
      {errors > 1 && errors}
    </span>
  );
}

/**
 * The quiet cue that says "a file landed here", twin of the console one and
 * sitting right beside it.
 *
 * A DOWNLOAD MUST NOT OPEN ANYTHING BY ITSELF. The sheet covers the page and
 * freezes it, so a file arriving while you read would take the page away from
 * you to tell you about something you did not ask for at that instant. Before
 * the sheet existed the same event brought a 40px row back over the page, which
 * was the same interruption with a bigger footprint.
 *
 * So the announcement is PASSIVE and the opening is yours: the cue appears (and
 * pulses once, unless the OS says no animations) and a click on it opens the
 * sheet with the Downloads section already down. `downloadsStarted` only drives
 * the appearing and the pulse; the tally is the number of files held.
 */
export function BrowserTabDownloadsCue({ paneId, onFill }: { paneId: string; onFill?: boolean }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const n = chrome?.downloads ?? 0;
  const started = chrome?.downloadsStarted ?? 0;
  const openDownloads = chrome?.commands.openDownloads;

  // The pulse is tied to the LAST START, not to the count: dismissing one entry
  // of three lowers the tally and must not look like a new file arriving.
  const [seenStarted, setSeenStarted] = useState(started);
  const [fresh, setFresh] = useState(false);
  if (started !== seenStarted) {
    setSeenStarted(started);
    setFresh(started > seenStarted);
  }
  useEffect(() => {
    if (!fresh) return;
    const timer = setTimeout(() => setFresh(false), 1600);
    return () => clearTimeout(timer);
  }, [fresh]);

  if (n <= 0) return null;
  const label = t('browser.tab.downloadsCue', { n: String(n) });
  return (
    <button
      type="button"
      onClick={(e) => { swallow(e); openDownloads?.(); }}
      onPointerDown={swallow}
      onDoubleClick={swallow}
      disabled={!openDownloads}
      className={`flex items-center gap-0.5 tabular-nums text-micro font-medium rounded-sm px-0.5 -mx-0.5 disabled:cursor-default ${
        onFill ? 'text-white' : 'text-app-text-faint/80 hover:text-app-text'
      } ${fresh && !prefersReducedMotion() ? 'animate-pulse' : ''}`}
      title={label}
      aria-label={label}
      data-testid="browser-tab-downloads-cue"
      data-fresh={fresh || undefined}
    >
      <Download size={11} />
      {n > 1 && n}
    </button>
  );
}

/**
 * The three dots: the third door to the tab sheet.
 *
 * VISIBILITY. At rest they are invisible: on a 150px tab three permanent dots
 * would be three permanent pixels stolen from the label. They appear on hover,
 * on focus, and STAY when the page has console errors, because that badge is a
 * notification and a notification you have to hover to see is not one.
 */
export function BrowserTabMenuButton({ paneId }: { paneId: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const errors = chrome?.consoleErrors ?? 0;
  const editAddress = chrome?.commands.editAddress;

  // THE DOTS ARE NOT A MENU ANY MORE, they are the third way into the ONE
  // surface. A menu here would be a second place to look for the same commands,
  // which is exactly what `TOPIC-BROWSER-02` forbids: the sheet holds them in
  // plain sight, and this button asks for it the same way a click on the tab
  // and Cmd+L do - all three bump `addressEditRequest`, which the sheet (drawn
  // from the tab's label, a few pixels to the left) answers.
  const openSheet = useCallback((e: React.MouseEvent) => {
    swallow(e);
    editAddress?.();
  }, [editAddress]);

  if (!chrome || !editAddress) return null;

  return (
    <button
      type="button"
      onClick={openSheet}
      onPointerDown={swallow}
      onDoubleClick={swallow}
      className={`relative w-4 h-4 flex items-center justify-center rounded flex-shrink-0 text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-opacity ${
        errors > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
      }`}
      title={t('browser.tab.menu')}
      aria-label={t('browser.tab.menu')}
      aria-haspopup="dialog"
      data-testid="browser-tab-menu"
      data-console-errors={errors || undefined}
    >
      <MoreVertical size={13} />
      {errors > 0 && (
        // The badge sits ON the dots, like an app icon's: it says "there is
        // something in here", which is precisely what it is.
        <span
          className="absolute -top-0.5 -right-0.5 min-w-[8px] h-[8px] rounded-full bg-red-600 dark:bg-red-500 ring-1 ring-app-bg"
          aria-hidden
        />
      )}
    </button>
  );
}
