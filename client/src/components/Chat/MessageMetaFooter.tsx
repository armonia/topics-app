import { formatDurationMs } from './toolGrouping';

interface Props {
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costCents?: number | null;
}

/**
 * Coerce a possibly-undefined / null / NaN / non-finite value to a safe
 * non-negative number. The `??` nullish-coalescing operator does NOT
 * handle NaN — `(NaN ?? 0) === NaN`, so `(NaN ?? 0) + (5 ?? 0) === NaN`.
 *
 * v3 foundations AGENT-04 fix: providers occasionally emit NaN or
 * Infinity for token counts (claude-code-sdk reports `prompt_tokens:
 * null` which Number()'s to NaN; some providers report Infinity on
 * abort). The legacy `?? 0` chain only handled null/undefined and
 * surfaced "NaN tokens" in the footer. This helper rejects all
 * non-finite values.
 */
function safeNum(v: number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v;
}

/**
 * Tiny footer strip shown below an assistant message.
 *
 * Each field is optional — if none are present the footer renders nothing
 * (returns null) so old/unmetered messages stay clean.
 *
 * The format mirrors the reference screenshot: `<duration>s · <tokens> tokens · $<cost>`.
 */
export function MessageMetaFooter({ latencyMs, promptTokens, completionTokens, costCents }: Props) {
  const prompt = safeNum(promptTokens);
  const completion = safeNum(completionTokens);
  const total = prompt + completion;
  const parts: Array<{ text: string; title?: string }> = [];
  // Il totale è dominato dai token LETTI, e in un turno agentico lungo quelli
  // sono lo stesso prompt riletto dalla cache a ogni chiamata al modello: si
  // arriva a milioni su una finestra da 200k, e senza spiegazione sembra un
  // conteggio rotto. Il dettaglio sta nel title invece che in una terza voce:
  // la striscia deve restare una riga sola.
  const tokensTitle =
    total > 0
      ? `${prompt.toLocaleString()} letti (prompt di ogni chiamata del turno, riletture dalla cache incluse) · ${completion.toLocaleString()} prodotti`
      : undefined;

  const safeLatency = safeNum(latencyMs);
  if (safeLatency > 0) {
    // Same formatter as the tool/turn timers so a slow turn reads "1m 30s",
    // not "90s" — one consistent duration language across the chat.
    parts.push({ text: formatDurationMs(safeLatency) });
  }
  if (total > 0) {
    parts.push({ text: `${total.toLocaleString()} tokens`, title: tokensTitle });
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
