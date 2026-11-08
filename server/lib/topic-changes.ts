/**
 * What a conversation has TOUCHED, file by file.
 *
 * The chat already knows it: every write goes through a tool call, and the
 * provider boundary normalizes those into `detail.type = 'write' | 'edit'`
 * with the path. Nobody was reading them back, so the only way to see what an
 * agent changed in a project was to scroll the transcript looking for tool
 * rows, or to open a terminal and run `git status` on the whole repository,
 * which answers a different question: it shows everything dirty, including
 * what another session did.
 *
 * Two halves, and the split is what makes this testable:
 *  - `aggregateTouchedFiles` is pure. Messages in, one row per path out, with
 *    the number of TURNS that wrote it (not the number of tool calls: three
 *    edits in one answer are one turn) and the timestamp of the last one.
 *  - `computeTopicChanges` adds git, and only for the paths the conversation
 *    named: `status` and `diff --numstat` both get an explicit pathspec, so
 *    the counts describe this topic and not the working tree around it.
 *
 * A topic a task was dispatched to is the exception: there the task's own diff
 * range decides the file set (`rangeChanges`), and the tool calls say how many
 * turns wrote each file. Only a task says whose a range is: a worktree with no
 * task can hold a second topic's work (the sidebar opens new topics in it), so
 * such a topic keeps its tool calls.
 */
import * as nodePath from "path";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { existsSync, realpathSync } from "fs";
import { parsePorcelainZ } from "./git-porcelain";
import { parseNumstatZ, type Numstat } from "./git-numstat";
import { gitDiffStat, runGitRead as git, type DiffStatEntry } from "./git-diff-stat";
import { resolveTaskDiffRange, revsOfRange, type TaskDiffRange } from "../services/task-diff-range";
import { defaultRunGit } from "../services/own-commits";
import { deriveToolDetail } from "../../shared/tool-detail";
import type { ToolCall } from "../../shared/types";
import type { TopicChangeKind, TopicChangedFile, TopicChanges } from "../../shared/topic-changes";
import type { DiffRevs } from "../../shared/diff-revs";

/** The slice of a stored message this module reads. */
export interface TouchedMessage {
  timestamp?: string;
  toolCalls?: ToolCall[];
}

/** One path as the tool calls alone describe it, before git has its say. */
export interface TouchedFile {
  path: string;
  /** `created` when the FIRST write on this path was a full-file write. */
  kind: "created" | "modified";
  /** How many distinct turns wrote to it. */
  turns: number;
  lastAt: string;
}

/** The path a write tool call names, or `null` if it is not a write. */
function writtenPath(call: ToolCall): { path: string; whole: boolean } | null {
  // A call that ended in an error wrote nothing: listing it would promise a
  // change that is not on disk.
  if (call.error) return null;
  // A typed detail that says what it is (read, shell, search...) is believed.
  // A MISSING one (older rows) or an `unknown` one is not a verdict: the
  // native provider's `edit_file` was stored as `unknown` for weeks (861 rows
  // since 10/09), and reading that as "not a write" dropped a quarter of a
  // topic's files from the strip. Those go through the same name+args
  // derivation the provider boundary uses, so the list of write names lives
  // in one place.
  const stored = call.detail;
  // An `unknown` detail keeps the args under `raw`: the only copy left when a
  // lean wire shape dropped the top-level ones.
  const args = call.args && Object.keys(call.args).length
    ? call.args
    : stored?.type === "unknown" ? stored.raw?.args : undefined;
  const detail = stored && stored.type !== "unknown"
    ? stored
    : deriveToolDetail(call.name ?? "", args);
  if (detail.type !== "write" && detail.type !== "edit") return null;
  return detail.filePath ? { path: detail.filePath, whole: detail.type === "write" } : null;
}

/**
 * The files the write tool calls of `messages` name, newest first.
 *
 * Pure: no filesystem, no git, no DB. `turns` counts messages, so an answer
 * that edited the same file four times counts once.
 */
