// Auto model selection for dispatched tasks.
//
// When a task is on "modello auto" (task.model === null) the dispatcher asks a
// FAST one-shot (haiku) to read the task and pick the right tier BEFORE the
// real agent spawns. The standard is OPUS-first: the human works on opus by
// default, so "auto" defaults to opus and only downgrades a task that is
// clearly smaller — a typo/rename/version-bump drops to haiku, a small fully
// specified one-spot fix to sonnet, deep research/modelling climbs to fable.
// Everything real (a feature, a UI change, multi-file work, debugging, design)
// stays on opus. The classifier judge itself runs on haiku (cheap), so the
// prompt is framed to make it err UPWARD when unsure, never silently downgrade.
//
// Design guarantees:
// - NEVER blocks dispatch: any failure (classifier error, timeout, unparsable
//   answer, model not available on this host) falls back to `fallback` so a
//   task is never stranded because the picker hiccuped.
// - Only picks among models the host actually advertises (the provider
//   snapshot's `models[]`); an unavailable tier degrades to the nearest one.
// - Deterministic mapping from the classifier's single-word tier to a concrete
//   model id, so the prompt stays tiny and cheap.

import { newestOfFamily, familyOf } from "../providers/claude-models";
import { EFFORT_TIERS } from "../../shared/effort";

/** Capability tiers the classifier chooses between (cheap → most capable). */
export const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Execution FLOOR. Haiku is "troppo poco potente" for real agent work (explicit
 * Attilio directive, opus-first standard), so it is NEVER an execution target:
 * it stays only the cheap classifier JUDGE. Any pick at or below this tier is
 * clamped UP to it, and haiku is stripped from the candidate set before
 * resolution so a host missing sonnet still can't degrade an agent onto haiku.
 */
export const MIN_EXECUTION_TIER: ModelTier = "sonnet";

/** Clamp a tier up to the execution floor (haiku → sonnet). */
export function floorTier(tier: ModelTier): ModelTier {
  return MODEL_TIERS.indexOf(tier) < MODEL_TIERS.indexOf(MIN_EXECUTION_TIER) ? MIN_EXECUTION_TIER : tier;
}

export type EffortTier = (typeof EFFORT_TIERS)[number];

/**
 * Pavimento dell'EFFORT, e il ragionamento e' lo stesso del pavimento sonnet.
 *
 * `medium` non e' scelto a caso: e' cio' che la board fa OGGI
 * (`board_settings.dispatch_effort`). Mettendo il pavimento li', il
 * classificatore puo' solo alzare rispetto allo stato attuale, mai abbassare —
 * quindi accendere l'auto non puo' peggiorare in silenzio nessun task. Se un
 * giorno si vorra' scendere a `low` per i task davvero minimi, sara' una
 * decisione presa guardando una misura, non un effetto collaterale.
 *
 * Vale la pena ricordare perche' l'effort conta piu' di quanto sembri: misurato
 * il 2026-08-09 sullo stesso micro-task, la stessa chat a `medium` costa 61,1k
 * token di lavoro e a `xhigh` 108,8k. L'effort e' la leva piu' pesante che
 * abbiamo, piu' dell'envelope di dispatch.
 */
export const MIN_EXECUTION_EFFORT: EffortTier = "medium";

/** Clamp an effort up to the floor (low → medium). */
export function floorEffort(effort: EffortTier): EffortTier {
  return EFFORT_TIERS.indexOf(effort) < EFFORT_TIERS.indexOf(MIN_EXECUTION_EFFORT)
    ? MIN_EXECUTION_EFFORT
    : effort;
}

/** Parse the classifier's free text into an effort tier, or null. Stessa regola
 *  di `parseTier`: vince la PRIMA parola-chiave che compare, non l'ordine della
 *  scala — una risposta prolissa non deve poter far vincere il tier sbagliato. */
export function parseEffort(raw: string): EffortTier | null {
  const t = (raw ?? "").toLowerCase();
  let best: { tier: EffortTier; at: number } | null = null;
  for (const tier of EFFORT_TIERS) {
    // `xhigh` contiene `high`: senza il confine a sinistra, "xhigh" darebbe
    // anche un match per "high" a indice+1, e la prima-posizione vincerebbe
    // comunque — ma il confine lo rende esplicito invece che fortunato.
    const m = new RegExp(`(^|[^a-z])${tier}([^a-z]|$)`).exec(t);
    if (m && (best === null || m.index < best.at)) best = { tier, at: m.index };
  }
  return best?.tier ?? null;
}

