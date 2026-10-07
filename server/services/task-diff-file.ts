/**
 * ONE FILE of a diff the board shows: its patch, or its bytes at one of the two
 * revisions the diff compares.
 *
 * Both routes that draw a diff panel answer through here: a card's delivery
 * (`/boards/:p/tasks/:t/diff`, with or without `?attempt=`) and a publish
 * (`/boards/:p/publish-diff`). The route resolves WHERE to read (the card's
 * worktree, the project checkout after the land, the publish range); this
 * module decides WHAT a query string may read there.
 *
 * WHY THE BYTES DO NOT GO THROUGH `/api/git/show`. That route reads with
 * `.text()` and answers `text/plain`, so a PNG arrives corrupted; its `cwd`
 * comes from the client, while the right checkout for a card is known only to
 * the server; and the After of a live worktree is the working tree, which
 * `git show` cannot read.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isInsideDir } from "../lib/path-containment";
import { previewTypeOf } from "../../shared/preview-kind";
import { defaultRunGit, type GitRunner } from "./own-commits";
import { revsOfRange } from "./task-diff-range";
import { SPAWN_TIMEOUT, spawnBounded } from "../lib/bounded-spawn";

/**
 * Per-file cap for `?file=`. Far above the bundle's: this is ONE file someone
 * asked for by name, and the client already folds a long file at 600 lines.
 * It stays a cap because a generated lockfile can still be tens of MB.
 */
const DIFF_FILE_PATCH_CAP = 2_000_000;

/**
 * Patch headers with a path's own letters, not git's quoted octal
 * (`"a/docs/citt\303\240.md"`): the drawer splits a patch on `diff --git a/… b/…`
 * and matches it to the stat, which `-z` already gives unquoted.
 */
export const UNQUOTED_PATHS = ["-c", "core.quotePath=false"];

/** Bytes above this are refused with `413` before anything is read. */
export const DIFF_BLOB_CAP = 10 * 1024 * 1024;

/** Where a diff is read: the checkout, the `git diff` selector, and whether the After is the working tree. */
export interface DiffFileTarget {
  cwd: string;
  range: string;
  live: boolean;
}

/**
 * `path` comes from a query string, so it is held to what the bundle could
 * have listed: relative, no `..`, no NUL.
 */
function isListablePath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes("..") && !path.includes("\0");
}

/**
 * The patch of ONE file in `range`, for the files the bundle left out, and with
 * `fullContext` the whole file as context ("Full file" in the panel).
 *
 * The bundle stops at its payload cap and the files past it arrived as a name
 * and a count with no way to read them (task 7657f201: 30 of 74). This is the
 * way: same range, one path.
 *
 * The path is matched LITERALLY (`--literal-pathspecs`, or `:(glob)*` would be
 * a whole-repo diff). An untracked file is diffed against /dev/null only if git
 * itself lists it as untracked: `--no-index` reads any path it is given,
 * including outside the repository.
 *
 * Full context keeps the line numbers of the plain diff, so a review note
 * anchored on (path, line, side) lands on the same row in both views.
 *
 * `origPath` is where a renamed or copied file came from (the bundle's
 * `origPath`). Git pairs a rename only among the paths it is shown: with the
 * new path alone the file is "new", every line added and no old side, while
 * the bundle drew one changed line.
 */
