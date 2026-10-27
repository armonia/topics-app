import { taskModelSelection, taskExecutionOptions } from "../../shared/task-coding-models";
import type { ProvidersSnapshot } from "../../shared/types";
import { claudeModelGenerations } from "../providers/claude-models";

/** The 400 a card gets when its model is stale or unknown (MP-TASK-03). */
export const STALE_TASK_MODEL_ERROR = {
  error: "Il modello scelto non è nel catalogo attuale o appartiene a una generazione superata.",
  code: "invalid_task_model",
} as const;

/**
 * Whether a requested task model occurs in a coding provider catalog and, for
 * Claude, belongs to the newest generation of its family. Auto and an empty
 * choice always pass. Without a snapshot (providers not probed yet, tests that
 * inject none) there is nothing to judge against, so the choice passes too:
 * refusing every explicit model at startup would be worse than the stale one.
 */
export function taskModelIsCurrent(value: unknown, snapshot: ProvidersSnapshot | null): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;

  const raw = value.trim();
  if (!raw || raw === "auto") return true;
  if (!snapshot) return true;

  const selection = taskModelSelection(raw);
  const catalogs = taskExecutionOptions(snapshot).map(({ name, models }) => ({ name, models }));
  // Topics native is the routing switch, not a menu row, but it still executes cards.
  for (const entry of snapshot.providers) {
    if (entry.name === "topics") catalogs.push({ name: entry.name, models: entry.models });
  }
  const generations = claudeModelGenerations(catalogs.flatMap(({ models }) => models));

  const eligible = catalogs.filter(({ name }) => !selection.provider || name === selection.provider);
  if (!selection.model) return eligible.length > 0;

  return eligible.some(({ models }) => {
    if (!models.includes(selection.model!)) return false;
    if (!selection.model!.startsWith("claude-")) return true;
    return generations[selection.model!]?.generation === "current";
  });
}

/** Where a router reads its model facts from: its own runnable list and the provider catalogs. */
export interface TaskModelSources {
  taskModels?: () => string[];
  taskModelSnapshot?: () => ProvidersSnapshot | null;
}

/**
 * Whether the model of a mirrored card is refused here; lives in the service so
 * the route is a single line (nodes.ts sits at the bloat ceiling).
 * A model this node runs (`taskModels`) is current here by definition.
 */
export function isStaleMirroredModel(model: unknown, sources: TaskModelSources, fallback: () => ProvidersSnapshot | null): boolean {
  if (typeof model !== "string" || !model || sources.taskModels?.().includes(model)) return false;
  return !taskModelIsCurrent(model, sources.taskModelSnapshot?.() ?? fallback());
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
