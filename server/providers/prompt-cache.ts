/**
 * prompt-cache.ts: prompt caching breakpoints for the providers that talk
 * straight to the Anthropic SDK.
 *
 * Why it exists: before this change `grep -rn "cache_control" server/` found
 * NOTHING. `claude.ts` built the params in three places (`sendChat`,
 * `streamHTTP`, `complete`) and marked no breakpoint at all, so every turn
 * paid the whole prefix at full price instead of 0.1x, on a conversation that,
 * the API being stateless, starts over every time and grows every turn.
 *
 * The Anthropic prefix order is `tools -> system -> messages`, so three markers
 * cover everything that repeats:
 *
 *   1. last tool     - freezes the tool schemas;
 *   2. end of system - freezes the system preamble;
 *   3. last message  - closes the conversation so far, so the next turn reads
 *                      it from the cache instead of prefilling it again.
 *
 * The limit is four: we use at most three, and the fourth stays free for
 * whoever adds a breakpoint later without breaking this function.
 *
 * A breakpoint below the model's minimum cacheable length is not an error: the
 * provider just does not cache that stretch. So the function measures nothing
 * and does not try to be clever: it marks the boundaries and leaves the
 * provider to decide what is worth keeping.
 */
import type Anthropic from "@anthropic-ai/sdk";

// 1h TTL: cache write a 2x but only once per hour; 5m would require a keepalive
// under every ~4 min to avoid cold writes on tasks with gaps > 5 min between turns.
const EPHEMERAL = { type: "ephemeral" as const, ttl: "1h" as const };

/** Massimo di breakpoint accettati dall'API. Qui è un'asserzione, non un budget da spendere. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Applica i breakpoint IN-PLACE. Idempotente: rimarcare gli stessi confini
 * lascia i params identici, così un chiamante che la invoca due volte non
 * moltiplica i marker (e non sfonda il limite di quattro).
 */
export function applyPromptCache(params: Anthropic.MessageCreateParams): void {
  // I segni si mettono qui e solo qui: quelli arrivati da fuori (storia ripresa, prompt a blocchi, definizioni
  // dei tool) si tolgono prima. Il 05/11 dalle 02:13 ogni turno di Jarvis su Discord moriva con «A maximum of 4
  // blocks with cache_control may be provided. Found 5».
  stripCacheMarks(params);
  markLastTool(params);
  markSystem(params);
  markLastMessage(params);
}

function stripCacheMarks(params: Anthropic.MessageCreateParams): void {
  const strip = (b: unknown) => {
    if (b && typeof b === "object" && "cache_control" in b) delete (b as Record<string, unknown>).cache_control;
  };
  if (Array.isArray(params.tools)) params.tools.forEach(strip);
  if (Array.isArray(params.system)) params.system.forEach(strip);
  for (const m of params.messages ?? []) if (Array.isArray(m.content)) m.content.forEach(strip);
}

function markLastTool(params: Anthropic.MessageCreateParams): void {
  const tools = params.tools;
  if (!Array.isArray(tools) || tools.length === 0) return;
  // The last LOADED tool: a deferred one is not in the prefix, and the API
  // refuses `cache_control` on it with a 400 (`native/tool-deferral.ts`).
  const loaded = (tools as unknown as Record<string, unknown>[]).filter((t) => t && typeof t === "object" && t.defer_loading !== true);
  const last = loaded[loaded.length - 1];
  if (last) last.cache_control = EPHEMERAL;
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
