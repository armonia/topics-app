import { taskModelSelection, taskExecutionOptions } from "../../shared/task-coding-models";
import type { ProvidersSnapshot } from "../../shared/types";
import { claudeModelGenerations } from "../providers/claude-models";
import { MODEL_TIERS } from "./task-model-picker";

/** The 400 a card gets when its model is stale or unknown (MP-TASK-03). */
export const STALE_TASK_MODEL_ERROR = {
  error: "Il modello scelto non è nel catalogo attuale o appartiene a una generazione superata.",
  code: "invalid_task_model",
} as const;

/**
 * Whether a requested task model is NOT known to be retired: it occurs in the
 * catalog of its coding provider and, for Claude, belongs to the newest
 * generation of its family. Auto and an empty choice always pass.
 *
 * A verdict needs a catalog that lists something. Without a snapshot
 * (providers not probed yet), with the provider still loading, absent from this
 * machine (Codex not installed) or listing no model, there is nothing to judge
 * against, so the choice passes and the dispatcher reports the missing runtime
 * when it starts: refusing every explicit model on those machines would be
 * worse than the stale one. A family alias (`opus`) names no generation: the
 * CLI resolves it to its newest, so it can never be a retired one.
 */
export function taskModelIsCurrent(value: unknown, snapshot: ProvidersSnapshot | null): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;

  const raw = value.trim();
  if (!raw || raw === "auto") return true;
  if (!snapshot) return true;

  const selection = taskModelSelection(raw);
  if (selection.model && (MODEL_TIERS as readonly string[]).includes(selection.model.replace(/\[1m\]$/, ""))) return true;
  const catalogs = taskExecutionOptions(snapshot).map(({ name, models }) => ({ name, models }));
  // Topics native is the routing switch, not a menu row, but it still executes cards.
  for (const entry of snapshot.providers) {
    if (entry.name === "topics") catalogs.push({ name: entry.name, models: entry.models });
  }
  const listedModels = catalogs.flatMap(({ models }) => models);
  const generations = claudeModelGenerations(listedModels);

  // A bare runtime (`codex`, `muse:auto`) names no model, so nothing can be stale.
  if (!selection.model) return true;
  // A retired Claude id stays retired under any runtime prefix, listed or not:
  // it is judged against the newest of its family that any catalog lists, after
  // the spellings a person can type (`codex: claude-sonnet-4-6[1m]`, a date suffix,
  // upper case) are reduced to the plain id.
  if (isRetiredClaudeId(selection.model, listedModels)) return false;

  const eligible = catalogs.filter(({ name }) => !selection.provider || name === selection.provider);

  const listed = eligible.filter(({ models }) => models.length > 0);
  if (listed.length === 0) return true;
  return listed.some(({ models }) => {
    if (!models.includes(selection.model!)) return false;
    if (!selection.model!.startsWith("claude-")) return true;
    return generations[selection.model!]?.generation === "current";
  });
}

/** Whether a Claude id is an older generation than the newest of its family that `listed` knows. */
function isRetiredClaudeId(model: string, listed: string[]): boolean {
  const claudeId = model.trim().toLowerCase().replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
  return claudeId.startsWith("claude-") && claudeModelGenerations([...listed, claudeId])[claudeId]?.generation === "older";
}

/** Where a router reads its model facts from: its own runnable list and the provider catalogs. */
export interface TaskModelSources {
  taskModels?: () => string[];
  taskModelSnapshot?: () => ProvidersSnapshot | null;
}

/**
 * Whether the model of a mirrored card is refused here; lives in the service so
 * the route is a single line (nodes.ts sits at the bloat ceiling).
 *
 * The origin already judged the model against its own catalog, and this node's
 * CLI may know a newer one than the catalog it probed: absence from the local
 * list is therefore not a verdict. Only a model this node can prove retired
 * (an older generation than one it lists) is refused.
 */
export function isStaleMirroredModel(model: unknown, sources: TaskModelSources, fallback: () => ProvidersSnapshot | null): boolean {
  if (typeof model !== "string" || !model || sources.taskModels?.().includes(model)) return false;
  const selection = taskModelSelection(model.trim());
  if (!selection.model) return false;
  const snapshot = sources.taskModelSnapshot?.() ?? fallback();
  if (!snapshot) return false;
  const listed = [...taskExecutionOptions(snapshot).flatMap(({ models }) => models), ...snapshot.providers.flatMap((entry) => entry.models)];
  return isRetiredClaudeId(selection.model, listed);
}

/**
 * Whether PATCHing a card onto `next` is refused; one line in the route. Only a
 * CHANGED model is judged: a card already on an older model can still be
 * edited, it just cannot be moved onto another stale one.
 */
export function isStaleModelChange(next: unknown, current: () => string | null | undefined, sources: TaskModelSources = {}): boolean {
  if (next === undefined) return false;
  if (String(next ?? "").trim() === (current() ?? "").trim()) return false;
  return !taskModelIsCurrent(next, sources.taskModelSnapshot?.() ?? null);
}
