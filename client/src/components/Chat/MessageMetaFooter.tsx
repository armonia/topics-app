import { formatDurationMs } from './toolGrouping';
import { safeNum, cacheBreakdown } from '../../lib/cacheBreakdown';

interface Props {
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costCents?: number | null;
  /**
   * Lo SCORPORO di `promptTokens`: quanta parte era cache. Quote DISGIUNTE —
   * `promptTokens = fresco + read + creation + creation1h`, e `cacheCreationTokens`
   * NON include `cacheCreation1hTokens`.
   *
   * `undefined` ≠ 0, e la differenza si vede: assente vuol dire che non lo
   * sappiamo (messaggio vecchio, provider che non riporta l'usage) e la striscia
   * torna a spiegare a parole; 0 vuol dire misurato, nessuna cache.
   */
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheCreation1hTokens?: number | null;
}

/**
 * Tiny footer strip shown below an assistant message.
 *
 * Each field is optional — if none are present the footer renders nothing
 * (returns null) so old/unmetered messages stay clean.
 *
 * The format mirrors the reference screenshot: `<duration>s · <tokens> tokens · $<cost>`.
 */
export function MessageMetaFooter({ latencyMs, promptTokens, completionTokens, costCents, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens }: Props) {
  const prompt = safeNum(promptTokens);
  const completion = safeNum(completionTokens);
  const total = prompt + completion;
  const parts: Array<{ text: string; title?: string }> = [];
  // Il totale è dominato dai token LETTI, e in un turno agentico lungo quelli
  // sono lo stesso prompt riletto dalla cache a ogni chiamata al modello: si
  // arriva a milioni su una finestra da 200k, e senza spiegazione sembra un
  // conteggio rotto. Il dettaglio sta nel title invece che in una terza voce:
  // la striscia deve restare una riga sola.
  // Lo scorporo è NOTO solo se il provider l'ha riportato: `undefined` significa
  // "non lo sappiamo", e in quel caso si torna a spiegare a parole invece di
  // inventare uno zero (che direbbe "nessuna cache", cosa diversa e falsa).
  const bd = cacheBreakdown({ promptTokens, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens });
  const breakdownKnown = bd.known;
  const cacheRead = bd.read;
  const write5m = bd.write5m;
  const write1h = bd.write1h;
  const fresh = bd.fresh;

  const tokensTitle =
    total === 0
      ? undefined
      : breakdownKnown
        ? // Con lo scorporo il title diventa una CONTABILITÀ, non una spiegazione:
          // le quattro voci sommano a `prompt`, così il numero grande smette di
          // sembrare rotto e si capisce da dove viene.
          [
            `${prompt.toLocaleString()} letti, di cui:`,
            `  ${cacheRead.toLocaleString()} riletti dalla cache`,
            ...(write5m > 0 ? [`  ${write5m.toLocaleString()} scritti in cache (5 min)`] : []),
            ...(write1h > 0 ? [`  ${write1h.toLocaleString()} scritti in cache (1 ora, costa 2×)`] : []),
            `  ${fresh.toLocaleString()} freschi`,
            `${completion.toLocaleString()} prodotti`,
          ].join('\n')
        : `${prompt.toLocaleString()} letti (prompt di ogni chiamata del turno, riletture dalla cache incluse) · ${completion.toLocaleString()} prodotti`;

  const safeLatency = safeNum(latencyMs);
  if (safeLatency > 0) {
    // Same formatter as the tool/turn timers so a slow turn reads "1m 30s",
    // not "90s" — one consistent duration language across the chat.
    parts.push({ text: formatDurationMs(safeLatency) });
  }
  if (total > 0) {
    parts.push({ text: `${total.toLocaleString()} tokens`, title: tokensTitle });
  }
  // La quota di cache come voce a sé, in percentuale: è l'informazione che il
  // numero grande non dà. Una percentuale sta in tre caratteri e la striscia resta
  // una riga — il dettaglio esatto è già nel title dei token.
  //
  // Solo quando c'è davvero cache: uno "0% cache" su un primo turno sarebbe
  // rumore, e la sua assenza dice la stessa cosa.
  if (breakdownKnown && prompt > 0 && cacheRead > 0) {
    const pct = bd.pct;
    parts.push({
      text: `${pct}% cache`,
      title: `${cacheRead.toLocaleString()} dei ${prompt.toLocaleString()} token letti erano una rilettura dalla cache — costano il 10% di un token fresco`,
    });
  }
  const safeCost = safeNum(costCents);
  if (safeCost > 0) {
    const usd = safeCost / 100;
    parts.push({ text: usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}` });
  }

  if (parts.length === 0) return null;

  return (
    <div data-testid="message-meta-footer" className="mt-2 text-[11px] text-app-text-muted flex items-center gap-1.5 flex-wrap">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-app-text-muted/60">·</span>}
          <span {...(p.title ? { title: p.title } : {})}>{p.text}</span>
        </span>
      ))}
    </div>
  );
}
