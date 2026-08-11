/**
 * Menu Download della pane browser — nella toolbar, non più una striscia
 * incollata in fondo alla pane.
 *
 * La striscia di prima aveva tre difetti, ed erano tre reclami: si prendeva una
 * riga della pagina senza poterla chiudere, teneva le voci solo 30 secondi (chi
 * guardava altrove non sapeva più se il file era arrivato) e non diceva dove
 * fosse finito il file. Qui: un bottone che compare solo quando c'è qualcosa,
 * il conto di quelli in corso, e un menu con — per ogni voce — apri, mostra nel
 * Finder, togli; più «svuota l'elenco» in fondo.
 *
 * UNO per due pane, perché i download sono due meccanismi diversi con la stessa
 * faccia: la pane NATIVA (Tauri) scarica su questo Mac e la voce porta un path
 * (`savedPath` → apri / mostra nel Finder); la pane CONDIVISA (server) scarica
 * sul server e la voce porta un link alla nostra origine (`href` → il download
 * lo fa il browser). Una voce ha l'uno o l'altro, mai entrambi.
 *
 * Il menu si apre da sé al primo download che parte (è la bolla di Chrome: senza,
 * un file che arriva non lo annuncia nessuno) e si chiude con Esc, con un clic
 * fuori o col suo bottone. Passa dalla primitiva `Menu`, che è anche ciò che lo
 * fa comparire SOPRA la webview nativa.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, Check, X as XIcon, FolderOpen, Loader2, AlertTriangle } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { POPOVER_DIVIDER, POPOVER_ITEM_DANGER } from '../../lib/popoverStyles';
import type { DownloadState } from './downloadsModel';

/** Una riga del menu, comune alle due pane. */
export interface DownloadRow {
  id: string;
  filename: string;
  state: DownloadState;
  /** Riga di sotto: il path salvato, la dimensione, il perché del fallimento. */
  detail?: string;
  /** Pane nativa: dove è finito il file su questo computer. */
  savedPath?: string;
  /** Pane condivisa: link scaricabile sulla nostra origine. */
  href?: string;
}

export interface DownloadsMenuProps {
  items: DownloadRow[];
  /** Quanti sono in corso (spinner + pallino sul bottone). */
  activeCount: number;
  /** Cresce a ogni download che parte: è il segnale che apre il menu da sé. */
  startedCount: number;
  onDismiss: (id: string) => void;
  onClear: () => void;
  /** Solo pane nativa: apri il file / mostralo nel Finder. */
  onOpen?: (path: string) => void;
  onReveal?: (path: string) => void;
}

export function DownloadsMenu({ items, activeCount, startedCount, onDismiss, onClear, onOpen, onReveal }: DownloadsMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Apertura automatica al download che PARTE (non a ogni render con la lista
  // piena, che riaprirebbe il menu appena chiuso).
  const seenRef = useRef(startedCount);
  useEffect(() => {
    if (startedCount > seenRef.current) {
      seenRef.current = startedCount;
      setOpen(true);
    }
  }, [startedCount]);

  // Elenco vuoto = niente bottone, quindi niente menu appeso a un'ancora sparita.
  useEffect(() => {
    if (items.length === 0 && open) setOpen(false);
  }, [items.length, open]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors shrink-0"
        title={activeCount > 0 ? `${activeCount} download in corso` : 'Download'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Download"
        data-testid="browser-downloads-button"
        data-active={activeCount > 0 || undefined}
      >
        {activeCount > 0
          ? <Loader2 size={14} className="animate-spin" aria-hidden />
          : <Download size={14} aria-hidden />}
        {activeCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[13px] h-[13px] px-[3px] rounded-full bg-primary text-white text-[9px] leading-[13px] text-center tabular-nums"
            data-testid="browser-downloads-badge"
          >
            {activeCount}
          </span>
        )}
      </button>
      <Menu
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        align="right"
        minWidth={280}
        className="max-w-[380px]"
        testId="browser-downloads-menu"
        ariaLabel="Download"
      >
        <div className="px-3 py-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-app-text-secondary">Download</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-5 h-5 flex items-center justify-center rounded text-app-text-muted hover:bg-app-hover"
            title="Chiudi"
            aria-label="Chiudi"
            data-testid="browser-downloads-close"
          >
            <XIcon size={12} aria-hidden />
          </button>
        </div>
        <div className={POPOVER_DIVIDER} />
        <div className="max-h-[320px] overflow-y-auto" data-testid="browser-downloads-list">
          {items.map((d) => {
            const done = d.state === 'completed';
            const failed = d.state === 'interrupted' || d.state === 'cancelled';
            const canOpen = done && !!d.savedPath && !!onOpen;
            return (
              <div
                key={d.id}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-app-hover"
                data-testid="browser-download-entry"
                data-state={d.state}
              >
                {done ? (
                  <Check size={13} className="text-green-800 dark:text-green-400 shrink-0" aria-hidden />
                ) : failed ? (
                  <AlertTriangle size={13} className="text-red-700 dark:text-red-400 shrink-0" aria-hidden />
                ) : (
                  <Loader2 size={13} className="animate-spin text-app-text-muted shrink-0" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  {/* Il nome è il bersaglio: apre il file (pane nativa) o scarica
                      il link (pane condivisa). Senza né l'uno né l'altro — voce
                      ancora in corso o fallita — resta testo, non un finto
                      bottone che non fa niente. */}
                  {d.href ? (
                    <a
                      href={d.href}
                      download
                      target="_blank"
                      rel="noreferrer"
                      className="block text-[12px] text-app-text truncate hover:underline"
                      title={`Scarica ${d.filename}`}
                      data-testid="browser-download-item"
                    >
                      {d.filename}
                    </a>
                  ) : canOpen ? (
                    <button
                      type="button"
                      onClick={() => onOpen!(d.savedPath!)}
                      className="block w-full text-left text-[12px] text-app-text truncate hover:underline"
                      title={`Apri ${d.savedPath}`}
                      data-testid="browser-download-item"
                    >
                      {d.filename}
                    </button>
                  ) : (
                    <div className="text-[12px] text-app-text truncate" title={d.filename} data-testid="browser-download-item">
                      {d.filename}
                    </div>
                  )}
                  <div className="text-[10px] text-app-text-faint truncate">
                    {failed ? 'Non riuscito' : d.detail || (done ? 'Completato' : 'In corso…')}
                  </div>
                </div>
                {done && d.savedPath && onReveal && (
                  <button
                    type="button"
                    onClick={() => onReveal(d.savedPath!)}
                    className="w-5 h-5 flex items-center justify-center rounded text-app-text-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
                    title="Mostra nel Finder"
                    aria-label="Mostra nel Finder"
                    data-testid="browser-download-reveal"
                  >
                    <FolderOpen size={12} aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDismiss(d.id)}
                  className="w-5 h-5 flex items-center justify-center rounded text-app-text-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
                  title="Togli dall'elenco"
                  aria-label="Togli dall'elenco"
                  data-testid="browser-download-dismiss"
                >
                  <XIcon size={12} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
        <div className={POPOVER_DIVIDER} />
        <button
          type="button"
          onClick={() => { onClear(); setOpen(false); }}
          className={POPOVER_ITEM_DANGER}
          data-testid="browser-downloads-clear"
        >
          <XIcon size={13} className="shrink-0" aria-hidden /> Svuota l'elenco
        </button>
      </Menu>
    </>
  );
}
