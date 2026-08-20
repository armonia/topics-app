import type { ContextSource } from '../../lib/api';
import type { ContextUsage } from '../../types';
import { useT } from '../../hooks/useT';
import { contextLevel } from '../../../../shared/context-thresholds';
import { formatTokens } from '../../lib/formatTokens';

const CATEGORY_COLORS: Record<string, string> = {
  openclaw: '#3b82f6',   // blue
  memory: '#8b5cf6',     // purple
  prompt: '#f59e0b',     // amber
  template: '#22c55e',   // green
  file: '#ef4444',       // red
  pinned: '#06b6d4',     // cyan
};

interface ContextBudgetBarProps {
  sources: ContextSource[];
  totalTokens: number;
  budgetLimit: number;
  budgetPercent: number;
  /**
   * La misura REALE dell'ultima chiamata al modello, quando c'è: è lo stesso
   * numero dell'anello nel composer, cioè quello per cui questo pannello si
   * apre. Assente su una chat che non ha ancora parlato col modello.
   */
  live?: ContextUsage | null;
}

/**
 * IL GRAFICO IN CIMA, E LE DUE MISURE NELL'ORDINE IN CUI SI CHIEDONO.
 *
 * Questo blocco rispondeva a una domanda sola — «di cosa è fatto il contesto
 * che iniettiamo noi» — e la metteva sotto un'etichetta che diceva soltanto
 * "Injected Context (estimate)". Ma il pannello lo si apre CLICCANDO L'ANELLO,
 * e l'anello mostra un altro numero: quanto ha in pancia il modello adesso.
 * Aprire una cosa e trovarci dentro una misura diversa da quella che si è
 * cliccata è il motivo per cui questo pannello non si capiva.
 *
 * Adesso in cima c'è QUEL numero, grande, con la sua barra e il suo colore
 * (le stesse soglie dell'anello, dalla funzione condivisa). Il preventivo di
 * ciò che iniettiamo resta — è l'unica parte su cui si può intervenire — ma
 * sotto, sottile, etichettato per quello che è, con la scomposizione a colori
 * e la legenda sulla stessa riga invece che su tre.
 */
export function ContextBudgetBar({ sources, totalTokens, budgetLimit, budgetPercent, live }: ContextBudgetBarProps) {
  const tr = useT();
  // Le soglie sono quelle condivise, non una copia: la barra le riscriveva con
  // `>` mentre il server classifica con `>=`, e ignorava la soglia in token
  // assoluti. `totalTokens` la abilita anche qui.
  const level = contextLevel(budgetPercent, totalTokens);
  const isCritical = level === 'critical';
  const isWarning = level === 'warn';

  // Il livello della misura VIVA lo ha già classificato il server: si usa
  // quello, non una riclassificazione locale della sola percentuale (che non
  // conoscerebbe la soglia in token assoluti).
  const liveLevel = live?.level ?? 'ok';
  const liveColor = liveLevel === 'critical'
    ? 'text-red-500'
    : liveLevel === 'warn'
      ? 'text-amber-500'
      : 'text-app-text';
  const liveFill = liveLevel === 'critical'
    ? 'bg-red-500'
    : liveLevel === 'warn'
      ? 'bg-amber-500'
      : 'bg-blue-500';

  const enabledSources = sources.filter(s => s.enabled && s.tokens > 0 && s.countInBudget);

  return (
    <div data-testid="context-budget-bar" className="px-4 pt-3 pb-2.5 border-b border-app-border">
      {/* LA MISURA VIVA — la stessa dell'anello da cui si è arrivati qui. */}
      {live && (
        <div className="mb-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-app-text-secondary">
              {live.model ? live.model : tr('ctxInspector.live')}
            </span>
            <span className={`text-[11px] tabular-nums ${liveColor}`}>
              {formatTokens(live.used)} / {live.estimated ? '≈' : ''}{formatTokens(live.size)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
              <div
                data-testid="live-context-fill"
                className={`h-full rounded-full transition-all duration-300 ${liveFill}`}
                style={{ width: `${Math.min(Math.max(live.percent, 0), 100)}%` }}
              />
            </div>
            <span data-testid="live-context-percent" className={`text-[15px] font-semibold tabular-nums leading-none ${liveColor}`}>
              {live.percent}%
            </span>
          </div>
        </div>
      )}

      {/* IL PREVENTIVO — quello su cui si può agire, spegnendo una sorgente. */}
      <div className="flex items-center justify-between mb-1">
        {/* Etichetta esplicita: questo è il PREVENTIVO di ciò che iniettiamo
            noi all'inizio del turno, non il contesto vivo del modello. Quello
            è la barra qui sopra (e l'anello nel composer). Due domande
            diverse: chiamarli tutti e due "Context" faceva sembrare che il
            13% dell'envelope fosse il 13% della finestra. */}
        <span
          className="text-[11px] text-app-text-secondary"
          title={tr('ctxInspector.injected.hint')}
        >
          {tr('ctxInspector.injected')}
        </span>
        <span data-testid="budget-percent" className={`text-[11px] tabular-nums ${isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-app-text-secondary'}`}>
          {formatTokens(totalTokens)} / {formatTokens(budgetLimit)} ({budgetLimit > 0 ? budgetPercent : 0}%)
        </span>
      </div>
      {/* Stacked bar */}
      <div className="h-1.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden flex">
        {enabledSources.map(source => {
          const widthPercent = budgetLimit > 0 ? (source.tokens / budgetLimit) * 100 : 0;
          if (widthPercent < 0.3) return null;
          return (
            <div
              key={source.id}
              className="h-full transition-all duration-300"
              style={{
                width: `${Math.min(widthPercent, 100)}%`,
                backgroundColor: CATEGORY_COLORS[source.category] || '#6b7280',
              }}
              title={`${source.label}: ${formatTokens(source.tokens)} tokens`}
            />
          );
        })}
      </div>
      {/* Legend — una riga sola, e solo le categorie che esistono davvero. */}
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-1.5">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => {
          const catSources = enabledSources.filter(s => s.category === cat);
          if (catSources.length === 0) return null;
          const catTokens = catSources.reduce((sum, s) => sum + s.tokens, 0);
          return (
            <div key={cat} className="flex items-center gap-1 text-[10px] text-app-text-muted">
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <span className="capitalize">{cat === 'openclaw' ? 'OpenClaw' : cat}</span>
              <span className="tabular-nums">{formatTokens(catTokens)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