export function aggregateTouchedFiles(messages: TouchedMessage[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  for (const message of messages) {
    const calls = message.toolCalls;
    if (!calls?.length) continue;
    // Per message, not per call: the same file written twice in one answer is
    // one turn.
    const inThisTurn = new Map<string, boolean>();
    for (const call of calls) {
      const hit = writtenPath(call);
      if (!hit) continue;
      if (!inThisTurn.has(hit.path)) inThisTurn.set(hit.path, hit.whole);
    }
    const at = message.timestamp ?? "";
    for (const [path, whole] of inThisTurn) {
      const seen = byPath.get(path);
      if (seen) {
        seen.turns += 1;
        if (at > seen.lastAt) seen.lastAt = at;
      } else {
        byPath.set(path, { path, kind: whole ? "created" : "modified", turns: 1, lastAt: at });
      }
    }
  }
  return [...byPath.values()].sort(newestFirst);
}

/** Newest write first; stable, so rows no tool call dated keep their order after the rest. */
function newestFirst(a: { lastAt: string }, b: { lastAt: string }): number {
  return a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0;
}

/**
 * The kind the panel shows: the tool calls said what they did, git says what
 * survived. An `??` (never committed) is a creation even when the agent only
 * edited it; a `D` is a deletion even though no write tool call can delete.
 */
export function refineKind(toolKind: "created" | "modified", xy: string | null): TopicChangeKind {
  if (!xy) return toolKind;
  if (xy.includes("?")) return "created";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "created";
  return "modified";
}

/** Beyond this many paths a single git invocation stops being one command. */
export const MAX_GIT_PATHS = 400;
/**
 * Untracked files cost a count each (a `--no-index` spawn here, a file read on
 * a range): count the first few only. On a range the ones past it are not
 * listed at all, which is what the drawer does past its own, larger cap; a file
 * a tool call wrote is listed anyway, through the tool-call half.
 */
const MAX_UNTRACKED_COUNTS = 50;

/**
 * The same path with its symlinks resolved, without requiring it to exist.
 *
 * Both sides of the `relative()` below must speak the same dialect: git answers
 * with the resolved root (`/private/tmp/x`) while a tool call carries the path
 * the agent wrote (`/tmp/x`), and on that mismatch every file in the repository
 * looks like it is outside it. Resolution walks up to the longest EXISTING
 * prefix, so a file the agent deleted still lands on the right side.
 */
function canonicalPath(target: string): string {
  const { real, gone } = splitAtDisk(target);
  return gone.length ? join(real, ...gone) : real;
}

/** `target` cut where the disk ends: its longest existing prefix, symlinks resolved, and the segments under it that are gone. */
function splitAtDisk(target: string): { real: string; gone: string[] } {
  let current = resolve(target);
  const gone: string[] = [];
  for (;;) {
    try {
      return { real: realpathSync(current), gone };
    } catch {
      const parent = dirname(current);
      if (parent === current) return { real: resolve(target), gone: [] };
      gone.unshift(basename(current));
      current = parent;
    }
  }
}

/** The repository root of `cwd`, or `null` when there is no repository. */
async function repoRoot(cwd: string): Promise<string | null> {
  const probe = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (probe.code !== 0) return null;
  const root = probe.text.trim();
  return root ? canonicalPath(root) : null;
}

async function currentBranch(cwd: string): Promise<string> {
  const named = await git(cwd, ["branch", "--show-current"]);
  const branch = named.text.trim();
  if (branch) return branch;
  const short = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return short.text.trim() || "HEAD";
}

/** Does this repository have a commit to diff against? */
async function hasHead(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).code === 0;
}

function countsOf(stat: Numstat | undefined): Pick<TopicChangedFile, "added" | "removed" | "binary"> {
  if (!stat) return {};
  return stat.binary ? { added: 0, removed: 0, binary: true } : { added: stat.added, removed: stat.removed };
}

