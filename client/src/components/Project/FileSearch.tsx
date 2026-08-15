import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, FileText, Type, ArrowLeft } from 'lucide-react';
import { filesApi } from '../../lib/api';
import { basename } from '../../lib/path-utils';
import { rankPaths } from '../../lib/fuzzyScore';
import {
  MODAL_PANEL, MODAL_LAYER,
  MODAL_PAGE_CONTAINER, MODAL_PAGE_PANEL, MODAL_PAGE_INSET,
} from '@/lib/modalStyles';
import { useMobile } from '@/hooks/useMobile';
import { useModalDialog } from '@/hooks/useModalDialog';
import { SELECTED_SURFACE } from '@/lib/selectionStyles';
import { Spinner } from '../Shared/Spinner';
import { useT } from '@/hooks/useT';

/**
 * FileSearch — «cerca nei progetti», UNA superficie con due modi.
 *
 * Prima era mono-progetto e legata a ⌘P, che però la annunciava come
 * «Quick-open file» mentre apriva un grep nel CONTENUTO: l'etichetta diceva una
 * cosa e il tasto ne faceva un'altra, e la ricerca per NOME esisteva solo
 * sepolta dentro ⌘K. Da qui il senso di mescolanza fra ⌘P, ⌘F e ⌘⇧F (che era
 * un alias identico di ⌘P).
 *
 * Ora:
 *   - `mode='name'`    → ⌘P, apri un file per nome (`/api/files/flat`,
 *     ordinato col matcher a punteggio di `lib/fuzzyScore`);
 *   - `mode='content'` → ⌘F, cerca dentro i file (`/api/files/search`, grep);
 *   - e il perimetro non è più un progetto solo ma il progetto a FUOCO più
 *     quelli APERTI, perché è così che si lavora qui: un progetto per tab.
 *
 * Il modo si commuta anche dalla UI, quindi i due tasti atterrano nello stesso
 * posto e nessuno resta prigioniero della scorciatoia che ha premuto.
 */

export type FileSearchMode = 'name' | 'content';

interface SearchResult {
  /** Radice del progetto a cui appartiene questa riga. */
  project: string;
  /** Path relativo alla radice. */
  file: string;
  /** Riga trovata (solo mode='content'). */
  line?: string;
  lineNumber?: number;
  match?: string;
}

interface FileSearchProps {
  /** Progetto a fuoco per primo, poi gli altri aperti. Mai vuoto. */
  projectPaths: string[];
  /** CONTROLLATO, non solo iniziale: ⌘P e ⌘F commutano il modo mentre la
   *  superficie è già aperta, e se lo stato vivesse qui dentro la prop
   *  cambierebbe senza che si veda niente. Lo stato sta in chi apre, così il
   *  tasto e l'interruttore parlano della stessa cosa. */
  mode: FileSearchMode;
  onModeChange: (mode: FileSearchMode) => void;
  onOpenFile?: (path: string, lineNumber?: number) => void;
  onClose: () => void;
}

/** Quanti file per nome mostrare. Il taglio arriva DOPO l'ordinamento. */
const NAME_LIMIT = 40;

