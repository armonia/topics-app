#!/usr/bin/env bun
/**
 * WHICH HEAVY JOBS OF ci.yml A CHANGE CAN REACH.
 *
 * WHY IT EXISTS. ci.yml ran every job on every pull request and every push to
 * main. Measured on the last 40 runs (04/11/2026): the e2e shards were 50% of the
 * billed minutes, `tauri (macos)` 24% and `process-groups (macos)` 15% (macOS
 * minutes count ten times), while a change that touches only `docs/` or only
 * `client/` cannot alter the verdict of the last two at all.
 *
 * THE RULE, AND WHY IT HAS TWO SHAPES.
 *
 *   e2e            a DENYLIST. Almost everything reaches an e2e shard (client,
 *                  server, shared, the specs, the lockfile), so the safe default
 *                  is "run", and only a short list of places the shards never
 *                  read is inert. A path nobody listed runs the shards.
 *   tauri,         an ALLOWLIST. Their inputs are few and known (the Rust crates,
 *   processGroups  the server the sidecar compiles, the files those tests import),
 *                  and a denylist would run them on every client change. The price
 *                  of an allowlist is a dependency nobody wrote down: that is what
 *                  scripts/ci-changes.test.ts closes, by computing the import
 *                  closure of the files each job runs and failing when a file in
 *                  it is not listed here.
 *
 * THE OPERATING SYSTEMS OF `tauri`. The macOS and Windows legs exist for what the
 * compiler of one system never reads (the `cfg(target_os)` branches of the Rust
 * crates) and for the TypeScript they EXECUTE with per-system branches: the native
 * addon, the git status parity, the PTY bridge suite. A TypeScript change anywhere
 * else in the server only has to compile, and the sidecar already compiles and
 * starts on all three systems for every server change (sidecar-smoke.yml). So
 * those changes run the Ubuntu leg only (macOS minutes count ten times), and the
 * three systems run when a changed file is in the import closure of what the other
 * legs execute (`osSensitiveFiles`, computed from the tree at hand, never listed by
 * hand) or in the static list of Rust, build and install inputs.
 *
 * `unit` and `gates` are NOT decided here: they always run. They are the cheap
 * net (8 and 10 minutes) and tests read docs, openspec and the workflows, so a
 * "docs only" change is not inert for them.
 *
 * ANY DOUBT RUNS EVERYTHING. No file list, an API that fails, a change too big for
 * the API to list: all three surfaces run on every system. A wrongly skipped job
 * is a regression nobody sees; a wrongly run one costs minutes.
 *
 * ON main THE DIFF IS NOT ENOUGH. The commit before this one may be red, and a
 * green run that skipped a job on top of a red one would be released by auto-bump
 * (it ships a SHA whose CI is green). So a push skips something only when the
 * previous commit of main has a green push run of its own: by induction every
 * green tree was judged in full, up to changes that were inert for each job.
 * The induction needs `before` to be an ancestor of `after`: a force push is
 * judged in full, and so is any compare that GitHub does not call "ahead" (a
 * three-dot compare of diverged commits lists the files from the merge base, not
 * from `before`).
 *
 * HOW IT IS CALLED (the `changes` job of ci.yml):
 *   bun run scripts/ci-changes.ts                  reads the event from GITHUB_EVENT_PATH
 *   bun run scripts/ci-changes.ts --files a b c    classifies a list, for a human
 *   bun run scripts/ci-changes.ts --os-closure     the files the other systems execute
 * It prints `name=value` lines, to stdout and to $GITHUB_OUTPUT.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export type Surface = "e2e" | "tauri" | "processGroups";
export const SURFACES: readonly Surface[] = ["e2e", "tauri", "processGroups"];

/** Output names are snake_case, the way ci.yml reads them. */
export const OUTPUT_NAME: Record<Surface, string> = { e2e: "e2e", tauri: "tauri", processGroups: "process_groups" };

export const ALL_TAURI_SYSTEMS: readonly string[] = ["macos-latest", "windows-latest", "ubuntu-latest"];
const SERVER_ONLY_TAURI_SYSTEMS: readonly string[] = ["ubuntu-latest"];

/** A change to the workflow or to this file re-judges everything: no surface is inert for it. */
const REBUILDS_ALL: readonly RegExp[] = [/^\.github\/workflows\/ci\.yml$/, /^scripts\/ci-changes\.ts$/];

