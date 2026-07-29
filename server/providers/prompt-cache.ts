/**
 * prompt-cache.ts — i breakpoint di prompt caching per i provider che parlano
 * direttamente con l'SDK Anthropic.
 *
 * Perché esiste: fino a questa change `grep -rn "cache_control" server/` non
 * trovava NULLA. `claude.ts` costruiva i params in tre punti (`sendChat`,
 * `streamHTTP`, `complete`) e non marcava un solo breakpoint, quindi ogni turno
 * ripagava l'intero prefisso a prezzo pieno invece di 0,1x — su una
 * conversazione che, per definizione di API stateless, riparte da capo ogni
 * volta e cresce ad ogni turno.
 *
 * L'ordine del prefisso Anthropic è `tools → system → messages`, quindi bastano
 * tre marker per coprire tutto ciò che si ripete:
 *
 *   1. ultimo tool      — congela gli schemi dei tool;
 *   2. fine del system  — congela il preambolo di sistema;
 *   3. ultimo messaggio — chiude la conversazione fin qui, così il turno
 *                         successivo la rilegge dalla cache invece di
 *                         riprefillarla.
 *
 * Il limite è quattro: ne usiamo al più tre, e il quarto resta libero per chi
 * dovesse aggiungere un breakpoint più avanti senza rompere questa funzione.
 *
 * Un breakpoint sotto la soglia minima di cache del modello non è un errore: il
 * provider semplicemente non cachea quel tratto. Per questo la funzione non
 * misura nulla e non prova a essere furba — marca i confini, e lascia al
 * provider la decisione su cosa valga la pena conservare.
 */
import type Anthropic from "@anthropic-ai/sdk";

const EPHEMERAL = { type: "ephemeral" as const };

/** Massimo di breakpoint accettati dall'API. Qui è un'asserzione, non un budget da spendere. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Applica i breakpoint IN-PLACE. Idempotente: rimarcare gli stessi confini
 * lascia i params identici, così un chiamante che la invoca due volte non
 * moltiplica i marker (e non sfonda il limite di quattro).
 */
export function applyPromptCache(params: Anthropic.MessageCreateParams): void {
  markLastTool(params);
  markSystem(params);
  markLastMessage(params);
}

function markLastTool(params: Anthropic.MessageCreateParams): void {
  const tools = params.tools;
  if (!Array.isArray(tools) || tools.length === 0) return;
  const last = tools[tools.length - 1] as unknown as Record<string, unknown>;
  if (last && typeof last === "object") last.cache_control = EPHEMERAL;
}

function markSystem(params: Anthropic.MessageCreateParams): void {
  const system = params.system;
  if (typeof system === "string") {
    // Una stringa non può portare `cache_control`: va espressa come blocco.
    if (system.length === 0) return;
    params.system = [{ type: "text", text: system, cache_control: EPHEMERAL }];
    return;
  }
  if (Array.isArray(system) && system.length > 0) {
    const last = system[system.length - 1] as unknown as Record<string, unknown>;
    if (last && typeof last === "object") last.cache_control = EPHEMERAL;
  }
}

function markLastMessage(params: Anthropic.MessageCreateParams): void {
  const messages = params.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (!last) return;

  if (typeof last.content === "string") {
    if (last.content.length === 0) return;
    last.content = [{ type: "text", text: last.content, cache_control: EPHEMERAL }];
    return;
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1] as unknown as Record<string, unknown>;
    if (lastBlock && typeof lastBlock === "object") lastBlock.cache_control = EPHEMERAL;
  }
}

/** Quanti breakpoint porta questo payload. Esposta per i test e per una diagnostica onesta. */
export function countCacheBreakpoints(params: Anthropic.MessageCreateParams): number {
  let n = 0;
  const bump = (v: unknown) => {
    if (v && typeof v === "object" && (v as Record<string, unknown>).cache_control) n++;
  };
  if (Array.isArray(params.tools)) params.tools.forEach(bump);
  if (Array.isArray(params.system)) params.system.forEach(bump);
  for (const m of params.messages ?? []) {
    if (Array.isArray(m.content)) m.content.forEach(bump);
  }
  return n;
}
