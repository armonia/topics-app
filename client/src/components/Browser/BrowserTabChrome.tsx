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
 *  - `BrowserTabMenuButton`: the three dots, and behind them everything else.
 *    It carries the console-error count as a badge, because an error nobody
 *    surfaces is an error nobody fixes: that was the whole point of the console
 *    badge living in the toolbar, and it must not be lost by hiding the toolbar.
 *
 * Both read the pane's live state from `state/browserPaneChrome`, which the
 * panel publishes. Both degrade to nothing when the panel has not mounted yet
 * (a restored tab whose pane is still cold): the tab keeps its favicon slot,
 * and the menu only offers what the pane actually published.
 */
import { useCallback, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, RotateCw, MoreVertical, ExternalLink, Copy, Check,
  Code2, Terminal, Download, Trash2, Minus, Plus, MonitorSmartphone, Pencil, AlertCircle,
  CornerUpLeft,
  Monitor, Smartphone, Tablet, Maximize,
} from 'lucide-react';
import { BrowserFavicon } from './BrowserFavicon';
import { Menu } from '../Shared/Menu';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
// Per-platform, not written out: on Windows there is no ⌘ and no ⌥.
import { shortcut } from '../../lib/shortcutLabel';
import type { DeviceMode } from './browserDevTypes';
import { POPOVER_ITEM, POPOVER_ITEM_DANGER, POPOVER_DIVIDER, DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { prettyUrl } from '../../lib/browserNavUrl';
import { copyText } from '../../lib/clipboard';
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
      className={`flex items-center gap-0.5 tabular-nums text-[10px] font-medium ${onFill ? 'text-white' : DANGER_TEXT}`}
      title={t('browser.tab.consoleErrors', { n: String(errors) })}
      aria-label={t('browser.tab.consoleErrors', { n: String(errors) })}
      data-testid="browser-tab-console-cue"
    >
      <AlertCircle size={11} />
      {errors > 1 && errors}
    </span>
  );
}

/** One icon in the menu's leading command row. */
function RowButton({
  icon, label, onClick, disabled, testId,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      title={label}
      aria-label={label}
      data-testid={testId}
      className="w-7 h-7 flex items-center justify-center rounded-md text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
    >
      {icon}
    </button>
  );
}

const DEVICE_GLYPH: Record<DeviceMode, typeof Monitor> = {
  desktop: Monitor, mobile: Smartphone, tablet: Tablet, auto: Maximize, custom: Maximize,
};

/**
 * The three dots, and the menu behind them.
 *
 * VISIBILITY. At rest the dots are invisible: on a 150px tab three permanent
 * dots would be three permanent pixels stolen from the address. They appear on
 * hover, on focus, while the menu is open, and STAY when the page has console
 * errors, because that badge is a notification and a notification you have to
 * hover to see is not one.
 */