export function FileSearch({ projectPaths, mode, onModeChange, onOpenFile, onClose }: FileSearchProps) {
  const tr = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [useRegex, setUseRegex] = useState<boolean>(false);
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [regexError, setRegexError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resultRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Il perimetro è stabile per tutta l'apertura: se l'utente cambia tab mentre
  // cerca, la lista sotto le mani non deve cambiare da sé.
  const projects = useMemo(() => projectPaths.filter(Boolean), [projectPaths]);
  const multi = projects.length > 1;

  // Escape chiude, il Tab resta dentro, il focus torna da dove è partito.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalDialog({ onClose, panelRef, initialFocusRef: inputRef });

  // Monotonic request token: a SLOWER earlier query (broad pattern, many
  // matches) resolving after a faster later one must not overwrite the newer
  // results — the input showed the new query with the old query's matches and
  // nothing re-corrected it until the user typed again.
  const searchSeqRef = useRef(0);

  /** Elenco piatto dei file per progetto, preso una volta per apertura. */
  const flatCache = useRef<Map<string, string[]>>(new Map());

  const doSearch = useCallback(async (q: string) => {
    const seq = ++searchSeqRef.current;
    setRegexError(null);
    setTruncated(false);
    setFailed(false);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    if (mode === 'content' && useRegex) {
      try { new RegExp(q); } catch (e: unknown) { setRegexError((e instanceof Error && e.message) || 'Invalid regex'); setResults([]); return; }
    }
    setLoading(true);
    try {
      // Un progetto lento non deve tenere in ostaggio gli altri: si chiede a
      // tutti insieme e si tiene ciò che risponde. `allSettled` e non `all` —
      // con `all` un solo progetto sparito (cartella rimossa, permessi) faceva
      // sparire TUTTI i risultati.
      const settled = await Promise.allSettled(projects.map(async (root): Promise<SearchResult[]> => {
        if (mode === 'name') {
          let files = flatCache.current.get(root);
          if (!files) {
            files = (await filesApi.flatList(root)).files ?? [];
            flatCache.current.set(root, files);
          }
          return rankPaths(files, q, NAME_LIMIT).map((file) => ({ project: root, file }));
        }
        const data = await filesApi.search(root, q, useRegex, caseSensitive);
        if ((data as { truncated?: boolean }).truncated) setTruncated(true);
        return data.results.map((r) => ({ project: root, file: r.file, line: r.line, lineNumber: r.lineNumber, match: r.match }));
      }));
      if (seq !== searchSeqRef.current) return; // stale — a newer search ran
      if (settled.every((s) => s.status === 'rejected')) setFailed(true);
      const merged = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
      // In modo NOME il punteggio è per progetto: si ri-ordina sull'unione, o
      // il progetto che risponde per primo si prende le prime righe.
      setResults(
        mode === 'name'
          ? rankPaths(merged.map((r) => `${r.project}\u0000${r.file}`), q, NAME_LIMIT).map((k) => {
              const [project, file] = k.split('\u0000');
              return { project, file };
            })
          : merged,
      );
    } catch {
      if (seq !== searchSeqRef.current) return;
      setFailed(true);
      setResults([]);
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  }, [projects, mode, useRegex, caseSensitive]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, doSearch]);

  // Reset selection when results change
  useEffect(() => { setSelectedIdx(-1); }, [results]);

  const openResult = useCallback((r: SearchResult) => {
    onOpenFile?.(`${r.project}/${r.file}`, r.lineNumber);
    onClose();
  }, [onOpenFile, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => {
        const next = Math.min(prev + 1, results.length - 1);
        resultRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => {
        const next = Math.max(prev - 1, 0);
        resultRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
      return;
    }
    if (e.key === 'Enter' && selectedIdx >= 0 && selectedIdx < results.length) {
      e.preventDefault();
      openResult(results[selectedIdx]);
    }
  };

  const highlightMatch = (line: string, match: string) => {
    if (!match) return line;
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = useRegex ? new RegExp(match, flags) : new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const parts = line.split(regex);
      const matches = line.match(regex);
      if (!matches) return line;
      return parts.reduce((acc: (string | React.ReactElement)[], part, i) => {
        acc.push(part);
        if (i < matches.length) {
          acc.push(<span key={i} className="bg-yellow-300/60 dark:bg-yellow-500/40 rounded-sm px-0.5">{matches[i]}</span>);
        }
        return acc;
      }, []);
    } catch {
      return line;
    }
  };

  // Raggruppamento: per progetto (solo se più d'uno) e poi per file, così due
  // file omonimi in due progetti diversi restano distinguibili.
  const grouped = useMemo(() => {
    const out: Array<{ key: string; project: string; file: string; rows: SearchResult[] }> = [];
    const index = new Map<string, number>();
    for (const r of results) {
      // `\u0000` scritto come ESCAPE, non come byte: un NUL letterale nel
      // sorgente rende il file invisibile a `grep -r` (che lo tratta come
      // binario) e fa fallire il presidio `check:nul`. Il valore a runtime è lo
      // stesso — serve un separatore che non possa comparire in un percorso.
      const key = `${r.project}\u0000${r.file}`;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, out.length);
        out.push({ key, project: r.project, file: r.file, rows: [r] });
      } else {
        out[at].rows.push(r);
      }
    }
    return out;
  }, [results]);

  const scopeLabel = multi
    ? `${projects.length} progetti`
    : basename(projects[0] ?? '') || 'files';

  const { isMobile } = useMobile();

  /* Gli interruttori sono gli STESSI nei due posti: cambia dove atterrano e
     quanto sono alti. Un dito vuole 44px, un puntatore no, e scrivere due volte
     gli stessi bottoni li farebbe divergere alla prima modifica. */
  const btn = isMobile ? 'px-3 h-11 text-[13px]' : 'px-1.5 py-0.5 text-[11px]';
  /* Una riga di risultato e' un bersaglio: `py-1` la teneva a ~22px, cioe' meta'
     dei 44 sotto i quali un dito non centra piu' quello che vede. */
  const rowPad = isMobile ? 'py-3 min-h-11' : 'py-1';
  const modeControls = (
    <>
      {/* Il modo è un interruttore, non due superfici: chi ha premuto ⌘P e
          voleva ⌘F non deve chiudere e riaprire. */}
      <div
        className={`flex items-center rounded border border-app-spinner overflow-hidden flex-shrink-0 ${isMobile ? 'flex-1' : ''}`}
        role="group"
        aria-label={tr('fileSearch.modeGroup')}
      >
        <button
          data-testid="file-search-mode-name"
          onClick={() => onModeChange('name')}
          aria-pressed={mode === 'name'}
          className={`${btn} ${isMobile ? 'flex-1 justify-center' : ''} flex items-center gap-1 ${mode === 'name' ? 'text-primary bg-primary/10' : 'text-app-text-muted'}`}
          title={tr('fileSearch.byNameTitle')}
        >
          <FileText size={isMobile ? 14 : 11} aria-hidden="true" /> {tr('fileSearch.byName')}
        </button>
        <button
          data-testid="file-search-mode-content"
          onClick={() => onModeChange('content')}
          aria-pressed={mode === 'content'}
          className={`${btn} ${isMobile ? 'flex-1 justify-center' : ''} flex items-center gap-1 ${mode === 'content' ? 'text-primary bg-primary/10' : 'text-app-text-muted'}`}
          title={tr('fileSearch.inContentTitle')}
        >
          <Type size={isMobile ? 14 : 11} aria-hidden="true" /> {tr('fileSearch.inContent')}
        </button>
      </div>
      {/* Regex e case valgono solo per il grep: in modo NOME sarebbero due
          interruttori che non fanno niente. */}
      {mode === 'content' && (
        <>
          <button
            onClick={() => setCaseSensitive(v => !v)}
            className={`${btn} ${isMobile ? 'w-11 justify-center flex items-center' : ''} font-mono rounded border flex-shrink-0 ${caseSensitive ? 'border-primary text-primary bg-primary/10' : 'border-app-spinner text-app-text-muted'}`}
            title="Case sensitive"
          >
            Aa
          </button>
          <button
            onClick={() => setUseRegex(v => !v)}
            className={`${btn} ${isMobile ? 'w-11 justify-center flex items-center' : ''} font-mono rounded border flex-shrink-0 ${useRegex ? 'border-primary text-primary bg-primary/10' : 'border-app-spinner text-app-text-muted'}`}
            title="Use regex"
          >
            .*
          </button>
        </>
      )}
    </>
  );

  return (
    <div
      data-testid="file-search"
      data-page={isMobile ? 'true' : undefined}
      className={isMobile
        ? MODAL_PAGE_CONTAINER
        : `fixed inset-0 ${MODAL_LAYER} flex items-start justify-center pt-[10vh] bg-black/30 dark:bg-black/50 backdrop-blur-sm`}
      onClick={isMobile ? undefined : onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'name' ? tr('fileSearch.dialogOpen') : tr('fileSearch.dialogSearch')}
        className={isMobile
          ? MODAL_PAGE_PANEL
          : `w-[600px] max-w-[92vw] max-h-[70vh] ${MODAL_PANEL} flex flex-col`}
        onClick={e => e.stopPropagation()}
        style={isMobile ? MODAL_PAGE_INSET : undefined}
      >
        {/* Search input.
            Su mobile questa riga porta SOLO indietro + campo. Gli interruttori
            scendono sotto: a 320px la riga sola dovrebbe reggere icona, campo,
            due bottoni di modo, «Aa», «.*» e la X, e il campo si schiacciava a
            una manciata di pixel. */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border">
          {isMobile ? (
            <button
              onClick={onClose}
              aria-label={tr('common.close')}
              className="w-11 h-11 -ml-2 flex items-center justify-center flex-shrink-0 text-app-text-muted"
            >
              <ArrowLeft size={20} />
            </button>
          ) : (
            <Search size={16} className="text-app-text-muted flex-shrink-0" />
          )}
          <input
            ref={inputRef}
            // Ancora stabile per chi guarda da fuori. Il `placeholder` non lo è:
            // è testo, e per giunta testo che cambia col MODO e con lo scope
            // («Apri un file in X…» / «Cerca in X…»). Tre spec lo usavano come
            // locator quando era ancora inglese — `input[placeholder*="Search"]`
            // — e sono diventate rosse alla traduzione, dicendo «element(s) not
            // found» su un input che c'era eccome.
            data-testid="file-search-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'name' ? tr('fileSearch.placeholderOpen', { scope: scopeLabel }) : tr('fileSearch.placeholderSearch', { scope: scopeLabel })}
            /* Vedi CommandPalette: 44px di bersaglio, e 16px di testo perche'
               sotto quella misura iOS zooma la pagina al primo tocco. */
            className={`flex-1 bg-transparent outline-none text-app-text-heading placeholder-app-text-faint ${
              isMobile ? 'h-11 text-[16px]' : 'text-sm'
            }`}
          />
          {!isMobile && modeControls}
          {!isMobile && (
            <button onClick={onClose} className="text-app-text-muted hover:text-app-text-hover" aria-label={tr('common.close')}>
              <X size={16} />
            </button>
          )}
        </div>
        {/* La seconda riga esiste solo a schermo stretto: e' lo spazio che la
            riga del campo non aveva. */}
        {isMobile && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border flex-shrink-0">
            {modeControls}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}
          {regexError && !loading && (
            <div data-testid="regex-error" className="text-center text-red-400 text-xs py-4 px-3">{regexError}</div>
          )}
          {/* Un errore di rete NON è «nessun risultato»: dirlo uguale insegna
              che la cosa cercata non c'è, che è la bugia peggiore per una
              ricerca. */}
          {failed && !loading && !regexError && (
            <div data-testid="file-search-error" className="text-center text-red-400 text-xs py-6 px-3">
              {tr('fileSearch.failed')}
            </div>
          )}
          {!loading && !regexError && !failed && query && results.length === 0 && (
            <div className="text-center text-app-text-muted text-xs py-6">{tr('fileSearch.noResults')}</div>
          )}
          {!loading && (() => {
            let flatIdx = 0;
            return grouped.map((g) => (
              <div key={g.key} className="border-b border-app-border-subtle last:border-b-0">
                <div className="px-3 py-1 text-[11px] font-medium text-app-text-secondary bg-app-inset sticky top-0 flex items-center gap-1.5">
                  <span className="truncate">{g.file}</span>
                  {multi && (
                    <span className="text-app-text-muted flex-shrink-0">· {basename(g.project)}</span>
                  )}
                </div>
                {mode === 'name' ? (() => {
                  const idx = flatIdx++;
                  return (
                    <button
                      ref={el => { resultRefs.current[idx] = el; }}
                      onClick={() => openResult(g.rows[0])}
                      className={`w-full text-left px-3 ${rowPad} flex items-center gap-2 transition-colors ${
                        idx === selectedIdx ? SELECTED_SURFACE : 'hover:bg-app-hover'
                      }`}
                    >
                      <span className="text-xs text-app-text-body font-mono truncate">{g.file}</span>
                    </button>
                  );
                })() : g.rows.map((r, i) => {
                  const idx = flatIdx++;
                  return (
                    <button
                      key={`${r.lineNumber}-${i}`}
                      ref={el => { resultRefs.current[idx] = el; }}
                      onClick={() => openResult(r)}
                      className={`w-full text-left px-3 ${rowPad} flex items-start gap-2 transition-colors ${
                        idx === selectedIdx ? SELECTED_SURFACE : 'hover:bg-app-hover'
                      }`}
                    >
                      <span className="text-[11px] text-app-text-muted font-mono w-8 text-right flex-shrink-0 mt-0.5">
                        {r.lineNumber}
                      </span>
                      <span className="text-xs text-app-text-body font-mono truncate">
                        {highlightMatch((r.line ?? '').trim(), r.match ?? '')}
                      </span>
                    </button>
                  );
                })}
              </div>
            ));
          })()}
          {/* Troncato dal SERVER (timeout del grep) o dal nostro tetto: sono due
              cose diverse e vanno dette diverse. */}
          {!loading && truncated && (
            <div className="text-center text-amber-500 text-[11px] py-2">
              {tr('fileSearch.truncated')}
            </div>
          )}
          {!loading && !truncated && mode === 'content' && results.length >= 100 && (
            <div className="text-center text-app-text-muted text-[11px] py-2">{tr('fileSearch.first100')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
