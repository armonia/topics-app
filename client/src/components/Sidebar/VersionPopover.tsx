/**
 * VersionPopover — opens from the status-bar version chip. Shows app info and,
 * crucially, the system auto-update box (the desktop updater surface) so the
 * user can check / download / install updates from one place. In web mode it
 * falls back to the service-worker update hint.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, Check, AlertCircle, Rocket, Sparkles, ChevronRight } from 'lucide-react';
import { useUpdater } from '@/lib/updater';
import { useSidecarIntegrity, shouldWarnAboutSidecars } from '@/lib/sidecarIntegrity';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import { isDesktop } from '@/lib/shell';
import { useT } from '@/hooks/useT';
import type { BundleDrift } from './bundleDrift';

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
  drift,
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
  /** Set when the bundle on screen is NOT the version the repo is at: `public/`
   *  is rebuilt by hand, so it can sit days behind. Null when they agree, or
   *  when one of the two facts is missing. */
  drift?: BundleDrift | null;
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
  // An update can land on the app and MISS a piece of it: on Windows the
  // installer skips a binary that is still running and exits 0 anyway (see
  // lib/sidecarIntegrity.ts). This popover is where the version number is read,
  // so it is where the number has to admit it is only partly true.
  const sidecars = useSidecarIntegrity();
  // Quanto tempo fa e' stata costruita: si ricava dalla data che il pannello
  // gia' riceve, senza una seconda fonte da tenere allineata.
  //
  // L'orologio si legge al MONTAGGIO, non nel corpo del render: `Date.now()`
  // durante il render e' una funzione impura (il lint lo marca, e ha ragione -
  // due render darebbero due risposte). Il pannello vive quanto resta aperto,
  // quindi un valore fissato all'apertura e' anche quello giusto: nessuno tiene
  // aperto un dropdown abbastanza da vedere «2 min fa» diventare «3 min fa».
  const [buildAgo] = useState(() => {
    const t = Date.parse(buildDate ?? '');
    if (!Number.isFinite(t)) return null;
    const min = Math.floor((Date.now() - t) / 60_000);
    if (min < 1) return tr('version.agoNow');
    if (min < 60) return tr('version.agoMin', { n: min });
    const h = Math.floor(min / 60);
    if (h < 24) return tr('version.agoHours', { n: h });
    return tr('version.agoDays', { n: Math.floor(h / 24) });
  });
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
    // A SUB-SURFACE, because this popover can live INSIDE another one.
    //
    // Since the status bar moved into the «Topics» menu the version chip opens
    // from in there, and this panel is a portal onto `<body>` — geometrically
    // OUTSIDE the dropdown hosting it. Without this line the pointerdown on the
    // changelog entry closed the dropdown, the bar inside it unmounted, the click
    // never reached a still-mounted element: the modal did not open. Measured
    // 2026-08-31: CHANGELOG-01..04 red on `changelog-modal`, with the popover
    // opening perfectly one step earlier.
    //
    // Not a new case: `lib/popoverRegistry.subSurfaceNodes` exists for exactly
    // this and its comment already tells the story («clicking an item closed
    // the parent panel»). The declaration was what was missing.
    exclusive: false,
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
        {/* LA DATA CON IL SUO «QUANTO TEMPO FA», ed e' qui che sta bene: la
            riga di stato la mostrava di continuo, competendo con gli fps e la
            memoria, per rispondere a una domanda che si fa una volta ogni
            tanto. Una data assoluta dice QUANDO, il tempo trascorso dice se e'
            vecchia - e la seconda e' la domanda vera. */}
        <div className="flex justify-between">
          <span>{tr('version.builtAt')}</span>
          <span className="text-app-text-secondary" data-testid="version-built-at">
            {buildDate || '-'}
            {buildAgo && <span className="ml-1 opacity-60">({buildAgo})</span>}
          </span>
        </div>
        <div className="flex justify-between"><span>Build</span><span className="text-app-text-secondary font-mono">{buildSha || '-'}</span></div>
        <div className="flex justify-between"><span>{tr('version.platform')}</span><span className="text-app-text-secondary">{platformLabel()}{isDesktop ? ' · desktop' : ''}</span></div>
        {/* Native shell version — surfaced ONLY when it lags the client (a
            client hot-deploy landed but the .app binary hasn't been released
            yet), so the two numbers never look like a contradiction. */}
        {isDesktop && shellVersion && shellVersion !== appVersion && (
          <div className="flex justify-between"><span>{tr('version.nativeApp')}</span><span className="text-app-text-secondary tabular-nums">v{shellVersion}</span></div>
        )}
      </div>

      {/* The number above says which version the REPO is at. When `public/` is
          older than that, the code on screen is a different thing, and this is
          the only place that says so: the chip cannot hold a sentence, and the
          question "which version am I on" is already answered here. */}
      {drift && (
        <div
          data-testid="version-bundle-drift"
          className="flex gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400"
        >
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium">{tr('version.drift')}</span>{' '}
            {tr('version.driftDetail', { bundle: drift.bundle, repo: drift.repo })}
          </span>
        </div>
      )}

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

      {/* Half applied update: the app is new, one of its binaries is not. */}
      {shouldWarnAboutSidecars(sidecars) && (
        <div
          data-testid="version-incomplete-install"
          className="flex gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400"
        >
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium">{tr('version.incompleteInstall')}</span>{' '}
            {tr('version.incompleteInstallDetail', { names: (sidecars?.bad ?? []).join(', ') })}
          </span>
        </div>
      )}

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
