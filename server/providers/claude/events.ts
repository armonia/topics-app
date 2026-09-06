/**
 * Il parsing degli eventi `stream-json` della CLI di Claude — PURO.
 *
 * ── Perché sta qui e non dentro il provider ─────────────────────────────────
 * `claude-code.ts` è il file più grande del repo, e metà è un parser di eventi
 * che NON sono un'API pubblicata: `system/compact_boundary`, `rate_limit_event`,
 * `stream_event`/`content_block_*`, la forma dell'`usage` dentro `assistant` e
 * dentro `result`. Sono campi interni di una CLI di terze parti — cambiano
 * senza preavviso, e quando cambiano non danno un errore: danno un pezzo di
 * interfaccia che smette di aggiornarsi. Il divider di compattazione che non
 * compare più. L'anello del contesto fermo. Il badge della fast mode spento.
 * Guasti muti, cioè i più cari da trovare.
 *
 * Isolarli qui li rende provabili su fixture REGISTRATE, senza spawnare la CLI
 * — la stessa cosa che è già stata fatta bene per `acp/translate.ts`. Il
 * provider resta il posto dove si applica lo stato (i Set di dedup, la
 * sidechain, i timer); qui si DECODIFICA soltanto.
 *
 * ── La regola che tiene ─────────────────────────────────────────────────────
 * Niente qui dentro tocca `pp`, il DB, l'orologio o l'ambiente. Ogni funzione
 * prende un evento e restituisce un valore. Se una funzione ha bisogno di
 * sapere «l'avevo già visto?», quella domanda appartiene al chiamante.
 */

import type { PlanUsage, PlanUsageWindow } from "../../../shared/provider-hold";
import type { ProviderUsage, ToolArgs } from "../types";
import { contextTokensFromUsage } from "../../usage/usage-update";

/** A reading without the instant it was taken: this module never asks a clock. */
export type PlanUsageReading = Omit<PlanUsage, "observedAtMs">;

/** Un evento NDJSON della CLI: forma libera, si legge difensivamente. */
type RawEvent = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────
// Instradamento di primo livello

/**
 * Che COSA è questa riga.
 *
 * Il nome (`kind`) è quello che il watchdog logga già oggi come
 * `lastEventKind`, quindi la stringa non è decorativa: è la traccia che
 * distingue un figlio piantato da uno che taceva per un motivo.
 */
export type StreamLineKind =
  /** `system/compact_boundary`: la sessione è stata compattata. */
  | "compaction"
  /** Ogni altro `system`: si scarta. */
  | "noise"
  /** `rate_limit_event`: how full the plan's usage windows are. */
  | "rate_limit"
  /** `stream_event`: i blocchi parziali di `--include-partial-messages`. */
  | "partial"
  /** `result`: il turno è finito. */
  | "result"
  /** `assistant` / `user`: i blocchi di contenuto. */
  | "content"
  /** Nient'altro di riconoscibile. */
  | "unknown";

export function classifyStreamLine(event: unknown): { kind: StreamLineKind; label: string } {
  const e = asRecord(event);
  const type = typeof e?.type === "string" ? e.type : "";
  const subtype = typeof e?.subtype === "string" ? e.subtype : "";
  const label = subtype ? `${type || "?"}/${subtype}` : type || "?";
  if (type === "system" && subtype === "compact_boundary") return { kind: "compaction", label };
  if (type === "rate_limit_event") return { kind: "rate_limit", label };
  if (type === "system") return { kind: "noise", label };
  if (type === "stream_event") return { kind: "partial", label };
  if (type === "result") return { kind: "result", label };
  if (type === "assistant" || type === "user") return { kind: "content", label };
  return { kind: "unknown", label };
}

