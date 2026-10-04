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
 *  - `BrowserTabCornerMark`: the favicon's corner, zero width (TABSLOT-03).
 *    It carries the console errors or, without them, WHAT KIND of browser tab
 *    this is (shared, real Chromium, connection gone; nothing on the default
 *    kind), which is where the three pills that used to float over the page
 *    ended up (`TOPIC-BROWSER-03`), one at a time by `browserCornerMark`. The
 *    kind is also said by the tab's accessible name (`browserKindNames.ts`).
 *  - `BrowserTabTakeControl`: while an agent drives, "take back control", a
 *    command of its own beside the dots, clear of Reload.
 *  - `BrowserTabMenuButton`: the three dots, which OPEN THE TAB SHEET
 *    (`BrowserTabSheet`) where everything else lives in plain sight, and the
 *    downloads with it.
 *
 * Both read the pane's live state from `state/browserPaneChrome`, which the
 * panel publishes. Both degrade to nothing when the panel has not mounted yet
 * (a restored tab whose pane is still cold): the tab keeps its favicon slot,
 * and the dots stay away until there is something behind them.
 */
import { useCallback } from 'react';
import { RotateCw, MoreVertical, MonitorSmartphone, Puzzle, WifiOff, WifiLow, Loader2, Bot, Gauge, CirclePause, Hand } from 'lucide-react';
import { browserCornerMark, browserTabKind, type BrowserTabKind } from './browserTabKind';
import { BrowserFavicon } from './BrowserFavicon';
import {
  useBrowserPaneChrome, type BrowserPaneChrome,
} from '../../state/browserPaneChrome';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { prefersReducedMotion } from '../../lib/reducedMotion';
import { useActiveLocale, useT } from '../../hooks/useT';
import { machineMemoryMb } from '../../lib/shell/heavyPanes';
import { pageSharePct } from './pausedUsage';
import { pctPlaceholders } from '../../lib/machineBusy';

const CPU_CORES = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 1) || 1);

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
  //
  // `tap-expand` on the button: 16 is still under the 24 of WCAG 2.5.8, so the
  // area that answers is a 24 square on the favicon (44 under a finger). Its
  // overhang lands on the tab's own padding, i.e. on the tab that holds it.
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
          className="tap-expand absolute inset-0 flex items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none text-app-text-secondary hover:text-app-text"
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
 * THE FAVICON'S CORNER (TABSLOT-03): one mark, zero width, so the label never
 * moves when a mark comes or goes. Until 2026-09-29 the kind sat in flow
 * between the favicon and the title, a fourth zone that pushed the label 20px
 * to the right every time the agent took the wheel.
 *
 * Which mark wins when both are true is `browserCornerMark`: a link that is
 * not live, then the console errors, then the kind. None is a command: "take back control" has its own
 * button (`BrowserTabTakeControl`), because a 10px corner on the favicon sits
 * on the Reload button, which fills the favicon's box.
 */