/**
 * Places the e2e shards never read, checked against the import closure of every
 * spec, the helpers, server.ts, the client entry and playwright.config.ts: none of
 * those files imports from here. Root markdown only (`*.md` elsewhere is a fixture
 * or a prompt that code reads). `.github/` is inert except ci.yml (handled above).
 */
export const E2E_INERT: readonly RegExp[] = [
  /^docs\//,
  /^openspec\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
  /^landing\//,
  /^desktop-tauri\//,
  /^native\//,
  /^\.github\//,
];

/** Files at the root that cargo and rustup find by walking up from any crate, so they steer all of them. */
const RUST_ROOT_CONFIG: readonly RegExp[] = [/^rust-toolchain(\.toml)?$/, /^\.cargo\//, /^Cargo\.(toml|lock)$/];

/** What the git status parity walks (it compares the two walkers on this very checkout) and how the checkout is written. */
const WALKED_TREE_CONFIG: readonly RegExp[] = [/(^|\/)\.gitignore$/, /^\.gitattributes$/];

/** What `bun test` loads for the two jobs below, and the files that decide what installs. */
const TEST_RUNTIME: readonly RegExp[] = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^\.bun-version$/,
  /^bunfig\.toml$/,
  /^tests\/setup\//,
  /^tests\/helpers\//,
  /^server\.ts$/,
  /^server\//,
  /^shared\//,
];

/** The four test files of the `process-groups` job, plus what they import (see the closure test). */
export const PROCESS_GROUPS_TRIGGERS: readonly RegExp[] = [
  ...TEST_RUNTIME,
  /^scripts\/(gate-slot|stray-ai-bridges|fix-node-pty-exec-bit)\.ts$/,
  /^scripts\/claude-hooks\//,
];

/** The Rust crates, the server the sidecar compiles, the native addon, and the tests the job runs. */
export const TAURI_TRIGGERS: readonly RegExp[] = [
  ...TEST_RUNTIME,
  /^desktop-tauri\//,
  /^native\//,
  /^public\//,
  /^tests\/tauri-shell\//,
  /^tests\/integration\//,
  /^scripts\/(gate-slot|stray-ai-bridges|fix-node-pty-exec-bit|measure-file-tree|gen-migrations-manifest|build-[\w-]+|check-cross-shell)\.(ts|sh)$/,
  /^scripts\/claude-hooks\//,
  ...RUST_ROOT_CONFIG,
  ...WALKED_TREE_CONFIG,
];

/**
 * The subset of the triggers above that the macOS and Windows legs exist for: the
 * Rust crates and their root config, the native addon, what gets embedded or
 * installed, the per-system build scripts, the shell tests, the walked tree, and
 * the sidecar entry (it carries `--native-selftest`). The TypeScript those legs
 * execute is not listed here: see `osSensitiveFiles`. Anything else in
 * TAURI_TRIGGERS is TypeScript that only has to compile, which the Ubuntu leg does.
 */
export const TAURI_EVERY_SYSTEM: readonly RegExp[] = [
  /^desktop-tauri\//,
  /^native\//,
  /^public\//,
  /^package\.json$/,
  /^bun\.lock$/,
  /^\.bun-version$/,
  /^scripts\/build-[\w-]+\.sh$/,
  /^scripts\/check-cross-shell\.sh$/,
  /^tests\/tauri-shell\//,
  /^tests\/integration\/pty-bridge/,
  /^server\/sidecar-entry\.ts$/,
  ...RUST_ROOT_CONFIG,
  ...WALKED_TREE_CONFIG,
];

/** The files whose import closure the macOS and Windows legs execute with per-system branches. */
export const OS_SENSITIVE_ENTRIES: readonly string[] = [
  "native/parity.test.ts",
  "server/lib/git-status.native.test.ts",
  "server/lib/native-addon.ts",
  "server/pty-bridge.mjs",
  "server/pty-bridge-platform.mjs",
  "tests/integration/pty-bridge-mjs.test.ts",
];

/**
 * Every repo file the entries above import, read from the tree under `root`
 * (node_modules left out: packages stay external). Throws when it cannot be built,
 * and the caller then treats every server file as system-sensitive. Run it in a
 * plain `bun` process: the preload of `bun test` changes how an extensionless
 * import resolves.
 */
