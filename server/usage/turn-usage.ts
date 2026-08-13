/**
 * L'accumulo del consumo di un turno, chiamata per chiamata.
 *
 * PERCHÉ ESISTE COME MODULO. La logica viveva inline dentro l'handler in
 * `routes/chat.ts`, dove nessun test può arrivarci: si sarebbe potuto sbagliare
 * un segno, dimenticare una quota o sommare due volte, e l'unico modo di
 * accorgersene sarebbe stato guardare un numero storto nella UI. È esattamente
 * il genere di aritmetica che va fuori dal call site.
 *
 * COSA ACCUMULA E COSA NO. Il provider manda l'usage di UNA chiamata al modello
 * (`onCallUsage`); questo somma. Il `result` finale del turno somma già ogni
 * chiamata per conto suo: sommare anche quello sarebbe contare due volte, ed è la
 * ragione per cui questo accumulo vive solo mentre il turno è in corso e non
 * partecipa al consuntivo salvato sul messaggio.
 *
 * QUOTE DISGIUNTE, come ovunque nel resto dell'app (`usage/pricing.ts`,
 * migration 070): `prompt = fresco + cacheRead + cacheCreation`, e
 * `cacheCreation1h` è una QUOTA di `cacheCreation`, non un'aggiunta. Il fresco è
 * il RESTO — mai un dato — perché è la sola definizione che fa tornare i conti
 * anche quando il provider arrotonda fra chiamate.
 */

/** Il consumo di UNA chiamata al modello, come lo manda il provider. */
export interface CallUsage {
  /** Totale letto: comprende già cacheRead e cacheCreation. */
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  /** Quota di `cacheCreation` scritta con TTL a un'ora (costa 2×). */
  cacheCreation1h: number;
}

/** Il totale del turno finora. */
export interface TurnUsage {
  /** Chiamate al modello viste finora. È il numero che spiega perché i token
   *  letti superano la finestra di contesto: lo stesso prompt riletto N volte. */
  calls: number;
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
}

export function emptyTurnUsage(): TurnUsage {
  return { calls: 0, prompt: 0, completion: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 };
}

/** Un numero utilizzabile, o 0. I provider mandano NaN (`prompt_tokens: null` che
 *  passa da `Number()`) e Infinity (su abort): un solo valore sporco avvelenerebbe
 *  il totale per tutto il resto del turno, perché qui si SOMMA. */
function n(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Somma una chiamata al totale. PURA: torna un oggetto nuovo, non muta.
 *
 * Non muta di proposito: l'accumulatore attraversa un handler asincrono chiamato
 * da un parser di stream, e una mutazione condivisa è il modo in cui due turni
 * sulla stessa sessione finirebbero per sommarsi a vicenda.
 */
export function accumulateTurnUsage(prev: TurnUsage, call: CallUsage): TurnUsage {
  return {
    calls: prev.calls + 1,
    prompt: prev.prompt + n(call.inputTokens),
    completion: prev.completion + n(call.outputTokens),
    cacheRead: prev.cacheRead + n(call.cacheRead),
    cacheCreation: prev.cacheCreation + n(call.cacheCreation),
    cacheCreation1h: prev.cacheCreation1h + n(call.cacheCreation1h),
  };
}

/**
 * Le quote DISGIUNTE del turno, scorporate dal totale accumulato.
 *
 * `fresh` è il resto e non scende sotto zero; `write1h` non supera le scritture
 * totali (il provider può riportare un 1h maggiore per arrotondamenti fra
 * chiamate, e un negativo qui farebbe pagare una tariffa a un numero inventato).
 *
 * SERVE A DUE COSE, ed è il motivo per cui non si chiama più `…CostParts`: al
 * prezzo e alla RIGA SALVATA. Finché il nome diceva «prezzo», il call site
 * scriveva su `messages` i campi grezzi di `TurnUsage` — che sono ANNIDATI —
 * dentro colonne il cui contratto è disgiunto (migration 070). Il risultato
 * erano 351 righe in produzione con `cache_creation_tokens =
 * cache_creation_1h_tokens`, cioè la stessa scrittura contata due volte, e un
 * «fresco» clampato a zero che nascondeva l'impossibile invece di dirlo. Chi
 * persiste o manda sul filo le quote di un turno passa DA QUI: è l'unico punto
 * che traduce l'annidato dell'API nel disgiunto del nostro schema.
 */
export function turnUsageParts(u: TurnUsage): {
  fresh: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  output: number;
} {
  const write1h = Math.min(u.cacheCreation1h, u.cacheCreation);
  return {
    fresh: Math.max(0, u.prompt - u.cacheRead - u.cacheCreation),
    cacheRead: u.cacheRead,
    cacheCreation5m: u.cacheCreation - write1h,
    cacheCreation1h: write1h,
    output: u.completion,
  };
}

/**
 * Le quote di un turno in corso NELLA FORMA in cui si salvano e si mandano sul
 * filo: `messages` (migration 070) e il frame `stream:usage`
 * (`shared/ws-outbound.ts`) usano gli stessi nomi e lo stesso contratto.
 *
 * PERCHÉ UNA FUNZIONE E NON CINQUE CAMPI SCRITTI A MANO. Perché scritti a mano
 * erano sbagliati. Il call site copiava `live.cacheCreation` — il totale
 * ANNIDATO — dentro `cacheCreationTokens`, che è disgiunto, e la stessa
 * scrittura finiva contata due volte: in produzione 351 righe con
 * `cache_creation_tokens = cache_creation_1h_tokens`, ~60M token di eccesso, e
 * una striscia che mostrava «X da cache · Y nuovi» con X+Y diverso dal totale.
 * La traduzione esisteva già venti righe sopra, ma si chiamava «per il prezzo»
 * e nessuno pensò che servisse anche alla riga. Adesso è una porta sola: chi
 * persiste o trasmette passa di qui, e `chat.ts` non nomina più i campi grezzi
 * (`tests/unit/no-raw-turn-usage.test.ts` lo tiene fermo).
 */
export interface TurnUsageWire {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation1hTokens: number;
}

export function turnUsageWire(u: TurnUsage): TurnUsageWire {
  const p = turnUsageParts(u);
  return {
    promptTokens: u.prompt,
    completionTokens: u.completion,
    cacheReadTokens: p.cacheRead,
    cacheCreationTokens: p.cacheCreation5m,
    cacheCreation1hTokens: p.cacheCreation1h,
  };
}
