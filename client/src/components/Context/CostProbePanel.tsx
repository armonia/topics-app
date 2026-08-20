import type { SessionCostProbe } from '../../types';
import { useT } from '@/hooks/useT';
import { formatTokens } from '../../lib/formatTokens';

/**
 * Il moltiplicatore della sessione, in chiaro: contesto × chiamate.
 *
 * PERCHÉ QUI. L'inspector rispondeva a una domanda sola — «cosa c'è dentro il
 * contesto» — e la barra sopra è il PREVENTIVO di ciò che iniettiamo noi. Manca
 * la domanda che decide la spesa: quel contesto quante volte è ripartito. Ogni
 * chiamata a un tool è una chiamata al modello, e ogni chiamata rilegge tutto:
 * una pagina fetchata al terzo turno la si ripaga a ogni chiamata fino in fondo.
 *
 * DUE NUMERI E NON UNO, ed è il punto di tutto il pannello. `projectedTokens`
 * (contesto di adesso × chiamate) è più grande di `promptTokens` (quello che è
 * partito davvero) perché il contesto CRESCEVA: i primi turni costavano meno di
 * quelli di adesso. Mostrare solo il primo sarebbe una previsione spacciata per
 * conto; solo il secondo sarebbe un conto senza la causa. Il rapporto fra i due
 * è l'unica cosa che dice quanto è cresciuto.
 */
export function CostProbePanel({ probe }: { probe: SessionCostProbe | null }) {
  const tr = useT();
  if (!probe || probe.contextTokens <= 0 || probe.toolCalls <= 0) return null;

  const dollari = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
  // Un decimale anche sopra i dieci milioni. Il default lo lascia cadere (per
  // non stampare «10.0M» in una striscia stretta), ma qui i due numeri grossi
  // vanno CONFRONTATI fra loro — proiettato contro spedito davvero — e a intero
  // 30,3M e 19,3M diventerebbero «30M» e «19M», cioè un rapporto letto a occhio
  // su cifre già arrotondate. Qui c'è la larghezza per il decimale.
  const milioni = (n: number) => formatTokens(n, { millionDecimals: 1 });

  return (
    <div data-testid="cost-probe-panel" className="px-4 py-3 border-b border-app-border">
      <div className="flex items-center justify-between mb-1.5">
        <span
          className="text-[12px] font-medium text-app-text"
          title={tr('cost.hint')}
        >
          Costo · contesto × chiamate
        </span>
        <span data-testid="cost-probe-total" className="text-[12px] font-semibold tabular-nums text-app-text-secondary">
          {dollari(probe.costUsd)}
        </span>
      </div>

      {/* La moltiplicazione, scritta come una moltiplicazione. Un'espressione si
          legge in un colpo; tre righe etichettate «contesto», «chiamate»,
          «totale» sarebbero gli stessi numeri senza la relazione fra loro, che
          è l'unica cosa nuova qui. */}
      <div
        data-testid="cost-probe-product"
        data-context={probe.contextTokens}
        data-calls={probe.toolCalls}
        className="flex items-baseline gap-1.5 text-[13px] tabular-nums text-app-text"
      >
        <span className="font-semibold">{formatTokens(probe.contextTokens)}</span>
        <span className="text-app-text-muted">×</span>
        <span className="font-semibold">{probe.toolCalls}</span>
        <span className="text-app-text-muted">chiamat{probe.toolCalls === 1 ? 'a' : 'e'} =</span>
        <span className="font-semibold">{milioni(probe.projectedTokens)}</span>
      </div>

      {/* Il numero su cui si può ancora decidere: non quanto è già andato, ma
          quanto costa la PROSSIMA chiamata. È sempre il contesto intero. */}
      <div className="mt-1.5 text-[11px] text-app-text-secondary">
        {tr('cost.eachCallRereads')}{' '}
        <span className="tabular-nums font-medium text-app-text">{formatTokens(probe.contextTokens)}</span>
        {probe.perCallUsd > 0 && (
          <>
            {' '}(<span className="tabular-nums" data-testid="cost-probe-percall">{dollari(probe.perCallUsd)}</span>)
          </>
        )}
        .
      </div>

      <div className="mt-0.5 text-[11px] text-app-text-muted">
        {tr('cost.reallySent')}{' '}
        <span className="tabular-nums" data-testid="cost-probe-measured">{milioni(probe.promptTokens)}</span>
        {' '}{tr('cost.overMessages', { n: probe.messages })}
      </div>

      {probe.lastTurn && probe.lastTurn.toolCalls > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-app-border text-[11px] text-app-text-secondary" data-testid="cost-probe-lastturn">
          {tr('cost.lastTurn')}{' '}
          <span className="tabular-nums font-medium text-app-text">{probe.lastTurn.toolCalls}</span>
          {' '}× <span className="tabular-nums">{formatTokens(probe.lastTurn.contextTokens)}</span>
          {' '}→ <span className="tabular-nums font-medium text-app-text">{formatTokens(probe.lastTurn.promptTokens)}</span>
          {probe.lastTurn.costUsd > 0 && <> · <span className="tabular-nums">{dollari(probe.lastTurn.costUsd)}</span></>}
        </div>
      )}
    </div>
  );
}
