import { useState, useEffect, useCallback } from 'react';
import { Plus, Minus, Undo2 } from 'lucide-react';
import { gitApi } from '../../lib/api';
import { Spinner } from '../Shared/Spinner';
import { ConfirmDialog } from '../Shared/ConfirmDialog';
import { createPortal } from 'react-dom';
import type { GitHunkSummary } from '../../types';
import { useHoverReveal } from '../../hooks/useHoverReveal';
import { useT } from '../../hooks/useT';

/**
 * I blocchi di un file, uno alla volta.
 *
 * Si poteva solo `git add <file>`: tutto o niente. Un fix e un rimaneggiamento
 * fatti nella stessa sessione finivano nello stesso commit per il solo motivo
 * di stare nello stesso file.
 *
 * La lista NON ridisegna il diff: quello sta già nel visualizzatore accanto, e
 * un secondo modo di leggere le stesse righe sarebbe solo un altro posto in cui
 * sbagliare. Qui c'è quel che serve a SCEGLIERE: dove comincia il blocco, che
 * funzione tocca, quante righe muove.
 *
 * Un lato alla volta, quello su cui si può agire adesso: se il file ha
 * modifiche non staged si mostrano quelle (Stage / Scarta), altrimenti quelle
 * nell'indice (Unstage). Mostrare entrambe le liste insieme vorrebbe dire due
 * numerazioni sullo schermo, e gli indici dei blocchi sono relativi al loro
 * diff: sbagliare lista vuol dire mettere in stage il blocco sbagliato.
 *
 * `px-3` e non `px-2`: e' il rientro dell'intestazione che sta subito sopra in
 * entrambi i posti dove questa striscia compare (il pannello Git e la tab del
 * diff). Con `px-2` il testo delle righe partiva 4px piu' a sinistra di quello
 * sopra, e l'evidenziazione al passaggio del mouse rendeva lo scalino evidente.
 */

export interface HunkActionsProps {
  projectPath: string;
  file: string;
  /**
   * Il lato da mostrare, quando chi monta lo SA.
   *
   * Il pannello git lo sa — è il gruppo della riga cliccata — e passarlo evita
   * che la striscia mostri un lato mentre il diff sopra ne mostra un altro:
   * cliccando sotto «Staged» il diff confronta HEAD con l'indice, e i blocchi
   * giusti da elencare sono quelli DA TOGLIERE, non quelli fuori dall'indice.
   *
   * Omesso, si indovina come prima: la tab del diff non conosce lo stato git
   * del file, e chiederglielo vorrebbe dire portarlo in un posto che non ne ha
   * bisogno per nient'altro.
   */
  side?: 'staged' | 'unstaged';
  /** Da rialzare quando lo stato git cambia, così la lista si rilegge. */
  reloadKey?: unknown;
  onApplied?: () => void;
}

