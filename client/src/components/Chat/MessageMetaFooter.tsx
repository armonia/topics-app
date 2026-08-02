import { formatDurationMs, formatCostCents } from './toolGrouping';
import { safeNum, cacheBreakdown, costBreakdown } from '../../lib/cacheBreakdown';

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
  /**
   * Il modello del turno. Sta nel tooltip del costo, non nella striscia: serve a
   * rendere il numero VERIFICABILE — senza sapere a che tariffa è stato contato,
   * un costo è un numero che si può solo credere. È anche la ragione per cui la
   * colonna esiste (migration 076): quando i prezzi si sono rivelati sbagliati,
   * senza il modello non si poteva sapere quale riga correggere.
   *
   * Assente sui messaggi anteriori alla 076.
   */
  model?: string | null;
}

/**
 * Tiny footer strip shown below an assistant message.
 *
 * Each field is optional — if none are present the footer renders nothing
 * (returns null) so old/unmetered messages stay clean.
 *
 * The format mirrors the reference screenshot: `<duration>s · <tokens> tokens · $<cost>`.
 */
export function MessageMetaFooter({ latencyMs, promptTokens, completionTokens, costCents, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens, model }: Props) {
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
  // La quota di cache, in COSTO e non in percentuale di token.
  //
  // Prima qui c'era «92% cache», e quella percentuale contava i TOKEN mentre si
  // legge come uno sconto. Sui numeri veri di un turno misurato il 92,5% dei
  // token era rilettura ma solo il 54,3% della SPESA: due numeri che raccontano
  // due storie diverse, e quello che serve quando si guarda un costo è il
  // secondo. Il chip dice ora quanto dei dollari veniva dalla cache; la
  // differenza col totale — che resta l'ultima voce, invariata — è il resto.
  const cb = costBreakdown({ promptTokens, completionTokens, costCents, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens });
  const safeCost = safeNum(costCents);
  if (cb.known && cb.cacheCents > 0) {
    parts.push({
      text: `${formatCostCents(cb.cacheCents)} cache`,
      // Il title è la CONTABILITÀ del costo, come il title dei token lo è dei
      // token: le voci sommano al totale. La scrittura in cache è nominata a
      // parte perché è la sorpresa — costa 1,25× (o 2× a un'ora) un token
      // fresco, non 0,1×, e in un turno lungo è una fetta grossa della spesa.
      title: [
        `${formatCostCents(safeCost)} in tutto, di cui:`,
        `  ${formatCostCents(cb.cacheCents)} di rilettura dalla cache (×0,1)`,
        ...(cb.writeCents > 0 ? [`  ${formatCostCents(cb.writeCents)} di scrittura in cache (×1,25, ×2 a un'ora)`] : []),
        `  ${formatCostCents(cb.freshCents - cb.writeCents)} di token freschi e risposta`,
        '',
        model ? `Modello: ${model}` : '',
        `Ripartizione del costo misurato in base al peso di ogni quota; su tutti i modelli Claude un token di risposta costa 5× uno di prompt.`,
      ].filter(Boolean).join('\n'),
    });
  }
  if (safeCost > 0) {
    parts.push({ text: formatCostCents(safeCost) });
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
