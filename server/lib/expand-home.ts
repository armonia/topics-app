/**
 * `~`, `~/x` and `~\x` expanded to the home directory, the input trimmed.
 * What a person types in a settings field; nothing in `node:fs` expands it.
 * One copy: four existed and disagreed on `~\`, on trimming and on whether
 * `$HOME` wins over `os.homedir()`.
 *
 * `home` defaults to `os.homedir()`; a caller that must follow `$HOME` (it
 * resolves paths the way another tool does) passes it.
 */
import { homedir } from "os";

export function expandHome(input: string, home: string = homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return home + trimmed.slice(1);
  return trimmed;
}
