/**
 * VersionPopover — opens from the status-bar version chip. Shows app info and,
 * crucially, the system auto-update box (the desktop updater surface) so the
 * user can check / download / install updates from one place. In web mode it
 * falls back to the service-worker update hint.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, Check, AlertCircle, Rocket } from 'lucide-react';
import { useUpdater } from '@/lib/updater';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { isDesktop } from '@/lib/shell';

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
  isDev,
  buildDate,
  buildSha,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  appVersion: string;
  isDev: boolean;
  buildDate: string;
  /** Git short-hash of the webapp build ('' when unavailable) — the freshness
   *  signal: the semver only moves on release bumps. */
  buildSha?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { available, status, check, download, install } = useUpdater();
  const { updateAvailable: swUpdate } = useServiceWorkerUpdate();

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorEl?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); e.stopPropagation(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [anchorEl, onClose]);

  if (!anchorEl) return null;
  const rect = anchorEl.getBoundingClientRect();

  return createPortal(
    <div
      ref={ref}
      className="glass-surface border border-app-border rounded-lg shadow-lg w-[260px] p-3 space-y-3"
      style={{
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 6,
        right: Math.max(8, window.innerWidth - rect.right),
        zIndex: 9999,
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
        <div className="flex justify-between"><span>Compilato</span><span className="text-app-text-secondary">{buildDate || '—'}</span></div>
        <div className="flex justify-between"><span>Build</span><span className="text-app-text-secondary font-mono">{buildSha || '—'}</span></div>
        <div className="flex justify-between"><span>Piattaforma</span><span className="text-app-text-secondary">{platformLabel()}{isDesktop ? ' · desktop' : ''}</span></div>
      </div>

      {/* Auto-update box */}
      <div className="border-t border-app-border pt-2.5">
        <div className="text-[9px] uppercase tracking-wide text-app-text-muted mb-1.5">Aggiornamenti</div>
        <UpdateBox
          available={available}
          state={status.state}
          progress={status.progress}
          error={status.error}
          newVersion={status.version}
          swUpdate={swUpdate}
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
  available, state, progress, error, newVersion, swUpdate, onCheck, onDownload, onInstall,
}: {
  available: boolean;
  state: 'idle' | 'checking' | 'update-available' | 'downloading' | 'ready' | 'error';
  progress?: number;
  error?: string;
  newVersion?: string;
  swUpdate: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  // Web (no Electron updater): surface the service-worker update if any.
  if (!available) {
    return swUpdate ? (
      <button
        onClick={() => window.location.reload()}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
      >
        <Download size={12} /> Aggiornamento pronto — ricarica
      </button>
    ) : (
      <div className="text-[11px] text-app-text-muted">Sei sulla versione web più recente.</div>
    );
  }

  if (state === 'checking') {
    return <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted"><RefreshCw size={12} className="animate-spin" /> Controllo aggiornamenti…</div>;
  }
  if (state === 'update-available') {
    return (
      <div className="space-y-1.5">
        <div className="text-[11px] text-app-text">Disponibile{newVersion ? ` v${newVersion}` : ''}.</div>
        <button onClick={onDownload} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
          <Download size={12} /> Scarica aggiornamento
        </button>
      </div>
    );
  }
  if (state === 'downloading') {
    return <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted"><Download size={12} /> Download… {progress !== undefined ? `${Math.round(progress)}%` : ''}</div>;
  }
  if (state === 'ready') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-500"><Check size={12} /> Nuova versione pronta.</div>
        <button onClick={onInstall} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 transition-colors">
          <Rocket size={12} /> Riavvia e installa
        </button>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-red-500"><AlertCircle size={12} /> {error || 'Controllo fallito'}</div>
        <button onClick={onCheck} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium hover:bg-app-hover text-app-text-secondary transition-colors">
          <RefreshCw size={12} /> Riprova
        </button>
      </div>
    );
  }
  // idle
  return (
    <button onClick={onCheck} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium hover:bg-app-hover text-app-text-secondary transition-colors">
      <RefreshCw size={12} /> Controlla aggiornamenti
    </button>
  );
}
