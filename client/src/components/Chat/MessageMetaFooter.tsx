import { contextTokens, costTokens, partsFromMessage } from '../../../../shared/token-cost';
import { formatDurationMs, formatCostCents } from './toolGrouping';
import { safeNum, cacheBreakdown, costBreakdown } from '../../lib/cacheBreakdown';
import { formatTokens } from '../../lib/formatTokens';

interface Props {
  latencyMs?: number | null;
  /**
   * Spiegazione della durata, quando ce n'è una da dare. Serve al turno fermo
   * su una domanda: lì il numero è il LAVORO (fermo), non il tempo passato, e
   * senza una riga che lo dica sembrerebbe un cronometro che si è piantato.
   */
  latencyTitle?: string;
  /**
   * Parola che precede la durata, quando il numero da solo si presterebbe a
   * essere letto per un'altra cosa. Serve al turno fermo su una domanda:
   * «lavorato 8s» non si confonde col tempo che stai facendo aspettare.
   */
  latencyPrefix?: string;
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
  /**
   * Dove sta la striscia.
   *
   * `block` (default) — piede a sé, con l'aria sopra e il permesso di andare a
   * capo. È la forma che serve al turno FERMO su una domanda (MessageParts):
   * lì questa striscia è l'unica cosa che dice cosa è costato finora, e deve
   * restare in chiaro.
   *
   * `inline` — un pezzo della riga che <MessageBubble> apre sotto il messaggio
   * finito, dove sta già l'ora e che compare solo passandoci sopra. Lì il capo
   * è vietato (una striscia di servizio che si sdoppia in due righe era metà
   * del fastidio) e ogni voce si porta il proprio `·` davanti, perché non è mai
   * la prima cosa sulla riga: l'ora la precede sempre.
   */
  variant?: 'block' | 'inline';
}

/**
 * Tiny footer strip shown below an assistant message.
 *
 * Each field is optional — if none are present the footer renders nothing
 * (returns null) so old/unmetered messages stay clean.
 *
 * The format mirrors the reference screenshot: `<duration>s · <tokens> tokens · $<cost>`.
 */
export function MessageMetaFooter({ latencyMs, latencyTitle, latencyPrefix, promptTokens, completionTokens, costCents, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens, model, variant = 'block' }: Props) {
  const prompt = safeNum(promptTokens);
  const completion = safeNum(completionTokens);
  const total = prompt + completion;
  const parts: Array<{ text: string; title?: string; testId?: string }> = [];
  // Il totale è dominato dai token LETTI, e in un turno agentico lungo quelli
  // sono lo stesso prompt riletto dalla cache a ogni chiamata al modello: si
  // arriva a milioni su una finestra da 200k, e senza spiegazione sembra un
  // conteggio rotto. Il title ne è la CONTABILITÀ per esteso; le due voci
  // grosse — riletto e nuovo — stanno anche in chiaro, nella voce qui sotto.
  // Lo scorporo è NOTO solo se il provider l'ha riportato: `undefined` significa
  // "non lo sappiamo", e in quel caso si torna a spiegare a parole invece di
  // inventare uno zero (che direbbe "nessuna cache", cosa diversa e falsa).
  const bd = cacheBreakdown({ promptTokens, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens });
  const breakdownKnown = bd.known;
  const cacheRead = bd.read;
  const write5m = bd.write5m;
  const write1h = bd.write1h;
  const fresh = bd.fresh;

  // Quanto è COSTATO (il numero in chiaro) e quanto CONTESTO è passato (la
  // prima riga del title): due domande, una regola sola, in `token-cost.ts`.
  const parti = partsFromMessage({
    usagePromptTokens: prompt, usageCompletionTokens: completion, cacheReadTokens: cacheRead,
  });
  const costo = costTokens(parti);
  const contesto = contextTokens(parti);

  const tokensTitle =
    total === 0
      ? undefined
      : breakdownKnown
        ? // Con lo scorporo il title diventa una CONTABILITÀ, non una spiegazione:
          // le quattro voci sommano a `prompt`, così il numero grande smette di
          // sembrare rotto e si capisce da dove viene.
          [
            `${costo.toLocaleString()} di costo · ${contesto.toLocaleString()} di contesto passato`,
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
    const shown = formatDurationMs(safeLatency);
    parts.push({ text: latencyPrefix ? `${latencyPrefix} ${shown}` : shown, ...(latencyTitle ? { title: latencyTitle } : {}), testId: 'message-duration' });
  }
  if (total > 0) {
    // IL NUMERO IN CHIARO E' QUANTO E' COSTATO, come sulla card e sul grafico.
    //
    // Qui c'era `prompt + completion`, cioè la rilettura di cache contata a
    // prezzo PIENO: la stessa formula della vecchia query della dashboard, e
    // 34,7× il numero che la card mostrava per lo stesso turno. Tre superfici,
    // tre risposte alla stessa domanda: nessuna delle tre veniva creduta.
    //
    // La regola sta in `shared/token-cost.ts` e la usano tutte e tre. «Quanto
    // contesto è passato» non sparisce: è la prima riga del title, dove la
    // contabilità si legge apposta invece che di sfuggita.
    // Compatto: `4.5M`, non `4.531.312`.
    parts.push({ text: `${formatTokens(costo)} tokens`, title: tokensTitle });
  }
  // Quanti di quei token erano rilettura e quanti roba nuova — IN CHIARO.
  //
  // La contabilità c'era già, ma solo nel `title`: dietro un hover, su una
  // striscia di metadati che nessuno pensa di sorvolare. Restava visibile solo
  // il costo della cache, cioè la conseguenza, mentre la domanda che si fa
  // guardando un turno da un milione di token è la causa: quanto stavo
  // rileggendo e quanto era nuovo.
  //
  // Le SCRITTURE stanno coi nuovi, come nello scorporo del costo: erano token
  // freschi, pagati di più per tenerli in cache: metterle dalla parte della
  // cache farebbe sembrare un risparmio un anticipo. Così le due voci sommano
  // esatte a `prompt`, e la terza voce del title (i prodotti) resta fuori
  // perché è output, non roba letta.
  if (breakdownKnown && prompt > 0) {
    parts.push({
      text: `${formatTokens(cacheRead)} da cache · ${formatTokens(bd.newTokens)} nuovi`,
      title: tokensTitle,
      testId: 'message-token-split',
    });
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

  const inline = variant === 'inline';
  return (
    <div
      data-testid="message-meta-footer"
      data-variant={variant}
      className={
        inline
          ? 'text-[11px] text-app-text-muted flex items-center gap-1.5 whitespace-nowrap'
          : 'mt-2 text-[11px] text-app-text-muted flex items-center gap-1.5 flex-wrap'
      }
    >
      {parts.map((p, i) => (
        <span key={i} className={`flex items-center gap-1.5${inline ? ' flex-shrink-0' : ''}`}>
          {(inline || i > 0) && <span className="text-app-text-muted/60">·</span>}
          <span {...(p.title ? { title: p.title } : {})} {...(p.testId ? { 'data-testid': p.testId } : {})}>{p.text}</span>
        </span>
      ))}
    </div>
  );
}
