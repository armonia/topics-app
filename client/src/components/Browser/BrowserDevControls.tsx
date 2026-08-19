/**
 * Dev-toolbar controls for the native browser pane: zoom, device emulation,
 * and a quick console (error/warning badge + dropdown panel). Rendered only for
 * the Tauri native pane (the host passes the handlers from useTauriBrowser);
 * web/screenshot mode omits them.
 *
 * La console e' una TENDINA, non un pannello di sviluppo: ci sta un filtro per
 * livello, una ricerca, il raggruppamento dei doppioni e un bottone «Copia», e
 * niente altro. Le regole che decidono cosa si vede stanno in
 * `consoleLogModel.ts` (pure e sotto test); qui resta solo il disegno.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Monitor, Smartphone, Tablet, Maximize, SlidersHorizontal, Terminal, ChevronDown, X, Search, Copy, Check, ArrowDown } from 'lucide-react';
import type { DeviceMode, BrowserConsoleEntry } from './browserDevTypes';
import { CONSOLE_FILTERS, buildConsoleView, consoleTime, formatConsoleRows, type ConsoleFilter, type ConsoleLogRow } from './consoleLogModel';
import { Menu } from '../Shared/Menu';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';

const ICON = 14;

/* ---------------------------------------------------------------- Zoom ---- */

