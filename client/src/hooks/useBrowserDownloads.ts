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
import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import {
  applyDownloadEvent,
  applyDownloadProgress,
  activeCount as countActive,
  type DownloadEntry,
  type DownloadEventIn,
  type DownloadProgressIn,
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

/** L'elenco PORTA con sé la pane a cui appartiene. Tenerli in un solo stato è
 *  ciò che permette di ripartire da zero quando la pane cambia identità senza
 *  farlo in un effetto: si legge `ctx` e si sa già se le voci sono le sue. */
interface DownloadsState {
  ctx: string;
  entries: DownloadEntry[];
  started: number;
}

const EMPTY = (ctx: string): DownloadsState => ({ ctx, entries: [], started: 0 });

export function useBrowserDownloads(contextId: string): BrowserDownloads {
  const [state, setState] = useState<DownloadsState>(() => EMPTY(contextId));
  /** «C'e' almeno un download in corso», letto dentro l'intervallo. Un ref e non
   *  una dipendenza: metterlo fra le dipendenze dell'effetto rifarebbe il timer
   *  a ogni download che parte o finisce. */
  const activeRef = useRef(false);

  // Pane diversa = elenco diverso: senza questo, cambiando contextId le voci
  // della pane precedente restavano appese a quella nuova. L'azzeramento avviene
  // DURANTE il render (il modo con cui React vuole che uno stato reagisca a un
  // prop cambiato) e non dentro un effetto, che farebbe un render a cascata —
  // il divieto di `react-hooks/set-state-in-effect`. `current` copre il render
  // in corso: React riesegue subito il componente, ma nessuno deve poter leggere
  // le voci della pane precedente nemmeno per un giro.
  const current = state.ctx === contextId ? state : EMPTY(contextId);
  if (state.ctx !== contextId) setState(current);

  useEffect(() => {
    if (!isTauri) return;
    let stop = false;
    const iv = window.setInterval(() => {
      void tauriInvoke<DownloadEventIn[]>('browser_take_download_events', { id: contextId })
        .then((events) => {
          if (stop || !events || !events.length) return;
          const starts = events.filter((e) => e.kind === 'start').length;
          // Callback di una sottoscrizione, non corpo di effetto: qui setState
          // è il modo previsto. La guardia su `ctx` scarta la risposta di un
          // poll partito per la pane di prima.
          setState((prev) => (prev.ctx !== contextId ? prev : {
            ...prev,
            entries: events.reduce(applyDownloadEvent, prev.entries),
            started: prev.started + starts,
          }));
        })
        .catch(() => {});
      // L'avanzamento si chiede SOLO con qualcosa in corso: ogni giro costa al
      // Rust uno stat per download pendente, e a elenco fermo non direbbe niente
      // di nuovo. La risposta sta in un ref e non fra le dipendenze, altrimenti
      // il timer si rifarebbe a ogni download che parte o finisce.
      if (!activeRef.current) return;
      void tauriInvoke<DownloadProgressIn[]>('browser_download_progress', { id: contextId })
        .then((msgs) => {
          if (stop || !msgs || !msgs.length) return;
          setState((prev) => {
            if (prev.ctx !== contextId) return prev;
            const entries = applyDownloadProgress(prev.entries, msgs);
            // `applyDownloadProgress` torna la stessa lista quando nulla cambia:
            // qui quell'identita' diventa «nessun render».
            return entries === prev.entries ? prev : { ...prev, entries };
          });
        })
        .catch(() => {});
    }, POLL_MS);
    return () => { stop = true; window.clearInterval(iv); };
  }, [contextId]);

  const dismiss = useCallback((id: string) => {
    setState((prev) => ({ ...prev, entries: prev.entries.filter((d) => d.id !== id) }));
  }, []);
  const clear = useCallback(() => setState((prev) => ({ ...prev, entries: [] })), []);
  const reveal = useCallback((path: string) => {
    // opener: seleziona il file nel Finder / gestore file.
    void tauriInvoke('plugin:opener|reveal_item_in_dir', { path }).catch(() => {});
  }, []);
  const openFile = useCallback((path: string) => {
    // Apre il file con l'app di sistema. Il permesso è ristretto a $DOWNLOAD/**
    // (capabilities/default.json): è l'unica cartella in cui scriviamo.
    void tauriInvoke('plugin:opener|open_path', { path }).catch(() => {});
  }, []);

  const active = countActive(current.entries);
  // Il ref insegue il conteggio da un effetto e non dal render: scrivere un ref
  // mentre React sta renderizzando e' proprio cio' che `react-hooks/refs` vieta,
  // perche' con il render concorrente quella scrittura puo' avvenire per un
  // tentativo che verra' buttato via. Qui l'unico lettore e' un timer, quindi
  // arrivarci un tick dopo non cambia niente.
  useEffect(() => { activeRef.current = active > 0; }, [active]);

  return {
    downloads: current.entries,
    activeCount: active,
    startedCount: current.started,
    dismiss,
    clear,
    reveal,
    openFile,
  };
}
