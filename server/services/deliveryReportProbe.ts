/**
 * The repository, seen by the delivery-report checks.
 *
 * Split from `deliveryReportChecks.ts` on purpose: that module is pure and its
 * bench runs in milliseconds against injected data. This one shells out to git,
 * and pure/impure is the seam that keeps the checks testable.
 *
 * EVERY CALL IS BEST-EFFORT. A probe that throws must never reach the caller:
 * these checks ANNOTATE a delivery, they do not gate it, so a git that is slow,
 * absent, or in a strange state has to degrade into an explicit unverifiable
 * result rather than an error on someone's card.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gitQuestions, type RepoProbe, type RepoSearchContext } from "./deliveryReportChecks";

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
const MAX_SHA_ROOTS = 48;
const MAX_ROOT_CANDIDATES = 64;
const GIT_LOOKUP_TIMEOUT_MS = 1_500;
const SHA_LOOKUP_CONCURRENCY = 4;
const DISCOVERED_ROOT_TTL_MS = 5 * 60_000;

const REPORTED_PATH = /(?:~\/|(?<![\w:/])\/(?!\/))[^\s`"'()<>{}[\],;]+|(?:[\w.-]+\/)+[\w.-]+(?:\.[\w-]+)?/g;

type ReportPath = { path: string; start: number };

function reportPaths(report: string): { absolute: ReportPath[]; relative: ReportPath[] } {
  const absolute = new Map<string, number>();
  const relativePaths = new Map<string, number>();
  for (const match of report.matchAll(REPORTED_PATH)) {
    const path = match[0]!.replace(/[.,;:!?]+$/, "").replace(/[)\]}>]+$/, "");
    if (!path || path.includes("://")) continue;
    const paths = path.startsWith("~/") || isAbsolute(path) ? absolute : relativePaths;
    if (!paths.has(path)) paths.set(path, match.index!);
  }
  return {
    absolute: [...absolute].map(([path, start]) => ({ path, start })),
    relative: [...relativePaths].map(([path, start]) => ({ path, start })),
  };
}

function normalizeCandidate(path: string): string {
  const parts = resolve(path).split(sep);
  const gitDir = parts.indexOf(".git");
  return gitDir > 0 ? parts.slice(0, gitDir).join(sep) || sep : parts.join(sep);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rootMentionIndex(report: string, root: string): number {
  const name = basename(root);
  if (!name || name === "." || name === "..") return -1;
  const fullPathIndex = report.indexOf(root);
  if (fullPathIndex >= 0) return fullPathIndex + root.length - name.length;
  const boundary = new RegExp(`(?:^|[\\s/\\\\\`'"(])(${escapeRegExp(name)})(?=$|[\\s/\\\\\`'":,;.)])`, "i");
  const match = boundary.exec(report);
  return match ? match.index + match[0].length - match[1]!.length : -1;
}

function nestedPathAfterMention(report: string, root: string, mention: number): string | null {
  const suffix = report.slice(mention + basename(root).length).match(/^\/([^\s`"'()<>{}[\],;]+)/)?.[1];
  const path = suffix?.replace(/[.,;:!?]+$/, "").replace(/[)\]}>]+$/, "");
  return path || null;
}

function isGitRoot(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function isWithinRoot(path: string, root: string): boolean {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function shaPositions(report: string, shas: readonly string[]): Array<{ sha: string; start: number }> {
  const lower = report.toLowerCase();
  const positions: Array<{ sha: string; start: number }> = [];
  for (const sha of shas) {
    let from = 0;
    while (from < lower.length) {
      const start = lower.indexOf(sha.toLowerCase(), from);
      if (start < 0) break;
      positions.push({ sha, start });
      from = start + sha.length;
    }
  }
  return positions;
}

function shasNearPosition(report: string, position: number, positions: readonly { sha: string; start: number }[]): Set<string> {
  const boundaries = /[!?;\n]|\.(?=\s|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundaries.exec(report)) !== null && match.index < position) start = match.index + match[0].length;
  boundaries.lastIndex = position;
  const endMatch = boundaries.exec(report);
  const end = endMatch?.index ?? report.length;
  return new Set(positions.filter((item) => item.start >= start && item.start < end).map((item) => item.sha));
}

function shasForMention(report: string, position: number, positions: readonly { sha: string; start: number }[]): Set<string> {
  const sameSentence = shasNearPosition(report, position, positions);
  if (sameSentence.size > 0) return sameSentence;

  const paragraphStart = report.lastIndexOf("\n\n", position) + 2;
  const nextParagraph = report.indexOf("\n\n", position);
  const paragraphEnd = nextParagraph < 0 ? report.length : nextParagraph;
  const inParagraph = positions.filter((item) => item.start >= paragraphStart && item.start < paragraphEnd);
  if (inParagraph.length === 0) return new Set();
  // A path after a commit describes that preceding claim, even when its text is long.
  const preceding = inParagraph.filter((item) => item.start < position).at(-1);
  const associated = preceding ?? inParagraph[0];
  return new Set(associated ? [associated.sha] : []);
}

function nearestExistingDirectory(path: string): string | null {
  let current = resolve(path);
  for (let i = 0; i < 12; i++) {
    try {
      const stat = statSync(current);
      if (stat.isDirectory()) return current;
      current = dirname(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

function hasGitMarker(path: string): boolean {
  let current = resolve(path);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

function displayRoot(root: string, home: string): string {
  if (root === home) return "~";
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return root.startsWith(prefix) ? `~/${root.slice(prefix.length)}` : root;
}

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

const discoveredRoots = new Map<string, number>();
function rememberRoot(root: string): void {
  discoveredRoots.delete(root);
  discoveredRoots.set(root, Date.now());
  while (discoveredRoots.size > MAX_SHA_ROOTS) {
    const oldest = discoveredRoots.keys().next().value as string | undefined;
    if (!oldest) break;
    discoveredRoots.delete(oldest);
  }
}

function recentRoots(): string[] {
  const now = Date.now();
  const roots: string[] = [];
  for (const [root, at] of discoveredRoots) {
    if (now - at >= DISCOVERED_ROOT_TTL_MS || !existsSync(root)) {
      discoveredRoots.delete(root);
      continue;
    }
    roots.unshift(root);
  }
  return roots;
}

/** Answers already given for this root, reused while fresh: a "no" for a sha is
 *  true for that root NOW, and a worktree gets commits later. */
