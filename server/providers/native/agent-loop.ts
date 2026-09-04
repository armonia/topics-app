/**
 * The agent round: ask, run, send back, repeat.
 *
 * THIS IS THE PIECE THE CLI DID FOR US, and the only reason Topics depended on
 * an external binary in order to work. An agent turn is not a reply: it is a
 * CONVERSATION with the machine in the middle. The model asks to read a file, we
 * read it, we send it back, it asks to edit it, and so on until it is done.
 * Every round is a fresh HTTP request with a history that keeps growing.
 *
 * ONE PROCESS, N SESSIONS — the real win, and it comes from here. A CLI is a
 * WHOLE Node process per session (~206 MB measured on this machine): eight
 * agents are ~1.7 GB of processes alone, and the machine started paging. Here a
 * session is an array of messages in memory: it costs its own tokens, not a
 * process. Eight agents are eight arrays inside the server that is already up.
 *
 * STREAMING IS MANDATORY, not a luxury: without it a long turn arrives all at
 * once after minutes of silence, and the Topics UI is built on deltas
 * (`onTextDelta`, `onToolStart`). SSE is parsed by hand because the shape is
 * simple and one more dependency on a path this central is paid for forever.
 */

import { getAccessToken, recoverAfter401 } from "./auth";
import {
  ApiHttpError, ApiStreamError, ApiTransportError, parseRetryAfter, retryRound,
  DEFAULT_RETRY_POLICY, type RetryPolicy,
} from "./retry";
import { CODING_TOOLS, executeTool, type ToolContext, type ToolSpec } from "./tools";
import { detectUserInputRequest } from "../ask-user-detector";
import type { ProviderUsage } from "../types";
import { decide, DEFAULT_AUTONOMY } from "./permissions";
import { applyPromptCache } from "../prompt-cache";
import {
  windowFor, clipToolResult, RESULT_HEAD_CHARS, RESULT_TAIL_CHARS,
  estimateChars, DEFAULT_CHARS_PER_TOKEN,
} from "./compaction";
import {
  compactIfNeeded, recoverFromFullContext, calibrateFrom, overheadCharsFor, type Calibration,
} from "./context-window";
import { isTopicsTool, executeTopicsTool, type TopicsToolContext } from "./topics-tools";
import { isMcpTool, executeMcpTool } from "./mcp-fleet";
import type { AutonomyLevel } from "../../../shared/types";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";
import { stopCauseFromSignal } from "../stop-reason";
import { splitLongWindow, betaHeader, spiegaErrore } from "./long-window";
import { thinkingConfigFor, DEFAULT_MAX_TOKENS } from "../../lib/native-parity";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * L'intestazione che l'OAuth di Claude Code richiede.
 *
 * NON è cosmetica e non è un travestimento: è il contesto d'uso che quel token
 * autorizza. Un token OAuth di Claude Code presentato senza questa riga viene
 * rifiutato — la sessione è quella di Claude Code, e va dichiarata per quella
 * che è. Verificato il 2026-08-16: con la riga, HTTP 200; senza, 401.
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Quanti giri di tool prima di fermarsi. Un agente in loop non deve girare
 * all'infinito — ma questo tetto CONTA IL LAVORO, non riconosce un loop, e a 60
 * i due erano indistinguibili.
 *
 * Misurato il 18-19/08/2026 sul log del server: `fermato dopo 60 giri di tool`
 * cento volte, su SESSANTASETTE topic distinti. Non è una manciata di agenti
 * impazziti: è il tetto che sega il lavoro normale. Un compito vero — «verifica
 * lo skeleton di tutta l'app» — di giri ne fa centinaia.
 *
 * Cosa costava. Il turno finisce `provider-error`, il dispatcher aspetta 60s e
 * riprende la STESSA sessione (quindi il lavoro non si perde), ma
 * `FREE_PROVIDER_ERRORS` è 3: dal quarto singhiozzo la card inizia a pagare
 * tentativi, e a tentativi finiti viene consegnata in review a metà. Sulla card
 * l'umano legge «Errore del provider» per una cosa che non è un errore e non è
 * del provider.
 *
 * 300 lascia finire un compito grosso dentro il primo giro e tiene comunque un
 * fondo alla corsa: 3 finestre da 300 sono 900 giri prima che una card paghi
 * qualcosa. Regolabile senza ricompilare per il caso raro che sfora davvero.
 */
const MAX_ITERATIONS = Number(process.env.TOPICS_MAX_TOOL_ROUNDS) || 300;

export interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  thinking?: string;
  /** La firma del pensiero: arriva a pezzi via `signature_delta`, e senza di
   *  lei il blocco non e' rimandabile indietro. */
  signature?: string;
  /** The arguments arrived truncated (the round was cut while the model was
   *  writing them) and `input` is a fallback empty object, not the call the model
   *  meant to make. Whoever reads this block must NOT treat it as a successful
   *  call. */
  inputTruncated?: boolean;
  /** Il corpo di un `redacted_thinking`, che l'API rimanda cifrato. */
  data?: string;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface AgentTurnOptions {
  model: string;
  maxTokens?: number;
  system?: string;
  /** The tier the user picked (`low`...`max`): see `thinkingConfigFor`. */
  effort?: string | null;
  /**
   * The tool registry, read once PER ROUND rather than once per turn.
   *
   * A thunk and not an array because a server's tool list is alive: the agent
   * can mount a gateway child mid-turn, and with a frozen array the tool it
   * just created would be invisible until the next turn. The result is
   * byte-identical from round to round until the fleet actually changes, so
   * the cached prefix survives; when it does change the prefix is invalidated,
   * and that is the price worth paying over a round wasted on unknown tools.
   */
  tools?: () => ToolSpec[];
  toolContext: ToolContext;
  /** La conversazione finora. Viene ESTESA in place: è la memoria della sessione. */
  history: AgentMessage[];
  /** Cosa l'agente può fare su questa macchina. Vedi `permissions.ts`. */
  autonomy?: AutonomyLevel;
  /**
   * I mestieri di Topics (card, browser, agenti). Assente = l'agente sa solo
   * programmare: è il caso di `complete` e dei test, non quello di una chat.
   */
  topics?: TopicsToolContext;
  /**
   * Il segnale che annulla il turno.
   *
   * Porta con sé anche la RAGIONE: chi annulla passa una {@link StopCause} a
   * `abort(reason)`, e il ciclo la rilegge da `signal.reason` quando serve.
   * Niente callback e niente campo parallelo — il segnale e il perché sono la
   * stessa cosa, e tenerli in due posti è tenere due verità.
   */
  signal?: AbortSignal;
  /**
   * L'uso di OGNI GIRO, appena il giro finisce.
   *
   * Il totale torna comunque a fine turno, ma «a fine turno» per un agente
   * dispacciato vuol dire dopo venti minuti e trecento giri di tool: chi guarda
   * la card vedeva il contatore fermo per tutto quel tempo, e a zero al primo
   * turno. Il ticker della board rilegge il registro ogni quattro secondi, e
   * quindi ha bisogno che il registro cresca DURANTE il turno.
   *
   * È un DELTA, non il progressivo: chi lo riceve somma. E vale anche per i
   * turni che finiscono male — un turno annullato o andato in errore ha bruciato
   * i giri che ha fatto, e prima quei token non arrivavano da nessuna parte.
   */
  onRoundUsage?: (usage: RoundResult["usage"]) => void;
  /**
   * How many times, and how long apart, a failed API call is tried again.
   * Tests pass a policy measured in milliseconds; production takes the
   * default from `retry.ts`, the same shape the CLI uses.
   */
  retryPolicy?: RetryPolicy;
  /** Measured chars-per-token, owned by the CALLER like `history`. */
  calibration?: Calibration;
}

/** Un giro solo: una richiesta, i suoi delta, i suoi blocchi. */
interface RoundResult {
  blocks: Block[];
  stopReason: string | null;
  /**
   * `cacheWrite1h` e' la QUOTA di `cacheWrite` scritta con TTL a un'ora, che
   * costa 2x un token fresco invece di 1.25x. Sta nell'usage
   * (`cache_creation.ephemeral_1h_input_tokens`) e non si deduce dal tempo fra
   * le richieste: tariffare tutto a 1.25x sottostima il conto, e su una sessione
   * reale il 100% delle scritture era a un'ora. Sottoinsieme, non addendo.
   */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
}

/**
 * Una richiesta all'API, con il suo stream consumato fino in fondo.
 *
 * Ricostruisce i blocchi dai delta: l'API manda `content_block_start`, poi N
 * `content_block_delta`, poi `content_block_stop`, e i `tool_use` arrivano come
 * FRAMMENTI DI JSON da concatenare. Se si prova a fare `JSON.parse` di un
 * frammento si ottiene spazzatura, quindi si accumula e si parsa alla chiusura
 * del blocco.
 */
