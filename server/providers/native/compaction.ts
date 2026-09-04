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
 *
 * ── WHAT THIS FILE GOT WRONG, measured on the live database (card 18bdf214) ──
 * Two topics stopped answering for good: every send came back
 * `prompt is too long: 1000176 tokens > 1000000 maximum`. The compaction had
 * NOT been skipped: `compaction_markers` holds its own receipt for one of
 * them, `pre=1115713 → post=480494`. It ran, it reported success, and the
 * request it produced was still twice the ceiling. Two defects, and both of
 * them are in here:
 *
 *   1. ONLY THE RESULTS WERE LIGHTENED. After compacting, 77% of what was left
 *      sat in the `tool_use` INPUTS: the arguments of a write, the body of an
 *      edit. 1.53 MB of the 1.98 MB payload, untouched, because nobody had
 *      looked at what was heavy AFTER the results were gone.
 *   2. FOUR CHARACTERS PER TOKEN IS AN ASSUMPTION, and on this content it was
 *      out by a factor of two. The threshold was being read off a number that
 *      was not the real one, so "we fit" meant nothing.
 *
 * The answers are below: the arguments are lightened like the results; what is
 * left over is CUT, so a compaction can no longer end with "still too big";
 * and the characters-per-token ratio stops being assumed and gets CALIBRATED
 * on what the API says it counted — a successful round reports its own prompt
 * size, and even the 400 carries the exact number.
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
const DROPPED = "[risultato rimosso per fare spazio: la conversazione era troppo lunga]"; // allow-italian: testo che legge il modello, non UI

/**
 * How many characters we assume make a token until the API tells us better.
 *
 * Four is the usual rule of thumb on English prose. On what an agent actually
 * sends (JSON arguments, diffs, source, base64) it is out by up to a factor of
 * two, always in the dangerous direction: it says the conversation is half the
 * size it is. It stays as the STARTING value because it is right often enough,
 * and because the very first round of a session has nothing measured yet.
 */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * The measured ratio never goes above the assumed one.
 *
 * Prose that really is 4.6 chars per token would let the estimate claim more
 * room than the assumption does, and being generous about the room left is the
 * exact mistake that killed those two chats. Below, on the other hand, we
 * follow the measurement all the way down: dense JSON at 1.9 is a fact.
 */
const MIN_CHARS_PER_TOKEN = 1;

/**
 * The ratio the API's own count implies, ready to hand to `estimateTokens`.
 *
 * `chars` must be the SAME number `estimateChars` produced for the payload
 * that was sent: it is a ratio between two measures of one request, so mixing
 * a char count from one place with a token count from another gives a number
 * that means nothing.
 */
export function charsPerTokenFrom(chars: number, realTokens: number): number {
  if (!Number.isFinite(chars) || !Number.isFinite(realTokens) || chars <= 0 || realTokens <= 0) {
    return DEFAULT_CHARS_PER_TOKEN;
  }
  return Math.min(DEFAULT_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, chars / realTokens));
}

/**
 * The characters that reach the API, `overheadChars` (system + tool schemas)
 * included.
 *
 * COUNTED PER BLOCK, and one branch here is a bug that was paid for: a
 * `tool_result` whose content is an ARRAY of blocks (a browser screenshot, a
 * structured result) used to weigh ZERO, because only the string form was
 * counted. Whatever we do not count, the API counts anyway.
 */
export function estimateChars(messages: AgentMessage[], overheadChars = 0): number {
  let chars = overheadChars;
  for (const m of messages) {
    if (typeof m.content === "string") { chars += m.content.length; continue; }
    for (const b of m.content) {
      chars += (b.text?.length ?? 0) + (b.thinking?.length ?? 0);
      if (typeof b.content === "string") chars += b.content.length;
      else if (b.content != null) chars += JSON.stringify(b.content).length;
      if (b.input) chars += JSON.stringify(b.input).length;
    }
  }
  return chars;
}

