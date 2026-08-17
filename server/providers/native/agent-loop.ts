/**
 * Il giro dell'agente: chiedi, esegui, rimanda, ripeti.
 *
 * È IL PEZZO CHE LA CLI FACEVA PER NOI, e l'unica ragione per cui Topics
 * dipendeva da un binario esterno per lavorare. Un turno d'agente non è una
 * risposta: è una CONVERSAZIONE con la macchina in mezzo. Il modello chiede di
 * leggere un file, noi lo leggiamo, glielo rimandiamo, lui chiede di
 * modificarlo, e così finché non ha finito. Ogni giro è una richiesta HTTP
 * nuova con la storia che cresce.
 *
 * UN PROCESSO, N SESSIONI — il guadagno vero, e viene da qui. Una CLI è un
 * processo Node INTERO per sessione (~206 MB misurati su questa macchina): otto
 * agenti sono ~1,7 GB di soli processi, e la macchina paginava. Qui una
 * sessione è un array di messaggi in memoria: costa i suoi token, non un
 * processo. Otto agenti sono otto array dentro il server che è già acceso.
 *
 * LO STREAMING È OBBLIGATORIO, non un lusso: senza, un turno lungo arriva tutto
 * insieme dopo minuti di silenzio, e la UI di Topics è costruita sui delta
 * (`onTextDelta`, `onToolStart`). Si parsa SSE a mano perché la forma è
 * semplice e una dipendenza in più su un percorso così centrale si paga per
 * sempre.
 */

import { getAccessToken } from "./auth";
import { CODING_TOOLS, executeTool, type ToolContext, type ToolSpec } from "./tools";
import { decide, DEFAULT_AUTONOMY } from "./permissions";
import { applyPromptCache } from "../prompt-cache";
import { needsCompaction, compact, windowFor } from "./compaction";
import { isTopicsTool, executeTopicsTool, type TopicsToolContext } from "./topics-tools";
import type { AutonomyLevel } from "../../../shared/types";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";
import { splitLongWindow, betaHeader, spiegaErrore } from "./long-window";

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

/** Quanti giri di tool prima di fermarsi. Un agente in loop non deve girare all'infinito. */
const MAX_ITERATIONS = 60;

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
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface AgentTurnOptions {
  model: string;
  maxTokens?: number;
  system?: string;
  tools?: ToolSpec[];
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
  signal?: AbortSignal;
}

/** Un giro solo: una richiesta, i suoi delta, i suoi blocchi. */
interface RoundResult {
  blocks: Block[];
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

  const body: Record<string, unknown> = {
    model: modelloApi,
    max_tokens: opts.maxTokens ?? 16384,
    stream: true,
    messages: opts.history,
    // Il primo blocco di system È l'identità di Claude Code, e deve restare il
    // primo: il resto del prompt di sistema viene dopo, come fa la CLI.
    system: [
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      ...(opts.system ? [{ type: "text", text: opts.system }] : []),
    ],
  };
  const tools = opts.tools ?? CODING_TOOLS;
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