export function BrowserTabMenuButton({ paneId }: { paneId: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const c = chrome?.commands;
  const errors = chrome?.consoleErrors ?? 0;
  const warnings = chrome?.consoleWarnings ?? 0;
  const downloads = chrome?.downloads ?? 0;

  const run = useCallback((fn?: () => void) => () => { setOpen(false); fn?.(); }, []);

  // COPY WHAT THE MENU SHOWS, and say so only when it happened.
  //
  // Two defects in four lines, and they were both invisible from here. The
  // clipboard got the RAW url while the line eleven pixels above showed
  // `prettyUrl` of it: on a local file that meant the menu read
  // `file:///Users/…/b.pdf` and the paste read
  // `tauri://localhost/api/media?path=%2FUsers%2F…`. And the failure branch was
  // an empty function, so outside a secure context (LAN over http, some
  // webviews) nothing was copied and nothing was said either - `copyText` is
  // the one door that answers with a boolean instead of throwing.
  const address = chrome ? prettyUrl(chrome.url) : '';
  const copyAddress = useCallback(() => {
    if (!address) return;
    void copyText(address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [address]);

  if (!chrome) return null;

  const DeviceGlyph = DEVICE_GLYPH[chrome.deviceMode] ?? Monitor;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { swallow(e); setOpen((o) => !o); }}
        onPointerDown={swallow}
        onDoubleClick={swallow}
        className={`relative w-4 h-4 flex items-center justify-center rounded flex-shrink-0 text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-opacity ${
          open || errors > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
        title={t('browser.tab.menu')}
        aria-label={t('browser.tab.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="browser-tab-menu"
        data-console-errors={errors || undefined}
      >
        <MoreVertical size={13} />
        {errors > 0 && (
          // The badge sits ON the dots, like an app icon's: it says "there is
          // something in here", which is precisely what a menu notification is.
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[8px] h-[8px] rounded-full bg-red-600 dark:bg-red-500 ring-1 ring-app-bg"
            aria-hidden
          />
        )}
      </button>

      <Menu
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        align="right"
        minWidth={232}
        testId="browser-tab-menu-panel"
        ariaLabel={t('browser.tab.menu')}
      >
        {/* WHERE YOU ARE, in full. The tab truncates the address; the menu is
            the one surface with room to show it whole. */}
        {address && (
          <div className="px-3 pt-2 pb-1.5 flex items-start gap-2">
            <BrowserFavicon url={chrome.url} faviconUrl={chrome.faviconUrl} size={14} className="mt-[1px]" />
            <span className="flex-1 min-w-0 text-[11px] leading-snug text-app-text break-all line-clamp-2" data-testid="browser-tab-menu-address">
              {address}
            </span>
          </div>
        )}

        {/* THE COMMAND ROW. Back / forward / reload / open-external are icons in
            a row and not four menu lines: they are the frequent ones, and four
            lines of text for four arrows is how a menu becomes a wall. */}
        <div className="px-2 pb-1.5 flex items-center gap-1">
          <RowButton
            icon={<ArrowLeft size={14} />}
            label={t('browser.tab.back')}
            onClick={c?.back && chrome.canGoBack ? run(c.back) : undefined}
            disabled={!chrome.canGoBack}
            testId="browser-tab-back"
          />
          <RowButton
            icon={<ArrowRight size={14} />}
            label={t('browser.tab.forward')}
            onClick={c?.forward && chrome.canGoForward ? run(c.forward) : undefined}
            disabled={!chrome.canGoForward}
            testId="browser-tab-forward"
          />
          <RowButton
            icon={<RotateCw size={14} className={chrome.loading ? 'animate-spin' : ''} />}
            label={t('browser.tab.reload')}
            onClick={run(c?.reload)}
          />
          <div className="flex-1" />
          <RowButton
            icon={copied ? <Check size={14} className="text-green-600 dark:text-green-400" /> : <Copy size={14} />}
            label={copied ? t('browser.tab.copied') : t('browser.tab.copyAddress')}
            onClick={chrome.url ? copyAddress : undefined}
            testId="browser-tab-copy-url"
          />
          <RowButton
            icon={<ExternalLink size={14} />}
            label={t('browser.openSystem')}
            onClick={c?.openExternal ? run(c.openExternal) : undefined}
          />
        </div>

        <div className={POPOVER_DIVIDER} />

        {c?.backToSpawner && (
          <button type="button" className={POPOVER_ITEM} onClick={run(c.backToSpawner)} data-testid="browser-tab-spawner">
            <CornerUpLeft size={13} className="shrink-0 text-app-text-tertiary" />
            <span className="flex-1 text-left">{t('browser.spawner.title')}</span>
          </button>
        )}

        {c?.editAddress && (
          <button type="button" className={POPOVER_ITEM} onClick={run(c.editAddress)} data-testid="browser-tab-edit-address">
            <Pencil size={13} className="shrink-0 text-app-text-tertiary" />
            <span className="flex-1 text-left">{t('browser.tab.editAddress')}</span>
            <span className="text-app-text-faint tabular-nums">{shortcut('L')}</span>
          </button>
        )}

        {/* THE CONSOLE, WITH ITS TALLY. This is the notification the task asks
            for: the count travels from the page to the badge on the dots, and
            here it says what it is made of. */}
        {c?.openConsole && (
          <button type="button" className={POPOVER_ITEM} onClick={run(c.openConsole)} data-testid="browser-tab-console">
            <Terminal size={13} className="shrink-0 text-app-text-tertiary" />
            <span className="flex-1 text-left">{t('browser.tab.console')}</span>
            {errors > 0 && <span className={`tabular-nums ${DANGER_TEXT}`}>{errors}</span>}
            {warnings > 0 && <span className={`tabular-nums ${WARNING_TEXT}`}>{warnings}</span>}
          </button>
        )}

        {c?.openDownloads && downloads > 0 && (
          <button type="button" className={POPOVER_ITEM} onClick={run(c.openDownloads)} data-testid="browser-tab-downloads">
            <Download size={13} className="shrink-0 text-app-text-tertiary" />
            <span className="flex-1 text-left">{t('browser.tab.downloads')}</span>
            <span className="text-app-text-faint tabular-nums">{downloads}</span>
          </button>
        )}

        {c?.toggleDevTools && (
          <button type="button" className={POPOVER_ITEM} onClick={run(c.toggleDevTools)} data-testid="browser-tab-devtools">
            <Code2 size={13} className="shrink-0 text-app-text-tertiary" />
            <span className="flex-1 text-left">DevTools</span>
            <span className="text-app-text-faint tabular-nums">{shortcut('I', { alt: true })}</span>
          </button>
        )}

        {/* ZOOM stays a ROW, not three menu lines: it is the one control here
            you use twice in a row, and a menu that closes between the two
            presses would make you reopen it to finish the thought. */}
        {c?.setZoom && (
          <>
            <div className={POPOVER_DIVIDER} />
            <div className="px-3 py-1 flex items-center gap-2" data-testid="browser-tab-zoom">
              <span className="flex-1 text-[12px] text-app-text">{t('browser.tab.zoom')}</span>
              <div className="flex items-center rounded-md border border-app-border-input overflow-hidden">
                <button type="button" onClick={() => c.setZoom?.(-1)} title={t('browser.dev.zoomOut')}
                  className="w-6 h-6 flex items-center justify-center hover:bg-app-hover text-app-text-secondary">
                  <Minus size={12} />
                </button>
                <button type="button" onClick={() => c.setZoom?.('reset')} title={t('browser.dev.zoomReset')}
                  className={`px-1.5 h-6 text-[11px] tabular-nums hover:bg-app-hover ${Math.round(chrome.zoom) !== 100 ? 'text-primary font-medium' : 'text-app-text-tertiary'}`}>
                  {Math.round(chrome.zoom)}%
                </button>
                <button type="button" onClick={() => c.setZoom?.(1)} title={t('browser.dev.zoomIn')}
                  className="w-6 h-6 flex items-center justify-center hover:bg-app-hover text-app-text-secondary">
                  <Plus size={12} />
                </button>
              </div>
            </div>
          </>
        )}

        {/* DEVICE, as a segmented row for the same reason as zoom: four presets
            are four taps of comparison, not four decisions. */}
        {c?.setDevice && (
          <div className="px-3 py-1 flex items-center gap-2" data-testid="browser-tab-device">
            <span className="flex-1 text-[12px] text-app-text flex items-center gap-1.5">
              <DeviceGlyph size={13} className="text-app-text-tertiary" />
              {t('browser.tab.device')}
            </span>
            <div className="flex items-center rounded-md border border-app-border-input overflow-hidden">
              {(['desktop', 'mobile', 'tablet', 'auto'] as DeviceMode[]).map((m) => {
                const G = DEVICE_GLYPH[m];
                const on = chrome.deviceMode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => c.setDevice?.(m)}
                    title={t('browser.dev.device', { name: m })}
                    aria-pressed={on}
                    className={`w-6 h-6 flex items-center justify-center hover:bg-app-hover ${on ? 'text-primary bg-app-hover' : 'text-app-text-secondary'}`}
                  >
                    <G size={12} />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {(c?.toggleShare || c?.forgetSite) && <div className={POPOVER_DIVIDER} />}

        {c?.toggleShare && (
          <button type="button" className={POPOVER_ITEM} onClick={run(c.toggleShare)} data-testid="browser-tab-share">
            <MonitorSmartphone size={13} className={`shrink-0 ${chrome.shared ? 'text-green-600 dark:text-green-400' : 'text-app-text-tertiary'}`} />
            <span className="flex-1 text-left">
              {chrome.shared ? t('browser.tab.session.shared') : t('browser.tab.session.native')}
            </span>
          </button>
        )}

        {c?.forgetSite && (
          <button type="button" className={POPOVER_ITEM_DANGER} onClick={run(c.forgetSite)} data-testid="browser-tab-forget-site">
            <Trash2 size={13} className="shrink-0" />
            {t('browser.forget.label')}
          </button>
        )}
      </Menu>
    </>
  );
}
