import { homedir } from "os";

/**
 * `~/bin/codex` is what a person types; `existsSync` does not expand it.
 * Trims the input, expands a leading `~`, `~/` or `~\` to the home directory
 * and leaves everything else as it is. The one definition, so the route that
 * validates a path and the code that later uses it expand it the same way.
 */
export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return homedir() + trimmed.slice(1);
  }
  return trimmed;
}