/**
 * `target` relative to `root` in git's spelling, or `null` when it is not under
 * `root`. Git answers `src/a.ts` on every platform, `relative()` answers
 * `src\\a.ts` on Windows (where topics-server ships inside the app), and the
 * two spellings of one file were two rows. `path` is the platform's; a test
 * hands in `win32`.
 */
export function pathInTree(
  root: string,
  target: string,
  path: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> = nodePath,
): string | null {
  const rel = path.relative(root, target);
  // Another drive on Windows: `relative` gives back the absolute target.
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return path.sep === "/" ? rel : rel.split(path.sep).join("/");
}

/**
 * The tree a task's tool calls wrote in: its worktree. A `path` while a
 * worktree row still names it; after the land's prune the row is gone too, and
 * only the folder's `name` is left, the one its branch `topics/<name>` was
 * made from (`worktree-manager.ts`): the delivery the review recorded, or the
 * attempt the dispatcher bound to the topic when no delivery was recorded.
 */
export type TaskTree = { path: string } | { name: string };

/**
 * A tool call's path relative to the task's tree, or `null` when it is not in
 * that tree.
 *
 * With a path the tree is read exactly. A relative path is the tree's own
 * whichever the tree. With a name only, an absolute path must run
 * through a GONE folder of that name, and what follows it is the relative
 * path, in full: `<wt>/docs/README.md` is `docs/README.md` and never the
 * range's `README.md`. Anything else is not the task's tree, even when its
 * relative path matches a range row: the shared checkout an agent wrote by
 * mistake, a scratch folder deleted since, another repository's
 * `package.json`. Folding those into a range row hid the write the strip
 * listed before the range existed.
 */
function treePathOf(path: string, tree: TaskTree): string | null {
  if ("path" in tree) {
    const root = canonicalPath(tree.path);
    return pathInTree(root, canonicalPath(isAbsolute(path) ? path : resolve(root, path)));
  }
  if (!isAbsolute(path)) {
    // Relative to the task's workspace, which is this worktree: that is how
    // the native provider's write_file resolves it.
    const segments = path.split(/[\\/]+/).filter((s) => s && s !== ".");
    return segments.length && !segments.includes("..") ? segments.join("/") : null;
  }
  const { gone } = splitAtDisk(path);
  const at = gone.indexOf(tree.name);
  return at >= 0 && at < gone.length - 1 ? gone.slice(at + 1).join("/") : null;
}

/**
 * The files of a diff range, each with the turns and the last write of the
 * tool calls that name it in the task's `tree`. A file no tool call names (a
 * shell command, a sub-agent) has `turns: 0`. A tool call the range does not
 * hold comes back in `rest`: the range can be narrower than what the chat
 * wrote (a live branch whose commits another local branch also holds, an
 * untracked file past the cap, a write outside the tree), and dropping it
 * would hide a file the strip listed before the range existed.
 */
export function rangeFiles(
  stat: DiffStatEntry[],
  touched: TouchedFile[],
  tree: TaskTree | null,
): { files: TopicChangedFile[]; rest: TouchedFile[] } {
  const writes = new Map(stat.map((s) => [s.path, { turns: 0, lastAt: "" }]));
  const rest: TouchedFile[] = [];
  for (const file of touched) {
    const rel = tree ? treePathOf(file.path, tree) : null;
    const seen = rel ? writes.get(rel) : undefined;
    if (!seen) {
      rest.push(file);
      continue;
    }
    seen.turns += file.turns;
    if (file.lastAt > seen.lastAt) seen.lastAt = file.lastAt;
  }
  const files = stat.map((s): TopicChangedFile => {
    const { turns, lastAt } = writes.get(s.path)!;
    const kind: TopicChangeKind = s.status === "A" ? "created" : s.status === "D" ? "deleted" : "modified";
    const binary = s.additions < 0 || s.deletions < 0;
    const counts = binary ? { added: 0, removed: 0, binary } : { added: s.additions, removed: s.deletions };
    return { path: s.path, kind, turns, lastAt, ...counts, inRange: true };
  });
  return { files: files.sort(newestFirst), rest };
}

