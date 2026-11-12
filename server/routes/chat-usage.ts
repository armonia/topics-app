import type { ProviderDoneMessage, ProviderUsage } from "../providers";
import { calculateCostWithCache, callsCostUsd, splitPromptTokens } from "../usage/pricing";
import type { ChatTurnScope } from "./chat-turn-scope";

/** The provider usage capture and the final-text helper of a streamed turn. */
export function createUsageCapture(turn: ChatTurnScope): void {
  const { liveCalls, overrideModel, resetStreamTimer } = turn;
  // Helper to extract text from final/aborted message
    /**
     * THE COUNT OF A TURN IS NOT A PROPERTY OF ITS HAPPY ENDING.
     *
     * This block used to live inside `onDone` and nowhere else, so a
     * turn stopped by the watchdog or by the human's Stop finalized its
     * row with tokens, cost and model all NULL - having consumed them
     * all the same. Same reading, two exits: whoever ends the turn
     * calls this before finalizing.
     *
     * Reading it twice is not a risk: the fields are assigned, not
     * accumulated, and only one of `onDone` / `onAborted` ever fires.
     */
    function captureProviderUsage(message: ProviderDoneMessage | undefined): void {
      if (!message) return;
      // Capture provider-reported usage so the message footer can
      // render. Different providers shape this slightly differently:
      // claude-code → `{ input_tokens, output_tokens, ... }`,
      // codex → `{ inputTokens, outputTokens, totalTokens }`.
      // Providers disagree on the spelling of the same count, so the
      // known shape is widened with the legacy aliases actually read
      // below (`input_tokens`, `prompt_tokens`, ...). They come back as
      // `unknown` and every use is guarded by a `typeof` check.
      const usage = message.usage as (ProviderUsage & Record<string, unknown>) | undefined;
      if (usage && typeof usage === "object") {
        const inputTotal = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens;
        const outputTotal = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens;
        // AN EMPTY COUNT IS NOT A COUNT OF ZERO, and the difference is
        // visible: the footer reads `undefined` as "we do not know" and
        // explains in words, while a 0 in the cache columns states "no
        // cache", which is a different claim and a false one. A turn
        // cancelled before its first round reports exactly this, and
        // its row must stay as it was.
        if (!inputTotal && !outputTotal && !usage.cacheRead && !usage.cacheCreation) return;
        if (typeof inputTotal === "number") turn.usagePromptTokens = inputTotal;
        if (typeof outputTotal === "number") turn.usageCompletionTokens = outputTotal;
        // Lo scorporo della cache si calcola SEMPRE, prima e a
        // prescindere dal costo.
        //
        // Prima viveva solo dentro il ramo `else if` qui sotto — quello
        // che deriva il prezzo quando il provider non lo dà — e
        // claude-code il prezzo lo dà quasi sempre (`total_cost_usd`).
        // Quindi nel caso NORMALE lo split non veniva nemmeno calcolato,
        // e la quota di cache era invisibile proprio sui turni dove è
        // enorme. Ma la composizione dei token è un FATTO del turno, non
        // un sottoprodotto del calcolo del prezzo: si misura sempre.
        if (typeof inputTotal === "number") {
          try {
            const s = splitPromptTokens({
              promptTokensTotal: inputTotal,
              cacheReadTokens: usage.cacheRead,
              cacheCreationTokens: usage.cacheCreation,
            });
            // Le due durate sono quote disgiunte: quel che non è a un'ora
            // è a cinque minuti. `min` perché il provider potrebbe
            // riportare un 1h maggiore del totale di scrittura scorporato
            // (arrotondamenti fra chiamate), e un negativo qui
            // avvelenerebbe sia la resa sia il prezzo.
            const w1h = Math.min(usage.cacheCreation1h ?? 0, s.cacheCreation);
            turn.cacheReadTokens = s.cacheRead;
            turn.cacheCreationTokens = s.cacheCreation - w1h;
            turn.cacheCreation1hTokens = w1h;
          } catch { /* modello sconosciuto o usage incoerente: nessuno scorporo */ }
        }
        // NB: `inputTotal` here is the TURN AGGREGATE (the CLI sums usage
        // across every model call in the turn), which is fine for
        // cost/tokens accounting below but is NOT a context size.
        // The post-compaction size is filled by onContextSize above,
        // from the first single call after the boundary.
        // Cost: try the provider field first, then derive via the
        // existing per-model price table when both token counts exist.
        // Il modello vale a prescindere da CHI ha calcolato il costo:
        // serve tanto per attribuire la spesa quanto per sapere, se un
        // domani la tariffa cambia, quale riga rifare.
        //
        // `liveModel` in mezzo NON è un ornamento: l'evento `result`
        // della CLI non porta il modello (vedi `RESULT_OK` in
        // events.fixture.ts), e su un topic che non ne fissa uno
        // `overrideModel` è vuoto. Senza questo anello il consuntivo
        // risolveva "unknown", `calculateCostWithCache` tornava 0, il
        // `if (usd > 0)` non scattava e il COALESCE della UPDATE
        // lasciava in piedi qualunque costo ci fosse già.
        //
        // Misurato sulla riga b26bd2e2 (topic ec3137d0, 13/08): 111
        // centesimi salvati contro 132 calcolati sulle sue quote
        // vere. La differenza è 21 centesimi, cioè ESATTAMENTE gli
        // 8.216 token di risposta a 25$/M: il numero salvato era il
        // costo del solo input. Quale scrittura l'abbia lasciato lì
        // non è ricostruibile a posteriori e non serve saperlo: con
        // il modello risolto il consuntivo ricalcola e sovrascrive,
        // che è la proprietà che mancava.
        //
        // Da non ripetere: il contatore di output VIVO non è un
        // segnaposto, contrariamente a quanto sembrava leggendo una
        // riga `partial=1` a metà turno. Ricostruito dal transcript
        // (eventi `assistant` deduplicati per `message.id`) l'accumulo
        // per chiamata di quella sessione fa 32.195 token di risposta,
        // e la somma dei `usage_completion_tokens` finalizzati nel DB
        // fa 32.195: combacia al token.
        // `message.model` rides the open shape, so it arrives untyped:
        // it counts only when it is a non-empty string.
        const reportedModel = typeof message.model === "string" ? message.model : undefined;
        const modelOfTurn = reportedModel || turn.liveModel || overrideModel || undefined;
        if (typeof modelOfTurn === "string" && modelOfTurn) turn.usageModel = modelOfTurn;
        // ── IL COSTO DELLA CLI: TROVATO, E LASCIATO DOV'È ─────────
        // `usage.costUsd` non esiste per claude-code: il provider
        // consegna il costo come FRATELLO di `usage`
        // (`claude-code.ts` passa `costUsd: event.total_cost_usd`
        // accanto a `usage: readResultUsage(event)`). Questo ramo
        // quindi non è mai scattato in produzione, e ogni prezzo
        // che l'app ha mai mostrato lo ha calcolato la nostra
        // tabella. Non è un bug che valga la pena "riparare" al
        // buio: leggere il livello giusto significherebbe sostituire
        // il numero mostrato ovunque con uno mai messo alla prova.
        //
        // ── COSA DICE LA MISURA (probe controllate, 13/08/2026) ────
        // Due `claude --print` su haiku, sessione nuova poi ripresa:
        //     chiamata 1 ....  $0,080838   (cc 40.015, cr 0)
        //     chiamata 2 ....  $0,0042665  (cr 40.015, cc 60)
        // Il secondo è VENTI VOLTE più piccolo del primo, quindi
        // `total_cost_usd` è PER TURNO, non cumulativo di sessione.
        // Su quella coppia combacia con la nostra tabella a cinque
        // decimali ($0,00427 calcolati contro $0,0042665 riportati).
        //
        // Ma su un turno che DELEGA non si riconcilia più, e in un
        // modo che non sappiamo ancora leggere: una sola invocazione
        // col tool `Task` ha emesso DUE eventi `result` (entrambi
        // `subtype: success`, nessun evento con `parentToolUseId`), e
        // il costo di ognuno stava fra 1,3× e 7,8× sopra il prezzo
        // dei token che quel `result` dichiara. Cioè il numero del
        // provider comprende lavoro che il suo stesso `usage` non
        // mostra — probabilmente le sotto-sessioni, che è la stessa
        // cosa che ha fatto nascere `services/dispatch-usage.ts`.
        //
        // Il nostro numero invece riconcilia sempre: combacia al
        // centesimo con la nostra tabella su 5 turni veri su 5 del
        // 13/08 (`usage/pricing.ts`, sotto test). Quindi resta il
        // nostro, con un limite DICHIARATO: su un turno che delega,
        // il costo mostrato è un PAVIMENTO, non il totale. Adottare
        // `total_cost_usd` va fatto quando si sa spiegare il doppio
        // `result` — non prima, perché significherebbe sostituire
        // ovunque un numero verificabile con uno che non lo è.
        //
        // (Il secondo `result` non ci fa doppio conteggio: `onDone`
        // azzera `pp.streamHandler`, quindi l'evento dopo trova un
        // handler nullo e cade — `claude-code.ts:2773`.)
        //
        // Resta letto per gli altri provider, che il costo lo
        // mettono davvero dentro `usage`.
        const usdFromProvider = typeof usage.costUsd === "number" ? usage.costUsd : undefined;
        if (usdFromProvider != null) {
          turn.costCents = Math.round(usdFromProvider * 100);
        } else if (liveCalls.length > 0) {
          // The provider reported its calls one by one: the message
          // costs the sum of their prices. Haiku 5.5 picks its rate
          // card per request, so the turn total (or its average) would
          // put every call on the same card.
          try {
            const usd = callsCostUsd(liveCalls, modelOfTurn || "unknown");
            if (usd > 0) turn.costCents = Math.round(usd * 100);
          } catch { /* unknown model: skip the cost, keep the tokens */ }
        } else if (typeof inputTotal === "number" && typeof outputTotal === "number") {
          try {
            // Riusa lo scorporo già calcolato sopra invece di rifarlo: era
            // duplicato, e due copie della stessa aritmetica sullo stesso
            // usage sono due occasioni di divergere.
            //
            // Perché lo scorporo serve al PREZZO: `inputTotal` comprende i token
            // letti DALLA CACHE, e in un turno agentico lungo sono la quota
            // schiacciante. Tariffarli come input fresco moltiplicava il
            // costo per ~10 (un turno da ~$9 mostrato a $90). Le due durate
            // di scrittura hanno tariffe diverse (2× a un'ora, 1.25× a
            // cinque minuti) e vanno pagate ognuna la sua.
            const fresh = inputTotal - (turn.cacheReadTokens ?? 0) - (turn.cacheCreationTokens ?? 0) - (turn.cacheCreation1hTokens ?? 0);
            const usd = calculateCostWithCache({
              model: modelOfTurn || "unknown",
              freshInputTokens: Math.max(0, fresh),
              outputTokens: outputTotal,
              cacheReadTokens: turn.cacheReadTokens ?? 0,
              cacheCreationTokens: turn.cacheCreationTokens ?? 0,
              cacheCreation1hTokens: turn.cacheCreation1hTokens ?? 0,
            });
            if (usd > 0) turn.costCents = Math.round(usd * 100);
          } catch { /* unknown model — skip cost, keep tokens */ }
        }
      }
    }
    turn.captureProviderUsage = captureProviderUsage;

  function extractFinalText(message: any): string | null {
    if (!message) return null;
    if (typeof message.text === "string") return message.text;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }
    return null;
  }
  turn.extractFinalText = extractFinalText;

  resetStreamTimer();
}
