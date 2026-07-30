/**
 * Lo scorporo della cache di un messaggio: numeri già pronti da mostrare.
 *
 * Sta in un modulo suo e non nel componente per una ragione precisa: è l'unica
 * parte con una logica che si può sbagliare — la distinzione fra "non lo
 * sappiamo" e "misurato, nessuna cache", le quote DISGIUNTE (sommare `write1h`
 * a `write5m` sarebbe contarle due volte) e il fresco come RESTO, che è la sola
 * definizione che fa tornare i conti a `prompt` anche quando il provider
 * arrotonda fra chiamate. Un file di componenti che esporta anche funzioni pure
 * rompe il fast-refresh di Vite (react-refresh/only-export-components): il
 * modulo separato è anche la casa giusta per i suoi test.
 */

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
export function safeNum(v: number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v;
}

/**
 * Lo scorporo della cache di un messaggio, come numeri già pronti da mostrare.
 *
 * Estratta dal componente perché è l'unica parte con una logica che si può
 * sbagliare: la distinzione fra "non lo sappiamo" e "misurato, nessuna cache", le
 * quote DISGIUNTE (sommare `write1h` a `write5m` sarebbe contarle due volte) e il
 * fresco come RESTO — che è la sola definizione che fa tornare i conti a `prompt`
 * anche quando il provider arrotonda fra chiamate.
 */
export interface CacheBreakdown {
  /** Il provider ha riportato la composizione? Se no, non si inventa uno zero. */
  known: boolean;
  read: number;
  write5m: number;
  write1h: number;
  /** Il resto: `prompt - read - write5m - write1h`, mai negativo. */
  fresh: number;
  /** Quota di rilettura sul totale letto, in percentuale intera. 0 se prompt è 0. */
  pct: number;
}

export function cacheBreakdown(args: {
  promptTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheCreation1hTokens?: number | null;
}): CacheBreakdown {
  const prompt = safeNum(args.promptTokens);
  // È `cacheReadTokens` a decidere se sappiamo: è l'unica quota che il provider
  // manda sempre quando manda l'usage. Le altre due possono legittimamente
  // mancare (un turno che non ha scritto in cache).
  const known = args.cacheReadTokens != null;
  const read = safeNum(args.cacheReadTokens);
  const write5m = safeNum(args.cacheCreationTokens);
  const write1h = safeNum(args.cacheCreation1hTokens);
  const fresh = Math.max(0, prompt - read - write5m - write1h);
  const pct = prompt > 0 ? Math.round((read / prompt) * 100) : 0;
  return { known, read, write5m, write1h, fresh, pct };
}