async function streamOnce(
  token: string,
  opts: AgentTurnOptions,
  handler: StreamHandler,
): Promise<RoundResult> {
  // LA FINESTRA LUNGA E' UN HEADER, NON UN NOME.
  // `claude-opus-5[1m]` e' una convenzione nostra: all'API va il nome NUDO
  // piu' il beta `context-1m-2025-08-07`. Prima l'id partiva col suffisso e il
  // beta non c'era, quindi la finestra lunga sul nativo non esisteva - e chi la
  // sceglieva si portava dietro la CLI intera senza saperlo. Vedi long-window.ts.
  const { model: modelloApi, longWindow } = splitLongWindow(opts.model);

  // EFFORT AND THINKING ARE DECIDED PER MODEL, in `native-parity`: the 5
  // family takes `adaptive` plus `output_config.effort`, the old ones a
  // `budget_tokens`. The gate looks at the BARE id: `[1m]` is our suffix.
  //
  // The cap is decided after, because a legacy budget must fit under it (the
  // API refuses `budget_tokens >= max_tokens`): the cap rises, the budget does
  // not shrink. Cutting the reasoning to spare the cap would be choosing
  // silently for whoever moved the slider.
  const thinking = thinkingConfigFor(modelloApi, opts.effort);
  const maxTokens = Math.max(opts.maxTokens ?? DEFAULT_MAX_TOKENS, thinking.minMaxTokens);

  const body: Record<string, unknown> = {
    model: modelloApi,
    max_tokens: maxTokens,
    stream: true,
    messages: opts.history,
    // Il primo blocco di system È l'identità di Claude Code, e deve restare il
    // primo: il resto del prompt di sistema viene dopo, come fa la CLI.
    system: [
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      ...(opts.system ? [{ type: "text", text: opts.system }] : []),
    ],
  };
  if (thinking.thinking) body.thinking = thinking.thinking;
  if (thinking.output_config) body.output_config = thinking.output_config;
  const tools = opts.tools?.() ?? CODING_TOOLS;
  if (tools.length > 0) body.tools = tools;

  // I BREAKPOINT DI CACHE, e qui pesano più che altrove. Un turno d'agente non
  // è una chiamata: sono N giri che rimandano OGNI VOLTA gli schemi dei tool, il
  // preambolo di sistema e tutta la conversazione fin lì. Senza marcare i
  // confini si ripaga quel prefisso a prezzo pieno a ogni giro invece di 0,1x —
  // su un agente che ne fa venti, è il grosso del conto.
  //
  // La funzione è la stessa che usa `claude.ts` (`prompt-cache.ts`) e non una
  // copia: i confini del prefisso Anthropic (`tools → system → messages`) sono
  // gli stessi per chiunque parli con quella API, e averne due versioni
  // significherebbe scoprire un domani che una delle due ha smesso di cachearlo.
  //
  // PRIMA SI PULISCE, ed è la differenza fra noi e `claude.ts`. Là la
  // conversazione si ricostruisce a ogni chiamata, quindi marcare l'ultimo
  // messaggio è un'operazione sola. Qui la storia è la STESSA e cresce a ogni
  // giro: il marker del giro precedente resta dov'è, ne arriva uno nuovo, e al
  // quinto giro l'API rifiuta tutto con «A maximum of 4 blocks with
  // cache_control may be provided. Found 5». Un turno che muore al quinto giro
  // per un'ottimizzazione di costo: il modo peggiore di risparmiare.
  stripMessageCacheMarks(opts.history);
  applyPromptCache(body as never);

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": betaHeader(longWindow),
        "user-agent": "claude-cli/2.1.0 (external, cli)",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    // No status, no event: the connection itself failed. Nothing has been
    // emitted yet, so `streamWithRetry` may simply try again (unless the
    // failure is our own abort, which it checks first).
    throw new ApiTransportError(
      `API unreachable: ${err instanceof Error ? err.message : String(err)}`, false, err,
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // `spiegaErrore` translates ONLY the long-window 400, which otherwise lands
    // mid-turn as an English sentence with no way out. Everything else passes
    // as it came: see long-window.ts. The status and the `retry-after` travel
    // with the error, because the decision to try again is taken upstream.
    throw new ApiHttpError(
      spiegaErrore(res.status, detail, opts.model),
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  if (!res.body) throw new ApiTransportError("API answered 200 with an empty body", false);

  const blocks: Block[] = [];
  const partialJson = new Map<number, string>();
  let stopReason: string | null = null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  // Has anything reached the handler yet? Decides whether a failure from here
  // on can be retried (nothing shown: yes) or must be reported (a replay would
  // show the same text twice). See `ApiStreamError.emitted`.
  let emitted = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE: eventi separati da riga vuota, a noi serve solo `data:`.
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let ev: any;
        try { ev = JSON.parse(payload); } catch { continue; }

        switch (ev.type) {
          case "message_start":
            usage.input += ev.message?.usage?.input_tokens ?? 0;
            usage.cacheRead += ev.message?.usage?.cache_read_input_tokens ?? 0;
            usage.cacheWrite += ev.message?.usage?.cache_creation_input_tokens ?? 0;
            usage.cacheWrite1h += ev.message?.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
            break;

          case "content_block_start": {
            emitted = true;
            const b = ev.content_block ?? {};
            // L'impalcatura va SOLO dove serve accumulare. Metterla su ogni
            // blocco significa appiccicare `text: ""` e `input: {}` anche a un
            // `thinking`, e l'API rifiuta la richiesta al giro dopo:
            // `messages.N.content.0.thinking.text: Extra inputs are not
            // permitted`. Misurato il 19/08/2026 su OTTO topic in una volta, il
            // minuto dopo che il catalogo ha smesso di declassare a un modello
            // che i blocchi di pensiero non li produceva.
            blocks[ev.index] =
              b.type === "text"
                ? { ...b, text: b.text ?? "" }
                : b.type === "tool_use"
                  ? { ...b, input: b.input ?? {} }
                  : { ...b };
            if (b.type === "tool_use") {
              partialJson.set(ev.index, "");
              handler.onToolStart(b.id, b.name, {});
            }
            break;
          }

          case "content_block_delta": {
            const d = ev.delta ?? {};
            const block = blocks[ev.index];
            if (d.type === "text_delta") {
              if (block) block.text = (block.text ?? "") + d.text;
              handler.onTextDelta(d.text, currentText(blocks));
            } else if (d.type === "thinking_delta") {
              if (block) block.thinking = (block.thinking ?? "") + d.thinking;
              handler.onThinkingDelta?.(d.thinking);
            } else if (d.type === "signature_delta") {
              // Senza firma il pensiero non torna indietro: l'API la pretende
              // per verificare che il blocco sia suo e non riscritto.
              if (block) block.signature = (block.signature ?? "") + d.signature;
            } else if (d.type === "input_json_delta") {
              // I frammenti si CONCATENANO: parsarli singolarmente è l'errore
              // classico su questo stream.
              partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + d.partial_json);
              // A BYTE ARRIVING IS A SIGN OF LIFE, and it has to be said out
              // loud. Writing the argument of a `write_file` that holds a whole
              // document takes minutes during which nothing else is emitted:
              // silent here, the route's watchdog would count that as a dead
              // stream the moment it stops suspending itself on a tool that has
              // only been ANNOUNCED. The turn is alive; the call has not started.
              if (block?.id) handler.onToolActivity?.(block.id);
            }
            break;
          }

          case "content_block_stop": {
            const raw = partialJson.get(ev.index);
            if (raw !== undefined && blocks[ev.index]) {
              // TRUNCATED ARGUMENTS ARE REPORTED, NOT FAKED INTO AN EMPTY OBJECT.
              //
              // This `catch` silently replaced an incomplete JSON with `{}`, and the
              // defect measured on 2026-08-28 (topic:4c935add, three times out of
              // three) runs right through here: the model was writing a whole
              // document inside the argument of a `write_file`, blew through the
              // output cap halfway into the JSON, and the call was left in the
              // database with `args: {}` and a green tick. A tool with no arguments
              // does not exist: saying so in the log is the only way for the next
              // occurrence to be visible instead of reconstructed from the wreckage.
              try { blocks[ev.index]!.input = raw ? JSON.parse(raw) : {}; }
              catch {
                console.warn(
                  `[agent-loop] argomenti troncati per il tool ${blocks[ev.index]!.name ?? "?"} `
                  + `(${raw.length} byte non leggibili): il giro e' stato tagliato a meta' della chiamata`,
                );
                blocks[ev.index]!.input = {};
                blocks[ev.index]!.inputTruncated = true;
              }
              partialJson.delete(ev.index);
              const b = blocks[ev.index]!;
              handler.onToolArgsUpdate?.(b.id!, b.input as any);
            }
            break;
          }

          case "message_delta":
            stopReason = ev.delta?.stop_reason ?? stopReason;
            usage.output += ev.usage?.output_tokens ?? 0;
            break;

          case "error":
            // A 529 does not always come as a status: the API can answer 200
            // and put `overloaded_error` in the body as the first event. That is
            // exactly what killed topic:9cb7c969 on 2026-09-03, 43ms after Enter.
            throw new ApiStreamError(
              `stream error: ${JSON.stringify(ev.error).slice(0, 200)}`,
              String(ev.error?.type ?? "unknown"),
              emitted,
            );
        }
      }
    }
  } catch (err) {
    if (err instanceof ApiStreamError) throw err;
    // The body broke while we were reading it: a transport failure, retryable
    // only if the user has not seen any of this round yet.
    throw new ApiTransportError(
      `stream dropped: ${err instanceof Error ? err.message : String(err)}`, emitted, err,
    );
  }

  return { blocks: blocks.filter(Boolean), stopReason, usage };
}

