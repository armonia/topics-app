// Auto model selection for dispatched tasks.
//
// When a task is on "modello auto" (task.model === null) the dispatcher asks a
// FAST one-shot (haiku) to read the task and pick the right tier BEFORE the
// real agent spawns. "Auto" used to mean a fixed sonnet default — this makes it
// an actual, per-task decision: a typo fix runs on haiku, a cross-cutting
// refactor or a data-modelling job runs on opus/fable.
//
// Design guarantees:
// - NEVER blocks dispatch: any failure (classifier error, timeout, unparsable
//   answer, model not available on this host) falls back to `fallback` so a
//   task is never stranded because the picker hiccuped.
// - Only picks among models the host actually advertises (the provider
//   snapshot's `models[]`); an unavailable tier degrades to the nearest one.
// - Deterministic mapping from the classifier's single-word tier to a concrete
//   model id, so the prompt stays tiny and cheap.

/** Capability tiers the classifier chooses between (cheap → most capable). */
export const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Canonical model id for each tier (matches the claude-code snapshot ids). */
const TIER_TO_MODEL: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
  fable: "claude-fable-5",
};

export interface PickModelDeps {
  /** One-shot completion (the dispatcher passes claude-code's, forced to haiku). */
  complete: (prompt: string) => Promise<string>;
  /** Live model ids the host advertises — the pick is constrained to these. */
  availableModels: readonly string[];
  /** Model id used when classification can't produce a valid available pick. */
  fallback: string;
  /** Optional log sink for observability (no-op in tests). */
  log?: (msg: string) => void;
}

const CLASSIFIER_PROMPT = (title: string, description: string) =>
  [
    "Sei un router di modelli. Scegli il modello AI più adatto per ESEGUIRE il task software qui sotto.",
    "Rispondi con UNA SOLA parola tra: haiku, sonnet, opus, fable. Nessun'altra parola, niente punteggiatura.",
    "",
    "Criterio:",
    "- haiku: banale/meccanico (typo, rinomina, bump versione, piccola modifica ovvia).",
    "- sonnet: task standard ben definito (endpoint, componente, fix circoscritto, test mirati).",
    "- opus: complesso/trasversale (refactor architetturale, debug non ovvio, più file/sistemi, design).",
    "- fable: massima difficoltà/ambiguità (ricerca, modellazione dati, algoritmi, ragionamento profondo).",
    "",
    `Titolo: ${title}`,
    description ? `Descrizione: ${description}` : "",
    "",
    "Modello:",
  ]
    .filter(Boolean)
    .join("\n");

/** Parse the classifier's free text into a tier, or null if unrecognisable. */
export function parseTier(raw: string): ModelTier | null {
  const t = raw.toLowerCase();
  // First tier keyword that appears wins — tolerant of stray words/punctuation
  // the model might add despite the instruction.
  for (const tier of MODEL_TIERS) {
    if (new RegExp(`(^|[^a-z])${tier}([^a-z]|$)`).test(t)) return tier;
  }
  return null;
}

/**
 * Resolve a tier to a concrete AVAILABLE model id. Exact match wins; otherwise
 * step DOWN the capability ladder to the nearest available tier (a host missing
 * `fable` serves `opus` for a fable pick, never something weaker than asked
 * when a stronger one is also gone — we search down then up). Returns null when
 * nothing maps (caller uses its fallback).
 */
export function tierToAvailableModel(tier: ModelTier, available: readonly string[]): string | null {
  const set = new Set(available);
  const want = TIER_TO_MODEL[tier];
  if (set.has(want)) return want;
  const idx = MODEL_TIERS.indexOf(tier);
  // Prefer the nearest LOWER tier (cheaper, safer), then fall upward.
  for (let d = 1; d < MODEL_TIERS.length; d++) {
    const lower = MODEL_TIERS[idx - d];
    if (lower && set.has(TIER_TO_MODEL[lower])) return TIER_TO_MODEL[lower];
    const higher = MODEL_TIERS[idx + d];
    if (higher && set.has(TIER_TO_MODEL[higher])) return TIER_TO_MODEL[higher];
  }
  return null;
}

/**
 * Pick a model id for a task. Never throws — returns `fallback` on any problem.
 */
export async function pickTaskModel(
  task: { text: string; description?: string | null },
  deps: PickModelDeps,
): Promise<string> {
  try {
    const title = (task.text ?? "").slice(0, 300);
    const description = (task.description ?? "").slice(0, 1200);
    const raw = await deps.complete(CLASSIFIER_PROMPT(title, description));
    const tier = parseTier(raw ?? "");
    if (!tier) {
      deps.log?.(`model-picker: unparsable answer ${JSON.stringify((raw ?? "").slice(0, 40))} → fallback`);
      return deps.fallback;
    }
    const model = tierToAvailableModel(tier, deps.availableModels);
    if (!model) {
      deps.log?.(`model-picker: tier ${tier} has no available model → fallback`);
      return deps.fallback;
    }
    deps.log?.(`model-picker: ${tier} → ${model}`);
    return model;
  } catch (err) {
    deps.log?.(`model-picker: failed (${err instanceof Error ? err.message : String(err)}) → fallback`);
    return deps.fallback;
  }
}