const answers = new Map<string, { v: boolean | null; at: number }>();
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
function git(args: string[], timeout: number, cwd = ROOT): Promise<{ out: string } | { exit: number; stderr: string } | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 << 20 }, (err, out, stderr) => {
      if (!err) return resolve({ out });
      const code = (err as { code?: unknown }).code;
      resolve(typeof code === "number" ? { exit: code, stderr: String(stderr ?? "") } : null);
    });
  });
}

/** `null` = could not be asked, which never becomes an accusation. */
async function ask(key: string, question: () => Promise<boolean | null>): Promise<boolean | null> {
  const hit = answers.get(key);
  if (hit !== undefined && Date.now() - hit.at < TRACKED_TTL_MS) return hit.v;
  const answer = await question();
  answers.set(key, { v: answer, at: Date.now() });
  return answer;
}

// `git log` exits 0 with EMPTY output when nothing matches, so here the answer
// is in the text; a non-zero exit is not an answer at all.
const symbolInHistory = (name: string) =>
  ask(`sym:${ROOT}:${name}`, async () => {
    const r = await git(["log", "--all", "-S", name, "--format=%h", "-1"], 20_000);
    return r !== null && "out" in r ? r.out.trim().length > 0 : null;
  }).then((answer) => answer ?? true);

async function trackedFiles(): Promise<string[]> {
  if (tracked && Date.now() - tracked.at < TRACKED_TTL_MS) return tracked.files;
  const r = await git(["ls-files"], 20_000);
  const files = r !== null && "out" in r ? r.out.split("\n").filter(Boolean) : [];
  tracked = { files, at: Date.now() };
  return files;
}

/** What the checks read: the answers `prepare` gathered, and for anything it
 *  was not asked, "no accusation". Never git. */