export function BrowserTabCornerMark({ paneId }: { paneId: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  if (!chrome) return null;
  const kind = browserTabKind(chrome);
  const errors = chrome.consoleErrors ?? 0;
  const mark = browserCornerMark(kind, errors);
  if (mark === 'kind' && kind) return <KindMark chrome={chrome} kind={kind} />;
  if (mark === 'errors') return <ConsoleCue errors={errors} />;
  return null;
}

/**
 * WHAT KIND OF BROWSER TAB THIS IS — one glyph on the favicon's corner, and
 * only when the answer is not the default one.
 *
 * THE DEFAULT KIND DRAWS NOTHING. A tab on its own device's view, not shared,
 * connected, on the server's bundled engine is what a browser tab simply *is*:
 * an icon there would be a badge every tab carries, i.e. no information at all,
 * paid for in the label's width on a 200px tab.
 *
 * ONE ICON, NOT THREE. Until 2026-09-14 these three facts were three pills
 * floating over the page itself (connection top-right, engine top-left, render
 * mode bottom-left) — switches parked on top of what they switched, which is
 * what `TOPIC-BROWSER-03` forbids. The switches moved into the sheet, where a
 * click can reach them; what stays here is only the ANSWER, and the tab has
 * room for one. So they are ordered by what a person needs to know first:
 *
 *  1. THE CONNECTION IS NOT THERE. A page that stopped updating looks exactly
 *     like a page that has nothing new to show, so this is the only one of the
 *     three that explains something you can otherwise misread.
 *  2. THIS IS NOT THE USUAL ENGINE. Running on the real Chromium means the
 *     extensions and the profile are in play — worth saying, because it changes
 *     what the page does.
 *  3. THIS PANE IS SHARED. The page is on the server and another device can be
 *     looking at it.
 *
 * The render mode (DOM ↔ video) is deliberately NOT here: both render the same
 * page and the difference is visible in the page itself, so it stays a switch in
 * the sheet without an icon of its own.
 */
function KindMark({ chrome, kind }: { chrome: BrowserPaneChrome; kind: BrowserTabKind }) {
  const t = useT();
  const locale = useActiveLocale();

  // The order of the kinds, and why the agent comes first, is in `browserTabKind`.
  // Until 2026-09-14 the agent was said by covering the page with a dark sheet:
  // the moment you most want to watch the page was the moment it was taken away.

  const Glyph =
    kind === 'agent' ? Bot
    : kind === 'disconnected' ? WifiOff
    : kind === 'connecting' ? Loader2
    : kind === 'degraded' ? WifiLow
    : kind === 'heavy-paused' ? CirclePause
    : kind === 'heavy' ? Gauge
    : kind === 'chromium' ? Puzzle
    : MonitorSmartphone;

  // THE TITLE SAYS WHAT THE AGENT IS DOING, when the pane knows: the action was
  // the one thing the removed box carried that the glyph alone cannot, and a
  // tooltip is where a running commentary belongs.
  const label =
    kind === 'agent'
      ? (chrome.agentAction
        ? t('browser.tab.kind.agentDoing', { action: chrome.agentAction })
        : t('browser.tab.kind.agent'))
    : kind === 'disconnected' ? t('browser.tab.kind.disconnected')
    : kind === 'connecting' ? t('browser.tab.kind.connecting')
    : kind === 'degraded' ? t('browser.tab.kind.degraded')
    : kind === 'heavy-paused' ? t('browser.tab.kind.heavyPaused')
    : kind === 'heavy' ? t('browser.tab.kind.heavy', pctPlaceholders(locale, { pct: pageSharePct({ cpu: chrome.heavy?.cpu ?? 0 }, { cores: CPU_CORES, memMb: machineMemoryMb() }) }))
    : kind === 'chromium' ? t('browser.tab.kind.chromium', { n: String(chrome.engineExtensions ?? 0) })
    : t('browser.tab.kind.shared');

  // THE LINK STATES KEEP THEIR COLOUR, the other two do not.
  //
  // The pill said "Polling" in yellow and "Connecting..." with a pulsing yellow
  // dot; here the text is gone and only an 8px glyph is left, so in the muted
  // ink of a tab's quiet rail "the connection is degraded" would have been
  // legible exactly to whoever already knew. Red stays reserved for the state
  // that is BROKEN (same rule as the console cue that shares its corner) and
  // amber carries the two that are WORKING BADLY - the measured pair in
  // `popoverStyles`, not a hand-picked yellow, because a glyph this small is
  // normal-text contrast and `amber-400` alone misses it in the light theme.
  //
  // Chromium and shared are facts, not faults: muted ink, no colour spent.
  const tone =
    kind === 'agent' ? 'text-primary'
    : kind === 'disconnected' ? DANGER_TEXT
    : kind === 'connecting' || kind === 'degraded' || kind === 'heavy' ? WARNING_TEXT
    : 'text-app-text-faint';

  const glyph = (
    <Glyph size={8} className={kind === 'connecting' && !prefersReducedMotion() ? 'animate-spin' : ''} />
  );

  return (
    <span
      className={`tab-corner-mark bg-app-bg ring-1 ring-app-bg ${tone}`}
      title={label}
      aria-label={label}
      data-testid="browser-tab-type-icon"
      data-kind={kind}
      // The RAW connection state, not the glyph's name: `degraded` and
      // `connecting` are two different link states and a test that cannot tell
      // them apart cannot prove the state machine never hangs in 'connecting'
      // (`browser-ws-streaming`). Absent on the panes that have no socket.
      data-connection={chrome.connection}
    >
      {glyph}
    </span>
  );
}

/**
 * "Take back control", while an agent drives this pane.
 *
 * It used to be the agent glyph on the favicon's corner: a 10px target whose
 * box overlapped the Reload button (which fills the favicon) by 6x6px, so a
 * click aimed at one could land on the other. Now it is a command like the
 * dots, beside them in the tab's hover extras (`.tab-extras`): 16px, clear of
 * Reload, the dots and Close. Keyboard focus reveals it like the others.
 *
 * It exists while the state does: the pane offers `takeControl` only while an
 * agent is at the wheel, and a command that ends a state nobody is in is a
 * dead door. The page itself is the other handle where it can carry one (the
 * transparent layer in `RemoteBrowserPanel`); on the native pane, which
 * composites above the DOM, this button is the only one.
 */
export function BrowserTabTakeControl({ paneId }: { paneId: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const takeControl = chrome?.agentActive ? chrome.commands.takeControl : undefined;
  if (!chrome || !takeControl) return null;
  const doing = chrome.agentAction
    ? t('browser.tab.kind.agentDoing', { action: chrome.agentAction })
    : t('browser.tab.kind.agent');
  return (
    <button
      type="button"
      onClick={(e) => { swallow(e); takeControl(); }}
      onPointerDown={swallow}
      onDoubleClick={swallow}
      className="tap-expand w-4 h-4 flex items-center justify-center rounded flex-shrink-0 text-primary hover:bg-app-hover"
      title={`${doing} - ${t('browser.agent.takeControl')}`}
      aria-label={t('browser.agent.takeControl')}
      data-testid="browser-tab-take-control"
    >
      <Hand size={12} />
    </button>
  );
}

/**
 * "This page is logging errors", as a corner mark on the favicon (TABSLOT-03).
 *
 * It used to sit in flow after the label, where every error that appeared took
 * the label's width and moved it. A corner is zero width and is still drawn at
 * rest, which is the part that matters: a notification you have to hover to
 * find is not a notification. Red is spent deliberately, because this is the
 * one mark that reports something BROKEN. The count is in its tooltip and the
 * console is one click away in the sheet.
 */
function ConsoleCue({ errors }: { errors: number }) {
  const t = useT();
  return (
    <span
      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-600 dark:bg-red-500 ring-1 ring-app-bg pointer-events-auto"
      title={t('browser.tab.consoleErrors', { n: String(errors) })}
      aria-label={t('browser.tab.consoleErrors', { n: String(errors) })}
      role="img"
      data-testid="browser-tab-console-cue"
      data-console-errors={errors}
    />
  );
}

/**
 * The three dots: the third door to the tab sheet.
 *
 * VISIBILITY is the tab's business, not this button's: the dots ride in the
 * tab's hover extras (`.tab-extras`), which cover the tail of the label instead
 * of taking its width (TABSLOT-01). The console errors are announced at rest by
 * the favicon's corner mark (`BrowserTabCornerMark`).
 *
 * DOWNLOADS LIVE HERE TOO (TABSLOT-03). A file that lands gives the dots a
 * count, and while there is one the dots open the sheet on its Downloads
 * section, the list the count announces. A download never opens anything by
 * itself: it would take the page away from you to report something you did
 * not ask about at that instant.
 */
export function BrowserTabMenuButton({ paneId }: { paneId: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const errors = chrome?.consoleErrors ?? 0;
  const downloads = chrome?.downloads ?? 0;
  const editAddress = chrome?.commands.editAddress;
  const openDownloads = chrome?.commands.openDownloads;

  // THE DOTS ARE NOT A MENU ANY MORE, they are the third way into the ONE
  // surface. A menu here would be a second place to look for the same commands,
  // which is exactly what `TOPIC-BROWSER-02` forbids: the sheet holds them in
  // plain sight, and this button asks for it the same way a click on the tab
  // and Cmd+L do - all three bump `addressEditRequest`, which the sheet (drawn
  // from the tab's label, a few pixels to the left) answers.
  const openSheet = useCallback((e: React.MouseEvent) => {
    swallow(e);
    if (downloads > 0 && openDownloads) openDownloads();
    else editAddress?.();
  }, [downloads, openDownloads, editAddress]);

  if (!chrome || !editAddress) return null;

  return (
    <button
      type="button"
      onClick={openSheet}
      onPointerDown={swallow}
      onDoubleClick={swallow}
      className="tap-expand relative w-4 h-4 flex items-center justify-center rounded flex-shrink-0 text-app-text-secondary hover:text-app-text hover:bg-app-hover"
      title={downloads > 0 ? `${t('browser.tab.menu')}\n${t('browser.tab.downloadsCue', { n: String(downloads) })}` : t('browser.tab.menu')}
      aria-label={downloads > 0 ? `${t('browser.tab.menu')}, ${t('browser.tab.downloadsCue', { n: String(downloads) })}` : t('browser.tab.menu')}
      aria-haspopup="dialog"
      // A door of the sheet: pressed while it is open, it closes it.
      data-sheet-door=""
      data-testid="browser-tab-menu"
      data-console-errors={errors || undefined}
      data-downloads={downloads || undefined}
    >
      <MoreVertical size={13} />
      {(errors > 0 || downloads > 0) && (
        // The badge sits ON the dots, like an app icon's: it says "there is
        // something in here", which is precisely what it is.
        <span
          className={`absolute -top-0.5 -right-0.5 min-w-[8px] h-[8px] rounded-full ring-1 ring-app-bg ${errors > 0 ? 'bg-red-600 dark:bg-red-500' : 'bg-primary'}`}
          aria-hidden
        />
      )}
    </button>
  );
}