export function HunkActions({ projectPath, file, side: sideProp, reloadKey, onApplied }: HunkActionsProps) {
  const t = useT();
  // Stage/scarta di un singolo blocco non hanno un altro percorso col dito (non
  // c'e' un menu di riga sugli hunk), quindi senza puntatore i comandi si
  // VEDONO invece di restare bersagli invisibili: `touch: 'shown'`.
  const hunkReveal = useHoverReveal('hunk', { touch: 'shown' });
  const [hunks, setHunks] = useState<GitHunkSummary[]>([]);
  const [side, setSide] = useState<'staged' | 'unstaged'>('unstaged');
  const [loading, setLoading] = useState(false);
  const [inCorso, setInCorso] = useState<number | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [daScartare, setDaScartare] = useState<number | null>(null);

  // Il lato lo decide questo componente, non chi lo monta: la tab del diff non
  // conosce lo stato git del file, e chiederglielo vorrebbe dire portare lo
  // stato git in un posto che non ne ha bisogno per nient'altro. Prima si
  // guarda fuori dall'indice, che è il caso comune; se lì non c'è niente si
  // guarda dentro, così un file completamente staged mostra comunque i suoi
  // blocchi da togliere invece di sparire.
  useEffect(() => {
    let vivo = true;
    setLoading(true);
    setErrore(null);
    (async () => {
      try {
        // Se il lato è dichiarato si prende quello, senza indovinare: chi lo
        // passa lo sa meglio di questa euristica, e un disaccordo fra la
        // striscia e il diff sopra fa mettere in stage il blocco sbagliato.
        if (sideProp) {
          const dati = await gitApi.hunks(projectPath, file, sideProp);
          if (!vivo) return;
          setSide(sideProp);
          setHunks(dati.hunks);
          return;
        }
        const fuori = await gitApi.hunks(projectPath, file, 'unstaged');
        if (!vivo) return;
        if (fuori.hunks.length > 0) { setSide('unstaged'); setHunks(fuori.hunks); return; }
        const dentro = await gitApi.hunks(projectPath, file, 'staged');
        if (!vivo) return;
        setSide('staged');
        setHunks(dentro.hunks);
      } catch {
        if (vivo) setHunks([]);
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => { vivo = false; };
  }, [projectPath, file, sideProp, reloadKey]);

  const applica = useCallback(async (index: number, action: 'stage' | 'unstage' | 'discard') => {
    setInCorso(index);
    setErrore(null);
    try {
      await gitApi.applyHunks(projectPath, file, [index], action);
      onApplied?.();
    } catch (err) {
      // Il 409 del server vuol dire «il file è cambiato sotto, gli indici che
      // hai in mano non descrivono più niente»: è un messaggio da leggere, non
      // un errore da inghiottire.
      setErrore(err instanceof Error ? err.message : 'Non è riuscito');
    } finally {
      setInCorso(null);
    }
  }, [projectPath, file, onApplied]);

  if (loading && hunks.length === 0) {
    return (
      <div className="px-3 py-1 border-b border-app-border flex items-center gap-2 text-[11px] text-app-text-muted">
        <Spinner size="xs" /> Cerco i blocchi…
      </div>
    );
  }
  // Un blocco solo è il file intero: i bottoni per file ci sono già sulla riga
  // della lista, e ripeterli qui sarebbe una seconda strada per la stessa cosa.
  if (hunks.length < 2) return null;

  return (
    <div className="border-b border-app-border" data-testid="hunk-actions">
      <div className="px-3 py-1 flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
          {hunks.length} blocchi
        </span>
        <span className="text-[10px] text-app-text-muted">
          {side === 'unstaged' ? 'fuori dall’indice' : 'nell’indice'}
        </span>
        {inCorso !== null && <Spinner size="xs" />}
      </div>

      {errore && <div className="px-3 pb-1 text-[11px] text-red-500">{errore}</div>}

      <div className="max-h-[140px] overflow-y-auto">
        {hunks.map(h => (
          <div
            key={h.index}
            data-testid="hunk-row"
            className="flex items-center gap-1.5 px-3 py-[3px] group/hunk hover:bg-app-hover transition-colors"
          >
            <span className="text-[10px] font-mono text-app-text-muted flex-shrink-0 tabular-nums">
              :{h.oldStart}
            </span>
            <span className="truncate text-[11px] text-app-text-body min-w-0" title={h.context}>
              {h.context || '-'}
            </span>
            <span className="ml-auto text-[10px] tabular-nums flex-shrink-0 leading-none">
              {h.added > 0 && <span className="text-green-500">+{h.added}</span>}
              {h.added > 0 && h.removed > 0 && ' '}
              {h.removed > 0 && <span className="text-red-500">-{h.removed}</span>}
            </span>
            <div className={`flex items-center gap-0.5 flex-shrink-0 ${hunkReveal}`}>
              {side === 'unstaged' ? (
                <>
                  <button
                    onClick={() => setDaScartare(h.index)}
                    disabled={inCorso !== null}
                    className="p-0.5 rounded hover:bg-app-hover disabled:opacity-40"
                    title={t('git.hunk.discardTitle')}
                  >
                    <Undo2 size={11} className="text-app-text-muted" />
                  </button>
                  <button
                    onClick={() => applica(h.index, 'stage')}
                    disabled={inCorso !== null}
                    className="p-0.5 rounded hover:bg-app-hover disabled:opacity-40"
                    title={t('git.hunk.stageTitle')}
                  >
                    <Plus size={11} className="text-green-500" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => applica(h.index, 'unstage')}
                  disabled={inCorso !== null}
                  className="p-0.5 rounded hover:bg-app-hover disabled:opacity-40"
                  title={t('git.hunk.unstageTitle')}
                >
                  <Minus size={11} className="text-red-500" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Scartare un blocco riscrive il FILE e git non ne ha copia: è l'unica
          delle tre azioni da cui non si torna indietro, quindi si chiede. */}
      {daScartare !== null && createPortal(
        <ConfirmDialog
          title={t('git.hunk.discardConfirmTitle')}
          confirmLabel={t('git.hunk.discardConfirmLabel')}
          onConfirm={() => { const i = daScartare; setDaScartare(null); applica(i, 'discard'); }}
          onCancel={() => setDaScartare(null)}
        >
          {t('git.hunk.discardConfirmBody')}
        </ConfirmDialog>,
        document.body,
      )}
    </div>
  );
}