function currentText(blocks: Block[]): string {
  return blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
}

/**
 * Toglie i breakpoint di cache lasciati dai giri precedenti.
 *
 * Ne resta uno solo, quello che `applyPromptCache` rimetterà sull'ultimo
 * messaggio: il prefisso cachato è comunque tutto ciò che viene prima, quindi
 * non si perde niente in risparmio e si resta sotto il tetto di quattro.
 */
function stripMessageCacheMarks(messages: AgentMessage[]): void {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b && typeof b === "object" && "cache_control" in b) {
        delete (b as Record<string, unknown>).cache_control;
      }
    }
  }
}

/**
 * Ripulisce i blocchi prima di rimandarli all'API.
 *
 * Serve perché durante lo streaming li COSTRUIAMO noi, e per farlo li
 * inizializziamo con i campi che dovranno avere: un blocco `text` nasce con
 * `input: {}` accanto, un `tool_use` con `text: ""`. Sono impalcature nostre, e
 * l'API le rifiuta con «Extra inputs are not permitted» al giro successivo —
 * cioè non al primo turno, ma appena l'agente usa un tool e la storia torna
 * indietro. Un errore che compare solo nel caso interessante.
 *
 * Si manda a ogni tipo di blocco esattamente ciò che quel tipo ammette.
 */
