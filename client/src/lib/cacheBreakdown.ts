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

/**
 * I MOLTIPLICATORI di costo rispetto a un token di input fresco. Sono gli stessi
 * di `server/usage/pricing.ts` — e sono uguali su tutta la famiglia Claude,
 * indipendenti dal modello, che è ciò che rende possibile lo scorporo qui sotto.
 */
const W_READ = 0.1;   // rileggere dalla cache costa un decimo
const W_5M = 1.25;    // scriverci (TTL 5 min) costa un quarto in più
const W_1H = 2;       // scriverci (TTL 1 ora) costa il doppio
/**
 * Quanto costa un token di OUTPUT rispetto a uno di input. Vale 5 su tutta la
 * famiglia Claude — Opus 5$/25$, Sonnet 3$/15$, Haiku 1$/5$ — ed è l'unica
 * costante che serve per ripartire un costo totale senza conoscere il modello.
 *
 * Il messaggio non porta il nome del modello (la tabella `messages` non ha la
 * colonna), quindi il prezzo assoluto qui non è ricostruibile. Il RAPPORTO sì, e
 * basta: si riparte `costCents` — che è misurato — in proporzione ai pesi. Sui
 * modelli GPT il rapporto è 4, non 5; oggi non morde perché i turni GPT non
 * hanno un costo calcolato, ma è la ragione per cui questo numero sta qui con un
 * nome invece di essere un 5 sparso nella formula.
 */
const W_OUT = 5;

/** Lo scorporo del COSTO di un messaggio: quanto della spesa era rilettura. */
export interface CostBreakdown {
  /** Ripartizione possibile? Serve lo scorporo dei token E un costo misurato. */
  known: boolean;
  /** Centesimi attribuibili alla RILETTURA dalla cache. */
  cacheCents: number;
  /** Centesimi attribuibili a tutto il resto: fresco, scritture, output. */
  freshCents: number;
  /** Le scritture in cache, scorporate dal fresco per il tooltip. */
  writeCents: number;
}

/**
 * Ripartisce il costo REALE di un messaggio fra «rilettura dalla cache» e
 * «tutto il resto».
 *
 * Perché serve: il chip mostrava «92% cache», che è una percentuale di TOKEN e
 * si legge come una percentuale di sconto. Sui numeri veri di un turno misurato
 * il 92,5% dei token era rilettura ma solo il 54,3% del COSTO — e il 34,6% del
 * costo era la SCRITTURA in cache, una voce che quella percentuale non nominava
 * mai (e che costa 1,25× o 2× un token fresco, non 0,1×).
 *
 * Il metodo è una ripartizione, non un ricalcolo: si pesano le quote coi loro
 * moltiplicatori e si spalma `costCents` in proporzione. Il vantaggio decisivo è
 * che il totale mostrato resta quello SALVATO — se il provider manda un costo
 * proprio, lo scorporo resta coerente con quel numero invece di contraddirlo con
 * un ricalcolo interno.
 *
 * La scrittura sta col «nuovo», non con la «cache»: scrivere in cache significa
 * che quei token erano freschi e li hai pagati DI PIÙ per memorizzarli. Metterla
 * dalla parte della cache farebbe sembrare un risparmio ciò che è un anticipo.
 */
export function costBreakdown(args: {
  promptTokens?: number | null;
  completionTokens?: number | null;
  costCents?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheCreation1hTokens?: number | null;
}): CostBreakdown {
  const empty: CostBreakdown = { known: false, cacheCents: 0, freshCents: 0, writeCents: 0 };
  const bd = cacheBreakdown(args);
  const cost = safeNum(args.costCents);
  // Senza scorporo dei token non si sa nulla; senza costo non c'è niente da
  // ripartire. `0` non è "gratis", è "non misurato": mostrare "0$ cache" su un
  // messaggio senza costo direbbe una cosa falsa con la stessa faccia di una vera.
  if (!bd.known || cost <= 0) return empty;

  const completion = safeNum(args.completionTokens);
  const wRead = bd.read * W_READ;
  const wWrite = bd.write5m * W_5M + bd.write1h * W_1H;
  const wRest = bd.fresh + completion * W_OUT;
  const total = wRead + wWrite + wRest;
  if (total <= 0) return empty;

  const cacheCents = (cost * wRead) / total;
  const writeCents = (cost * wWrite) / total;
  return { known: true, cacheCents, writeCents, freshCents: cost - cacheCents };
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