function answering(
  shas: ReadonlyMap<string, boolean>,
  symbols: ReadonlyMap<string, boolean>,
  files: readonly string[] | null,
  shaLocations: ReadonlyMap<string, readonly string[]> = new Map(),
  shaUnverifiableLocations: ReadonlyMap<string, readonly string[]> = new Map(),
): RepoProbe {
  return {
    shaExists: (sha) => shas.get(sha) ?? true,
    shaSearchLocations: (sha) => shaLocations.get(sha) ?? [],
    shaSearchUnverifiableLocations: (sha) => shaUnverifiableLocations.get(sha) ?? [],
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
  prepare: async (reports, context: RepoSearchContext = {}) => {
    const shas = new Map<string, boolean>();
    const shaLocations = new Map<string, readonly string[]>();
    const shaUnverifiableLocations = new Map<string, readonly string[]>();
    const symbols = new Map<string, boolean>();
    let files: string[] | null = null;
    let home = resolve(context.homeDirectory ?? homedir());
    try { home = realpathSync(home); } catch { /* keep the configured path */ }
    type Candidate = {
      path: string;
      reportIndexes: Set<number>;
      expectedReports: Set<number>;
      shas: Set<string>;
      cardRoot: boolean;
      expectedCardRoot: boolean;
      gitMarker: boolean;
    };
    const candidateByPath = new Map<string, Candidate>();
    const addCandidate = (
      path: string,
      reportIndex?: number,
      expected = false,
      exactRoot = false,
      cardRoot = false,
      citedShas: ReadonlySet<string> = new Set(),
    ) => {
      const normalized = normalizeCandidate(path);
      const dir = exactRoot ? normalized : nearestExistingDirectory(normalized) ?? normalized;
      const key = resolve(dir);
      const hit = candidateByPath.get(key) ?? {
        path: key,
        reportIndexes: new Set<number>(),
        expectedReports: new Set<number>(),
        shas: new Set<string>(),
        cardRoot: false,
        expectedCardRoot: false,
        gitMarker: hasGitMarker(dir),
      };
      if (reportIndex !== undefined) hit.reportIndexes.add(reportIndex);
      if (reportIndex !== undefined && expected) hit.expectedReports.add(reportIndex);
      for (const sha of citedShas) hit.shas.add(sha);
      hit.cardRoot ||= cardRoot;
      hit.expectedCardRoot ||= cardRoot;
      candidateByPath.set(key, hit);
    };

    const hostRoots = [...new Set((context.knownRoots ?? [])
      .filter((path): path is string => typeof path === "string" && isAbsolute(path))
      .map((path) => resolve(path)))];
    const knownRoots = [...new Set([...hostRoots.filter(isGitRoot), ...recentRoots()])];
    const pathIsExpected = (path: string) => hostRoots.some((root) => isWithinRoot(path, root));
    const shasByReport = reports.map((report) => [...new Set(gitQuestions(report).shas)]);
    const allShas = [...new Set(shasByReport.flat())];
    for (let i = 0; i < reports.length; i++) {
      const report = reports[i]!;
      const positions = shaPositions(report, shasByReport[i]!);
      const named = reportPaths(report);
      for (const mention of named.absolute) {
        const path = mention.path.startsWith("~/") ? join(home, mention.path.slice(2)) : mention.path;
        addCandidate(
          path,
          i,
          pathIsExpected(path),
          false,
          false,
          shasForMention(report, mention.start, positions),
        );
      }
      for (const mention of named.relative) {
        const citedShas = shasForMention(report, mention.start, positions);
        const homePath = join(home, mention.path);
        const serverPath = join(ROOT, mention.path);
        addCandidate(homePath, i, pathIsExpected(homePath), false, false, citedShas);
        addCandidate(serverPath, i, pathIsExpected(serverPath), false, false, citedShas);
      }
      for (const path of knownRoots) {
        const mention = rootMentionIndex(report, path);
        if (mention < 0) continue;
        const citedShas = shasForMention(report, mention, positions);
        addCandidate(path, i, true, true, false, citedShas);
        const nested = nestedPathAfterMention(report, path, mention);
        if (nested) addCandidate(join(path, nested), i, true, false, false, citedShas);
      }
    }
    addCandidate(ROOT, undefined, false, true, true, new Set(allShas));
    for (const path of knownRoots) addCandidate(path, undefined, false, true);

    const candidates = [...candidateByPath.values()];
    const citedRepos = candidates.filter((candidate) =>
      candidate.reportIndexes.size > 0 && !candidate.cardRoot && (candidate.expectedReports.size > 0 || candidate.gitMarker));
    const citedOther = candidates.filter((candidate) =>
      candidate.reportIndexes.size > 0 && !candidate.cardRoot && candidate.expectedReports.size === 0 && !candidate.gitMarker);
    const card = candidates.find((candidate) => candidate.cardRoot);
    const optional = candidates.filter((candidate) => candidate.reportIndexes.size === 0 && !candidate.cardRoot);
    const prioritized = [...citedRepos, ...(card ? [card] : []), ...optional, ...citedOther];
    const selected = prioritized.slice(0, MAX_ROOT_CANDIDATES);
    if (card && !selected.includes(card)) selected[selected.length - 1] = card;
    const selectedSet = new Set(selected);
    const omitted = candidates.filter((candidate) => !selectedSet.has(candidate));
    const unknownBySha = new Map<string, Set<string>>();
    const markUnknown = (sha: string, location: string) => {
      const locations = unknownBySha.get(sha) ?? new Set<string>();
      locations.add(location);
      unknownBySha.set(sha, locations);
    };
    for (const candidate of omitted) {
      if (!candidate.gitMarker && candidate.expectedReports.size === 0 && !candidate.cardRoot) continue;
      for (const sha of candidate.shas) markUnknown(sha, displayRoot(candidate.path, home));
    }

    const gitRoots: string[] = [];
    const rootShas = new Map<string, Set<string>>();
    let cardGitRoot: string | null = null;
    for (let i = 0; i < selected.length; i += SHA_LOOKUP_CONCURRENCY) {
      const batch = selected.slice(i, i + SHA_LOOKUP_CONCURRENCY);
      const results = await Promise.all(batch.map(async (candidate) => ({
        candidate,
        answer: await git(["-C", candidate.path, "rev-parse", "--show-toplevel"], GIT_LOOKUP_TIMEOUT_MS),
      })));
      for (const { candidate, answer: r } of results) {
        if (r !== null && "out" in r) {
          const root = resolve(r.out.trim());
          if (root) {
            if (!gitRoots.includes(root)) gitRoots.push(root);
            rememberRoot(root);
            const shasForRoot = rootShas.get(root) ?? new Set<string>();
            for (const sha of candidate.shas) shasForRoot.add(sha);
            rootShas.set(root, shasForRoot);
            if (candidate.cardRoot) cardGitRoot = root;
          }
          continue;
        }
        const notRepository = r !== null && /not a git repository/i.test(r.stderr);
        const unresolved = r === null || !notRepository;
        if (candidate.expectedCardRoot || unresolved || candidate.expectedReports.size > 0) {
          const location = displayRoot(candidate.path, home);
          if (candidate.cardRoot) {
            for (const sha of candidate.shas) markUnknown(sha, location);
          } else if (candidate.expectedReports.size > 0 || (unresolved && candidate.gitMarker)) {
            for (const sha of candidate.shas) markUnknown(sha, location);
          }
        }
      }
    }

    const searchSha = async (sha: string): Promise<void> => {
      let found = false;
      const searched: string[] = [];
      const requiredRoots = new Set<string>();
      if (cardGitRoot) requiredRoots.add(cardGitRoot);
      for (const root of gitRoots) {
        if (rootShas.get(root)?.has(sha)) requiredRoots.add(root);
      }
      const incomplete = new Set(unknownBySha.get(sha) ?? []);
      const required = gitRoots.filter((root) => requiredRoots.has(root));
      const requiredToSearch = required.slice(0, MAX_SHA_ROOTS);
      for (const root of required.slice(MAX_SHA_ROOTS)) incomplete.add(displayRoot(root, home));
      const optionalToSearch = gitRoots
        .filter((root) => !requiredRoots.has(root))
        .slice(0, Math.max(0, MAX_SHA_ROOTS - requiredToSearch.length));
      const searchRoots = async (roots: readonly string[], stopWhenFound: boolean): Promise<void> => {
        for (let i = 0; i < roots.length && (!stopWhenFound || !found); i += SHA_LOOKUP_CONCURRENCY) {
          const batch = roots.slice(i, i + SHA_LOOKUP_CONCURRENCY);
          const results = await Promise.all(batch.map(async (root) => ({
            root,
            answer: await ask(`sha:${root}:${sha}`, async () => {
              const r = await git(["cat-file", "-e", `${sha}^{commit}`], GIT_LOOKUP_TIMEOUT_MS, root);
              return r === null ? null : "out" in r;
            }),
          })));
          for (const result of results) {
            searched.push(displayRoot(result.root, home));
            if (result.answer === true) found = true;
            else if (result.answer === null && requiredRoots.has(result.root)) incomplete.add(displayRoot(result.root, home));
          }
        }
      };
      await searchRoots(requiredToSearch, false);
      await searchRoots(optionalToSearch, true);
      shas.set(sha, found);
      shaLocations.set(sha, searched);
      if (!found && requiredRoots.size === 0 && incomplete.size === 0) {
        incomplete.add(cardGitRoot ? displayRoot(cardGitRoot, home) : displayRoot(ROOT, home));
      }
      if (incomplete.size > 0) shaUnverifiableLocations.set(sha, [...incomplete]);
    };

    for (let reportIndex = 0; reportIndex < reports.length; reportIndex++) {
      const report = reports[reportIndex]!;
      const q = gitQuestions(report);
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
    for (const sha of allShas) await searchSha(sha);
    return answering(shas, symbols, files, shaLocations, shaUnverifiableLocations);
  },
};
}

/** This server's own checkout: the fallback when a card names no repository. */
export const repoProbe: RepoProbe = probeForRoot(SERVER_ROOT);
