/**
 * Where the hook script lives on disk, and how it gets there.
 *
 * Next to the token, under Topics' OWN home: `${TOPICS_HOME}/claude-hooks/`.
 * It used to be a copy in `~/.claude/topics-hooks/`, made by the installer —
 * meaning the hooks only worked for whoever had installed them globally, and
 * then fired in every Claude session of the machine. Now the server writes it at
 * boot and hands it to its own spawns through `--settings` (`topics-hooks.ts`).
 *
 * The text is EMBEDDED (`with { type: "text" }`): the `bun build --compile`
 * sidecar has no `scripts/` dir to read it from. `scripts/claude-hooks/post-hook.sh`
 * stays the source.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { topicsHome } from "../services/daemon-state";
import { writeFileAtomic } from "./atomic-write";
import POST_HOOK_SCRIPT from "../../scripts/claude-hooks/post-hook.sh" with { type: "text" };

export function hookScriptPath(home: string = topicsHome()): string {
  return join(home, "claude-hooks", "post-hook.sh");
}

/**
 * Write `content` at `path`, mode 0755, only when what is there differs (text
 * or mode). Returns whether it wrote. Throws on a disk error: the caller decides
 * how loud to be.
 */
export function writeHookScript(path: string, content: string = POST_HOOK_SCRIPT): boolean {
  let same = false;
  try {
    same = readFileSync(path, "utf-8") === content && (statSync(path).mode & 0o777) === 0o755;
  } catch {
    // Missing or unreadable: write it.
  }
  if (same) return false;
  mkdirSync(dirname(path), { recursive: true });
  // Temp + rename, mode set on the temp: the live sessions run this file on
  // every hook, and a plain write truncates it first. A hook starting in that
  // window would run an empty or half-written script.
  writeFileAtomic(path, content, { mode: 0o755 });
  return true;
}
