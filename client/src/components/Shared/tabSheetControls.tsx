/**
 * THE ROWS OF THE TAB SHEET THAT ARE CONTROLS, not commands: the page zoom and
 * the device (pressed twice in a row, so they never close their level), the
 * console and downloads lists (popovers of their own, marked as the sheet's),
 * the three session switches and the rename field. `buildTabSheetEntries`
 * places them, `TabSheetBody` draws the rest; loaded with the body.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Check, Minus, Plus, MonitorSmartphone, Monitor, Smartphone, Tablet, Maximize, SlidersHorizontal,
  Puzzle, Boxes, MonitorPlay, Edit3,
} from 'lucide-react';
import { ConsoleBadge } from '../Browser/BrowserDevControls';
import { DownloadsMenu } from '../Browser/DownloadsMenu';
import type { DeviceMode } from '../Browser/browserDevTypes';
import type { BrowserPaneChrome } from '../../state/browserPaneChrome';
import { POPOVER_ITEM } from '../../lib/popoverStyles';
import type { useT } from '../../hooks/useT';
import type { useToast } from './Toast';
import { getTerminalSessionFromPaneId } from '../../state/pane/adapters';
import { renameTerminalSession } from '../../lib/terminalActions';
import { menuRowClass } from '../Sidebar/menuRow';
import type { TabSheetDoor } from '../../state/tabSheet';
import type { TabSheetTarget } from './tabSheetTypes';
import { DEVICE_LABEL_KEY } from './tabSheetEntries';

/** One glyph per device mode, never the same twice. */
const DEVICE_GLYPH: Record<DeviceMode, typeof Monitor> = {
  desktop: Monitor, mobile: Smartphone, tablet: Tablet, auto: Maximize, custom: SlidersHorizontal,
};

export interface ControlRenderers {
  target: TabSheetTarget;
  chrome: BrowserPaneChrome | undefined;
  owner: string;
  door: TabSheetDoor;
  isMobile: boolean;
  onClose: () => void;
  toast: ReturnType<typeof useToast>;
  t: ReturnType<typeof useT>;
}

