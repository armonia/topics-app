/**
 * Validation of the «worktree root» setting, shared by the PUT route (which
 * refuses a bad value) and the resolver (which ignores one written by hand).
 *
 * A root must be an absolute folder that is neither the system temp area nor
 * inside it: `/tmp` is cleaned by the OS under live checkouts, and one agent
 * tool filled 202 GB there unseen. Inside a repository is refused by the
 * caller that knows the projects, not here.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** System temp areas a root may not live in. Fixed list, no env: a root is a durable place. */
const TEMP_AREAS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];

/**
 * The canonical form of a typed root: `~` expanded, made absolute, no trailing
 * slash. Null when it is empty, relative, or inside a temp area.
 */
export function normalizeWorktreeRoot(raw: string, home: string = homedir()): string | null {
  let value = raw.trim();
  if (value === "") return null;
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = join(home, value.slice(2));
  if (!isAbsolute(value)) return null;
  const abs = resolve(value);
  for (const temp of TEMP_AREAS) {
    if (abs === temp || abs.startsWith(temp + sep)) return null;
  }
  return abs;
}
