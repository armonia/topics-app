import { taskModelSelection, taskExecutionOptions } from "../../shared/task-coding-models";
import type { ProvidersSnapshot } from "../../shared/types";
import { claudeModelGenerations } from "../providers/claude-models";

/** Whether a requested task model occurs in a coding provider catalog and is current. */
export function taskModelIsCurrent(value: unknown, snapshot: ProvidersSnapshot | null): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;

  const raw = value.trim();
  if (!raw || raw === "auto") return true;

  const selection = taskModelSelection(raw);
  const catalogs = taskExecutionOptions(snapshot).map(({ name, models }) => ({ name, models }));
  for (const entry of snapshot?.providers ?? []) {
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