/** The rows that are controls: they act in place and keep the level open. */
export function ControlRow({ id, controls }: { id: string; controls: ControlRenderers }) {
  const { chrome, owner, door, t, onClose, target, toast } = controls;
  const c = chrome?.commands;
  const [sizing, setSizing] = useState(false);
  const [cw, setCw] = useState('414');
  const [ch, setCh] = useState('896');
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const editing = renameDraft !== null;
  // Focused and selected once, when the field appears: a new name is one
  // keystroke away.
  useEffect(() => {
    if (!editing) return;
    const timer = setTimeout(() => { renameRef.current?.focus(); renameRef.current?.select(); }, 0);
    return () => clearTimeout(timer);
  }, [editing]);

  if (id === 'rename') {
    const submit = () => {
      const name = (renameDraft ?? '').replace(/\s+/g, ' ').trim();
      if (name) {
        const { pane, actions } = target;
        const sid = getTerminalSessionFromPaneId(pane.id);
        if (sid) renameTerminalSession(sid, name, toast, t);
        else if (pane.type === 'chat' && pane.topicId) actions.onRenameChat?.(pane.topicId, name);
        else if (pane.type === 'browser') actions.onRenameBrowser?.(pane.id, name);
      }
      onClose();
    };
    if (renameDraft === null) {
      return (
        <button type="button" role="menuitem" data-testid="tab-sheet-rename" title={t('tab.rename')}
          onClick={() => setRenameDraft(target.pane.title ?? target.label)} className={menuRowClass(controls.isMobile)}>
          <Edit3 size={14} className="flex-shrink-0" />
          <span className="flex-1 text-left">{t('tab.menu.rename')}</span>
        </button>
      );
    }
    return (
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Edit3 size={14} className="shrink-0 text-app-text-muted" />
        <input
          ref={renameRef}
          data-testid="tab-sheet-rename-input"
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder={t('tab.newName')}
          aria-label={t('tab.newName')}
          maxLength={120}
          className="flex-1 min-w-0 bg-app-input border border-app-border rounded px-2 py-1 text-prose md:text-compact text-app-text focus:outline-none focus:border-primary"
        />
        <button type="button" onClick={submit} title={t('common.save')} aria-label={t('common.save')}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors">
          <Check size={14} />
        </button>
      </div>
    );
  }

  if (!chrome || !c) return null;

  if (id === 'zoom' && c.setZoom) {
    // A control, not a command: it is pressed twice in a row, so it never
    // closes the level (TABSHEET-02).
    return (
      <div className="px-3 py-1 flex items-center gap-2" data-testid="browser-tab-zoom">
        <span className="flex-1 text-compact text-app-text">{t('browser.tab.zoom')}</span>
        <div className="flex items-center rounded-md border border-app-border-input overflow-hidden">
          <button type="button" onClick={() => c.setZoom?.(-1)} title={t('browser.dev.zoomOut')} aria-label={t('browser.dev.zoomOut')} data-testid="browser-tab-zoom-out"
            className="w-6 h-6 coarse:w-11 coarse:h-11 flex items-center justify-center hover:bg-app-hover text-app-text-secondary">
            <Minus size={12} />
          </button>
          <button type="button" onClick={() => c.setZoom?.('reset')} title={t('browser.dev.zoomReset')} data-testid="browser-tab-zoom-reset"
            className={`px-1.5 h-6 coarse:h-11 text-mini tabular-nums hover:bg-app-hover ${Math.round(chrome.zoom) !== 100 ? 'text-primary font-medium' : 'text-app-text-tertiary'}`}>
            {Math.round(chrome.zoom)}%
          </button>
          <button type="button" onClick={() => c.setZoom?.(1)} title={t('browser.dev.zoomIn')} aria-label={t('browser.dev.zoomIn')} data-testid="browser-tab-zoom-in"
            className="w-6 h-6 coarse:w-11 coarse:h-11 flex items-center justify-center hover:bg-app-hover text-app-text-secondary">
            <Plus size={12} />
          </button>
        </div>
      </div>
    );
  }

  if (id === 'device' && c.setDevice) {
    const DeviceGlyph = DEVICE_GLYPH[chrome.deviceMode] ?? Monitor;
    const applySize = () => {
      const w = parseInt(cw, 10);
      const h = parseInt(ch, 10);
      if (w > 0 && h > 0) c.setDevice?.('custom', { width: w, height: h });
    };
    return (
      <>
        <div className="px-3 py-1 flex items-center gap-2" data-testid="browser-tab-device">
          <span className="flex-1 text-compact text-app-text flex items-center gap-1.5">
            <DeviceGlyph size={13} className="text-app-text-tertiary" />
            {t('browser.tab.device')}
          </span>
          <div className="flex items-center rounded-md border border-app-border-input overflow-hidden">
            {(['desktop', 'mobile', 'tablet', 'auto', 'custom'] as DeviceMode[]).map((m) => {
              const G = DEVICE_GLYPH[m];
              const on = chrome.deviceMode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { if (m === 'custom') setSizing(true); else { setSizing(false); c.setDevice?.(m); } }}
                  title={t('browser.dev.device', { name: t(DEVICE_LABEL_KEY[m]) })}
                  aria-label={t(DEVICE_LABEL_KEY[m])}
                  aria-pressed={on}
                  data-testid={`browser-tab-device-${m}`}
                  className={`w-6 h-6 coarse:w-11 coarse:h-11 flex items-center justify-center hover:bg-app-hover ${on ? 'text-primary bg-app-hover' : 'text-app-text-secondary'}`}
                >
                  <G size={12} />
                </button>
              );
            })}
          </div>
        </div>
        {(sizing || chrome.deviceMode === 'custom') && (
          <div className="px-3 pb-1 flex items-center gap-1 justify-end" data-testid="browser-tab-device-size">
            <input value={cw} onChange={(e) => setCw(e.target.value)} placeholder="W" inputMode="numeric" aria-label={t('browser.dev.width')}
              className="w-14 px-1 py-0.5 text-mini bg-surface border border-app-border-input rounded text-app-text-heading" />
            <span className="text-app-text-faint text-mini">×</span>
            <input value={ch} onChange={(e) => setCh(e.target.value)} placeholder="H" inputMode="numeric" aria-label={t('browser.dev.height')}
              className="w-14 px-1 py-0.5 text-mini bg-surface border border-app-border-input rounded text-app-text-heading" />
            <button type="button" onClick={applySize} data-testid="browser-tab-device-size-apply"
              className="ml-1 px-1.5 h-6 text-mini rounded bg-primary text-white hover:bg-primary/90">
              {t('tabSheet.device.apply')}
            </button>
          </div>
        )}
      </>
    );
  }

  if (id === 'console' && chrome.consoleEntries && c.clearConsole) {
    return (
      <ConsoleBadge
        entries={chrome.consoleEntries}
        summary={{ errors: chrome.consoleErrors, warnings: chrome.consoleWarnings }}
        onClear={c.clearConsole}
        label={t('browser.tab.console')}
        testId="browser-tab-console"
        popoverOwner={owner}
      />
    );
  }

  if (id === 'downloads' && chrome.downloadsMenu) {
    return (
      <DownloadsMenu
        {...chrome.downloadsMenu}
        // Opened from the cue the list is already down: that click WAS the
        // request. From any other door it must not be.
        requestOpen={door === 'downloads' ? chrome.downloadsOpenRequest : 0}
        label={t('browser.tab.downloads')}
        testId="browser-tab-downloads"
        popoverOwner={owner}
      />
    );
  }

  if (id === 'share' && c.toggleShare) {
    return (
      <button type="button" role="menuitem" className={POPOVER_ITEM} onClick={() => c.toggleShare?.()}
        data-testid="browser-tab-share" data-share-mode={chrome.shareMode ?? (chrome.shared ? 'shared' : 'native')}
        aria-pressed={chrome.shared} title={t('browser.tab.session.hint')}>
        <MonitorSmartphone size={13} className={`shrink-0 ${chrome.shared ? 'text-green-600 dark:text-green-400' : 'text-app-text-tertiary'}`} />
        <span className="flex-1 text-left">
          {chrome.shareMode === 'auto' ? t('browser.tab.session.auto') : chrome.shared ? t('browser.tab.session.shared') : t('browser.tab.session.native')}
        </span>
      </button>
    );
  }

  if (id === 'engine' && c.setEngine) {
    return (
      <button type="button" role="menuitem" className={POPOVER_ITEM}
        onClick={() => c.setEngine?.(chrome.engine === 'chromium' ? 'native' : 'chromium')}
        data-testid="browser-tab-engine" data-engine={chrome.engine ?? 'native'} aria-pressed={chrome.engine === 'chromium'}
        title={chrome.engine === 'chromium' ? t('browser.engine.real', { n: String(chrome.engineExtensions ?? 0) }) : t('browser.engine.native')}>
        <Puzzle size={13} className={`shrink-0 ${chrome.engine === 'chromium' ? 'text-primary' : 'text-app-text-tertiary'}`} />
        <span className="flex-1 text-left">
          {chrome.engine === 'chromium' ? t('browser.tab.engine.chromium', { n: String(chrome.engineExtensions ?? 0) }) : t('browser.tab.engine.playwright')}
        </span>
      </button>
    );
  }

  if (id === 'render' && c.setRenderMode) {
    return (
      <button type="button" role="menuitem" className={POPOVER_ITEM}
        onClick={() => c.setRenderMode?.(chrome.renderMode === 'dom' ? 'video' : 'dom')}
        data-testid="browser-tab-render" data-render-mode={chrome.renderMode ?? 'dom'} aria-pressed={chrome.renderMode === 'dom'}
        title={chrome.renderMode === 'dom' ? t('browser.mode.dom') : t('browser.mode.video')}>
        {chrome.renderMode === 'dom' ? <Boxes size={13} className="shrink-0 text-primary" /> : <MonitorPlay size={13} className="shrink-0 text-app-text-tertiary" />}
        <span className="flex-1 text-left">{chrome.renderMode === 'dom' ? t('browser.tab.render.dom') : t('browser.tab.render.video')}</span>
      </button>
    );
  }
  return null;
}
