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
 *  - `BrowserTabTypeIcon`: WHAT KIND of browser tab this is (shared, real
 *    Chromium, connection gone) between the favicon and the title, and nothing
 *    at all on the default kind. It is where the three pills that used to float
 *    over the page ended up — see `TOPIC-BROWSER-03`.
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
import { RotateCw, MoreVertical, AlertCircle, Download, MonitorSmartphone, Puzzle, WifiOff, WifiLow, Loader2, Bot } from 'lucide-react';
import { BrowserFavicon } from './BrowserFavicon';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
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
 * WHAT KIND OF BROWSER TAB THIS IS — one icon, between the favicon and the
 * title, and only when the answer is not the default one.
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
export function BrowserTabTypeIcon({ paneId }: { paneId: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  if (!chrome) return null;

  // ABSENT MEANS CONNECTED, not "unknown": the native and iframe panes have no
  // streaming socket, and a pane with no socket cannot have lost one. Reading
  // absence as a problem would have put a warning glyph on every native tab.
  const connection = chrome.connection ?? 'connected';

  // FOUR STATES, FOUR GLYPHS, and `fallback-http` keeps its own on purpose: it
  // is not "connecting" (the page IS updating, over polling) and not "gone".
  // Folding it into the spinner would have said "still trying" about a link
  // that already settled, which is the one wrong thing you can say about a
  // degraded connection.
  // THE AGENT COMES FIRST, and it is the one kind that is not a property of
  // the pane but a thing happening right now. Until 2026-09-14 it was said by
  // covering the page with `bg-black/40 backdrop-blur` and a box in the middle:
  // the single moment you most want to watch the page was the moment the page
  // was taken away. The fact moved here; over the page only the transparent
  // layer that swallows the clicks is left.
  const kind =
    chrome.agentActive ? 'agent'
    : connection === 'disconnected' ? 'disconnected'
    : connection === 'connecting' ? 'connecting'
    : connection === 'fallback-http' ? 'degraded'
    : chrome.engine === 'chromium' ? 'chromium'
    // SHARED IS THE EFFECTIVE RENDER, and the pane publishes it as such: true
    // only where the page actually lives on the server and another device can
    // therefore be looking at it. An iframe pane draws the page with this
    // device's own engine and publishes `shared: false`, so the icon stays off
    // the default kind without this line having to guess.
    //
    // It was briefly gated on `shareMode` too, to keep the icon off panes where
    // sharing is not a CHOICE. That reading silenced it on the entire web
    // client, where `shareMode` is undefined (there is no native view to choose
    // instead) and every streaming pane is genuinely the shared session: the
    // one place the icon has something to say, it said nothing. The fact is
    // worth an icon wherever it holds - "your phone can be watching this" does
    // not stop being true because you could not have had it otherwise.
    : chrome.shared ? 'shared'
    : undefined;
  if (!kind) return null;

  const Glyph =
    kind === 'agent' ? Bot
    : kind === 'disconnected' ? WifiOff
    : kind === 'connecting' ? Loader2
    : kind === 'degraded' ? WifiLow
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
    : kind === 'chromium' ? t('browser.tab.kind.chromium', { n: String(chrome.engineExtensions ?? 0) })
    : t('browser.tab.kind.shared');

  // THE LINK STATES KEEP THEIR COLOUR, the other two do not.
  //
  // The pill said "Polling" in yellow and "Connecting..." with a pulsing yellow
  // dot; here the text is gone and only an 11px glyph is left, so in the muted
  // ink of a tab's quiet rail "the connection is degraded" would have been
  // legible exactly to whoever already knew. Red stays reserved for the state
  // that is BROKEN (same rule as the console cue a few pixels to the right) and
  // amber carries the two that are WORKING BADLY - the measured pair in
  // `popoverStyles`, not a hand-picked yellow, because 11px is normal-text
  // contrast and `amber-400` alone misses it in the light theme.
  //
  // Chromium and shared are facts, not faults: muted ink, no colour spent.
  const tone =
    kind === 'agent' ? 'text-primary'
    : kind === 'disconnected' ? DANGER_TEXT
    : kind === 'connecting' || kind === 'degraded' ? WARNING_TEXT
    : 'text-app-text-faint';

  const glyph = (
    <Glyph size={11} className={kind === 'connecting' && !prefersReducedMotion() ? 'animate-spin' : ''} />
  );

  // THE AGENT GLYPH IS A BUTTON, the other four are not. Every other kind
  // reports a fact you cannot act on from a 11px box; this one names a state
  // that the person may want to END, and the page underneath is now visible and
  // untouched, so the tab is the only place left holding a handle. It is also
  // the handle on the paths where the page itself cannot carry one (the native
  // pane composites above the DOM: a transparent layer over it would catch
  // nothing).
  if (kind === 'agent' && chrome.commands.takeControl) {
    const takeControl = chrome.commands.takeControl;
    return (
      <button
        type="button"
        className={`flex items-center justify-center w-3 h-3 flex-shrink-0 ${tone} hover:opacity-70 transition-opacity`}
        title={`${label} - ${t('browser.agent.takeControl')}`}
        aria-label={t('browser.agent.takeControl')}
        data-testid="browser-tab-type-icon"
        data-kind={kind}
        data-connection={chrome.connection}
        onPointerDown={swallow}
        onDoubleClick={swallow}
        onClick={(e) => { swallow(e); takeControl(); }}
      >
        {glyph}
      </button>
    );
  }

  return (
    <span
      className={`flex items-center justify-center w-3 h-3 flex-shrink-0 ${tone}`}
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
 *
 * IT IS DRAWN TWICE, and that is the tab's own idiom rather than a duplicate.
 * The quiet rail and the command rail TAKE TURNS: hover a tab and `.row-trail`
 * goes `opacity: 0; pointer-events: none` while `.row-actions` lights up
 * (`index.css`). So a cue that is only a signal cannot be clicked - the very
 * gesture that reaches for it is the one that switches its rail off. Measured:
 * Playwright reported the close ring intercepting every click aimed at it. The
 * copy in the quiet rail is therefore inert (`disabled`, out of the tab order)
 * and the copy in the command rail is the button, in the same spot - exactly
 * how the close ring already takes over from the notification badge.
 */
export function BrowserTabDownloadsCue({ paneId, onFill, inRail }: {
  paneId: string;
  onFill?: boolean;
  /** Drawn inside the tab's COMMAND rail rather than its quiet one. Same glyph,
   *  same spot: the two rails take turns (`index.css`, `.row-trail` goes
   *  `pointer-events: none` on hover), so the pressable copy lives here and the
   *  one you read at rest lives there. */
  inRail?: boolean;
}) {
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
      // In the quiet rail it is a SIGNAL and nothing else - that rail stops
      // taking pointer events the instant you hover it, so a live handler there
      // would only ever be a promise the CSS breaks.
      disabled={!inRail || !openDownloads}
      tabIndex={inRail ? undefined : -1}
      className={`flex items-center gap-0.5 tabular-nums text-micro font-medium rounded-sm disabled:cursor-default ${
        inRail
          ? 'w-4 h-4 justify-center text-app-text-secondary hover:text-app-text hover:bg-app-hover'
          : `px-0.5 -mx-0.5 ${onFill ? 'text-white' : 'text-app-text-faint/80'}`
      } ${fresh && !prefersReducedMotion() ? 'animate-pulse' : ''}`}
      title={label}
      aria-label={label}
      data-testid={inRail ? 'browser-tab-downloads-cue' : 'browser-tab-downloads-signal'}
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
      // A door of the sheet: pressed while it is open, it closes it.
      data-sheet-door=""
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
