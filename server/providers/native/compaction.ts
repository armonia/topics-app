/**
 * Cosa succede quando la conversazione non ci sta più nella finestra.
 *
 * IL PROBLEMA, in concreto. Ogni giro del loop rimanda TUTTA la storia: il
 * turno cresce, e un agente che lavora davvero — legge cinque file, esegue dei
 * test, guarda l'output — arriva a centinaia di migliaia di token in una
 * sessione sola. Arrivato al tetto l'API risponde 400 e il turno muore, con il
 * lavoro fatto fin lì buttato. Le CLI compattavano da sole; togliendo la CLI,
 * questo è il pezzo che manca.
 *
 * COSA SI BUTTA, ed è tutta la decisione. Non i messaggi più vecchi in blocco:
 * il primo messaggio dell'utente è la RICHIESTA, e perderla trasforma l'agente
 * in uno che lavora senza sapere perché. Si buttano invece i RISULTATI DEI
 * TOOL vecchi, che sono il 90% del peso e il 10% del significato — il contenuto
 * di un file letto venti giri fa non serve più, mentre serve sapere che è stato
 * letto e cosa se n'è concluso.
 *
 * QUINDI: si tiene la richiesta iniziale, si tiene la coda recente per intero,
 * e in mezzo i risultati dei tool diventano un segnaposto. La forma della
 * conversazione resta valida — ogni `tool_use` ha ancora il suo `tool_result`,
 * che l'API pretende — ma smette di pesare.
 *
 * PERCHÉ NON SI CHIEDE AL MODELLO DI RIASSUMERE, che è l'altra strada
 * possibile: costa un turno intero (tempo e token) proprio nel momento in cui
 * si sta finendo il budget, e introduce un punto in cui il riassunto può
 * mentire. Buttare i risultati dei tool è deterministico, istantaneo e non
 * inventa niente. Se un domani servisse il riassunto, questo file è il posto.
 */

import type { Block, Message } from "./agent-loop";

/**
 * Quanto della finestra si può usare prima di intervenire.
 *
 * 0.75 e non 0.95: la compattazione deve avvenire PRIMA che il turno sbatta,
 * e il conto dei token è una stima (vedi `estimateTokens`). Il margine copre
 * l'errore della stima più la risposta che deve ancora arrivare.
 */
const COMPACT_AT = 0.75;

/** Quanti messaggi in coda restano SEMPRE intatti. */
const KEEP_RECENT = 6;

/** Il testo che prende il posto di un risultato buttato. */
const DROPPED = "[risultato rimosso per fare spazio: la conversazione era troppo lunga]";

/**
 * Una stima dei token, non un conteggio.
 *
 * Il conteggio vero richiede il tokenizer di Anthropic, che qui non abbiamo, o
 * una chiamata di rete per ogni controllo — inaccettabile a ogni giro del loop.
 * Quattro caratteri per token è l'approssimazione d'uso comune sull'inglese e
 * sbaglia in eccesso sul codice, che è il verso giusto: si compatta un po'
 * prima del necessario invece di scoprire il tetto sbattendoci contro.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") { chars += m.content.length; continue; }
    for (const b of m.content) {
      chars += (b.text?.length ?? 0) + (b.thinking?.length ?? 0);
      if (typeof b.content === "string") chars += b.content.length;
      if (b.input) chars += JSON.stringify(b.input).length;
    }
  }
  return Math.ceil(chars / 4);
}

/** La conversazione ha bisogno di essere compattata? */
export function needsCompaction(messages: Message[], windowTokens: number): boolean {
  return estimateTokens(messages) > windowTokens * COMPACT_AT;
}

/**
 * Alleggerisce la conversazione, restituendone una nuova.
 *
 * NON muta l'originale: chi chiama tiene la storia vera e decide se sostituirla.
 * Restituisce anche quanto si è risparmiato, perché una compattazione che non
 * libera niente è un'informazione (vuol dire che il peso sta altrove, nei
 * messaggi recenti, e allora il tetto arriverà lo stesso).
 */
export function compact(
  messages: Message[],
): { messages: Message[]; before: number; after: number } {
  const before = estimateTokens(messages);
  if (messages.length <= KEEP_RECENT + 1) {
    // Troppo corta per potarla senza perdere l'essenziale: meglio lasciarla e
    // lasciare che l'API dica di no, che è un errore leggibile.
    return { messages, before, after: before };
  }

  const head = messages[0]!;               // la richiesta: non si tocca mai
  const tail = messages.slice(-KEEP_RECENT); // la coda recente: intatta
  const middle = messages.slice(1, -KEEP_RECENT);

  const lightened = middle.map((m) => {
    if (typeof m.content === "string") return m;
    const blocks = m.content.map((b): Block => {
      // Si svuota SOLO il contenuto dei risultati. Il blocco resta, con il suo
      // `tool_use_id`: toglierlo romperebbe l'accoppiamento che l'API pretende
      // fra ogni `tool_use` e il suo `tool_result`, e la richiesta verrebbe
      // rifiutata — un modo molto efficace di trasformare una compattazione in
      // un guasto.
      if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > DROPPED.length) {
        return { ...b, content: DROPPED };
      }
      return b;
    });
    return { ...m, content: blocks };
  });

  const next = [head, ...lightened, ...tail];
  return { messages: next, before, after: estimateTokens(next) };
}

/**
 * La finestra di contesto di un modello, in token.
 *
 * Numeri dichiarati e non scoperti: l'API non li espone, e sbagliarli per
 * ECCESSO significa non compattare in tempo. Un modello sconosciuto prende il
 * valore più prudente invece del più generoso.
 */
export function windowFor(model: string): number {
  if (/opus-4|sonnet-4-6|sonnet-4-5/.test(model)) return 200_000;
  if (/haiku-4/.test(model)) return 200_000;
  if (/\[1m\]|-1m/.test(model)) return 1_000_000;
  return 200_000;
}
