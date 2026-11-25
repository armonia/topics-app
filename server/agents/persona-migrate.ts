/**
 * One-time migration: the principal agent's `SOUL.md` used to carry both the
 * generic base (now `server/agents/base/SOUL.md`) and the user's always-valid
 * directives (now the rules layer, `<home>/RULES.md`). This splits the two out
 * of that file.
 *
 * Classifying the agent's current `SOUL.md` into "generic" (drop — it now
 * lives in the shipped base), "directives" (move to `RULES.md`) and
 * "agent-specific" (keep — e.g. permissions naming people) is a judgment
 * call on real prose, made once by whoever runs this against the real
 * `jarvis-channels` home. `migratePrincipalSoul` only does the mechanical
 * part once that split is decided: backup both files (dated, via
 * `safeWrite`), append the directives to `RULES.md`, and replace the agent's
 * `SOUL.md` with just its own additions.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { safeWrite } from "./config-files";
import type { Paths } from "../routes/agent-config";

export interface PersonaSplit {
  /** What moves to the user layer — the directives that apply to every agent. */
  directives: string;
  /** What stays as this agent's own addition (e.g. permissions naming people). */
  agentAdditions: string;
}

export interface MigrationResult {
  userFile: string;
  userBackup: string | null;
  soulFile: string;
  soulBackup: string | null;
}

/** Appends to an existing `RULES.md` rather than overwriting it: a second
 *  agent migrated later must not erase the first agent's directives. */
function appendedUser(home: string, directives: string): string {
  const file = join(home, "RULES.md");
  const existing = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!directives.trim()) return existing;
  return existing ? `${existing}\n\n${directives.trim()}` : directives.trim();
}

export function migratePrincipalSoul(paths: Paths, workspace: string, split: PersonaSplit): MigrationResult {
  const userFile = join(paths.home, "RULES.md");
  const soulFile = join(workspace, "SOUL.md");

  const userBackup = safeWrite(userFile, `${appendedUser(paths.home, split.directives)}\n`, paths.home);
  const soulBackup = safeWrite(soulFile, `${split.agentAdditions.trim()}\n`, paths.home);

  return { userFile, userBackup, soulFile, soulBackup };
}