/**
 * How full the plan's windows are, out of a `rate_limit_event`.
 *
 * THE UNITS ARE NOT THE ONES THE REST OF THE SERVER USES, and that is the whole
 * risk of this function. The CLI writes `utilization` as a FRACTION (0-1, and
 * it can go past 1 on overage) and `resetsAt` as epoch SECONDS; the usage
 * endpoint writes percent 0-100 and an ISO instant, and every reader downstream
 * speaks the endpoint's dialect. A missed x100 reads 0.92 as 1% and never
 * brakes; a missed x1000 puts every reset in 1970, which reads as a window that
 * has already reset and so is dropped on sight.
 *
 * Null when the event carries no `unifiedWindows`: older CLIs send the same
 * event with only `status`/`resetsAt`, and "I do not know" must not read as
 * "empty window".
 */
export function readRateLimitUsage(event: unknown): PlanUsageReading | null {
  const e = asRecord(event);
  if (!e || e.type !== "rate_limit_event") return null;
  const windows = asRecord(asRecord(e.rate_limit_info)?.unifiedWindows);
  if (!windows) return null;
  const fiveHour = readUnifiedWindow(windows.five_hour);
  const sevenDay = readUnifiedWindow(windows.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function readUnifiedWindow(raw: unknown): PlanUsageWindow | null {
  const w = asRecord(raw);
  if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return null;
  const resetsAt = w.resetsAt;
  const resetsAtMs = typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt * 1_000 : null;
  return { utilization: w.utilization * 100, resetsAtMs };
}

/**
 * L'evento è stato emesso da una SOTTO-SESSIONE (il figlio di un `Task`)?
 * La CLI lo marca con `parent_tool_use_id` al livello più esterno. Torna l'id
 * del genitore, o null.
 */
export function readParentToolUseId(event: unknown): string | null {
  const v = asRecord(event)?.parent_tool_use_id;
  return typeof v === "string" && v ? v : null;
}

// ─────────────────────────────────────────────────────────────────────────
// I blocchi di contenuto

/** Le forme che la CLI mette dentro `message.content`. */
export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id?: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

/**
 * I blocchi di un evento `assistant`/`user`.
 *
 * Il formato sul filo è `{ type: "assistant", message: { content: [...] } }`.
 * Una versione del provider leggeva `event.content` — sempre `undefined` —
 * quindi `onTextDelta` non partiva mai e la chat mostrava lo stub «No response
 * received». Si accettano entrambe le forme apposta: se una release futura
 * appiattisse il campo, il testo continuerebbe ad arrivare.
 */
export function readEventContent(event: unknown): AssistantBlock[] | null {
  const e = asRecord(event);
  if (!e) return null;
  if (e.type !== "assistant" && e.type !== "user") return null;
  const nested = asRecord(e.message)?.content;
  if (Array.isArray(nested)) return nested as AssistantBlock[];
  if (Array.isArray(e.content)) return e.content as AssistantBlock[];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Usage

/** L'usage di UNA chiamata al modello, nel vocabolario di Topics. */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  model?: string;
}

/**
 * L'usage e il modello di UNA chiamata, da un evento `assistant`.
 *
 * Due domande nascono da qui e vanno tenute separate: quanto è GRANDE il
 * prompt che il modello ha appena visto (il serbatoio, che sale e scende con le
 * compattazioni) e quanto ha CONSUMATO quella chiamata (la bolletta, che solo
 * cresce). Vedi `contextTokensOf`.
 *
 * `inputTokens` è il TOTALE letto e comprende `cacheRead` + `cacheCreation`;
 * `cacheCreation1h` è una QUOTA di `cacheCreation`, non un addendo — il TTL sta
 * scritto nell'usage e non si deduce dal tempo fra le richieste (una scrittura
 * a un'ora costa 2×, una a cinque minuti 1.25×).
 *
 * Null quando l'evento non porta usage: un evento senza usage non è una
 * chiamata a zero token, è una chiamata di cui non sappiamo niente.
 */
export function readAssistantCallUsage(event: unknown): CallUsage | null {
  const e = asRecord(event);
  if (!e || e.type !== "assistant") return null;
  const msg = asRecord(e.message);
  const mu = asRecord(msg?.usage);
  if (!mu) return null;
  const model = typeof msg?.model === "string" && msg.model ? msg.model : undefined;
  const cacheRead = num(mu.cache_read_input_tokens);
  const cacheCreation = num(mu.cache_creation_input_tokens);
  return {
    inputTokens: num(mu.input_tokens) + cacheRead + cacheCreation,
    outputTokens: num(mu.output_tokens),
    cacheRead,
    cacheCreation,
    cacheCreation1h: num(asRecord(mu.cache_creation)?.ephemeral_1h_input_tokens),
    ...(model ? { model } : {}),
  };
}

/**
 * L'identità della CHIAMATA API che ha prodotto questo evento.
 *
 * Serve perché `assistant` NON è un evento per chiamata: la CLI ne emette uno
 * per BLOCCO di contenuto, e ognuno ripete la STESSA `message.usage`. Misurato
 * su un turno reale (16 ricerche voli): 24 eventi `assistant` con usage, 4
 * `message.id` distinti — 8 + 9 + 5 + 2. Chi accumula quell'usage senza
 * guardare l'id conta lo stesso prompt fino a 9 volte: 925.774 token diventano
 * 4.893.590, e il costo del turno $3,66 diventa $22,80.
 *
 * `message.id` è l'id del messaggio Anthropic, identico su tutti i blocchi
 * della stessa risposta e diverso fra una risposta e l'altra. Null quando
 * manca: chi chiama non deve poter confondere «id assente» con «stesso id»,
 * quindi in quel caso si torna al comportamento storico (nessuna deduplica) e
 * non a «già visto».
 */
export function readAssistantMessageId(event: unknown): string | null {
  const e = asRecord(event);
  if (!e || e.type !== "assistant") return null;
  const id = asRecord(e.message)?.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * La dimensione del contesto che quella chiamata ha visto.
 *
 * Si legge dall'evento e non da `CallUsage` per non fare aritmetica al
 * contrario: lì `inputTokens` è già il totale (comprende cache read e
 * creation), mentre `contextTokensFromUsage` vuole le tre quote separate e le
 * somma lui. Quali token contino è una decisione che NON appartiene a questo
 * provider: la stessa regola vale per Codex e per chiunque arrivi dopo.
 *
 * Zero significa «niente da dire» (evento senza usage, o usage tutto a zero):
 * il chiamante non emette.
 */
export function readAssistantContextTokens(event: unknown): number {
  const mu = asRecord(asRecord(asRecord(event)?.message)?.usage);
  if (!mu) return 0;
  return contextTokensFromUsage({
    inputTokens: num(mu.input_tokens),
    cacheRead: num(mu.cache_read_input_tokens),
    cacheCreation: num(mu.cache_creation_input_tokens),
  });
}

/**
 * La quota di una chiamata attribuita a UNA delle `k` azioni che ha deciso.
 *
 * Una sola chiamata non sa dire quale dei suoi `tool_use` paralleli pesi di
 * più: si divide in parti uguali. Divisione INTERA per difetto, così la somma
 * delle azioni non supera mai il totale del turno.
 */
export function splitCallUsage(usage: CallUsage, k: number): CallUsage {
  const d = k > 0 ? k : 1;
  return {
    inputTokens: Math.floor(usage.inputTokens / d),
    outputTokens: Math.floor(usage.outputTokens / d),
    cacheRead: Math.floor(usage.cacheRead / d),
    cacheCreation: Math.floor(usage.cacheCreation / d),
    cacheCreation1h: Math.floor(usage.cacheCreation1h / d),
    ...(usage.model ? { model: usage.model } : {}),
  };
}

/**
 * L'usage AGGREGATO del turno, da un evento `result`.
 *
 * È la somma di ogni chiamata del turno: leggerlo come «quanto è grande il
 * contesto adesso» è l'errore che faceva dichiarare al divider di
 * compattazione un'ESPLOSIONE del contesto subito dopo averlo dimezzato.
 *
 * I campi a zero escono `undefined` di proposito: a valle distinguono «non
 * c'era cache» da «cache a zero», e il payload resta quello storico.
 */
export function readResultUsage(event: unknown): ProviderUsage {
  const usage = asRecord(asRecord(event)?.usage) ?? {};
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const cacheCreation1h = num(asRecord(usage.cache_creation)?.ephemeral_1h_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  return {
    inputTokens: num(usage.input_tokens) + cacheCreation + cacheRead,
    outputTokens: num(usage.output_tokens),
    cacheCreation: cacheCreation || undefined,
    cacheCreation1h: cacheCreation1h || undefined,
    cacheRead: cacheRead || undefined,
  };
}

/**
 * Il testo di errore di un `result` fallito, appiattito.
 *
 * Serve a una cosa sola: riconoscere il «No conversation found with session ID»
 * — che la CLI riporta come result di ERRORE su stdout, non su stderr — e
 * mandarlo nella stessa ripresa che gestisce un `--resume` morto.
 */
export function readResultErrorText(event: unknown): string | null {
  const e = asRecord(event);
  if (!e) return null;
  const failed = e.is_error === true || e.subtype === "error_during_execution";
  if (!failed) return null;
  const parts = [
    typeof e.subtype === "string" ? e.subtype : "",
    ...(Array.isArray(e.errors) ? e.errors.map((x) => String(x)) : []),
  ];
  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────
// I blocchi parziali (`--include-partial-messages`)

/**
 * Il ciclo di vita di un `tool_use` mentre il modello ne SCRIVE l'input.
 *
 * È l'unica parte dei `stream_event` che si consuma: testo e ragionamento
 * continuano ad arrivare dagli snapshot cumulativi, che restano la loro unica
 * sorgente — leggerli anche da qui li conterebbe due volte.
 */
export type PartialToolEvent =
  /** Il modello ha COMINCIATO a scrivere l'input di questo tool. */
  | { kind: "tool_start"; index: number; id: string; name: string }
  /** Un altro pezzo di JSON dell'input. */
  | { kind: "input_delta"; index: number; chunk: string }
  /** L'input è completo: quel che c'è nel buffer è tutto. */
  | { kind: "block_stop"; index: number };

/**
 * Decodifica un `stream_event`. Null per tutto ciò che non riguarda il ciclo di
 * vita di un `tool_use` — inclusi gli eventi delle sotto-sessioni, i cui tool
 * si aggregano dagli snapshot della sidechain e non da qui.
 */
export function decodePartialStreamEvent(event: unknown): PartialToolEvent | null {
  const e = asRecord(event);
  if (!e || e.type !== "stream_event") return null;
  if (readParentToolUseId(e)) return null;
  const ev = asRecord(e.event);
  if (!ev) return null;
  const index = typeof ev.index === "number" ? ev.index : -1;

  if (ev.type === "content_block_start") {
    const block = asRecord(ev.content_block);
    if (!block || block.type !== "tool_use") return null;
    const id = typeof block.id === "string" ? block.id : "";
    if (!id) return null;
    return { kind: "tool_start", index, id, name: String(block.name ?? "") };
  }
  if (ev.type === "content_block_delta") {
    const delta = asRecord(ev.delta);
    if (delta?.type !== "input_json_delta" || typeof delta.partial_json !== "string") return null;
    return { kind: "input_delta", index, chunk: delta.partial_json };
  }
  if (ev.type === "content_block_stop") {
    return { kind: "block_stop", index };
  }
  return null;
}

/**
 * Il buffer accumulato → gli argomenti del tool.
 *
 * Tre esiti, e la differenza conta:
 *  • buffer VUOTO → `{}`. È un input davvero vuoto: i tool senza argomenti non
 *    emettono nemmeno un delta.
 *  • oggetto JSON valido → quello.
 *  • qualunque altra cosa (troncato, array, scalare) → null, cioè «non lo so»:
 *    la finalizzazione tocca allo snapshot cumulativo, che arriva comunque.
 */
export function parseToolInputBuffer(buf: string): ToolArgs | null {
  if (!buf) return {};
  try {
    const parsed = JSON.parse(buf) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ToolArgs;
    }
  } catch {
    /* lo snapshot cumulativo finalizza al posto nostro */
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): RawEvent | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as RawEvent) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
