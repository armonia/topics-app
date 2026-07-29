/**
 * Da `session/update` di ACP al vocabolario che la chat di Topics sa già
 * disegnare (3.2).
 *
 * Perché la traduzione è pura e sta qui, invece che dentro il provider: è
 * l'unico pezzo dell'integrazione che dipende SOLO dal protocollo. Un agente
 * ACP nuovo non porta codice nuovo, porta al massimo una variante di payload —
 * e una variante di payload si prova con un oggetto letterale, senza spawnare
 * niente. Il provider resta un guscio: processo, sessione, handler.
 *
 * Le due scelte non ovvie, entrambe deliberate:
 *
 *  • **Il nome della tool call è il `title`.** ACP separa il titolo leggibile
 *    (`title`: «Reading configuration file») dalla categoria (`kind`: `read`).
 *    La riga della chat mostra un nome: mettere lì `kind` darebbe dieci righe
 *    identiche chiamate «read». Il `kind` viaggia negli args, dove la UI può
 *    prenderlo per l'icona senza che il testo ne soffra.
 *
 *  • **`plan` non produce niente, per ora.** È l'aggancio naturale del 3.4
 *    (goal nella chat nativa) e buttarlo dentro il testo del modello sarebbe
 *    peggio che ignorarlo: diventerebbe trascritto, quindi persistito, quindi
 *    parte del contesto. Resta un ramo esplicito con un test che lo blocca, così
 *    chi farà il 3.4 sa dove attaccarsi.
 */

import type { ToolArgs } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// Forme ACP v1 che ci servono (sottoinsieme: solo ciò che leggiamo)

export interface AcpContentBlock {
  type?: string;
  text?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
  [key: string]: unknown;
}

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpToolCallContent {
  type?: string;
  content?: AcpContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
  [key: string]: unknown;
}

export interface AcpSessionUpdate {
  sessionUpdate?: string;
  /**
   * Lo stesso nome per due forme, ed è ACP a volerlo così: su un chunk è UN
   * `ContentBlock`, su una tool call è una LISTA di `ToolCallContent`. Chi
   * legge discrimina sul ramo, non sul campo.
   */
  content?: AcpContentBlock | AcpToolCallContent[];
  /** tool_call / tool_call_update */
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: AcpToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string; line?: number }>;
  /** usage_update */
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string };
  /** plan */
  entries?: Array<{ content?: string; priority?: string; status?: string }>;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Il nostro vocabolario

export type AcpTranslated =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_start"; toolCallId: string; name: string; args?: ToolArgs }
  | { kind: "tool_args"; toolCallId: string; args: ToolArgs }
  | { kind: "tool_update"; toolCallId: string; partialResult: string }
  | { kind: "tool_result"; toolCallId: string; result: string; isError: boolean }
  | { kind: "context"; tokens: number; windowTokens?: number };

/**
 * Stato minimo fra un update e l'altro: quali tool call sono già state
 * annunciate. Serve perché ACP permette a un agente di mandare direttamente un
 * `tool_call_update` per una call mai annunciata (o di annunciarla due volte
 * dopo un reconnect): senza memoria, il primo caso lascerebbe la chat senza la
 * riga e il secondo ne farebbe due.
 */
export interface AcpTranslateState {
  announced: Set<string>;
}

export function newTranslateState(): AcpTranslateState {
  return { announced: new Set() };
}

const TERMINAL_STATUS = new Set<AcpToolCallStatus>(["completed", "failed"]);

/**
 * Un `session/update` → zero o più eventi nostri. Zero è un esito legittimo e
 * frequente (`plan`, `current_mode_update`, un chunk vuoto): il chiamante non
 * deve distinguere «non capito» da «capito, niente da mostrare».
 */
export function translateSessionUpdate(
  update: AcpSessionUpdate | null | undefined,
  state: AcpTranslateState,
): AcpTranslated[] {
  if (!update || typeof update !== "object") return [];
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = contentText(chunkBlock(update.content));
      return text ? [{ kind: "text", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = contentText(chunkBlock(update.content));
      return text ? [{ kind: "thinking", text }] : [];
    }
    case "tool_call":
    case "tool_call_update":
      return translateToolCall(update, state);
    case "usage_update": {
      const used = finite(update.used);
      if (used === undefined) return [];
      const size = finite(update.size);
      return [{ kind: "context", tokens: used, ...(size ? { windowTokens: size } : {}) }];
    }
    // `user_message_chunk` è l'eco del nostro stesso prompt (replay di
    // `session/load`): ri-emetterlo duplicherebbe il messaggio dell'umano.
    case "user_message_chunk":
    // Vedi l'intestazione: agganci del 3.4 / superfici che non abbiamo.
    case "plan":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
      return [];
    default:
      return [];
  }
}

