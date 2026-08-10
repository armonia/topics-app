// Auto model selection for dispatched tasks.
//
// La stessa chiamata decide DUE cose, e non è un risparmio di token: il giudice
// legge il task una volta sola, quindi il modello e il peso escono da un'unica
// lettura coerente invece che da due letture libere di contraddirsi. Il peso
// (`light`/`heavy`) è quella che non riguarda l'agente ma la MACCHINA — vedi
// `TASK_WEIGHTS` in shared/board.ts — ed è ciò su cui lo scheduler decide se un
// task può partire accanto ad altri.
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
import { TASK_WEIGHTS, type TaskWeight } from "../../shared/board";

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
    "Rispondi con DUE parole separate da uno spazio: prima il modello, poi il peso. Nient'altro, niente punteggiatura.",
    "",
    "Modello (nel dubbio, il più capace — sonnet è il MINIMO, non esiste un modello più piccolo):",
    "- opus: DEFAULT. Qualsiasi lavoro reale — feature, modifica UI, logica, debug, più file/sistemi, design, refactor. Se non è palesemente banale, è opus.",
    "- fable: massima difficoltà/ambiguità (ricerca, modellazione dati, algoritmi non ovvi, ragionamento profondo).",
    "- sonnet: MINIMO assoluto — SOLO task piccolo e pienamente specificato in un punto solo (un fix circoscritto e ovvio, un test mirato, un ritocco isolato, un typo/rinomina/bump). Mai scendere sotto.",
    "",
    "Peso (quanto il task MORDE LA MACCHINA mentre gira — non quanto è difficile: un algoritmo ambiguo non consuma niente, una build sì):",
    "- light: DEFAULT, quasi tutto. Leggere e scrivere file, un test mirato, comandi brevi, ragionare.",
    "- heavy: il lavoro passa per forza da una macinata lunga che occupa la macchina — compilare/buildare il progetto, la suite di test intera, installare dipendenze, indicizzare, benchmark, encoding video. Nel dubbio light.",
    "",
    `Titolo: ${title}`,
    description ? `Descrizione: ${description}` : "",
    "",
    "Risposta (due parole, es. «opus light»):",
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
 * Parse the classifier's free text into a weight, or null when it didn't say.
 *
 * Stessa regola di `parseTier`: vince la PRIMA parola-chiave che compare, con i
 * confini di parola — così «lightweight» non è un `light`, e una risposta
 * prolissa («direi light, non heavy») consegna quello che il giudice ha scelto
 * per primo invece dell'ultimo che ha nominato.
 *
 * Il peso NON è messo ai voti come lo è (altrove) il modello: è una domanda
 * binaria e concreta — «questo lavoro passa da una macinata lunga?» — dove il
 * giudice non balla come sulle sfumature di un tier. E il costo di sbagliare è
 * asimmetrico nella direzione giusta: `null` e ogni risposta illeggibile valgono
 * `light`, cioè lo scheduler si comporta come prima.
 */
export function parseWeight(raw: string): TaskWeight | null {
  const t = (raw ?? "").toLowerCase();
  let best: { weight: TaskWeight; at: number } | null = null;
  for (const w of TASK_WEIGHTS) {
    const m = new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).exec(t);
    if (m && (best === null || m.index < best.at)) best = { weight: w, at: m.index };
  }
  return best?.weight ?? null;
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
 * Il piano di esecuzione di un task: su quale modello gira, e quanto morde la
 * macchina mentre gira.
 *
 * `weight: null` significa «non lo so», NON `light` scritto di nascosto: chi
 * legge tratta il null come leggero — cioè come si comportava il dispatcher
 * prima che il peso esistesse — ma resta distinguibile un giudice muto da un
 * giudice che ha detto «leggero». È l'unico modo per accorgersi che il
 * classificatore ha smesso di rispondere.
 */
export interface TaskPlan {
  model: string;
  weight: TaskWeight | null;
}

/**
 * Pick a model id AND a weight for a task. Never throws — returns `fallback` on
 * any problem (a picker hiccup must never strand or misroute a dispatch), e in
 * quel caso il peso è `null`, cioè leggero: un giudice caduto non deve poter
 * fermare la coda della board.
 */
export async function pickTaskModel(
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
      return { model: deps.fallback, weight: null };
    }
    // Il peso si cerca DOPO il modello: la prima parola è il tier, quindi si
    // legge ciò che resta. Cercarlo nell'intera risposta farebbe vincere un tier
    // che portasse lo stesso nome (non ce n'è oggi, ma il prompt può cambiare e
    // questo non deve diventare un indovinello).
    const weight = parseWeight(raw.slice(raw.toLowerCase().indexOf(rawTier) + rawTier.length));
    // Clamp to the execution floor (haiku → sonnet) and strip haiku from the
    // candidate set, so neither a haiku pick NOR a walk-down on a host missing
    // sonnet can ever land an agent on haiku.
    const tier = floorTier(rawTier);
    const execAvailable = deps.availableModels.filter((m) => familyOf(m) !== TIER_TO_FAMILY.haiku);
    const model = tierToAvailableModel(tier, execAvailable);
    if (!model) {
      deps.log?.(`model-picker: tier ${tier} has no available model → fallback`);
      return { model: deps.fallback, weight: null };
    }
    // Always log the raw answer: a misroute must be diagnosable from the log
    // alone (the parsed tier hides whether the judge really said that).
    const clamped = tier !== rawTier ? ` (floor da ${rawTier})` : "";
    const weightNote = weight ? ` · peso ${weight}` : " · peso non letto → light";
    deps.log?.(`model-picker: ${tier}${clamped} → ${model}${weightNote} — raw ${JSON.stringify(raw.slice(0, 60))}`);
    return { model, weight };
  } catch (err) {
    deps.log?.(`model-picker: failed (${err instanceof Error ? err.message : String(err)}) → fallback`);
    return { model: deps.fallback, weight: null };
  }
}