/**
 * Famiglia CLI per ogni tier. È una FAMIGLIA e non un id preciso perché un id
 * preciso invecchia da solo: qui c'era `claude-opus-4-8` scritto a mano, e ha
 * continuato a mandare ogni agente dispatchato su Opus 4.8 per tutto il tempo
 * in cui la CLI offriva già Opus 5 — nessun errore, nessun log, solo una
 * generazione indietro. La versione la decide l'host: si prende la più recente
 * fra quelle che annuncia davvero.
 */
const TIER_TO_FAMILY: Record<ModelTier, string> = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
  fable: "fable",
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
    "Sei un router di task. Il modello DI DEFAULT è opus: l'umano lavora normalmente su opus.",
    "Scendi a un modello più piccolo SOLO se il task è chiaramente più piccolo; nel dubbio scegli opus (mai declassare).",
    "Rispondi con DUE parole separate da uno spazio: prima il modello, poi lo sforzo. Nient'altro, niente punteggiatura.",
    "",
    "Modello (nel dubbio, il più capace — sonnet è il MINIMO, non esiste un modello più piccolo):",
    "- opus: DEFAULT. Qualsiasi lavoro reale — feature, modifica UI, logica, debug, più file/sistemi, design, refactor. Se non è palesemente banale, è opus.",
    "- fable: massima difficoltà/ambiguità (ricerca, modellazione dati, algoritmi non ovvi, ragionamento profondo).",
    "- sonnet: MINIMO assoluto — SOLO task piccolo e pienamente specificato in un punto solo (un fix circoscritto e ovvio, un test mirato, un ritocco isolato, un typo/rinomina/bump). Mai scendere sotto.",
    "",
    "Sforzo (quanto deve RAGIONARE prima di agire — è una leva costosa: da medium a xhigh il costo quasi raddoppia, quindi si alza solo dove serve davvero):",
    "- medium: MINIMO. La strada è già scritta nel task: si sa dove mettere le mani e cosa scrivere.",
    "- high: DEFAULT per il lavoro reale. Va deciso qualcosa — dove intervenire, come strutturarlo, quali casi coprire.",
    "- xhigh: la difficoltà è capire il problema, non risolverlo: causa non nota, vincoli in conflitto, progettazione, debug di qualcosa che si manifesta lontano dalla causa.",
    "- max: solo per l'eccezionale — un problema aperto, dove sbagliare approccio costa più che pensarci a lungo.",
    "",
    `Titolo: ${title}`,
    description ? `Descrizione: ${description}` : "",
    "",
    "Risposta (due parole, es. «opus high»):",
  ]
    .filter(Boolean)
    .join("\n");

/** Parse the classifier's free text into a tier, or null if unrecognisable. */
export function parseTier(raw: string): ModelTier | null {
  const t = (raw ?? "").toLowerCase();
  // Well-formed answer (the single tier word, possibly after whitespace) wins
  // outright — this is what the prompt asks for.
  const exact = t.match(/^\s*(haiku|sonnet|opus|fable)\b/);
  if (exact) return exact[1] as ModelTier;
  // Otherwise: the EARLIEST tier keyword in the text wins. Scanning tiers in
  // MODEL_TIERS order instead (the old behavior) made "haiku" win whenever it
  // appeared ANYWHERE — a verbose answer ("non è haiku, è opus") or an error
  // string carrying a model id ("claude-haiku-4-5 …") routed every real task
  // to haiku. The model states its pick first, so first-position is the pick.
  let best: { tier: ModelTier; at: number } | null = null;
  for (const tier of MODEL_TIERS) {
    const m = new RegExp(`(^|[^a-z])${tier}([^a-z]|$)`).exec(t);
    if (m && (best === null || m.index < best.at)) best = { tier, at: m.index };
  }
  return best?.tier ?? null;
}

/**
 * Resolve a tier to a concrete AVAILABLE model id. Exact match wins; otherwise
 * step DOWN the capability ladder to the nearest available tier (a host missing
 * `fable` serves `opus` for a fable pick, never something weaker than asked
 * when a stronger one is also gone — we search down then up). Returns null when
 * nothing maps (caller uses its fallback).
 */
