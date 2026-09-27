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
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gitQuestions, type RepoProbe } from "./deliveryReportChecks";

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

/** How long a git answer stays fresh: enough to check one report, short enough
 *  that a commit made later is seen. */
const TRACKED_TTL_MS = 30_000;

/**
 * GIT IS NEVER ASKED ON THE SERVER'S LOOP. These questions ran inside the
 * update that moves a card to review, synchronously: `git log --all -S` walks
 * every ref and took up to 20 s, and the whole server stood still meanwhile.
 * Asking only the slow one ahead was not enough (PR #147, second review): a
 * question the warm-up had skipped, or an answer that expired before the check
 * read it, fell back to a synchronous git, 2 s and 44 s of loop held. So git is
 * asked in `prepare` only, asynchronously, and the checks read the answers it
 * returned, never git and never a cache that can expire under them.
 */
function buildProbe(ROOT: string): RepoProbe {
const MIGRATIONS = join(ROOT, "server", "db", "migrations");

/** Answers already given for this root, reused while fresh: a "no" for a sha is
 *  true for that root NOW, and a worktree gets commits later. */
const answers = new Map<string, { v: boolean; at: number }>();
let tracked: { files: string[]; at: number } | null = null;

/**
 * "git answered NO" and "git could not be asked" are DIFFERENT, and collapsing
 * them broke the whole thing once: `git cat-file -e` exiting non-zero, which is
 * precisely the answer "that commit does not exist", was read as "could not
 * check" and the most important check in the module was dead in production.
 *
 * The distinction is in the error. A non-zero EXIT is an answer (`code` is a
 * number); a failure to spawn (`ENOENT`, `EACCES`) or a timeout (`killed`,
 * `code` null) is not. Measured on Bun 1.3.8.
 */
function git(args: string[], timeout: number): Promise<{ out: string } | { exit: number } | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 64 << 20 }, (err, out) => {
      if (!err) return resolve({ out });
      const code = (err as { code?: unknown }).code;
      resolve(typeof code === "number" ? { exit: code } : null);
    });
  });
}

/** `null` = could not be asked, which never becomes an accusation. */
async function ask(key: string, question: () => Promise<boolean | null>): Promise<boolean> {
  const hit = answers.get(key);
  if (hit !== undefined && Date.now() - hit.at < TRACKED_TTL_MS) return hit.v;
  const answer = await question();
  const v = answer === null ? true : answer;
  answers.set(key, { v, at: Date.now() });
  return v;
}

const shaExists = (sha: string) =>
  ask(`sha:${sha}`, async () => {
    const r = await git(["cat-file", "-e", `${sha}^{commit}`], 20_000);
    return r === null ? null : "out" in r;
  });

// `git log` exits 0 with EMPTY output when nothing matches, so here the answer
// is in the text; a non-zero exit is not an answer at all.
const symbolInHistory = (name: string) =>
  ask(`sym:${name}`, async () => {
    const r = await git(["log", "--all", "-S", name, "--format=%h", "-1"], 20_000);
    return r !== null && "out" in r ? r.out.trim().length > 0 : null;
  });

async function trackedFiles(): Promise<string[]> {
  if (tracked && Date.now() - tracked.at < TRACKED_TTL_MS) return tracked.files;
  const r = await git(["ls-files"], 20_000);
  const files = r !== null && "out" in r ? r.out.split("\n").filter(Boolean) : [];
  tracked = { files, at: Date.now() };
  return files;
}

/** What the checks read: the answers `prepare` gathered, and for anything it
 *  was not asked, "no accusation". Never git. */
function answering(shas: ReadonlyMap<string, boolean>, symbols: ReadonlyMap<string, boolean>, files: readonly string[] | null): RepoProbe {
  return {
    shaExists: (sha) => shas.get(sha) ?? true,
    symbolInHistory: (name) => symbols.get(name) ?? true,
    fileMatches: (citation) => {
      const c = citation.replace(/^\.?\//, "");
      // No list, or an empty one, means git could not answer. Claiming "no
      // file matches" then would accuse every path in the report.
      if (!files || files.length === 0) return true;
      return files.some((f) => f === c || f.endsWith("/" + c)) || existsSync(join(ROOT, c));
    },
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
    readLine: (path, line) => {
      try {
        return readFileSync(join(ROOT, path), "utf8").split("\n")[line - 1] ?? null;
      } catch {
        return null;
      }
    },
  };
}

return {
  ...answering(new Map(), new Map(), null),
  prepare: async (reports) => {
    const shas = new Map<string, boolean>();
    const symbols = new Map<string, boolean>();
    let files: string[] | null = null;
    for (const report of reports) {
      const q = gitQuestions(report);
      for (const sha of q.shas) if (!shas.has(sha)) shas.set(sha, await shaExists(sha));
      if (q.citesFiles && files === null) files = await trackedFiles();
      // Report by report, and inside one only until a symbol is found: the
      // `some` in `checkReport` stops there, so git is not asked what the check
      // will not read. Every report gets its own answers (the first version
      // stopped at the first symbol found across ALL of them).
      for (const name of q.symbols) {
        const found = symbols.get(name) ?? (await symbolInHistory(name));
        symbols.set(name, found);
        if (found) break;
      }
    }
    return answering(shas, symbols, files);
  },
};
}

/** This server's own checkout: the fallback when a card names no repository. */
export const repoProbe: RepoProbe = probeForRoot(SERVER_ROOT);