/** What the `/changes` route knows about the task dispatched to a topic. */
export interface TopicRangeAnchors {
  task: {
    id: string;
    deliveryBranch: string | null;
    deliveryCommit: string | null;
    /** How many files the review measured in the delivery, when it did. */
    deliveryFiles: number | null;
    /** The branch of the latest attempt launched in this topic: its worktree's. */
    attemptBranch: string | null;
  };
  /** The topic's worktree row, while it still has one. */
  worktree: { absPath: string; mode: string; branchName: string | null } | null;
  /** The project's own checkout: where main, and so the land merge, lives. */
  repoPath: string | null;
}

/**
 * WHERE a topic's changes are read, decided once for the list
 * (`/topics/:id/changes`) and the changeset (`/topics/:id/changes/diff`), so
 * the two can never describe two different diffs.
 *
 *  - `range`: the task's own diff range, the drawer's (`resolveTaskDiffRange`:
 *    the live worktree, then the land merge, then the delivery commit). The
 *    whole range, no path filter: shell and sub-agent writes are in it.
 *  - `head`: `HEAD` of the repository the topic sits in against its working
 *    tree, LIMITED to the repository-relative paths the write tool calls name
 *    (at most `MAX_GIT_PATHS`). `hasHead` false = a repository with no commit,
 *    whose only changes are untracked files.
 *  - `null`: no file, no folder, or a folder outside any repository.
 */
export type TopicChangeTarget =
  | { kind: "range"; cwd: string; range: string; live: boolean; taskRange: TaskDiffRange; stat?: DiffStatEntry[] }
  | { kind: "head"; cwd: string; range: "HEAD"; live: true; paths: string[]; hasHead: boolean }
  | null;

/**
 * The task's range for a topic a task was dispatched to, or `null` when there
 * is none to read, or the one read is not the card's.
 *
 * Git owns the file set there because the tool calls got it wrong twice
 * (review of 23/09): once the worktree is pruned every tool call path points
 * into a folder that is gone (d6158ec6: 42 paths, 0 resolved), and a file a
 * shell command or a sub-agent wrote has no write tool call at all (e8e3b8bf:
 * strip 5, git 9).
 */
async function taskRangeTarget(anchors: TopicRangeAnchors): Promise<TopicChangeTarget> {
  const { task, worktree: wt } = anchors;
  // The drawer's anchors (`routes/tasks.ts`): only a branch worktree still on disk is live.
  const live = wt && wt.mode === "branch" && wt.absPath && existsSync(wt.absPath)
    ? { cwd: wt.absPath, branch: wt.branchName }
    : null;
  const range = await resolveTaskDiffRange({
    taskId: task.id,
    worktree: live,
    repoPath: anchors.repoPath,
    delivery: { branch: task.deliveryBranch, commit: task.deliveryCommit },
  });
  if (!range) return null;
  const target = { kind: "range" as const, cwd: range.cwd, range: range.range, live: range.live, taskRange: range };
  if (range.source !== "delivery-commit" || task.deliveryFiles === null) return target;
  // Read back after the branches around it are gone, a delivery commit counts
  // as the card's every commit no local branch holds any more: another
  // session's commit its branch carried (cf665621: 17 files where the review
  // measured 13), or, for a delivery older than the 21/08 history rewrite,
  // the old history since June (7bc6b178: 3045 for 4). The review measured
  // the delivery while those branches still said whose each commit was, so a
  // range holding more files than that is not the card's. The drawer still
  // draws it; the strip keeps the tool calls. A land merge is exactly what
  // the land brought, and stays. A commit range has no untracked side.
  const { stat } = await gitDiffStat(range.cwd, range.range);
  return stat.length > task.deliveryFiles ? null : { ...target, stat };
}

