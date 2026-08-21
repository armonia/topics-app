import { useState, useCallback } from 'react';
import { ChevronDown, FileDiff } from 'lucide-react';
import { boardApi } from '../../lib/board';
import { useT } from '../../hooks/useT';

/**
 * I FILE DELLA CONSEGNA, come elenco che si apre.
 *
 * COSA CAMBIA. Era un chip: «136 file +6017 -868», in fondo alla riga dei chip.
 * Diceva QUANTO e mai COSA — e davanti a una consegna da rivedere «quali file
 * ha toccato» e' la prima domanda, non la seconda. Chiesto esplicitamente:
 * «avevamo detto di mettere i file modificati come dropdown e metterli in fondo
 * alla card, ma prima dell'input».
 *
 * IL RIASSUNTO RESTA CHIUSO. Aprire ogni card di una colonna trasformerebbe la
 * review in un muro di percorsi: il numero e' cio' che si legge di sfuggita, i
 * nomi sono cio' che si chiede quando quella card interessa davvero.
 *
 * SI CARICA SOLO QUANDO SI APRE. I nomi non stanno nel task (il DB tiene solo i
 * conteggi) e arrivano da `/tasks/:id/diff`, che legge git: chiederlo per ogni
 * card di una board sarebbe una lettura di repository per riga. Una volta
 * caricati restano, finche' la card e' montata.
 */

/** Quanti file si mostrano prima di dire «e altri N». Un elenco piu' lungo di
 *  cosi' dentro una card non si legge: quello intero e' nel drawer, dove c'e'
 *  anche il diff. */
const MAX_FILE = 12;

interface FileStat { path: string; additions: number; deletions: number; status: string }

export function DeliveryFiles({ projectId, taskId, files, insertions, deletions, commit }: {
  projectId: string;
  taskId: string;
  /** Il CONTEGGIO, che il task porta sempre: e' cio' che si vede da chiuso. */
  files: number;
  insertions: number;
  deletions: number;
  commit: string | null;
}) {
  const tr = useT();
  const [aperto, setAperto] = useState(false);
  const [stat, setStat] = useState<FileStat[] | null>(null);
  /** Un errore si DICE: un elenco vuoto dopo un click fa pensare a una
   *  consegna senza file, che e' un'altra affermazione. */
  const [errore, setErrore] = useState<string | null>(null);
  const [caricando, setCaricando] = useState(false);

  const apri = useCallback(async (e: React.MouseEvent) => {
    // Il click nudo sulla card apre il drawer: qui NON vogliamo tutte e due le
    // cose insieme.
    e.stopPropagation();
    const prossimo = !aperto;
    setAperto(prossimo);
    if (!prossimo || stat || caricando) return;
    setCaricando(true);
    setErrore(null);
    try {
      const d = await boardApi.taskDiff(projectId, taskId);
      setStat(Array.isArray(d?.stat) ? (d.stat as FileStat[]) : []);
    } catch (err) {
      setErrore(err instanceof Error ? err.message : String(err));
    } finally {
      setCaricando(false);
    }
  }, [aperto, stat, caricando, projectId, taskId]);

  const mostrati = stat?.slice(0, MAX_FILE) ?? [];
  const resto = (stat?.length ?? 0) - mostrati.length;

  return (
    <div className="mt-1.5" data-testid="card-delivery-files">
      <button
        type="button"
        onClick={apri}
        aria-expanded={aperto}
        data-testid="card-delivery-files-toggle"
        title={tr('board.card.deliveryStatTitle', {
          files, add: insertions, del: deletions, commit: commit?.slice(0, 8) ?? '?',
        })}
        className="flex w-full items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-xs md:text-[11px] text-app-text-heading hover:bg-white/15"
      >
        <FileDiff className="h-3 w-3 shrink-0" />
        {tr('board.card.deliveryFiles', { n: files })}
        {/* I due numeri con i loro colori: il verde e il rosso qui non sono uno
            stato ma un VERSO, ed e' l'unica cosa che distingue una consegna che
            aggiunge da una che cancella. */}
        <span className="text-emerald-400">+{insertions}</span>
        <span className="text-rose-400">-{deletions}</span>
        <ChevronDown
          className={`ml-auto h-3 w-3 shrink-0 transition-transform ${aperto ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {aperto && (
        <div
          data-testid="card-delivery-files-list"
          onClick={(e) => e.stopPropagation()}
          className="mt-1 max-h-40 overflow-y-auto rounded border border-app-border bg-black/20 px-1.5 py-1 scrollbar-standard"
        >
          {caricando && <div className="px-0.5 py-1 text-[10px] text-app-text-muted">{tr('board.card.deliveryFilesLoading')}</div>}
          {errore && <div className="px-0.5 py-1 text-[10px] text-rose-300">{tr('board.card.deliveryFilesError')}</div>}
          {!caricando && !errore && stat?.length === 0 && (
            <div className="px-0.5 py-1 text-[10px] text-app-text-muted">{tr('board.card.deliveryFilesEmpty')}</div>
          )}
          {mostrati.map((f) => (
            <div key={f.path} className="flex items-center gap-1.5 py-0.5 text-[10px] leading-tight">
              {/* IL PERCORSO SI TRONCA A SINISTRA, non a destra: di
                  `client/src/components/Board/Card.tsx` la parte che identifica
                  il file e' la FINE, e `truncate` mangia proprio quella.
                  `dir="rtl"` col testo isolato inverte il taglio senza
                  invertire le lettere. */}
              <span
                dir="rtl"
                className="truncate text-app-text-secondary"
                title={f.path}
              >&#x2066;{f.path}&#x2069;</span>
              <span className="ml-auto shrink-0 tabular-nums text-emerald-400">+{f.additions}</span>
              <span className="shrink-0 tabular-nums text-rose-400">-{f.deletions}</span>
            </div>
          ))}
          {resto > 0 && (
            // La coda si DICHIARA invece di sparire: un elenco troncato in
            // silenzio fa credere di aver visto tutto.
            <div className="px-0.5 pt-1 text-[10px] text-app-text-muted">
              {tr('board.card.deliveryFilesMore', { n: resto })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
