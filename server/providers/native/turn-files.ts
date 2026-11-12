/**
 * The files THIS turn created in its workspace.
 *
 * WHY. The native guard refuses a recursive or forced `rm` outside the temp
 * folders. A channel turn that writes `launch.sh` with a heredoc and removes it
 * at the end was refused all the same: the guard could not tell its own file
 * from the user's. The registry tells them apart, so the turn may remove what
 * it made and nothing it found.
 *
 * PRECISE BEFORE COMPLETE. A path is registered only when it did NOT exist
 * before the tool ran, DOES exist after, and sits inside the workspace (also
 * once symlinks are resolved). A file the turn overwrote, appended to, edited or
 * only listed was there first and is never registered. The cost is recall: the
 * forms read are `write_file`, `>`, `tee`, `touch`, `mkdir` and `cp`; a file
 * made by a script the turn ran is not registered, and removing it is refused
 * like any other file the guard cannot vouch for.
 *
 * PER TURN. One registry per `runAgentTurn`: a file made in an earlier turn is
 * somebody else's work by the time it is removed.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expandHome } from "../../lib/expand-home";
import { callCwd, pathExists, segmentCreations, walkShell } from "./shell-walk";

export interface TurnFiles {
  /** True when `abs` is a path the turn created, or sits inside a directory it created. */
  has(abs: string): boolean;
  /**
   * Call BEFORE a tool runs; call the function it returns AFTER. Tools other
   * than `write_file` and `bash` create nothing the registry can vouch for.
   */
  watch(tool: string, input: Record<string, unknown>): () => void;
}

const NOTHING = () => {};
const INERT: TurnFiles = { has: () => false, watch: () => NOTHING };

/** True when `abs` is `root` or sits inside it. */
export function isWithin(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

/**
 * If `abs` is inside `workspace` and does not exist yet, the highest folder the
 * tool will have to create to make it (`mkdir -p a/b/c` makes `a`); otherwise null.
 */
export function topmostNew(abs: string, workspace: string): string | null {
  const ws = resolve(workspace);
  const inside = (p: string) => {
    const rel = relative(ws, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(abs) || pathExists(abs)) return null;
  let top = abs;
  while (inside(dirname(top)) && !pathExists(dirname(top))) top = dirname(top);
  return top;
}

/** Absolute paths a command creates, as far as its text says so. Existence is checked by the caller. */
function creationTargets(command: string, startCwd: string): string[] {
  const out: string[] = [];
  walkShell(command, startCwd, (seg) => out.push(...segmentCreations(seg)));
  return out;
}

export function createTurnFiles(workspace: string): TurnFiles {
  if (!workspace) return INERT;
  const ws = resolve(workspace);
  const made = new Set<string>();

  /** The parent folder, with symlinks resolved, is still inside the workspace. */
  const reallyInside = (abs: string): boolean => {
    try {
      const rel = relative(realpathSync(ws), realpathSync(dirname(abs)));
      return !rel.startsWith("..") && !isAbsolute(rel);
    } catch {
      return false;
    }
  };

  return {
    has(abs) {
      const p = resolve(abs);
      for (const m of made) if (isWithin(p, m)) return true;
      return false;
    },

    watch(tool, input) {
      let targets: string[];
      if (tool === "write_file") {
        targets = [resolve(ws, expandHome(String(input.path ?? "")))];
      } else if (tool === "bash") {
        targets = creationTargets(String(input.command ?? ""), callCwd(input, ws) ?? ws);
      } else {
        return NOTHING;
      }
      const fresh = [...new Set(targets)].flatMap((t) => {
        const top = topmostNew(t, ws);
        return top ? [{ path: t, top }] : [];
      });
      if (fresh.length === 0) return NOTHING;
      return () => {
        for (const f of fresh) if (pathExists(f.path) && reallyInside(f.path)) made.add(f.top);
      };
    },
  };
}
