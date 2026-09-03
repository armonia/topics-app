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

import type { Block, AgentMessage } from "./agent-loop";

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
export function estimateTokens(messages: AgentMessage[], overheadChars = 0): number {
  let chars = overheadChars;
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

/**
 * Does the conversation need compacting?
 *
 * `overheadChars` IS THE WEIGHT THAT IS NOT IN THE MESSAGES: the system prompt
 * and the tool schemas travel with every request and count in the same
 * window. Left out, the estimate said "you fit" to a request the API refused:
 * with the MCP fleet mounted the schemas alone are tens of thousands of tokens.
 */
export function needsCompaction(messages: AgentMessage[], windowTokens: number, overheadChars = 0): boolean {
  return estimateTokens(messages, overheadChars) > windowTokens * COMPACT_AT;
}

/**
 * How much of ONE tool result enters the history, head plus tail: about 12k
 * tokens. Of the same order as the CLI's own caps (2000 lines for a Read, 30k
 * chars for a shell) and small enough that one round cannot blow a 200k window
 * by itself: the calls per round are bounded by the output cap, and each one
 * is bounded here.
 */
export const RESULT_HEAD_CHARS = 40_000;
export const RESULT_TAIL_CHARS = 8_000;

/** How much of a recent result survives when the tail is the problem. */
const TAIL_RESULT_HEAD = 6_000;
const TAIL_RESULT_TAIL = 2_000;

/**
 * A tool result cut to head and tail, with a notice in between that says HOW
 * MUCH is missing and HOW to get it back.
 *
 * One function for two uses: the loop applies it to every result as it enters
 * the history (`agent-loop`), and the compaction applies it again, tighter,
 * to the tail when lightening the middle was not enough. Head AND tail, not
 * the head alone: the end of an output (the exit code, the real error, the
 * last lines of a test run) is often worth more than its beginning.
 */
export function clipToolResult(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${cut} chars omitted: read a slice with offset/limit or max_chars ...]\n\n${text.slice(-tail)}`;
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
  messages: AgentMessage[],
  opts?: { windowTokens?: number; overheadChars?: number },
): { messages: AgentMessage[]; before: number; after: number } {
  const overhead = opts?.overheadChars ?? 0;
  const before = estimateTokens(messages, overhead);
  // The target the history has to get back under, when the caller says so.
  // Without one, the only signal left is "it freed nothing".
  const target = opts?.windowTokens != null ? opts.windowTokens * COMPACT_AT : null;

  let next = messages;
  if (messages.length > KEEP_RECENT + 1) {
    next = lightenMiddle(messages);
  }
  let after = estimateTokens(next, overhead);

  // THE TAIL IS THE WEIGHT, and lightening the middle did not help.
  //
  // This is two huge reads in the same round: the history is short, or the
  // middle is already empty, and the weight sits in the results that JUST
  // arrived. Here nothing used to happen, "and the API was left to say no":
  // but that no is a 400 the loop does not retry, and the history that caused
  // it stayed in memory unchanged, so EVERY later turn of the session repeated
  // the same 400 until somebody reset the chat. A readable error, once, is
  // fine; the same error forever is not.
  //
  // The tail results are cut to head and tail, with the notice that says how
  // to re-read the missing piece: the model has not consumed them yet, so it
  // loses nothing it had already used, and it can re-read in slices what it
  // needs.
  const stillOver = target != null ? after > target : after >= before;
  if (stillOver) {
    next = clipTailResults(next);
    after = estimateTokens(next, overhead);
  }
  return { messages: next, before, after };
}

function clipTailResults(messages: AgentMessage[]): AgentMessage[] {
  const head = messages[0]!;
  const rest = messages.slice(1).map((m) => {
    if (typeof m.content === "string") return m;
    let touched = false;
    const blocks = m.content.map((b): Block => {
      if (b.type === "tool_result" && typeof b.content === "string"
          && b.content.length > TAIL_RESULT_HEAD + TAIL_RESULT_TAIL) {
        touched = true;
        return { ...b, content: clipToolResult(b.content, TAIL_RESULT_HEAD, TAIL_RESULT_TAIL) };
      }
      return b;
    });
    return touched ? { ...m, content: blocks } : m;
  });
  return [head, ...rest];
}

function lightenMiddle(messages: AgentMessage[]): AgentMessage[] {
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

  return [head, ...lightened, ...tail];
}

/**
 * La finestra di contesto di un modello, in token.
 *
 * Numeri dichiarati e non scoperti: l'API non li espone, e sbagliarli per
 * ECCESSO significa non compattare in tempo. Un modello sconosciuto prende il
 * valore più prudente invece del più generoso.
 */
export function windowFor(model: string): number {
  // LA VARIANTE A FINESTRA LUNGA SI GUARDA PER PRIMA, e l'ordine non e' uno
  // stile: era l'ultimo dei quattro rami, quindi `claude-opus-4[1m]` cadeva
  // nel ramo `opus-4` e usciva a 200k senza mai arrivarci. Misurato il 17/08:
  // due famiglie su quattro dichiaravano un quinto della finestra che avevano,
  // e la conversazione veniva compattata buttando contesto che c'era ancora.
  //
  // Il suffisso e' una nostra convenzione (`providers/claude-models.ts`) e
  // vince su qualunque famiglia: dice «questo modello, con la finestra lunga».
  if (/\[1m\]$|-1m$/.test(model)) return 1_000_000;
  if (/opus-4|sonnet-4-6|sonnet-4-5/.test(model)) return 200_000;
  if (/haiku-4/.test(model)) return 200_000;
  return 200_000;
}