/**
 * The loop's own tally, in the shape every consumer downstream already speaks.
 *
 * `inputTokens` IS THE WHOLE PROMPT, cache included, and that is the contract
 * of the column it ends up in.
 *
 * The API reports `input_tokens` as the FRESH share only: cache reads and cache
 * writes are counted apart. Handing that number over as-is looks harmless and
 * is not, because `messages.usage_prompt_tokens` means the opposite everywhere
 * else in this repo (see `partsFromMessage` in shared/token-cost.ts, which
 * SUBTRACTS the cache read from it, and the note on top of profile-stats.ts).
 * Measured on the live database: 1448 rows out of 1448 written by the CLI
 * runtime satisfy `usage_prompt_tokens >= cache_read_tokens`, against 0 out of
 * 6 written by this one. On a real turn it was 14 instead of 234564, so the
 * billable share came out as `max(0, 14 - 230541)` = zero and the whole turn
 * vanished from the profile and the person stats.
 *
 * The price was never wrong: `splitPromptTokens` rebuilds the fresh share by
 * subtracting the cache columns, which are reported separately and correctly.
 * Only this column was, and only for this runtime.
 *
 * `cacheCreation1h` is a SUBSET of `cacheCreation`, not an addend: it is the
 * share written with a one-hour TTL, which costs 2x a fresh token instead of
 * 1.25x. Adding them would bill that share twice. `cacheWrite1h` is therefore
 * NOT summed into the total below either, for the same reason.
 */
export function toProviderUsage(
  total: RoundResult["usage"],
): Required<Pick<ProviderUsage, "inputTokens" | "outputTokens" | "cacheRead" | "cacheCreation" | "cacheCreation1h">> {
  return {
    inputTokens: total.input + total.cacheRead + total.cacheWrite,
    outputTokens: total.output,
    cacheRead: total.cacheRead,
    cacheCreation: total.cacheWrite,
    cacheCreation1h: total.cacheWrite1h,
  };
}

export function forApi(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text ?? "" };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
      case "thinking":
        // Il pensiero torna indietro INTERO — firma compresa, perche' senza
        // firma l'API lo rifiuta — ma SOLO con i campi che quel tipo ammette.
        // «Intero» non vuol dire «cosi' com'e'»: il blocco che abbiamo in mano
        // e' quello che abbiamo costruito noi durante lo streaming, e prima di
        // questa riga si portava dietro la nostra impalcatura.
        return { type: "thinking", thinking: b.thinking ?? "", ...(b.signature ? { signature: b.signature } : {}) };
      case "redacted_thinking":
        // Cifrato dall'API: si rimanda il corpo e nient'altro.
        return { type: "redacted_thinking", data: b.data };
      default:
        return b;
    }
  });
}

/**
 * HOW A ROUND THAT DID NOT ASK FOR TOOLS ENDED.
 *
 * The rule that matters is the second one, and it was missing. `stop_reason`
 * was read for `max_tokens` and NOTHING else: every other value, `null`
 * included, came out as `{end: "end_turn"}` - a natural end, no notice, no
 * retry. And `null` is precisely the value you get when the SSE body ends
 * without a `message_delta`, that is when the stream dies halfway through.
 *
 * The tell is the one already written for a truncated call: a round that
 * carries `tool_use` blocks and did NOT close with `tool_use` was INTERRUPTED
 * while the model was writing the call. Whatever the reason. A healthy turn
 * closes with `end_turn` and no `tool_use` block, so this never touches it.
 *
 * `max_tokens` keeps its own end even with tool blocks: the output cap cut it,
 * which is a different (and honest) sentence. The dispatcher marks that end as
 * failed; it does not compact or resume it, so the cap itself has to be high
 * enough for the work (see `DEFAULT_MAX_TOKENS`).
 */