export async function osSensitiveFiles(root: string = process.cwd()): Promise<Set<string>> {
  const built = (await Bun.build({
    entrypoints: OS_SENSITIVE_ENTRIES.map((entry) => resolve(root, entry)),
    target: "bun",
    write: false,
    packages: "external",
    metafile: true,
  } as Parameters<typeof Bun.build>[0])) as Awaited<ReturnType<typeof Bun.build>> & { metafile?: { inputs: Record<string, unknown> } };
  if (!built.success || !built.metafile) throw new Error(`the import closure did not build: ${built.logs.map(String).join("; ")}`);
  return new Set(Object.keys(built.metafile.inputs).map((file) => relative(root, resolve(root, file))));
}

export type Verdict = {
  run: Record<Surface, boolean>;
  /** The systems `tauri` runs on, empty when it does not run. */
  tauriSystems: string[];
  why: Record<Surface, string>;
};

const clean = (file: string): string => file.trim().replace(/^\.\//, "");
const matchesAny = (patterns: readonly RegExp[], file: string): boolean => patterns.some((re) => re.test(file));

/** Everything runs, everywhere, and `why` says why. */
export function runEverything(why: string): Verdict {
  return {
    run: { e2e: true, tauri: true, processGroups: true },
    tauriSystems: [...ALL_TAURI_SYSTEMS],
    why: { e2e: why, tauri: why, processGroups: why },
  };
}

/**
 * Which surfaces a set of changed paths can reach, and a sentence that says why.
 * `osSensitive` is the closure of what the other systems execute; without it every
 * server and shared file counts as such (a doubt runs everything).
 */
export function classify(changed: readonly string[], osSensitive?: ReadonlySet<string>): Verdict {
  const files = changed.map(clean).filter(Boolean);
  if (files.length === 0) return runEverything("no changed file is known: everything runs");
  const rebuilder = files.find((f) => matchesAny(REBUILDS_ALL, f));
  if (rebuilder) return runEverything(`${rebuilder} re-judges every job`);

  const isSystemSensitive = (f: string) => matchesAny(TAURI_EVERY_SYSTEM, f) || (osSensitive ? osSensitive.has(f) : /^(server|shared)\//.test(f));
  const outsideInert = files.find((f) => !matchesAny(E2E_INERT, f));
  const tauriHit = files.find((f) => matchesAny(TAURI_TRIGGERS, f));
  const processHit = files.find((f) => matchesAny(PROCESS_GROUPS_TRIGGERS, f));
  const everySystem = files.some(isSystemSensitive);
  const none = `none of the ${files.length} files is an input of the job`;
  return {
    run: { e2e: outsideInert !== undefined, tauri: tauriHit !== undefined, processGroups: processHit !== undefined },
    tauriSystems: tauriHit === undefined ? [] : [...(everySystem ? ALL_TAURI_SYSTEMS : SERVER_ONLY_TAURI_SYSTEMS)],
    why: {
      e2e: outsideInert ? `${outsideInert} is read by the shards` : `all ${files.length} files are inert for the shards`,
      tauri: tauriHit ? `${tauriHit} is an input of the job${everySystem ? "" : ", on Ubuntu only"}` : none,
      processGroups: processHit ? `${processHit} is an input of the job` : none,
    },
  };
}

type Reply = { ok: boolean; json(): Promise<unknown> };
export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<Reply>;

const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "topics-ci-changes" });

type FileEntry = { filename: string; previous_filename?: string };

/** The files API of a pull request lists 100 per page and at most 3000. */
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
/** The compare API lists at most 300 files and has no page for the rest. */
const COMPARE_FILE_CAP = 300;

/** A path and, for a rename, the path it came from: moving a file out of `server/` changes the server. */
function pathsOf(entries: FileEntry[]): string[] {
  return entries.flatMap((e) => (e.previous_filename ? [e.filename, e.previous_filename] : [e.filename]));
}