/** The tool calls' paths inside `root`, repository-relative, and the rest. */
function splitByRepo(root: string, touched: TouchedFile[]): { inside: Array<{ touched: TouchedFile; rel: string }>; outside: TouchedFile[] } {
  const inside: Array<{ touched: TouchedFile; rel: string }> = [];
  const outside: TouchedFile[] = [];
  for (const file of touched) {
    const rel = pathInTree(root, canonicalPath(isAbsolute(file.path) ? file.path : resolve(root, file.path)));
    if (rel === null) outside.push(file);
    else inside.push({ touched: file, rel });
  }
  return { inside, outside };
}

/**
 * The target of a topic (see `TopicChangeTarget`). `cwd` is the topic's
 * worktree if it has one, its project folder otherwise; `anchors` is set on a
 * topic a task was dispatched to, and the task's range goes first.
 */
export async function resolveTopicChangeTarget(
  cwd: string | null | undefined,
  messages: TouchedMessage[],
  anchors?: TopicRangeAnchors | null,
  touched: TouchedFile[] = aggregateTouchedFiles(messages),
): Promise<TopicChangeTarget> {
  // The range runs at the end of every turn; a conversation that ran no tool
  // (no write, no shell, no sub-agent) changed nothing, and asks git nothing.
  if (anchors && messages.some((m) => m.toolCalls?.length)) {
    const fromRange = await taskRangeTarget(anchors);
    if (fromRange) return fromRange;
  }
  if (!touched.length || !cwd) return null;
  const root = await repoRoot(cwd);
  if (!root) return null;
  const paths = splitByRepo(root, touched).inside.slice(0, MAX_GIT_PATHS).map((f) => f.rel);
  return { kind: "head", cwd: root, range: "HEAD", live: true, paths, hasHead: paths.length ? await hasHead(root) : false };
}

/** The two SHAs of a target: what the panel may ask the bytes of. */
export async function revsOfTarget(target: TopicChangeTarget): Promise<DiffRevs | null> {
  if (!target || (target.kind === "head" && !target.hasHead)) return null;
  return revsOfRange(defaultRunGit, target.cwd, target.range, target.live);
}

/**
 * A task topic's changes, read from the task's range: one row per file of the
 * range, with the turns of the tool calls that wrote it in the task's tree.
 * The tool calls the range does not hold keep a row of their own.
 */
async function rangeChanges(
  target: Extract<TopicChangeTarget, { kind: "range" }>,
  anchors: TopicRangeAnchors,
  touched: TouchedFile[],
): Promise<Omit<TopicChanges, "revs">> {
  const { task, worktree: wt } = anchors;
  const range = target.taskRange;
  const live = wt && wt.mode === "branch" && wt.absPath && existsSync(wt.absPath) ? { branch: wt.branchName } : null;
  const root = canonicalPath(range.cwd);
  const stat = target.stat ?? (await gitDiffStat(range.cwd, range.range, {
    includeUntracked: range.live,
    untrackedCap: MAX_UNTRACKED_COUNTS,
  })).stat;
  // No recorded delivery (89 of the cards landed by `merge task <id>` on main
  // have none): the attempt still names the worktree the topic wrote in.
  const taskBranch = task.deliveryBranch ?? task.attemptBranch;
  const deliveredFrom = taskBranch?.split("/").pop();
  const tree: TaskTree | null = wt?.absPath ? { path: wt.absPath } : deliveredFrom ? { name: deliveredFrom } : null;
  const { files, rest } = rangeFiles(stat, touched, tree);
  // The rest is asked of git only in the tree the range reads, the live
  // worktree: a landed range reads the shared checkout, where `src/a.ts` of a
  // wrong-tree write would come back as a second row named like the range's.
  const [outside, branch] = await Promise.all([
    !rest.length ? [] : range.live ? toolCallFiles(root, rest).then((r) => r.files) : rest.map(uncounted),
    live?.branch ?? wt?.branchName ?? taskBranch ?? currentBranch(range.cwd),
  ]);
  // No `dirty`: the range does not ask which of its files are still
  // uncommitted, and nothing reads that number to pay a git call per turn.
  return {
    files: outside.length ? [...files, ...outside].sort(newestFirst) : files,
    git: { root, branch },
    taskId: task.id,
  };
}

