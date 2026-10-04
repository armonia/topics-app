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
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { topicsHome } from "../services/daemon-state";
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
  writeFileSync(path, content, { mode: 0o755 });
  // writeFileSync's `mode` applies only on CREATION: a file that was already
  // there keeps its old permissions.
  chmodSync(path, 0o755);
  return true;
}