/** Every path a pull request touches. Null when the list cannot be trusted (HTTP error, or more files than the API lists). */
export async function pullRequestFiles(repo: string, number: number, token: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<string[] | null> {
  const files: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetcher(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`, { headers: headers(token) });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body)) return null;
    files.push(...pathsOf(body as FileEntry[]));
    if (body.length < PAGE_SIZE) return files;
  }
  return null;
}

/** Every path between two commits of main. Null when the list is capped, unreadable, or `before` is not an ancestor. */
export async function pushFiles(repo: string, before: string, after: string, token: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<string[] | null> {
  const res = await fetcher(`https://api.github.com/repos/${repo}/compare/${before}...${after}`, { headers: headers(token) });
  if (!res.ok) return null;
  const body = (await res.json()) as { status?: string; files?: FileEntry[] };
  // Only "ahead" means `before` is an ancestor of `after`; otherwise the files are listed from the merge base.
  if (body.status !== "ahead" || !Array.isArray(body.files) || body.files.length >= COMPARE_FILE_CAP) return null;
  return pathsOf(body.files);
}

type RunEntry = { event?: string; head_branch?: string; conclusion?: string | null };

/** True when `sha` has a push run of ci.yml on main that concluded success. Any doubt is false. */
export async function previousPushIsGreen(repo: string, sha: string, token: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<boolean> {
  const res = await fetcher(`https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=20`, { headers: headers(token) });
  if (!res.ok) return false;
  const body = (await res.json()) as { workflow_runs?: RunEntry[] };
  return (body.workflow_runs ?? []).some((r) => r.event === "push" && r.head_branch === "main" && r.conclusion === "success");
}

/** `name=value` lines for the outputs of the job. */
export function renderOutputs(verdict: Verdict): string[] {
  return [...SURFACES.map((s) => `${OUTPUT_NAME[s]}=${verdict.run[s]}`), `tauri_systems=${JSON.stringify(verdict.tauriSystems)}`];
}

type EventPayload = { pull_request?: { number?: number }; before?: string; after?: string; forced?: boolean };

const NO_COMMIT = /^0+$/;

export type EventInput = { event: string | undefined; payload: EventPayload; repo: string; token: string };

/** The verdict for one event. It never throws: a failure is the verdict "everything runs". */
export async function judgeEvent(input: EventInput, fetcher: Fetcher = fetch as unknown as Fetcher, osSensitive?: ReadonlySet<string>): Promise<Verdict> {
  try {
    const { event, payload, repo, token } = input;
    if (!repo || !token) return runEverything("no repository or token: everything runs");

    if (event === "pull_request" && payload.pull_request?.number) {
      const files = await pullRequestFiles(repo, payload.pull_request.number, token, fetcher);
      return files ? classify(files, osSensitive) : runEverything("the file list of the pull request is unreadable or too long: everything runs");
    }
    if (event === "push") {
      const { before, after } = payload;
      if (!before || !after || NO_COMMIT.test(before)) return runEverything("a push without a previous commit: everything runs");
      if (payload.forced === true) return runEverything("a force push: the previous commit is not its ancestor, everything runs");
      if (!(await previousPushIsGreen(repo, before, token, fetcher))) return runEverything("the previous commit of main has no green push run: everything runs");
      const files = await pushFiles(repo, before, after, token, fetcher);
      return files ? classify(files, osSensitive) : runEverything("the file list of the push is unreadable, too long or not a straight line: everything runs");
    }
    return runEverything(`the ${event ?? "unknown"} event is judged in full: everything runs`);
  } catch (error) {
    return runEverything(`${(error as Error).message}: everything runs`);
  }
}

/** The closure of the system-sensitive files, or undefined (with a warning) when it cannot be built. */
async function closureOrWarn(): Promise<Set<string> | undefined> {
  try {
    const files = await osSensitiveFiles();
    console.log(`system-sensitive closure: ${files.size} files`);
    return files;
  } catch (error) {
    console.log(`::warning title=System closure unknown::${(error as Error).message}: every server file counts as system-sensitive`);
    return undefined;
  }
}

/** The event of the running workflow, read from the environment the runner sets. */
async function judgeRunnerEvent(env: Record<string, string | undefined>): Promise<Verdict> {
  try {
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8")) as EventPayload;
    const input = { event: env.GITHUB_EVENT_NAME, payload, repo: env.GITHUB_REPOSITORY ?? "", token: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "" };
    return await judgeEvent(input, fetch as unknown as Fetcher, await closureOrWarn());
  } catch (error) {
    return runEverything(`the event payload is unreadable (${(error as Error).message}): everything runs`);
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--os-closure")) {
    console.log([...(await osSensitiveFiles())].sort().join("\n"));
    return 0;
  }
  const at = argv.indexOf("--files");
  const verdict = at >= 0 ? classify(argv.slice(at + 1), await closureOrWarn()) : await judgeRunnerEvent(process.env);
  const lines = renderOutputs(verdict);
  for (const s of SURFACES) console.log(`${s}: ${verdict.run[s] ? "RUN " : "skip"}  (${verdict.why[s]})`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