function roundEnd(stopReason: string | null, toolUseCount: number): TurnEndInfo {
  if (stopReason === "max_tokens") return { end: "max_tokens" };
  if (toolUseCount > 0) {
    const detail =
      `il giro portava ${toolUseCount} chiamata/e a strumenti ma si e' chiuso con `
      + `stop_reason=${stopReason ?? "null"}: lo stream si e' interrotto mentre il modello `
      + `scriveva la chiamata, il turno non e' finito da solo`;
    return { end: "error", cause: "provider-error", detail };
  }
  return { end: "end_turn" };
}

/**
 * Il turno completo: gira finché il modello non ha più tool da chiedere.
 *
 * IL CICLO È IL PUNTO. `stop_reason: "tool_use"` significa «ho chiesto degli
 * strumenti, dammi i risultati e continuo»; qualunque altra cosa è la fine del
 * turno. Ogni giro aggiunge DUE messaggi alla storia — la richiesta
 * dell'assistente e i risultati come messaggio utente — ed è così che il
 * modello vede cosa è successo.
 *
 * I TOOL SI ESEGUONO IN SERIE, di proposito. In parallelo sarebbe più veloce,
 * ma due `edit_file` sullo stesso file che partono insieme si sovrascrivono: la
 * velocità non vale una modifica persa.
 */