export function ZoomControl({ zoom = 100, onZoom }: { zoom?: number; onZoom: (delta: number | 'reset') => Promise<number> }) {
  // `zoom` is the reactive source of truth (a clean integer percent from the
  // ZOOM_STEPS ladder), so button AND keyboard changes show the same value.
  const pct = Math.round(zoom);
  const apply = (d: number | 'reset') => { void onZoom(d); };
  return (
    <div className="flex items-center rounded-md border border-app-border-input overflow-hidden" data-testid="browser-zoom">
      <button type="button" onClick={() => apply(-1)} title="Riduci zoom"
        className="w-5 h-6 flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary">
        <Minus size={12} />
      </button>
      <button type="button" onClick={() => apply('reset')} title="Reimposta zoom (100%)"
        className={`px-1 h-6 text-[11px] tabular-nums ${pct !== 100 ? 'text-primary font-medium' : 'text-app-text-tertiary'} hover:bg-black/5 dark:hover:bg-white/5`}>
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
  desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', auto: 'Auto', custom: 'Responsive',
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
  const btnRef = useRef<HTMLButtonElement>(null);
  const Icon = DEVICE_ICON[mode];
  const active = mode !== 'desktop';
  return (
    <>
      <button ref={btnRef} type="button" title={`Dispositivo: ${DEVICE_LABEL[mode]}`}
        data-testid="browser-device-switcher"
        onClick={() => setOpen(o => !o)}
        className={`h-6 px-1.5 flex items-center gap-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${active ? 'text-primary' : 'text-app-text-secondary'}`}>
        <Icon size={ICON} />
        <ChevronDown size={10} className="opacity-60" />
      </button>
      {/* Anchored React <Menu> (portal + flip/clamp + Escape/dismissal). The W×H
          input row means the panel owns its own focus → unmanagedFocus. */}
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} align="right" minWidth={160} unmanagedFocus>
        <div data-testid="browser-device-menu">
          {(['desktop', 'mobile', 'tablet', 'auto', 'custom'] as DeviceMode[]).map((m) => {
            const MI = DEVICE_ICON[m];
            return (
              <button key={m} type="button"
                onClick={() => { onSet(m); setOpen(false); }}
                className={`w-full px-3 py-1.5 flex items-center gap-2 text-left text-[12px] hover:bg-app-hover ${mode === m ? 'text-primary' : 'text-app-text'}`}>
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
      </Menu>
    </>
  );
}

/* ------------------------------------------------------------ Console ---- */

/**
 * I colori dei livelli, tarati per ENTRAMBI i temi.
 *
 * Erano `red-400` e `amber-400` nudi, cioè scelti guardando solo il buio: sul
 * vetro chiaro di macOS l'ambra faceva 1,55:1 contro una soglia di 4,5. Le
 * coppie stanno in `popoverStyles` coi numeri misurati accanto.
 */
const LEVEL_STYLE: Record<BrowserConsoleEntry['level'], string> = {
  error: DANGER_TEXT, warn: WARNING_TEXT, info: 'text-app-text', log: 'text-app-text-secondary', debug: 'text-app-text-tertiary',
};

/** Quanto vicino al fondo conta ancora come «in fondo». Un pixel esatto non
 *  torna mai: lo zoom del browser e le altezze frazionarie lasciano resti
 *  sotto l'unità, e con la soglia a 0 l'auto-scorrimento si spegneva da solo
 *  appena arrivato in coda. */
const AT_BOTTOM_SLACK = 8;

/** Per quanto resta scritto «Copiato». Abbastanza da leggerlo, poco da non
 *  restare lì come un'etichetta. */
const COPIED_FEEDBACK_MS = 1400;

function ConsoleRow({ row }: { row: ConsoleLogRow }) {
  const tone = LEVEL_STYLE[row.level];
  return (
    <div className="px-3 py-0.5 flex gap-2 hover:bg-app-hover/50" data-testid="browser-console-row">
      {/* Colonna a larghezza fissa e cifre tabellari: le ore devono stare
          incolonnate anche quando le righe sotto sono di lunghezza diversa. */}
      <span className="shrink-0 w-[52px] tabular-nums text-app-text-faint select-none">{consoleTime(row.at)}</span>
      <span className={`shrink-0 ${tone}`} aria-hidden>{row.level === 'error' ? '✖' : row.level === 'warn' ? '⚠' : '›'}</span>
      <span className={`flex-1 min-w-0 break-all ${tone}`}>{row.text}</span>
      {row.count > 1 && (
        <span
          className="shrink-0 self-start px-1 rounded bg-app-hover text-app-text-secondary tabular-nums"
          title={`Ripetuto ${row.count} volte di fila`}
        >
          x{row.count}
        </span>
      )}
      {row.source && <span className="shrink-0 text-app-text-faint">{row.source}</span>}
    </div>
  );
}

export function ConsoleBadge({
  entries, summary, onClear,
}: {
  entries: BrowserConsoleEntry[];
  summary: { errors: number; warnings: number };
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  // Falso = l'utente è risalito, quindi l'auto-scorrimento è sospeso. È lui a
  // decidere: una console che ributta giù mentre stai leggendo una riga di
  // mezz'ora fa è una console che non si può leggere.
  const [stuckToTail, setStuckToTail] = useState(true);
  const btnRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lette da un ascoltatore registrato una volta sola: senza le ref
  // ri-registrarlo a ogni tasto lo rimetterebbe in coda agli altri, che è
  // esattamente ciò che l'ordine qui sotto deve evitare.
  const openRef = useRef(open);
  const queryRef = useRef(query);
  useEffect(() => { openRef.current = open; queryRef.current = query; }, [open, query]);

  const { rows, counts } = useMemo(() => buildConsoleView(entries, filter, query), [entries, filter, query]);

  // Coda: solo se l'utente non è risalito. Riparte quando torna in fondo.
  useEffect(() => {
    const el = bodyRef.current;
    if (!open || !el || !stuckToTail) return;
    el.scrollTop = el.scrollHeight;
  }, [open, stuckToTail, rows]);

  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  /**
   * Escape SVUOTA la ricerca invece di chiudere il pannello, ma solo mentre il
   * cursore è nel campo e c'è qualcosa da svuotare: a campo vuoto Escape torna
   * a essere «chiudi», che è ciò che uno si aspetta da un popover.
   *
   * Registrato al MONTAGGIO e non all'apertura, e non è un dettaglio: la chiusura
   * la fa `useDismissable` con un ascoltatore sullo STESSO `document` e nella
   * stessa fase di cattura, dove a decidere chi parla per primo è l'ordine di
   * registrazione. Quello si registra quando il pannello si apre, cioè sempre
   * dopo questo. `stopImmediatePropagation` serve perché `stopPropagation` non
   * ferma gli altri ascoltatori dello stesso nodo.
   */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      if (!openRef.current || !queryRef.current) return;
      if (document.activeElement !== searchRef.current) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      setQuery('');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setStuckToTail(el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK);
  };

  const goToTail = () => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStuckToTail(true);
  };

  const copyVisible = () => {
    const text = formatConsoleRows(rows);
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    }).catch(() => { /* appunti negati dal sistema: nessun falso «Copiato» */ });
  };

  const hasErr = summary.errors > 0;
  const hasWarn = !hasErr && summary.warnings > 0;
  const count = hasErr ? summary.errors : hasWarn ? summary.warnings : 0;
  const chipBase = 'px-1.5 h-[18px] flex items-center gap-1 rounded border text-[10px] leading-none transition-colors';
  return (
    <>
      <button ref={btnRef} type="button" title="Console"
        data-testid="browser-console-badge"
        onClick={() => { setOpen(o => !o); setStuckToTail(true); }}
        className={`h-6 px-1.5 flex items-center gap-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${hasErr ? DANGER_TEXT : hasWarn ? WARNING_TEXT : 'text-app-text-secondary'}`}>
        <Terminal size={ICON} />
        {count > 0 && <span className="text-[10px] font-semibold tabular-nums leading-none">{count > 99 ? '99+' : count}</span>}
      </button>
      {/* Anchored React <Menu> (portal + flip/clamp + Escape/dismissal + focus-
          restore). A scrollable log panel that owns its own layout → unmanagedFocus.
          The `-my-1` wrapper cancels Menu's POPOVER_SURFACE py-1 so the header/body
          sit flush to the card edges exactly like the old POPOVER_PANEL surface. */}
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} align="right" unmanagedFocus className="w-[460px] max-w-[86vw]">
        <div className="-my-1 flex flex-col" data-testid="browser-console-panel">
          <div className="px-2 py-1.5 border-b border-app-border flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <div className="flex-1 min-w-0 flex items-center gap-1 px-1.5 h-6 rounded bg-surface border border-app-border-input focus-within:border-primary">
                <Search size={11} className="shrink-0 text-app-text-faint" aria-hidden />
                <input
                  ref={searchRef}
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filtra i messaggi"
                  aria-label="Filtra i messaggi della console"
                  data-testid="browser-console-search"
                  className="flex-1 min-w-0 bg-transparent text-[11px] text-app-text placeholder:text-app-text-faint focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={copyVisible}
                disabled={rows.length === 0}
                title="Copia le righe visibili"
                data-testid="browser-console-copy"
                className="h-6 px-1.5 flex items-center gap-1 rounded text-[11px] text-app-text-secondary hover:bg-app-hover disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                {copied ? 'Copiato' : 'Copia'}
              </button>
              <button
                type="button"
                onClick={onClear}
                title="Svuota la console"
                aria-label="Svuota la console"
                data-testid="browser-console-clear"
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary"
              >
                <X size={13} aria-hidden />
              </button>
            </div>
            {/* I numeri sui chip seguono la RICERCA, non il buffer: dicono dove
                sono finite le righe che stai cercando. */}
            <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Filtra per livello">
              {CONSOLE_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => { setFilter(f.id); setStuckToTail(true); }}
                  aria-pressed={filter === f.id}
                  data-testid={`browser-console-filter-${f.id}`}
                  className={`${chipBase} ${filter === f.id
                    ? 'border-primary/50 bg-primary/10 text-app-text'
                    : 'border-app-border text-app-text-tertiary hover:bg-app-hover'}`}
                >
                  {f.label}
                  <span className="tabular-nums opacity-70">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="relative">
            <div
              ref={bodyRef}
              onScroll={onBodyScroll}
              className="max-h-[260px] overflow-y-auto py-1 font-mono text-[11px] leading-relaxed"
            >
              {rows.length === 0 ? (
                <div className="px-3 py-3 text-app-text-faint text-center">
                  {entries.length === 0 ? 'Nessun messaggio' : 'Nessun messaggio corrisponde'}
                </div>
              ) : rows.map((r) => <ConsoleRow key={r.id} row={r} />)}
            </div>
            {!stuckToTail && (
              <button
                type="button"
                onClick={goToTail}
                data-testid="browser-console-tail"
                className="absolute right-2 bottom-2 flex items-center gap-1 px-2 h-6 rounded-full glass-surface border border-app-border text-[10px] text-app-text-secondary shadow hover:bg-app-hover"
              >
                <ArrowDown size={11} aria-hidden />
                Vai in fondo
              </button>
            )}
          </div>
        </div>
      </Menu>
    </>
  );
}
