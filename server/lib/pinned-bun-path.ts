import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Where scripts/install-bun.sh puts a pinned Bun: `<root>/<version>/bun`.
 * `root` is injectable so tests never touch the real home.
 */
function pinnedBunRoot(): string {
  return join(homedir(), ".topics", "bun");
}

export interface PinnedBunPath {
  /** PATH to give the child, or undefined when it must keep the server's own. */
  path?: string;
  /** One log line when the repo pins a version that is not installed. */
  note?: string;
}

/**
 * A check that runs inside a repo with `.bun-version` must see that Bun first,
 * as the CI does, even though the server's PATH puts the shared global Bun
 * first (it serves every other project and stays as it is). Without the file
 * or without the binary nothing changes.
 */
export function pinnedBunPath(cwd: string, basePath: string | undefined, root: string = pinnedBunRoot()): PinnedBunPath {
  let want = "";
  try {
    want = readFileSync(join(cwd, ".bun-version"), "utf8").trim();
  } catch {
    return {};
  }
  if (!want || /[\\/]/.test(want)) return {};
  const dir = join(root, want);
  if (!existsSync(join(dir, "bun"))) {
    return { note: `[pinned-bun] Bun ${want} is pinned in ${cwd} but not installed in ${root}: checks run the PATH Bun` };
  }
  return { path: basePath ? `${dir}${delimiter}${basePath}` : dir };
}
