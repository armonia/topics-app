import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, History, GitCommit } from 'lucide-react';
import { gitApi } from '../../lib/api';
import { basename as pathBasename } from '../../lib/path-utils';
import { Spinner } from '../Shared/Spinner';
import type { GitLogEntry, GitCommitDetail, GitCommitFile } from '../../types';
import { useT } from '../../hooks/useT';

/**
 * La cronologia dei commit.
 *
 * `/api/git/log` e `gitApi.log` esistevano da sempre e non li chiamava
 * NESSUNO: il pannello mostrava l'ultimo commit e basta, e per vedere cosa
 * conteneva quello prima bisognava uscire dall'app. Rotta e metodo erano codice
 * morto che sembrava una funzionalità.
 *
 * Si carica in tre passi, e ognuno solo quando serve: la lista dei commit
 * quando apri la sezione, i file di un commit quando apri quel commit, il diff
 * quando apri quel file. Un `git show` per ogni commit in lista sarebbe stato
 * il modo più veloce per rendere lento il pannello.
 *
 * Le righe NON hanno una tipografia loro: prendono quella delle righe della
 * lista modifiche, con cui dividono il pannello. Con un `text-[12px]` erano
 * alte 24px contro 25,5 (misurato), cioè due liste sulla stessa colonna che non
 * stanno sulla stessa griglia — e l'evidenziazione al passaggio del mouse lo
 * mostra riga per riga.
 */

const PAGINA = 20;

function stateColor(status: string): string {
  switch (status) {
    case 'A': return 'text-green-500';
    case 'D': return 'text-red-500';
    case 'R': case 'C': return 'text-blue-500';
    default: return 'text-amber-500';
  }
}

function RowFile({ file, onOpen }: { file: GitCommitFile; onOpen: () => void }) {
  const nome = pathBasename(file.path) || file.path;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  return (
    <button
      onClick={onOpen}
      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
      className="w-full flex items-center gap-1.5 px-3 py-[3px] text-left hover:bg-app-hover transition-colors"
    >
      <span className={`${stateColor(file.status)} text-[8px] font-bold w-[14px] text-center flex-shrink-0`}>
        {file.status}
      </span>
      <span className="truncate text-app-text-body min-w-0">
        {file.origPath && (
          <span className="text-app-text-muted line-through mr-1">
            {pathBasename(file.origPath) || file.origPath}
          </span>
        )}
        {nome}
        {dir && <span className="text-app-text-muted ml-1 text-[11px]">{dir}</span>}
      </span>
      <span className="ml-auto text-[10px] tabular-nums flex-shrink-0 leading-none">
        {file.binary
          ? <span className="text-app-text-muted">bin</span>
          : <>
              {file.added > 0 && <span className="text-green-500">+{file.added}</span>}
              {file.added > 0 && file.removed > 0 && ' '}
              {file.removed > 0 && <span className="text-red-500">-{file.removed}</span>}
            </>}
      </span>
    </button>
  );
}

export interface CommitHistoryProps {
  projectPath: string;
  /** Aperto un file di un commit: `rev` è l'hash, il chiamante mostra il diff. */
  onOpenFile?: (file: string, rev: string) => void;
  /** Sale a ogni commit: la lista va riletta perché ce n'è uno nuovo in cima. */
  reloadKey?: unknown;
  /**
   * Dove sta.
   *
   * `section` — una fascia richiudibile dentro un pannello: porta la sua
   * intestazione e il suo bordo, e la lista ha un tetto per non mangiarsi il
   * pannello che la ospita.
   *
   * `popover` — il corpo di un popover, che È già la sua disclosure: niente
   * intestazione (sarebbe una seconda etichetta sopra la prima), niente bordo,
   * lista sempre aperta. Il tetto lo mette il popover, che si clampa allo
   * schermo e non a un pannello — ed è tutta la ragione per cui la cronologia
   * è finita lì: dentro il pannello competeva per l'altezza con la lista dei
   * file e perdeva, tagliandosi.
   */
  variant?: 'section' | 'popover';
}

