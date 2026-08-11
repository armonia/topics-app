/**
 * I download di UNA pane browser nativa (Tauri).
 *
 * Scarica la coda di eventi del Rust (`browser_take_download_events`, già
 * filtrata per contextId lato server) e la trasforma nell'elenco che la toolbar
 * mostra nel suo menu Download. Le regole della lista stanno in
 * `components/Browser/downloadsModel.ts` (pure, testate); qui c'è solo il poll e
 * le azioni.
 *
 * Fuori da Tauri non fa niente: la pane condivisa (server) scarica sul server,
 * non su questo computer, e non ha nessuna coda da drenare.
 */
import { useCallback, useEffect, useState } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import {
  applyDownloadEvent,
  activeCount as countActive,
  type DownloadEntry,
  type DownloadEventIn,
} from '../components/Browser/downloadsModel';

const POLL_MS = 1000;

export interface BrowserDownloads {
  downloads: DownloadEntry[];
  activeCount: number;
  /** Quante voci sono arrivate in totale — cresce a ogni nuovo download, così
   *  chi guarda (la toolbar) sa che è successo qualcosa senza confrontare liste. */
  startedCount: number;
  dismiss: (id: string) => void;
  clear: () => void;
  reveal: (path: string) => void;
  openFile: (path: string) => void;
}

export function useBrowserDownloads(contextId: string): BrowserDownloads {
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [startedCount, setStartedCount] = useState(0);

  useEffect(() => {
    if (!isTauri) return;
    // Pane diversa = elenco diverso: senza questo, cambiando contextId le voci
    // della pane precedente restavano appese a quella nuova.
    setDownloads([]);
    setStartedCount(0);
    let stop = false;
    const iv = window.setInterval(() => {
      void tauriInvoke<DownloadEventIn[]>('browser_take_download_events', { id: contextId })
        .then((events) => {
          if (stop || !events || !events.length) return;
          setDownloads((prev) => events.reduce(applyDownloadEvent, prev));
          const starts = events.filter((e) => e.kind === 'start').length;
          if (starts) setStartedCount((n) => n + starts);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => { stop = true; window.clearInterval(iv); };
  }, [contextId]);

  const dismiss = useCallback((id: string) => {
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  }, []);
  const clear = useCallback(() => setDownloads([]), []);
  const reveal = useCallback((path: string) => {
    // opener: seleziona il file nel Finder / gestore file.
    void tauriInvoke('plugin:opener|reveal_item_in_dir', { path }).catch(() => {});
  }, []);
  const openFile = useCallback((path: string) => {
    // Apre il file con l'app di sistema. Il permesso è ristretto a $DOWNLOAD/**
    // (capabilities/default.json): è l'unica cartella in cui scriviamo.
    void tauriInvoke('plugin:opener|open_path', { path }).catch(() => {});
  }, []);

  return { downloads, activeCount: countActive(downloads), startedCount, dismiss, clear, reveal, openFile };
}