export async function gitDiffFilePatch(
  cwd: string,
  range: string,
  path: string,
  gopts?: { includeUntracked?: boolean; fullContext?: boolean; origPath?: string | null; runGit?: GitRunner },
): Promise<{ path: string; patch: string; truncated: boolean } | null> {
  const orig = gopts?.origPath;
  if (!isListablePath(path) || (orig != null && !isListablePath(orig))) return null;
  const run = gopts?.runGit ?? defaultRunGit;
  const context = gopts?.fullContext ? ["-U100000"] : [];
  const paths = orig ? [orig, path] : [path];
  let patch = (await run(cwd, [...UNQUOTED_PATHS, "--literal-pathspecs", "diff", ...context, range, "--", ...paths])).stdout;
  if (!patch && gopts?.includeUntracked) {
    const others = (await run(cwd, ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", path])).stdout;
    if (others.split("\0").includes(path)) {
      patch = (await run(cwd, [...UNQUOTED_PATHS, "diff", "--no-index", "--", "/dev/null", path])).stdout;
    }
  }
  const truncated = patch.length > DIFF_FILE_PATCH_CAP;
  return { path, patch: truncated ? patch.slice(0, DIFF_FILE_PATCH_CAP) : patch, truncated };
}

function refuse(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ code, ...extra }, { status });
}

/**
 * The bytes of `path` at `blob`, streamed, for the panel's picture and
 * rendered page.
 *
 * `blob` is accepted only when it is one of the two revisions of the range as
 * resolved NOW (`409 stale_rev` otherwise, and the client re-reads the bundle):
 * if the card landed between the list and the click, the bytes shown are still
 * those of the commits the list names. `worktree` only on a live range, and
 * there the file is read from disk only when its REAL path is inside the
 * worktree's real path: a symlink pointing out is a `404`.
 *
 * `target: null` = the route could not resolve a range at all, which for the
 * client is the same news as a stale revision.
 */
export async function serveDiffBlob(
  target: DiffFileTarget | null,
  path: string,
  blob: string,
  opts?: { runGit?: GitRunner },
): Promise<Response> {
  if (!target) return refuse(409, "stale_rev", { revs: null });
  if (!isListablePath(path)) return refuse(400, "invalid_input");
  const type = previewTypeOf(path);
  if (!type) return refuse(415, "unsupported_type");

  const run = opts?.runGit ?? defaultRunGit;
  const revs = await revsOfRange(run, target.cwd, target.range, target.live);
  const allowed = blob === "worktree"
    ? target.live && !!revs && revs.head === null
    : !!revs && (blob === revs.base || blob === revs.head);
  if (!allowed) return refuse(409, "stale_rev", { revs });

  const headers: Record<string, string> = {
    "Content-Type": type.mime,
    "X-Content-Type-Options": "nosniff",
    // An SVG opened on its own is a document that can run script: here it is
    // an inert picture. Harmless on the raster types, so it goes on every reply.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    // A SHA addresses content, so its bytes never change; the working tree does.
    "Cache-Control": blob === "worktree" ? "no-store" : "private, max-age=31536000, immutable",
  };

  if (blob === "worktree") {
    let real: string;
    let size: number;
    try {
      real = realpathSync(join(target.cwd, path));
      if (!isInsideDir(real, realpathSync(target.cwd))) return refuse(404, "not_found");
      const st = statSync(real);
      if (!st.isFile()) return refuse(404, "not_found");
      size = st.size;
    } catch {
      return refuse(404, "not_found");
    }
    if (size > DIFF_BLOB_CAP) return refuse(413, "too_large", { size });
    return new Response(Bun.file(real), { headers: { ...headers, "Content-Length": String(size) } });
  }

  const spec = `${blob}:${path}`;
  // Not at that revision (an added file's Before, a deleted file's After, a
  // path inside the empty tree): the client shows only the side that exists.
  const sized = await run(target.cwd, ["cat-file", "-s", spec]);
  const size = Number.parseInt(sized.stdout.trim(), 10);
  if (sized.code !== 0 || !Number.isFinite(size)) return refuse(404, "not_found");
  if (size > DIFF_BLOB_CAP) return refuse(413, "too_large", { size });
  // Streamed straight from git's stdout: never `.text()`, never a whole buffer
  // held on the server's loop.
  const proc = spawnBounded(["git", "-C", target.cwd, "cat-file", "blob", spec], { stdout: "pipe", stderr: "ignore", timeoutMs: SPAWN_TIMEOUT.query });
  return new Response(proc.stdout, { headers: { ...headers, "Content-Length": String(size) } });
}
