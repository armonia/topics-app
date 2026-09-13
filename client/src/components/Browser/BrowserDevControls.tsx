/**
 * The quick console of a browser pane: an error/warning badge and the dropdown
 * panel behind it. Rendered from the TAB SHEET, which passes the entries and
 * the clear handler the pane published; a path without a console of its own
 * (streaming, iframe) simply does not pass them and no badge is drawn.
 *
 * Zoom and device emulation used to live here too, as a `ZoomControl` and a
 * `DeviceSwitcher` for the 40px toolbar. They are rows in the sheet now - in
 * plain sight, `custom` included - and a dropdown inside a panel is exactly
 * what `TOPIC-BROWSER-02` forbids.
 *
 * La console e' una TENDINA, non un pannello di sviluppo: ci sta un filtro per
 * livello, una ricerca, il raggruppamento dei doppioni e un bottone «Copia», e
 * niente altro. Le regole che decidono cosa si vede stanno in
 * `consoleLogModel.ts` (pure e sotto test); qui resta solo il disegno.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, ChevronRight, X, Search, Copy, Check, ArrowDown, TriangleAlert } from 'lucide-react';
import type { BrowserConsoleEntry } from './browserDevTypes';
import { CONSOLE_FILTERS, buildConsoleView, consoleTime, formatConsoleRows, type ConsoleFilter, type ConsoleLogRow } from './consoleLogModel';
import { Menu } from '../Shared/Menu';
import { DANGER_TEXT, WARNING_TEXT, POPOVER_ITEM } from '../../lib/popoverStyles';
import { useT } from '../../hooks/useT';

const ICON = 14;

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
      <span className={`shrink-0 self-center ${tone}`} aria-hidden>
        {row.level === 'error' ? <X size={12} /> : row.level === 'warn' ? <TriangleAlert size={12} /> : <ChevronRight size={12} />}
      </span>
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
  entries, summary, onClear, open: openProp, onOpenChange, label, testId,
}: {
  entries: BrowserConsoleEntry[];
  summary: { errors: number; warnings: number };
  onClear: () => void;
  /** Controlled open state. The panel is normally its own master, but the tab
   *  menu can now ask for "show me the console": that arrives from outside, so
   *  the state has to be liftable. Uncontrolled (undefined) stays the default. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Given, the trigger becomes a full menu ROW (glyph + name + tally) instead
   *  of a bare glyph. The tab sheet needs the name written out: in a panel read
   *  top to bottom an unlabelled glyph is a guess. */
  label?: string;
  /** Override the trigger's testid. It is the ANCHOR of the panel, so a test
   *  that wants to open the console has to click this exact element: a wrapper
   *  around it would be clicked in its middle and miss. */
  testId?: string;
}) {
  const t = useT();
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = useCallback((next: boolean | ((o: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    setOpenLocal(value);
    onOpenChange?.(value);
  }, [open, onOpenChange]);
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
  const chipBase = 'px-1.5 h-[18px] flex items-center gap-1 rounded border text-micro leading-none transition-colors';
  return (
    <>
      <button ref={btnRef} type="button" title="Console"
        data-testid={testId ?? 'browser-console-badge'}
        onClick={() => { setOpen(o => !o); setStuckToTail(true); }}
        className={label
          ? `${POPOVER_ITEM} ${hasErr ? DANGER_TEXT : hasWarn ? WARNING_TEXT : ''}`
          : `h-6 px-1.5 flex items-center gap-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${hasErr ? DANGER_TEXT : hasWarn ? WARNING_TEXT : 'text-app-text-secondary'}`}>
        <Terminal size={ICON} className={label ? 'shrink-0' : undefined} />
        {label && <span className="flex-1 text-left">{label}</span>}
        {count > 0 && <span className="text-micro font-semibold tabular-nums leading-none">{count > 99 ? '99+' : count}</span>}
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
                  placeholder={t('browser.dev.console.filterPlaceholder')}
                  aria-label={t('browser.dev.console.filterLabel')}
                  data-testid="browser-console-search"
                  className="flex-1 min-w-0 bg-transparent text-mini text-app-text placeholder:text-app-text-faint focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={copyVisible}
                disabled={rows.length === 0}
                title={t('browser.dev.console.copyVisible')}
                data-testid="browser-console-copy"
                className="h-6 px-1.5 flex items-center gap-1 rounded text-mini text-app-text-secondary hover:bg-app-hover disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                {copied ? t('browser.dev.console.copied') : t('browser.dev.console.copy')}
              </button>
              <button
                type="button"
                onClick={onClear}
                title={t('browser.dev.console.clear')}
                aria-label={t('browser.dev.console.clear')}
                data-testid="browser-console-clear"
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary"
              >
                <X size={13} aria-hidden />
              </button>
            </div>
            {/* I numeri sui chip seguono la RICERCA, non il buffer: dicono dove
                sono finite le righe che stai cercando. */}
            <div className="flex items-center gap-1 flex-wrap" role="group" aria-label={t('browser.dev.console.levelFilter')}>
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
              className="max-h-[260px] overflow-y-auto py-1 font-mono text-mini leading-relaxed"
            >
              {rows.length === 0 ? (
                <div className="px-3 py-3 text-app-text-faint text-center">
                  {entries.length === 0 ? t('browser.dev.console.empty') : t('browser.dev.console.noMatch')}
                </div>
              ) : rows.map((r) => <ConsoleRow key={r.id} row={r} />)}
            </div>
            {!stuckToTail && (
              <button
                type="button"
                onClick={goToTail}
                data-testid="browser-console-tail"
                className="absolute right-2 bottom-2 flex items-center gap-1 px-2 h-6 rounded-full glass-surface border border-app-border text-micro text-app-text-secondary shadow hover:bg-app-hover"
              >
                <ArrowDown size={11} aria-hidden />
                {t('browser.dev.console.toTail')}
              </button>
            )}
          </div>
        </div>
      </Menu>
    </>
  );
}
