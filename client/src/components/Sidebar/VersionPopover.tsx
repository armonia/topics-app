/**
 * VersionPopover — opens from the status-bar version chip. Shows app info and,
 * crucially, the system auto-update box (the desktop updater surface) so the
 * user can check / download / install updates from one place. In web mode it
 * falls back to the service-worker update hint.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, Check, AlertCircle, Rocket, Sparkles, ChevronRight } from 'lucide-react';
import { useUpdater } from '@/lib/updater';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import { isDesktop } from '@/lib/shell';
import { useT } from '@/hooks/useT';

function platformLabel(): string {
  // The desktop shell (Tauri) exposes no native platform field — derive it from
  // the UA so a Tauri mac/win/linux build isn't mislabelled as "Web".
  if (isDesktop) {
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return 'macOS';
    if (/Win/i.test(ua)) return 'Windows';
    if (/Linux/i.test(ua)) return 'Linux';
  }
  return 'Web';
}

export function VersionPopover({
  anchorEl,
  appVersion,
  shellVersion,
  isDev,
  buildDate,
  buildSha,
  onClose,
  onOpenChangelog,
}: {
  anchorEl: HTMLElement | null;
  /** The running CLIENT bundle version (moves on every deploy). */
  appVersion: string;
  /** The native desktop shell binary version — shown only when it differs from
   *  the client (i.e. after a client-only hot-deploy, before a shell release). */
  shellVersion?: string;
  isDev: boolean;
  buildDate: string;
  /** Git short-hash of the webapp build ('' when unavailable) — the freshness
   *  signal: the semver only moves on release bumps. */
  buildSha?: string;
  onClose: () => void;
  /** Open the full "Novità" changelog modal (and close this popover). */
  onOpenChangelog: () => void;
}) {
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Ref view of the raw anchor element so it counts as "inside" for dismissal
  // and acts as the focus-restore trigger (refs[0]).
  const anchorRef = useRef<HTMLElement | null>(null);
  // Mirror the raw anchor into a ref in an effect (not during render) to satisfy
  // react-hooks/refs; useDismissable reads it only inside its own effect, which
  // runs after this one.
  useEffect(() => { anchorRef.current = anchorEl; });
  const { available, status, check, download, install } = useUpdater();
  // «AUTO» VUOL DIRE CHE NON DEVI FARE NIENTE, e allora non si chiede niente.
  //
  // Col flag `topics-dev.json` acceso le finestre si ricaricano DA SOLE a ogni
  // build (`startDevBundleReload`): l'aggiornamento arriva senza gesti. Il
  // pannello pero' continuava a mostrare «nuova versione disponibile» con il
  // suo bottone «Scarica», cioe' chiedeva di fare a mano una cosa che stava
  // gia' succedendo. Segnalato: «mi esce una nuova versione disponibile anche
  // se sono in modalita' automatica».
  const { status: sistema } = useSystemStatus(true, 60000);
  const autoUpdate = !!sistema?.server?.devReload;
  const { updateAvailable: swUpdate } = useServiceWorkerUpdate();

  // Close on outside pointer / Escape via the shared contract. The component is
  // only mounted while open, so `open` is always true here.
  useDismissable({
    open: true,
    onClose,
    refs: [anchorRef, ref],
  });

  if (!anchorEl) return null;
  const rect = anchorEl.getBoundingClientRect();
  // Left-align to the chip, but CLAMP so the fixed-width panel never spills off
  // either edge. The chip sits at the bottom-LEFT of the sidebar; the previous
  // right-anchoring (`right = innerWidth - rect.right`) pushed the 260px panel's
  // left edge off-screen whenever the sidebar was narrow — the "dropdown esce
  // fuori dallo schermo" bug. Clamped left keeps it fully visible at any width.
  const POPOVER_W = 260;
  const left = Math.min(
    Math.max(8, rect.left),
    Math.max(8, window.innerWidth - POPOVER_W - 8),
  );

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      className={`${POPOVER_PANEL} w-[260px] p-3 space-y-3`}
      style={{
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 6,
        left,
        zIndex: Z_POPOVER,
      }}
    >
      {/* Identity */}
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-app-text">Topics</span>
        <span className="flex items-center gap-1.5">
          <span className="text-[12px] tabular-nums text-app-text-secondary">v{appVersion}</span>
          {isDev && (
            <span className="px-1 rounded bg-amber-500/15 text-amber-500 font-medium text-[9px] leading-tight">dev</span>
          )}
        </span>
      </div>
      <div className="space-y-1 text-[11px] text-app-text-muted">
        <div className="flex justify-between"><span>{tr('version.builtAt')}</span><span className="text-app-text-secondary">{buildDate || '-'}</span></div>
        <div className="flex justify-between"><span>Build</span><span className="text-app-text-secondary font-mono">{buildSha || '-'}</span></div>
        <div className="flex justify-between"><span>{tr('version.platform')}</span><span className="text-app-text-secondary">{platformLabel()}{isDesktop ? ' · desktop' : ''}</span></div>
        {/* Native shell version — surfaced ONLY when it lags the client (a
            client hot-deploy landed but the .app binary hasn't been released
            yet), so the two numbers never look like a contradiction. */}
        {isDesktop && shellVersion && shellVersion !== appVersion && (
          <div className="flex justify-between"><span>{tr('version.nativeApp')}</span><span className="text-app-text-secondary tabular-nums">v{shellVersion}</span></div>
        )}
      </div>

      {/* Novità — opens the full navigable changelog modal */}
      <div className="border-t border-app-border pt-2.5">
        <button
          onClick={onOpenChangelog}
          data-testid="changelog-open"
          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
          <Sparkles size={12} />
          <span>{tr('version.whatsNew')}</span>
          <ChevronRight size={12} className="ml-auto" />
        </button>
      </div>

      {/* Auto-update box */}
      <div className="border-t border-app-border pt-2.5">
        <div className="text-[9px] uppercase tracking-wide text-app-text-muted mb-1.5">{tr('version.updates')}</div>
        <UpdateBox
          available={available}
          state={status.state}
          progress={status.progress}
          error={status.error}
          newVersion={status.version}
          swUpdate={swUpdate}
          autoUpdate={autoUpdate}
          onCheck={check}
          onDownload={download}
          onInstall={install}
        />
      </div>
    </div>,
    document.body,
  );
}

