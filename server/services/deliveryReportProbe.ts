/**
 * The repository, seen by the delivery-report checks.
 *
 * Split from `deliveryReportChecks.ts` on purpose: that module is pure and its
 * bench runs in milliseconds against injected data. This one shells out to git,
 * and pure/impure is the seam that keeps the checks testable.
 *
 * EVERY CALL IS BEST-EFFORT. A probe that throws must never reach the caller:
 * these checks ANNOTATE a delivery, they do not gate it, so a git that is slow,
 * absent, or in a strange state has to degrade into "no finding" rather than
 * into an error on someone's card.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RepoProbe } from "./deliveryReportChecks";

const SERVER_ROOT = join(import.meta.dir, "..", "..");

/**
 * ONE PROBE PER REPOSITORY, and the repository is the one the report talks
 * about. The probe used to be a singleton over this server's own checkout:
 * `git ls-files` and `cat-file` on topics-app's main. So a file that existed
 * only on the delivery branch was "not tracked", a dancerooms commit "in no
 * ref", and main's tracked list, cached once per process, went stale the
 * moment a card landed. Four true deliveries were accused on 2026-09-04 alone.
 */
const probes = new Map<string, RepoProbe>();
export function probeForRoot(root: string): RepoProbe {
  const hit = probes.get(root);
  if (hit) return hit;
  const built = buildProbe(root);
  probes.set(root, built);
  return built;
}

/** How long a `git ls-files` answer stays fresh: enough to check one report,
 *  short enough that a commit made later is seen. */
const TRACKED_TTL_MS = 30_000;

function buildProbe(ROOT: string): RepoProbe {
const MIGRATIONS = join(ROOT, "server", "db", "migrations");

/** Cached per process: `git log --all -S` walks every ref and is not cheap. */
// Memoised git answers expire like the tracked list: a "no" for a sha is
// true for that root NOW, and a worktree gets commits later.
const cache = new Map<string, { v: boolean; at: number }>();

/**
 * "git answered NO" and "git could not be asked" are DIFFERENT, and collapsing
 * them broke the whole thing.
 *
 * `execFileSync` throws in both cases, so a plain `catch` cannot tell them
 * apart. The first version of this file caught everything and returned `true`
 * — fail open, so that a machine without git would not accuse anyone. The
 * effect was that `git cat-file -e <sha>` exiting non-zero, which is precisely
 * the answer "that commit does not exist", was read as "could not check" and
 * silently returned "it exists". The single most important check in the module
 * was dead in production, and the bench never noticed because the bench injects
 * its own probe.
 *
 * The distinction is in the error: a non-zero EXIT (`status` is a number) is an
 * answer; a failure to spawn at all (ENOENT, EACCES, a timeout) is not.
 */
function askGit(run: () => string): boolean | null {
  try {
    run();
    return true;
  } catch (e) {
    const err = e as { status?: unknown; code?: unknown };
    if (typeof err.status === "number") return false; // git answered: no
    return null; // git could not be asked
  }
}

function memo(key: string, f: () => boolean | null): boolean {
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < TRACKED_TTL_MS) return hit.v;
  const answer = f();
  const v = answer === null ? true : answer;
  cache.set(key, { v, at: Date.now() });
  return v;
}

let trackedFiles: string[] | null = null;
let trackedAt = 0;
function tracked(): string[] {
  if (trackedFiles && Date.now() - trackedAt < TRACKED_TTL_MS) return trackedFiles;
  try {
    trackedFiles = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\n")
      .filter(Boolean);
  } catch {
    trackedFiles = [];
  }
  trackedAt = Date.now();
  return trackedFiles;
}

return {
  shaExists: (sha) =>
    memo(`sha:${sha}`, () =>
      askGit(() => {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
        return "";
      }),
    ),
  migrations: () => {
    try {
      return readdirSync(MIGRATIONS);
    } catch {
      return [];
    }
  },
  readMigration: (name) => {
    try {
      return readFileSync(join(MIGRATIONS, name), "utf8");
    } catch {
      return "";
    }
  },
  fileMatches: (citation) => {
    const c = citation.replace(/^\.?\//, "");
    const files = tracked();
    // An empty list means git could not answer. Claiming "no file matches"
    // then would accuse every path in the report.
    if (files.length === 0) return true;
    return files.some((f) => f === c || f.endsWith("/" + c)) || existsSync(join(ROOT, c));
  },
  readLine: (path, line) => {
    try {
      return readFileSync(join(ROOT, path), "utf8").split("\n")[line - 1] ?? null;
    } catch {
      return null;
    }
  },
  symbolInHistory: (name) =>
    memo(`sym:${name}`, () => {
      // `git log` exits 0 with EMPTY output when nothing matches, so here the
      // answer is in the text, not in the exit code.
      try {
        const out = execFileSync("git", ["log", "--all", "-S", name, "--format=%h", "-1"], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 20_000,
        });
        return out.trim().length > 0;
      } catch {
        return null; // could not be asked
      }
    }),
};
}

/** This server's own checkout: the fallback when a card names no repository. */
export const repoProbe: RepoProbe = probeForRoot(SERVER_ROOT);
