/**
 * The context windows a provider DECLARED, as opposed to the ones our table
 * guesses from the model name.
 *
 * A configured endpoint knows its own window exactly: it is `n_ctx`, either
 * written in the endpoint config or read back from `/v1/models`. The static
 * table in `shared/context-window.ts` cannot know it, and for a name it has
 * never seen it falls back on `DEFAULT_CONTEXT_WINDOW` = 1M. That is how a
 * 200k llama-server ended up drawn as a one-million-token budget: not a wrong
 * number in the table, a number the table was never in a position to have.
 *
 * WHY A REGISTRY AND NOT A DIRECT CALL. The consumer is
 * `server/usage/context-window.ts`, which the context assembler imports; the
 * producer is the provider snapshot manager, which imports half of the
 * provider layer. Wiring one to the other directly buys an import cycle. So
 * the snapshot manager PUBLISHES here and the assembler READS here, and this
 * module knows about neither.
 *
 * KEYED BY MODEL, NOT BY PROVIDER + MODEL, and that is a deliberate narrowing.
 * The one call site that matters (`assemble.ts`) resolves a budget from a topic
 * that carries a model; threading the provider through it would mean editing a
 * file the bloat ratchet has frozen. Model names coming from these endpoints
 * are specific enough (`qwen38-27b-200k`) that a collision between two
 * providers declaring DIFFERENT windows for the SAME name is not a case worth
 * paying an architecture for. If it ever happens, last publisher wins, and the
 * number is still closer to the truth than 1M.
 */

/** model name (lowercased) -> declared window in tokens. */
const declared = new Map<string, number>();

/** Which provider published which names, so a removed endpoint takes its own away. */
const byProvider = new Map<string, string[]>();

/**
 * Publish (or clear) the windows a provider declares. Replaces whatever that
 * provider said before: an endpoint that drops a model must stop answering for
 * it, otherwise a stale number outlives the config that produced it.
 */
export function publishDeclaredWindows(
  provider: string,
  windows: Record<string, number> | null | undefined,
): void {
  for (const name of byProvider.get(provider) ?? []) declared.delete(name);
  byProvider.delete(provider);

  if (!windows) return;
  const owned: string[] = [];
  for (const [model, tokens] of Object.entries(windows)) {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
    const key = model.toLowerCase();
    declared.set(key, Math.round(tokens));
    owned.push(key);
  }
  if (owned.length > 0) byProvider.set(provider, owned);
}

/** The declared window for a model, or undefined when nobody declared one. */
export function declaredWindowForModel(model: string | null | undefined): number | undefined {
  if (!model || typeof model !== "string") return undefined;
  return declared.get(model.toLowerCase());
}

/** Test seam: forget everything anybody published. */
export function resetDeclaredWindows(): void {
  declared.clear();
  byProvider.clear();
}