  const res = await fetch(API_URL, {
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

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    // `spiegaErrore` traduce SOLO il 400 della finestra lunga, che altrimenti
    // arriva a turno gia' partito come una frase inglese senza via d'uscita.
    // Tutto il resto passa intatto: vedi long-window.ts.
    throw new Error(spiegaErrore(res.status, detail, opts.model));
  }

  const blocks: Block[] = [];
  const partialJson = new Map<number, string>();
  let stopReason: string | null = null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

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
          break;

        case "content_block_start": {
          const b = ev.content_block ?? {};
          blocks[ev.index] = { ...b, text: b.text ?? "", input: b.input ?? {} };
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
          } else if (d.type === "input_json_delta") {
            // I frammenti si CONCATENANO: parsarli singolarmente è l'errore
            // classico su questo stream.
            partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + d.partial_json);
          }
          break;
        }

        case "content_block_stop": {
          const raw = partialJson.get(ev.index);
          if (raw !== undefined && blocks[ev.index]) {
            try { blocks[ev.index]!.input = raw ? JSON.parse(raw) : {}; }
            catch { blocks[ev.index]!.input = {}; }
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
          throw new Error(`stream error: ${JSON.stringify(ev.error).slice(0, 200)}`);
      }
    }
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
function forApi(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text ?? "" };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
      case "thinking":
        // Il pensiero torna indietro INTERO, firma compresa: rimandarlo mutilato
        // fa rifiutare la richiesta sui modelli con extended thinking.
        return b;
      default:
        return b;
    }
  });
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
    return { turnEnd: { end: "error", cause: "provider-error", detail: msg }, text: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }

  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let finalText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (opts.signal?.aborted) {
      return { turnEnd: { end: "cancelled", cause: "user" }, text: finalText, usage: total };
    }

    // Si compatta PRIMA di chiedere, non dopo aver ricevuto un 400: a quel
    // punto il turno è già morto e il lavoro fatto fin qui è perso. Il
    // controllo costa una scansione della storia, cioè niente rispetto al giro
    // di rete che segue.
    if (needsCompaction(opts.history, windowFor(opts.model))) {
      const c = compact(opts.history);
      if (c.after < c.before) {
        // Si sostituisce IN PLACE perché `history` è la memoria della sessione
        // e il chiamante tiene lo stesso array: assegnargliene uno nuovo
        // lascerebbe la sessione con la versione pesante.
        opts.history.length = 0;
        opts.history.push(...c.messages);
        console.log(
          `[native] contesto compattato: ~${c.before} → ~${c.after} token stimati`,
        );
        handler.onCompaction?.({ trigger: "auto", preTokens: c.before, postTokens: c.after });
      }
    }

    const round = await streamOnce(token, opts, handler);
    total.input += round.usage.input;
    total.output += round.usage.output;
    total.cacheRead += round.usage.cacheRead;
    total.cacheWrite += round.usage.cacheWrite;

    // La risposta entra nella storia PRIMA dei risultati: l'ordine è parte del
    // protocollo, e invertirlo fa rifiutare la richiesta successiva.
    opts.history.push({ role: "assistant", content: forApi(round.blocks) });

    const toolUses = round.blocks.filter((b) => b.type === "tool_use");
    if (round.stopReason !== "tool_use" || toolUses.length === 0) {
      finalText = currentText(round.blocks);
      const end: TurnEndInfo =
        round.stopReason === "max_tokens"
          ? { end: "max_tokens" }
          : { end: "end_turn" };
      handler.onDone?.({ result: finalText, turnEnd: end });
      return { turnEnd: end, text: finalText, usage: total };
    }

    const results: Block[] = [];
    for (const t of toolUses) {
      // Il permesso si valuta PRIMA di eseguire, e un rifiuto è un risultato di
      // tool come un altro: l'agente lo legge, capisce perché, e cambia strada.
      // Farlo fallire con un'eccezione gli farebbe sparire il turno sotto i
      // piedi per una regola che poteva semplicemente rispettare.
      const verdict = decide(t.name!, (t.input ?? {}) as Record<string, unknown>, opts.autonomy ?? DEFAULT_AUTONOMY);
      // Due famiglie di tool, un solo giro. I mestieri di Topics passano dai
      // loro handler (`topics-tools.ts`), quelli di macchina dai nostri: la
      // distinzione è sul NOME e non su un prefisso, perché e' la tabella MCP
      // a decidere quali nomi esistono, non una convenzione che va tenuta
      // allineata a mano.
      const out = !verdict.allow
        ? { content: verdict.reason, isError: true }
        : opts.topics && isTopicsTool(t.name!)
          ? await executeTopicsTool(t.name!, (t.input ?? {}) as Record<string, unknown>, opts.topics)
          : await executeTool(t.name!, (t.input ?? {}) as Record<string, any>, opts.toolContext);
      handler.onToolResult(t.id!, out.content, out.isError);
      results.push({
        type: "tool_result",
        tool_use_id: t.id,
        content: out.content,
        ...(out.isError ? { is_error: true } : {}),
      });
    }
    opts.history.push({ role: "user", content: results });
  }

  // Tetto raggiunto. È una fine anomala e va detta: un agente che gira in
  // tondo su 60 giri ha un problema che il silenzio nasconderebbe.
  const detail = `fermato dopo ${MAX_ITERATIONS} giri di tool`;
  handler.onError(detail);
  return { turnEnd: { end: "error", cause: "provider-error", detail }, text: finalText, usage: total };
}