export function CommitHistory({ projectPath, onOpenFile, reloadKey, variant = 'section' }: CommitHistoryProps) {
  const t = useT();
  const inPopover = variant === 'popover';
  // Nel popover è sempre aperta: chi l'ha aperto ha già espresso l'intenzione.
  const [expanded, setExpanded] = useState(inPopover);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [limit, setLimit] = useState(PAGINA);
  const [loading, setLoading] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [apertoHash, setApertoHash] = useState<string | null>(null);
  const [dettaglio, setDettaglio] = useState<GitCommitDetail | null>(null);
  const [caricandoDettaglio, setCaricandoDettaglio] = useState(false);
  // Il dettaglio arriva in ritardo: senza questo, aprire un commit e poi
  // subito un altro lascia in vista i file del primo se la sua risposta arriva
  // per seconda.
  const requestRef = useRef(0);

  const carica = useCallback(async (quanti: number) => {
    setLoading(true);
    setErrore(null);
    try {
      setCommits(await gitApi.log(projectPath, quanti));
    } catch (err) {
      setErrore(err instanceof Error ? err.message : 'Non sono riuscito a leggere la cronologia');
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  // Solo da aperta: una sezione chiusa che interroga git a ogni commit è
  // lavoro che nessuno guarda.
  useEffect(() => {
    if (!expanded) return;
    carica(limit);
  }, [expanded, limit, carica, reloadKey]);

  // Cambiando progetto quello che c'è in vista non è più di questo progetto.
  useEffect(() => {
    setCommits([]);
    setApertoHash(null);
    setDettaglio(null);
    setLimit(PAGINA);
  }, [projectPath]);

  const openCommit = useCallback(async (hash: string) => {
    if (apertoHash === hash) { setApertoHash(null); setDettaglio(null); return; }
    const mio = ++requestRef.current;
    setApertoHash(hash);
    setDettaglio(null);
    setCaricandoDettaglio(true);
    try {
      const d = await gitApi.commitFiles(projectPath, hash);
      if (requestRef.current === mio) setDettaglio(d);
    } catch {
      if (requestRef.current === mio) setDettaglio(null);
    } finally {
      if (requestRef.current === mio) setCaricandoDettaglio(false);
    }
  }, [projectPath, apertoHash]);

  // `min-h-0` sul contenitore, e l'intestazione qui sotto `flex-shrink-0`: sono
  // le due meta' della stessa regola, e vanno insieme.
  //
  // Senza `min-h-0` questa sezione non cede MAI, perche' il suo min-content
  // comprende l'intera lista dei commit: misurato, 173px di piede dentro un
  // pannello da 200, con gli ultimi commit tagliati dal fondo — «tagliato a
  // meta'». Con `min-h-0` la sezione cede, e a cedere dentro di lei e' la
  // LISTA: l'intestazione e' `flex-shrink-0` e resta, la lista scorre gia' di
  // suo. Mettere solo `min-h-0` senza proteggere l'intestazione e' l'errore
  // opposto — la sezione si schiacciava a 1px sui 33 naturali.
  return (
    <div
      className={inPopover ? 'flex flex-col min-h-0' : 'border-t border-app-border flex flex-col min-h-0'}
      data-testid="commit-history"
      data-variant={variant}
    >
      {/* `py-2`, come ogni altra riga del piede e come l'intestazione del
          pannello (`h-8`, cioe' ~8px sopra il testo). Con `py-1` questa riga
          aveva 4px sopra contro gli 8px della riga sopra: piu' bassa di 9px e
          asimmetrica, e si leggeva come schiacciata sul fondo. */}
      {inPopover ? (
        // Nel popover l'unica cosa da dire è che sta caricando: il titolo lo
        // porta già il popover, e un secondo «Cronologia» qui sarebbe una
        // ripetizione dentro un contenitore alto quattro righe.
        loading && commits.length === 0 ? (
          <div className="px-3 py-2 flex items-center gap-2 text-[11px] text-app-text-muted">
            <Spinner size="sm" /> Carico…
          </div>
        ) : null
      ) : (
        <div className="flex items-center justify-between px-3 py-2 flex-shrink-0">
          <button
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider hover:text-app-text-hover transition-colors"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <History size={10} />
            Cronologia
          </button>
          {expanded && loading && <Spinner size="sm" />}
        </div>
      )}

      {/* Aperta, la lista scorre DENTRO di se': e' un pie' di pagina, non deve
          spingere. Senza, con venti commit in un pannello basso il contenuto
          sfondava il fondo del pannello (misurato: 2,5px oltre) e lo scroller
          dei file si schiacciava a zero. Il tetto la limita anche quando lo
          spazio ci sarebbe: aprire la cronologia non deve far sparire la lista
          delle modifiche. */}
      {expanded && (
        <div className={inPopover ? 'pb-1 overflow-y-auto flex-1 min-h-0' : 'pb-1 overflow-y-auto flex-1 min-h-0 max-h-[220px]'}>
          {errore && <div className="px-3 py-1 text-[11px] text-red-500">{errore}</div>}
          {!errore && !loading && commits.length === 0 && (
            <div className="px-3 py-1 text-[11px] text-app-text-muted">{t('git.history.noCommits')}</div>
          )}

          {commits.map(c => {
            const aperto = apertoHash === c.hash;
            return (
              <div key={c.hash}>
                <button
                  onClick={() => openCommit(c.hash)}
                  aria-expanded={aperto}
                  title={`${c.message}\n${c.author} · ${c.ago}`}
                  data-testid="commit-row"
                  className={`w-full flex items-center gap-1.5 px-3 py-[3px] text-left transition-colors ${aperto ? 'bg-app-hover' : 'hover:bg-app-hover'}`}
                >
                  <GitCommit size={10} className="flex-shrink-0 text-app-text-tertiary" />
                  <span className="truncate text-app-text-body min-w-0">{c.message}</span>
                  <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 text-[10px] text-app-text-muted">
                    <span className="font-mono">{c.shortHash || c.hash.slice(0, 7)}</span>
                    <span>{c.ago}</span>
                  </span>
                </button>

                {aperto && (
                  <div className="bg-app-hover/40">
                    {caricandoDettaglio && (
                      <div className="px-3 py-1 text-[11px] text-app-text-muted">{t('common.loading')}</div>
                    )}
                    {!caricandoDettaglio && dettaglio?.files.length === 0 && (
                      <div className="px-3 py-1 text-[11px] text-app-text-muted">
                        {t('git.history.noFilesHere')}
                      </div>
                    )}
                    {!caricandoDettaglio && dettaglio?.files.map(f => (
                      <RowFile
                        key={f.path}
                        file={f}
                        onOpen={() => onOpenFile?.(f.path, c.hash)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Si allunga a richiesta: chiedere mille commit a un repo grosso per
              mostrarne venti è lavoro buttato. */}
          {commits.length >= limit && (
            <button
              onClick={() => setLimit(l => l + PAGINA)}
              className="w-full px-3 py-1 text-[11px] text-primary hover:underline text-left"
            >
              {t('git.history.showMore', { n: PAGINA })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