export async function runAgentTurn(
  opts: AgentTurnOptions,
  handler: StreamHandler,
): Promise<{ turnEnd: TurnEndInfo; text: string; usage: RoundResult["usage"] }> {
  const token = await getAccessToken();
  if (!token) {
    const msg = "nessuna credenziale Claude: fai `claude` → /login una volta, poi riprova";
    handler.onError(msg);
    return { turnEnd: { end: "error", cause: "provider-error", detail: msg }, text: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } };
  }

  // Mutable on purpose: a 401 mid-turn renews the token, and every round after
  // that must carry the new one.
  const auth = { token };
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  let finalText = "";
  // The caller's calibration when it keeps one (it survives across turns),
  // turn-local otherwise; the recovery count is per TURN, not per round.
  const calibration = opts.calibration ?? { charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  const recovery = { attempts: 0 };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (opts.signal?.aborted) {
      // ANCHE QUESTA USCITA PARLA.
      //
      // Prima faceva `return` e basta: nessun `onDone`, nessun `onError`,
      // nessun `onAborted`. Chi ascolta — `routes/chat.ts` — finalizza il turno
      // SOLO da uno di quei tre, quindi su questo ramo lo stream SSE restava
      // aperto su un turno già morto, e a chiuderlo arrivava minuti dopo un
      // watchdog, con la sua spiegazione sbagliata («il provider non risponde»).
      // Un'uscita muta da un ciclo è una promessa non mantenuta a chi aspetta.
      //
      // La causa si legge dal segnale. Se chi ha annullato non l'ha dichiarata
      // NON si inventa: il turno resta `cancelled` senza causa, e a valle
      // `cancelledNotice` su quel ramo scrive comunque un cartello. Indovinare
      // «user» è precisamente ciò che ha fatto sparire la spiegazione.
      const causa = stopCauseFromSignal(opts.signal);
      const end: TurnEndInfo = causa ? { end: "cancelled", cause: causa } : { end: "cancelled" };
      handler.onAborted?.({ result: finalText, turnEnd: end, usage: toProviderUsage(total) });
      return { turnEnd: end, text: finalText, usage: total };
    }

    // Compacted BEFORE asking, never after a 400: by then the turn is dead.
    const windowTokens = windowFor(opts.model);
    const overheadChars = overheadCharsFor(opts, CLAUDE_CODE_IDENTITY);
    compactIfNeeded({ history: opts.history, windowTokens, overheadChars, calibration, handler });

    // Taken BEFORE the request: with the count the API reports, they give the
    // real ratio. Afterwards the history has changed.
    const sentChars = estimateChars(opts.history, overheadChars);

    // One round, tried again when the failure is the API's and not ours: the
    // policy and the loop live in retry.ts, this is the only call site.
    let round: RoundResult;
    try {
      round = await retryRound((token) => streamOnce(token, opts, handler), {
        auth,
        policy: opts.retryPolicy ?? DEFAULT_RETRY_POLICY,
        signal: opts.signal,
        renewToken: recoverAfter401,
        onRetry: (info) => handler.onRetry?.(info),
      });
    } catch (err) {
      // A full context is a measurement, not a failure: it recompacts and
      // returns, or rethrows what it cannot resolve. See `context-window.ts`.
      recoverFromFullContext(err, {
        history: opts.history, windowTokens, overheadChars, sentChars, calibration,
        state: recovery, aborted: opts.signal?.aborted === true, handler,
      });
      i--; // the same round, with a lightened history
      continue;
    }
    total.input += round.usage.input;
    total.output += round.usage.output;
    total.cacheRead += round.usage.cacheRead;
    total.cacheWrite += round.usage.cacheWrite;
    // Mancava, e nessuno lo vedeva perché il totale è giusto su tutto il resto:
    // la quota a TTL un'ora arrivava sempre zero, cioè la parte di scrittura di
    // cache che costa 2x veniva tariffata 1.25x.
    total.cacheWrite1h += round.usage.cacheWrite1h;

    calibrateFrom(calibration, sentChars, round.usage);
    // Il giro è finito: il suo costo va depositato ADESSO, non a fine turno.
    // Il `try` c'è perché è telemetria: un registro che esplode non deve
    // portarsi via il turno.
    try { opts.onRoundUsage?.(round.usage); } catch { /* la misura non ferma il lavoro */ }

    // La risposta entra nella storia PRIMA dei risultati: l'ordine è parte del
    // protocollo, e invertirlo fa rifiutare la richiesta successiva.
    opts.history.push({ role: "assistant", content: forApi(round.blocks) });

    // LA PROSA DI QUESTO GIRO SI TIENE, non solo quella dell'ultimo.
    //
    // `finalText` si popolava SOLO sul ramo che chiude il turno, quindi un
    // turno interrotto a metà tornava al chiamante con testo VUOTO — anche
    // quando il modello aveva già scritto delle frasi nei giri precedenti. In
    // un turno agentico è la norma: si spiega cosa si sta per fare, si chiama
    // un tool, si continua. Su un'uscita anticipata (abort, tetto dei giri)
    // quel testo era l'unica cosa da mostrare sotto il cartello, e si perdeva.
    //
    // Si TIENE solo se questo giro ha prodotto prosa: un giro di soli tool non
    // deve cancellare quello che era stato detto prima.
    const prosaDelGiro = currentText(round.blocks);
    if (prosaDelGiro.trim()) finalText = prosaDelGiro;

    const toolUses = round.blocks.filter((b) => b.type === "tool_use");
    if (round.stopReason !== "tool_use" || toolUses.length === 0) {
      finalText = currentText(round.blocks);
      const end = roundEnd(round.stopReason, toolUses.length);
      if (end.end === "error") {
        // A CUT ROUND IS NOT A FINISHED TURN, so it does not leave through
        // `onDone`: the route finalizes an `onError` with a notice, and the
        // dispatcher retries. Going out of the door marked "finished" is
        // exactly what made this death silent.
        handler.onError(end.detail ?? "il giro si e' interrotto a meta'");
        return { turnEnd: end, text: finalText, usage: total };
      }
      // THE COUNT TRAVELS WITH THE END, or nobody ever sees it.
      //
      // The footer under a message opens on `usagePromptTokens > 0`, and that
      // number reaches the row from the usage a provider reports when the turn
      // ends. This loop counted every round into `total` and then called
      // `onDone` without it: the numbers existed and died here. Measured on the
      // live database - 0 assistant rows out of 755 carry usage for this
      // runtime, against 103 of 104 for the CLI one, which is why the chat
      // showed no consumption at all.
      //
      // `recordTurnUsage` does NOT cover this: it feeds an in-memory registry
      // whose only reader is its own test, and it empties on every restart.
      handler.onDone?.({ result: finalText, turnEnd: end, usage: toProviderUsage(total) });
      return { turnEnd: end, text: finalText, usage: total };
    }

    const results: Block[] = [];
    for (const t of toolUses) {
      // Il permesso si valuta PRIMA di eseguire, e un rifiuto è un risultato di
      // tool come un altro: l'agente lo legge, capisce perché, e cambia strada.
      // Farlo fallire con un'eccezione gli farebbe sparire il turno sotto i
      // piedi per una regola che poteva semplicemente rispettare.
      // FROM HERE THE TOOL IS RUNNING, and this is the only place that knows
      // it. The announcement went out at `content_block_start`, while the
      // model was still writing the call; whoever suspends a watchdog on "a
      // tool is running" must hang it on this signal, not on that one.
      handler.onToolExecStart?.(t.id!);
      // A TOOL THAT ASKS THE HUMAN NEEDS A FORM ON SCREEN, and this is where
      // the native runtime says so.
      //
      // The panel is rendered from the detector's verdict - the answer channel
      // (`/api/sessions/:key/ask-user`) only carries the reply back, and its
      // own comment says the form is already up by the time it starts waiting.
      // The CLI provider has always called the detector here; this runtime
      // never did, so `ask_user_question` blocked the turn with the question
      // sitting in the database and no control on screen. Observed on
      // 2026-08-28: a chat parked for minutes, unanswerable by anyone.
      //
      // Fired BEFORE the call, because the handler is what blocks: it long
      // polls for the answer, so anything published afterwards would arrive
      // once the wait is already over.
      const askSchema = detectUserInputRequest({ name: t.name!, input: t.input ?? {} });
      if (askSchema) handler.onUserInputRequired?.(t.id!, t.name!, askSchema);
      const verdict = decide(t.name!, (t.input ?? {}) as Record<string, unknown>, opts.autonomy ?? DEFAULT_AUTONOMY);
      // Tre famiglie di tool, un solo giro. I mestieri di Topics passano dai
      // loro handler (`topics-tools.ts`), quelli di macchina dai nostri, e i
      // tool dei server MCP globali dalla flotta (`mcp-fleet.ts`).
      // The MCP branch goes FIRST and it is the only one keyed on a prefix:
      // `mcp__<server>__<tool>` is a name WE built when mounting, so it cannot
      // collide with a native tool, while the other two are told apart by the
      // table that owns their names.
      const out = !verdict.allow
        ? { content: verdict.reason, isError: true }
        : isMcpTool(t.name!)
          ? await executeMcpTool(t.name!, (t.input ?? {}) as Record<string, unknown>)
          : opts.topics && isTopicsTool(t.name!)
            ? await executeTopicsTool(t.name!, (t.input ?? {}) as Record<string, unknown>, opts.topics)
            : await executeTool(t.name!, (t.input ?? {}) as Record<string, any>, opts.toolContext);
      handler.onToolResult(t.id!, out.content, out.isError);
      // EVERY RESULT IS CAPPED HERE, whichever family produced it (machine,
      // Topics, MCP): one place, one budget. The UI above gets the whole
      // output; what enters the history is head and tail with a notice on how
      // to read the rest. Without this, two big reads in one round could push
      // a 200k window past its limit on their own, and the resulting 400 sat
      // in the session for good. The same clip, tighter, is what the
      // compaction applies to the tail when everything else has failed.
      results.push({
        type: "tool_result",
        tool_use_id: t.id,
        content: clipToolResult(out.content, RESULT_HEAD_CHARS, RESULT_TAIL_CHARS),
        ...(out.isError ? { is_error: true } : {}),
      });
      // IL TURNO PUÒ ESSERE MORTO MENTRE QUESTO TOOL GIRAVA.
      //
      // Il controllo in cima al `for` esterno non basta: un turno sta quasi
      // sempre fermo qui dentro, e riprendere il giro vorrebbe dire spendere
      // una chiamata al modello — e i secondi che lo spegnimento non ha — per
      // una risposta che nessuno leggerà. Peggio: senza uscire di qui non si
      // chiama `onAborted`, e senza `onAborted` la route non finalizza, quindi
      // la chat resta con la risposta troncata e nessuna spiegazione. È
      // esattamente il 20/08 su topic:9f9e9629.
      //
      // Si esce SUBITO, con la prosa già scritta e la causa che viaggia nel
      // segnale: il cartello lo compone `cancelledNotice` a valle.
      if (opts.signal?.aborted) {
        const causa = stopCauseFromSignal(opts.signal);
        const end: TurnEndInfo = causa ? { end: "cancelled", cause: causa } : { end: "cancelled" };
        handler.onAborted?.({ result: finalText, turnEnd: end, usage: toProviderUsage(total) });
        return { turnEnd: end, text: finalText, usage: total };
      }
    }
    opts.history.push({ role: "user", content: results });
  }

  // Tetto raggiunto. È una fine anomala e va detta — ma va detta per quello che
  // è. `fermato dopo N giri di tool` su una card diventa «Errore del provider»,
  // e manda a cercare un guasto di rete che non c'è: il turno ha finito il
  // budget di giri, il lavoro è salvo, e la ripresa continua la stessa sessione.
  const detail =
    `il turno ha esaurito i ${MAX_ITERATIONS} giri di tool a disposizione (non è un guasto: ` +
    `il lavoro resta, la ripresa continua la stessa sessione). Se questo compito ne serve di più, ` +
    `alza TOPICS_MAX_TOOL_ROUNDS`;
  handler.onError(detail);
  return { turnEnd: { end: "error", cause: "provider-error", detail }, text: finalText, usage: total };
}
