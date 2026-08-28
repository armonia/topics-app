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
import { detectUserInputRequest } from "../ask-user-detector";
import { decide, DEFAULT_AUTONOMY } from "./permissions";
import { applyPromptCache } from "../prompt-cache";
import { needsCompaction, compact, windowFor } from "./compaction";
import { isTopicsTool, executeTopicsTool, type TopicsToolContext } from "./topics-tools";
import { isMcpTool, executeMcpTool } from "./mcp-fleet";
import type { AutonomyLevel } from "../../../shared/types";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";
import { stopCauseFromSignal } from "../stop-reason";
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
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

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
          usage.cacheWrite1h += ev.message?.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          break;

        case "content_block_start": {
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
 * which is a different (and honest) sentence, and the dispatcher already knows
 * that one means "compact and resume".
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

  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  let finalText = "";

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
      handler.onAborted?.({ result: finalText, turnEnd: end });
      return { turnEnd: end, text: finalText, usage: total };
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
    // Mancava, e nessuno lo vedeva perché il totale è giusto su tutto il resto:
    // la quota a TTL un'ora arrivava sempre zero, cioè la parte di scrittura di
    // cache che costa 2x veniva tariffata 1.25x.
    total.cacheWrite1h += round.usage.cacheWrite1h;
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
      handler.onDone?.({ result: finalText, turnEnd: end });
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
      results.push({
        type: "tool_result",
        tool_use_id: t.id,
        content: out.content,
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
        handler.onAborted?.({ result: finalText, turnEnd: end });
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