function translateToolCall(update: AcpSessionUpdate, state: AcpTranslateState): AcpTranslated[] {
  const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (!id) return [];

  const out: AcpTranslated[] = [];
  const args = toolArgs(update);

  if (!state.announced.has(id)) {
    state.announced.add(id);
    out.push({
      kind: "tool_start",
      toolCallId: id,
      name: toolName(update),
      ...(args ? { args } : {}),
    });
  } else if (args) {
    // Già annunciata: gli args arrivati dopo arricchiscono la stessa riga.
    out.push({ kind: "tool_args", toolCallId: id, args });
  }

  const status = update.status;
  const body = toolOutputText(update);

  if (status && TERMINAL_STATUS.has(status)) {
    out.push({
      kind: "tool_result",
      toolCallId: id,
      result: body,
      isError: status === "failed",
    });
  } else if (body) {
    out.push({ kind: "tool_update", toolCallId: id, partialResult: body });
  }

  return out;
}

/**
 * Il nome che finisce nella riga. `title` è pensato dall'agente per essere
 * letto; `kind` è una categoria; l'ultimo scalino evita una riga senza nome.
 */
function toolName(update: AcpSessionUpdate): string {
  const title = typeof update.title === "string" ? update.title.trim() : "";
  if (title) return title;
  const kind = typeof update.kind === "string" ? update.kind.trim() : "";
  return kind || "tool";
}

/** `rawInput` più il `kind`, che la UI usa per l'icona. */
function toolArgs(update: AcpSessionUpdate): ToolArgs | undefined {
  const raw =
    update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
      ? { ...(update.rawInput as ToolArgs) }
      : undefined;
  const kind = typeof update.kind === "string" ? update.kind : undefined;
  const locations = Array.isArray(update.locations) ? update.locations : undefined;
  if (!raw && !kind && !locations) return undefined;
  const args: ToolArgs = raw ?? {};
  if (kind && args.kind === undefined) args.kind = kind;
  if (locations?.length && args.locations === undefined) args.locations = locations;
  return args;
}

/**
 * Il testo di un `ToolCallContent[]`, più `rawOutput` come ultima spiaggia.
 * I diff si rendono come diff testuale: la chat non ha (ancora) una superficie
 * per il diff strutturato, e mostrare «[diff]» sarebbe peggio di mostrarlo.
 */
function toolOutputText(update: AcpSessionUpdate): string {
  const parts: string[] = [];
  const content = update.content;
  const list: AcpToolCallContent[] = Array.isArray(content)
    ? (content as AcpToolCallContent[])
    : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "diff") {
      const path = typeof item.path === "string" ? item.path : "";
      const old = typeof item.oldText === "string" ? item.oldText : "";
      const next = typeof item.newText === "string" ? item.newText : "";
      parts.push([path && `--- ${path}`, old && `- ${old}`, next && `+ ${next}`].filter(Boolean).join("\n"));
      continue;
    }
    if (item.type === "terminal") {
      if (typeof item.terminalId === "string") parts.push(`[terminal ${item.terminalId}]`);
      continue;
    }
    const text = contentText(item.content ?? (item as AcpContentBlock));
    if (text) parts.push(text);
  }
  if (parts.length) return parts.join("\n");
  const raw = update.rawOutput;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return "";
    }
  }
  return "";
}

/** Il `content` di un chunk: un blocco solo, mai la lista delle tool call. */
function chunkBlock(content: AcpSessionUpdate["content"]): AcpContentBlock | undefined {
  return Array.isArray(content) ? undefined : content;
}

/** Il testo di un ContentBlock, per i tipi che un testo ce l'hanno. */
export function contentText(block: AcpContentBlock | null | undefined): string {
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string" && block.text) return block.text;
  if (block.resource && typeof block.resource === "object") {
    const r = block.resource;
    if (typeof r.text === "string" && r.text) return r.text;
    if (typeof r.uri === "string") return r.uri;
  }
  if (block.type === "resource_link" && typeof block.uri === "string") return block.uri;
  return "";
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}