/**
 * Una stima dei token, non un conteggio.
 *
 * Il conteggio vero richiede il tokenizer di Anthropic, che qui non abbiamo, o
 * una chiamata di rete per ogni controllo — inaccettabile a ogni giro del loop.
 *
 * `charsPerToken` IS THE CALIBRATION, and it is the difference between a
 * threshold and a guess: the caller passes back the ratio measured on the last
 * round (`charsPerTokenFrom`), so from the second round on this function is
 * reporting what the API counts rather than what we hoped.
 */
export function estimateTokens(
  messages: AgentMessage[],
  overheadChars = 0,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  const ratio = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(estimateChars(messages, overheadChars) / ratio);
}

/**
 * Does the conversation need compacting?
 *
 * `overheadChars` IS THE WEIGHT THAT IS NOT IN THE MESSAGES: the system prompt
 * and the tool schemas travel with every request and count in the same
 * window. Left out, the estimate said "you fit" to a request the API refused:
 * with the MCP fleet mounted the schemas alone are tens of thousands of tokens.
 */
export function needsCompaction(
  messages: AgentMessage[],
  windowTokens: number,
  overheadChars = 0,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): boolean {
  return estimateTokens(messages, overheadChars, charsPerToken) > windowTokens * COMPACT_AT;
}

/**
 * The token count the API reports when it refuses a prompt for being too long,
 * and the ceiling it measured it against. `null` when the error is anything
 * else.
 *
 * IT IS THE ONLY EXACT MEASUREMENT WE EVER GET of a payload we sent, and it
 * arrives precisely when we need it: the estimate that let this request through
 * can be corrected with it, on the spot, instead of being tuned by hand.
 */
export function promptTooLong(message: string): { tokens: number; max: number } | null {
  const m = /prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i.exec(message);
  if (!m) return null;
  return { tokens: Number(m[1]), max: Number(m[2]) };
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
  opts?: { windowTokens?: number; overheadChars?: number; charsPerToken?: number },
): { messages: AgentMessage[]; before: number; after: number; droppedMessages: number } {
  const overhead = opts?.overheadChars ?? 0;
  const ratio = opts?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const before = estimateTokens(messages, overhead, ratio);
  // The target the history has to get back under, when the caller says so.
  // Without one, the only signal left is "it freed nothing".
  const target = opts?.windowTokens != null ? opts.windowTokens * COMPACT_AT : null;

  let next = messages;
  if (messages.length > KEEP_RECENT + 1) {
    next = lightenMiddle(messages);
  }
  let after = estimateTokens(next, overhead, ratio);

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
    after = estimateTokens(next, overhead, ratio);
  }

  // AND IF IT STILL DOES NOT FIT, THE OLDEST TURNS GO.
  //
  // Everything above LIGHTENS: it keeps every message and empties what is
  // inside them. That has a floor, and the floor can sit above the ceiling —
  // measured on the live database (card 18bdf214): a compaction that reported
  // 480k estimated tokens produced a request the API counted at 1,000,176 and
  // refused. Reporting success on a request that cannot be sent is worse than
  // failing, because nobody goes looking.
  //
  // So when a target exists and the lightening did not reach it, the oldest
  // turns are CUT. It is the one operation that always converges, and it is
  // last because it is the only one that loses something the model could still
  // have used.
  let droppedMessages = 0;
  if (target != null && after > target) {
    const cut = dropOldest(next, target, overhead, ratio);
    droppedMessages = cut.dropped;
    if (cut.dropped > 0) {
      next = cut.messages;
      after = estimateTokens(next, overhead, ratio);
    }
  }
  return { messages: next, before, after, droppedMessages };
}

/** The notice left on the initial request when turns have been cut away. */
function droppedNotice(n: number): string {
  return `\n\n[${n} earlier messages of this conversation were removed to fit the context window. `
    + `What came before is gone: ask again for anything you need from it.]`;
}

