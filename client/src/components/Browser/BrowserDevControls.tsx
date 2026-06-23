/**
 * Dev-toolbar controls for the native browser pane: zoom, device emulation,
 * and a quick console (error/warning badge + dropdown panel). Rendered only in
 * Electron native mode (the host passes the handlers from useNativeBrowser);
 * web/screenshot mode omits them.
 */
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Monitor, Smartphone, Tablet, Maximize, SlidersHorizontal, Terminal, ChevronDown, X } from 'lucide-react';
import type { DeviceMode, BrowserConsoleEntry } from './browserDevTypes';

const ICON = 14;

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, onClose]);
  return ref;
}

/* ---------------------------------------------------------------- Zoom ---- */

export function ZoomControl({ onZoom }: { onZoom: (delta: number | 'reset') => Promise<number> }) {
  const [level, setLevel] = useState(0);
  const pct = Math.round(Math.pow(1.2, level) * 100);
  const apply = async (d: number | 'reset') => { setLevel(await onZoom(d)); };
  return (
    <div className="flex items-center rounded-md border border-app-border-input overflow-hidden" data-testid="browser-zoom">
      <button type="button" onClick={() => apply(-1)} title="Riduci zoom"
        className="w-5 h-6 flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary">
        <Minus size={12} />
      </button>
      <button type="button" onClick={() => apply('reset')} title="Reimposta zoom (100%)"
        className={`px-1 h-6 text-[11px] tabular-nums ${pct !== 100 ? 'text-accent font-medium' : 'text-app-text-tertiary'} hover:bg-black/5 dark:hover:bg-white/5`}>
        {pct}%
      </button>
      <button type="button" onClick={() => apply(1)} title="Aumenta zoom"
        className="w-5 h-6 flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary">
        <Plus size={12} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- Device ---- */

const DEVICE_ICON: Record<DeviceMode, typeof Monitor> = {
  desktop: Monitor, mobile: Smartphone, tablet: Tablet, auto: Maximize, custom: SlidersHorizontal,
};
const DEVICE_LABEL: Record<DeviceMode, string> = {
  desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', auto: 'Auto', custom: 'Custom',
};

export function DeviceSwitcher({
  mode, onSet,
}: {
  mode: DeviceMode;
  onSet: (mode: DeviceMode, custom?: { width: number; height: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cw, setCw] = useState('414');
  const [ch, setCh] = useState('896');
  const ref = useOutsideClose(open, () => setOpen(false));
  const Icon = DEVICE_ICON[mode];
  const active = mode !== 'desktop';
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)} title={`Dispositivo: ${DEVICE_LABEL[mode]}`}
        data-testid="browser-device-switcher"
        className={`h-6 px-1.5 flex items-center gap-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${active ? 'text-accent' : 'text-app-text-secondary'}`}>
        <Icon size={ICON} />
        <ChevronDown size={10} className="opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-50 min-w-[160px] glass-surface border border-app-border rounded-md shadow-xl py-1"
          data-testid="browser-device-menu">
          {(['desktop', 'mobile', 'tablet', 'auto'] as DeviceMode[]).map((m) => {
            const MI = DEVICE_ICON[m];
            return (
              <button key={m} type="button"
                onClick={() => { onSet(m); setOpen(false); }}
                className={`w-full px-3 py-1.5 flex items-center gap-2 text-left text-[12px] hover:bg-app-hover ${mode === m ? 'text-accent' : 'text-app-text'}`}>
                <MI size={13} /> {DEVICE_LABEL[m]}
              </button>
            );
          })}
          <div className="border-t border-app-border my-1" />
          <div className="px-3 py-1.5 flex items-center gap-1">
            <SlidersHorizontal size={13} className="text-app-text-tertiary shrink-0" />
            <input value={cw} onChange={e => setCw(e.target.value)} placeholder="W" inputMode="numeric"
              className="w-12 px-1 py-0.5 text-[11px] bg-surface border border-app-border-input rounded text-app-text-heading" />
            <span className="text-app-text-faint text-[11px]">×</span>
            <input value={ch} onChange={e => setCh(e.target.value)} placeholder="H" inputMode="numeric"
              className="w-12 px-1 py-0.5 text-[11px] bg-surface border border-app-border-input rounded text-app-text-heading" />
            <button type="button"
              onClick={() => {
                const w = parseInt(cw, 10), h = parseInt(ch, 10);
                if (w > 0 && h > 0) { onSet('custom', { width: w, height: h }); setOpen(false); }
              }}
              className="ml-auto px-1.5 py-0.5 text-[11px] rounded bg-primary text-white hover:bg-primary/90">OK</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Console ---- */

const LEVEL_STYLE: Record<BrowserConsoleEntry['level'], string> = {
  error: 'text-red-400', warn: 'text-amber-400', info: 'text-app-text', log: 'text-app-text-secondary', debug: 'text-app-text-tertiary',
};

export function ConsoleBadge({
  entries, summary, onClear,
}: {
  entries: BrowserConsoleEntry[];
  summary: { errors: number; warnings: number };
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const bodyRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to the newest entry when open.
  useEffect(() => { if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [open, entries.length]);

  const hasErr = summary.errors > 0;
  const hasWarn = !hasErr && summary.warnings > 0;
  const count = hasErr ? summary.errors : hasWarn ? summary.warnings : 0;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)} title="Console"
        data-testid="browser-console-badge"
        className={`h-6 px-1.5 flex items-center gap-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${hasErr ? 'text-red-400' : hasWarn ? 'text-amber-400' : 'text-app-text-secondary'}`}>
        <Terminal size={ICON} />
        {count > 0 && <span className="text-[10px] font-semibold tabular-nums leading-none">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-50 w-[420px] max-w-[80vw] glass-surface border border-app-border rounded-md shadow-xl flex flex-col"
          data-testid="browser-console-panel">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-app-border">
            <span className="text-[11px] font-medium text-app-text-secondary">
              Console · {summary.errors} errori · {summary.warnings} warning
            </span>
            <button type="button" onClick={onClear} title="Svuota" className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary">
              <X size={13} />
            </button>
          </div>
          <div ref={bodyRef} className="max-h-[260px] overflow-y-auto py-1 font-mono text-[11px] leading-relaxed">
            {entries.length === 0 ? (
              <div className="px-3 py-3 text-app-text-faint text-center">Nessun messaggio</div>
            ) : entries.map((e) => (
              <div key={e.id} className="px-3 py-0.5 flex gap-2 hover:bg-app-hover/50">
                <span className={`shrink-0 ${LEVEL_STYLE[e.level]}`}>{e.level === 'error' ? '✖' : e.level === 'warn' ? '⚠' : '›'}</span>
                <span className={`break-all ${LEVEL_STYLE[e.level]}`}>{e.text}</span>
                {e.source && <span className="ml-auto shrink-0 text-app-text-faint">{e.source}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