export function tierToAvailableModel(tier: ModelTier, available: readonly string[]): string | null {
  // `preferLong`: un agente dispatchato lavora su un repo vero e legge file veri
  // — la finestra da 200k di un id nudo la esaurisce e lo manda in compattazione
  // a metà task. Dove l'host serve il milione, lo si prende (`longVariantOf`
  // lascia stare le famiglie che non lo reggono).
  const pick = (t: ModelTier | undefined) =>
    t ? newestOfFamily(TIER_TO_FAMILY[t], available, { preferLong: true }) : null;
  const want = pick(tier);
  if (want) return want;
  const idx = MODEL_TIERS.indexOf(tier);
  // Prefer the nearest LOWER tier (cheaper, safer), then fall upward.
  for (let d = 1; d < MODEL_TIERS.length; d++) {
    const lowerId = pick(MODEL_TIERS[idx - d]);
    if (lowerId) return lowerId;
    const higherId = pick(MODEL_TIERS[idx + d]);
    if (higherId) return higherId;
  }
  return null;
}

/**
 * Il piano di esecuzione di un task: quale modello, e quanto deve ragionare.
 *
 * `effort: null` significa «non lo so», NON «medium»: il chiamante ricade sulla
 * configurazione della board. Distinguere le due cose e' l'unico modo per
 * accorgersi che il classificatore sta fallendo — un `medium` scritto al posto
 * di un `null` renderebbe un guasto indistinguibile da una scelta.
 */
export interface TaskPlan {
  model: string;
  effort: EffortTier | null;
}

/**
 * Pick a model id AND an effort tier for a task. Never throws — returns
 * `fallback` on any problem (a picker hiccup must never strand or misroute a
 * dispatch).
 */
export async function pickTaskPlan(
  task: { text: string; description?: string | null },
  deps: PickModelDeps,
): Promise<TaskPlan> {
  try {
    const title = (task.text ?? "").slice(0, 300);
    const description = (task.description ?? "").slice(0, 1200);
    const raw = (await deps.complete(CLASSIFIER_PROMPT(title, description))) ?? "";
    const rawTier = parseTier(raw);
    if (!rawTier) {
      deps.log?.(`model-picker: unparsable answer ${JSON.stringify(raw.slice(0, 60))} → fallback`);
      return { model: deps.fallback, effort: null };
    }
    // Clamp to the execution floor (haiku → sonnet) and strip haiku from the
    // candidate set, so neither a haiku pick NOR a walk-down on a host missing
    // sonnet can ever land an agent on haiku.
    const tier = floorTier(rawTier);
    const execAvailable = deps.availableModels.filter((m) => familyOf(m) !== TIER_TO_FAMILY.haiku);
    const model = tierToAvailableModel(tier, execAvailable);
    if (!model) {
      deps.log?.(`model-picker: tier ${tier} has no available model → fallback`);
      return { model: deps.fallback, effort: null };
    }
    // L'effort si legge DOPO il modello: la prima parola e' il tier, quindi si
    // cerca lo sforzo in cio' che resta. Cercarlo nell'intera risposta farebbe
    // vincere un tier di modello che porta lo stesso nome (non ce ne sono oggi,
    // ma il prompt puo' cambiare e questo non deve diventare un indovinello).
    const afterModel = raw.slice(raw.toLowerCase().indexOf(rawTier) + rawTier.length);
    const rawEffort = parseEffort(afterModel);
    const effort = rawEffort ? floorEffort(rawEffort) : null;
    // Always log the raw answer: a misroute must be diagnosable from the log
    // alone (the parsed tier hides whether the judge really said that).
    const clamped = tier !== rawTier ? ` (floor da ${rawTier})` : "";
    const effortNote = rawEffort
      ? ` · effort ${effort}${effort !== rawEffort ? ` (floor da ${rawEffort})` : ""}`
      : " · effort non letto → resta quello della board";
    deps.log?.(`model-picker: ${tier}${clamped} → ${model}${effortNote} — raw ${JSON.stringify(raw.slice(0, 60))}`);
    return { model, effort };
  } catch (err) {
    deps.log?.(`model-picker: failed (${err instanceof Error ? err.message : String(err)}) → fallback`);
    return { model: deps.fallback, effort: null };
  }
}