/** A tool call's row as the call alone describes it: its own path, no counts. */
function uncounted({ path, kind, turns, lastAt }: TouchedFile): TopicChangedFile {
  return { path, kind, turns, lastAt };
}

/**
 * The tool calls' files crossed with git in `root`: repository-relative paths,
 * with `status` and `diff --numstat` both given an explicit pathspec, so the
 * counts describe these files and not the working tree around them. A file
 * written OUTSIDE the repo keeps its own path and stays out of every git call.
 * `dirty` counts the ones git still reports as changed.
 */
async function toolCallFiles(root: string, touched: TouchedFile[]): Promise<{ files: TopicChangedFile[]; dirty: number }> {
  const { inside, outside } = splitByRepo(root, touched);
  const scoped = inside.slice(0, MAX_GIT_PATHS);
  const pathspec = scoped.map((f) => f.rel);

  const head = pathspec.length ? await hasHead(root) : false;
  const [status, numstat] = await Promise.all([
    pathspec.length ? git(root, ["status", "--porcelain", "-z", "--", ...pathspec]) : Promise.resolve({ code: 0, text: "" }),
    pathspec.length
      ? git(root, head ? ["diff", "HEAD", "--numstat", "-z", "--", ...pathspec] : ["diff", "--numstat", "-z", "--", ...pathspec])
      : Promise.resolve({ code: 0, text: "" }),
  ]);

  const xyByPath = new Map<string, string>();
  for (const entry of parsePorcelainZ(status.text)) xyByPath.set(entry.path, entry.status);
  const stats = parseNumstatZ(numstat.text);

  // Untracked files are absent from every `git diff` against HEAD: their whole
  // content is the addition, and only `--no-index` will count it.
  let untrackedLeft = MAX_UNTRACKED_COUNTS;
  const files: TopicChangedFile[] = [];
  for (const { touched: file, rel } of scoped) {
    const xy = xyByPath.get(rel) ?? null;
    let stat = stats.get(rel);
    if (!stat && xy?.includes("?") && untrackedLeft > 0) {
      untrackedLeft -= 1;
      const counted = await git(root, ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", rel]);
      stat = parseNumstatZ(counted.text).get(rel) ?? [...parseNumstatZ(counted.text).values()][0];
    }
    files.push({
      path: rel,
      kind: refineKind(file.kind, xy),
      turns: file.turns,
      lastAt: file.lastAt,
      ...countsOf(stat),
    });
  }
  for (const file of [...inside.slice(MAX_GIT_PATHS).map((f) => f.touched), ...outside]) files.push(uncounted(file));
  return { files, dirty: xyByPath.size };
}

/**
 * The changes of one topic: its write tool calls, crossed with git when the
 * topic has a folder inside a repository, and the revisions of the target they
 * were read on (`revs`, the same the changeset route answers).
 *
 * Outside a repository (or without git at all) the answer is still useful: the
 * paths, the kinds the tool calls imply, and `git: null`.
 */
export async function computeTopicChanges(
  cwd: string | null | undefined,
  messages: TouchedMessage[],
  anchors?: TopicRangeAnchors | null,
): Promise<TopicChanges> {
  const touched = aggregateTouchedFiles(messages);
  const target = await resolveTopicChangeTarget(cwd, messages, anchors, touched);
  if (!target) return { files: touched.map(uncounted), git: null, revs: null };
  if (target.kind === "range") {
    const [listed, revs] = await Promise.all([rangeChanges(target, anchors!, touched), revsOfTarget(target)]);
    return { ...listed, revs };
  }
  const root = target.cwd;
  const [branch, { files, dirty }, revs] = await Promise.all([currentBranch(root), toolCallFiles(root, touched), revsOfTarget(target)]);
  // `dirty` counts the topic's OWN files that git still reports as changed,
  // not the dirt of the whole repository: the panel is about this topic.
  return { files, git: { root, branch, dirty }, revs };
}