/**
 * Drops the oldest turns until the conversation fits the target.
 *
 * THREE INVARIANTS, and each one is a way of breaking the very turn we were
 * trying to save:
 *
 *  · the INITIAL REQUEST stays, with a notice saying how much is gone: an
 *    agent that no longer knows what it was asked keeps working, which is
 *    worse than stopping;
 *  · the cut lands only on an `assistant` boundary, so what is left does not
 *    open with orphan `tool_result` blocks: the API refuses a result without
 *    its request exactly as it refuses the opposite;
 *  · after the initial request (which is `user`) the first kept message is an
 *    `assistant`, so the role alternation the API demands still holds.
 *
 * If cutting everything cuttable is still not enough, the deepest possible cut
 * is kept: it is the smallest request this conversation can produce anyway,
 * and the caller learns from `after` that it did not get there.
 */
function dropOldest(
  messages: AgentMessage[],
  target: number,
  overhead: number,
  ratio: number,
): { messages: AgentMessage[]; dropped: number } {
  const head = messages[0];
  if (!head || messages.length <= KEEP_RECENT + 1) return { messages, dropped: 0 };

  // The possible boundaries: the indices of an `assistant`, stopping before
  // the recent tail, which stays intact by contract.
  const lastCut = messages.length - KEEP_RECENT;
  let best: { messages: AgentMessage[]; dropped: number } | null = null;
  for (let i = 1; i < lastCut; i++) {
    if (messages[i]!.role !== "assistant") continue;
    const dropped = i - 1;
    if (dropped <= 0) continue;
    const kept: AgentMessage[] = [withNotice(head, dropped), ...messages.slice(i)];
    best = { messages: kept, dropped };
    if (estimateTokens(kept, overhead, ratio) <= target) return best;
  }
  return best ?? { messages, dropped: 0 };
}

/** The initial request with the notice appended. Does not mutate the original. */
function withNotice(head: AgentMessage, dropped: number): AgentMessage {
  const notice = droppedNotice(dropped);
  if (typeof head.content === "string") return { ...head, content: head.content + notice };
  return { ...head, content: [...head.content, { type: "text", text: notice }] };
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
      // THE ARGUMENTS WEIGH MORE THAN THE RESULTS, and this file never acted
      // like it until now.
      //
      // The result of a `write_file` is "ok, written"; its ARGUMENT is the
      // whole file. Same for an `edit_file` (the old text plus the new one)
      // and for a task created with a long description. Measured on the two
      // dead topics (card 18bdf214): after every result had been emptied, 77%
      // of what was left were `tool_use.input`, 1.53 MB out of 1.98 MB. We
      // were compacting the light part and leaving the heavy one untouched.
      if (b.type === "tool_use" && b.input) {
        const light = lightenInput(b.input as Record<string, unknown>);
        if (light) return { ...b, input: light };
      }
      return b;
    });
    return { ...m, content: blocks };
  });

  return [head, ...lightened, ...tail];
}

/**
 * How long an argument may stay before it is emptied. Under this threshold a
 * value is a path, an id, a flag: things that do not weigh anything and that
 * still say what the agent was doing.
 */
const ARG_KEEP_CHARS = 200;

/**
 * The arguments of an old call, lightened.
 *
 * THE SHAPE STAYS AND THE BULK GOES: every key survives, and so does the
 * beginning of each long value. A `write_file` still says which file it wrote
 * (the `path` is short and survives whole) and loses the content, which is
 * what weighs and which the model already watched go by twenty rounds ago.
 *
 * The structure is left alone: a value that is not a long string (a number, a
 * boolean, a small object) passes as it is. Returns `null` when there was
 * nothing to lighten, so the caller does not rebuild the block for nothing.
 */
function lightenInput(input: Record<string, unknown>): Record<string, unknown> | null {
  let touched = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > ARG_KEEP_CHARS) {
      touched = true;
      out[k] = `${v.slice(0, ARG_KEEP_CHARS)}… [${v.length - ARG_KEEP_CHARS} chars dropped to fit the context window]`;
      continue;
    }
    // A big object or array (a todo list, a nested payload) weighs as much as
    // a long string and gets the same treatment, without pretending the result
    // is still that structure: it becomes a note.
    if (v !== null && typeof v === "object") {
      const json = JSON.stringify(v);
      if (json.length > ARG_KEEP_CHARS) {
        touched = true;
        out[k] = `[${json.length} chars dropped to fit the context window]`;
        continue;
      }
    }
    out[k] = v;
  }
  return touched ? out : null;
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