function UpdateBox({
  available, state, progress, error, newVersion, swUpdate, autoUpdate, onCheck, onDownload, onInstall,
}: {
  available: boolean;
  state: 'idle' | 'checking' | 'update-available' | 'downloading' | 'ready' | 'error';
  progress?: number;
  error?: string;
  newVersion?: string;
  swUpdate: boolean;
  /** Le finestre si ricaricano da sole: non c'e' niente da chiedere all'utente. */
  autoUpdate: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const tr = useT();
  // Web (no Electron updater): surface the service-worker update if any.
  if (!available) {
    return swUpdate ? (
      <button
        onClick={() => window.location.reload()}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
      >
        <Download size={12} /> {tr('version.swReady')}
      </button>
    ) : (
      <div className="text-[11px] text-app-text-muted">{tr('version.webUpToDate')}</div>
    );
  }

  if (state === 'checking') {
    return <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted"><RefreshCw size={12} className="animate-spin" /> {tr('version.checking')}</div>;
  }
  if (state === 'update-available') {
    // In automatico si DICE che sta arrivando, non si chiede di scaricarla: il
    // bottone «Scarica» accanto a un aggiornamento che si installa da solo fa
    // credere che senza quel clic non succeda niente.
    if (autoUpdate) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
          <RefreshCw size={12} />
          {tr('version.autoArriving', { v: newVersion ? ` v${newVersion}` : '' })}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        <div className="text-[11px] text-app-text">{tr('version.available', { v: newVersion ? ` v${newVersion}` : '' })}</div>
        <button onClick={onDownload} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
          <Download size={12} /> {tr('version.download')}
        </button>
      </div>
    );
  }
  if (state === 'downloading') {
    return <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted"><Download size={12} /> {tr('version.downloading', { pct: progress !== undefined ? `${Math.round(progress)}%` : '' })}</div>;
  }
  if (state === 'ready') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-500"><Check size={12} /> {tr('version.ready')}</div>
        <button onClick={onInstall} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 transition-colors">
          <Rocket size={12} /> {tr('version.installRestart')}
        </button>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-red-500"><AlertCircle size={12} /> {error || tr('version.checkFailed')}</div>
        <button onClick={onCheck} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium hover:bg-app-hover text-app-text-secondary transition-colors">
          <RefreshCw size={12} /> {tr('common.retry')}
        </button>
      </div>
    );
  }
  // idle
  return (
    <button onClick={onCheck} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium hover:bg-app-hover text-app-text-secondary transition-colors">
      <RefreshCw size={12} /> {tr('version.check')}
    </button>
  );
}
