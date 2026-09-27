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
 * range decides the file set (`taskRangeChanges`), and the tool calls only say
 * how many turns wrote each file.
 */
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { existsSync, realpathSync } from "fs";
import { parsePorcelainZ } from "./git-porcelain";
import { parseNumstatZ, type Numstat } from "./git-numstat";
import { gitDiffStat, runGitRead as git, type DiffStatEntry } from "./git-diff-stat";
import { resolveTaskDiffRange } from "../services/task-diff-range";
import { deriveToolDetail } from "../providers/claude/tool-detail";
import type { ToolCall } from "../../shared/types";
import type { TopicChangeKind, TopicChangedFile, TopicChanges } from "../../shared/topic-changes";

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
  return [...byPath.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
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
 * Untracked files cost one `--no-index` spawn each: count the first few only.
 * On a task's range the ones past it are not listed at all, which is what the
 * drawer does past its own, larger cap.
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
  let current = resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      tail.unshift(basename(current));
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
 * The range path a tool call's path names, or `null`.
 *
 * A tool call carries the path the agent wrote, absolute and often inside a
 * worktree that is already pruned, so it cannot be made relative to any root
 * still on disk. It is matched by suffix instead: `/any/wt/src/a.ts` is
 * `src/a.ts`, the LONGEST range path it ends with, so a root-level `a.ts`
 * does not take it.
 */
function rangePathOf(path: string, inRange: Map<string, unknown>): string | null {
  const segments = path.split(/[\\/]+/).filter((s) => s && s !== ".");
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join("/");
    if (inRange.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The files of a task's diff range, each with the turns and the last write of
 * the tool calls that name it. A file no tool call names (a shell command, a
 * sub-agent) has `turns: 0`; a tool call path outside the range is dropped,
 * since git says it left no change.
 */
export function rangeFiles(stat: DiffStatEntry[], touched: TouchedFile[]): TopicChangedFile[] {
  const writes = new Map(stat.map((s) => [s.path, { turns: 0, lastAt: "" }]));
  for (const file of touched) {
    const rel = rangePathOf(file.path, writes);
    const seen = rel ? writes.get(rel) : undefined;
    if (!seen) continue;
    seen.turns += file.turns;
    if (file.lastAt > seen.lastAt) seen.lastAt = file.lastAt;
  }
  const files = stat.map((s): TopicChangedFile => {
    const { turns, lastAt } = writes.get(s.path)!;
    const kind: TopicChangeKind = s.status === "A" ? "created" : s.status === "D" ? "deleted" : "modified";
    const binary = s.additions < 0 || s.deletions < 0;
    return { path: s.path, kind, turns, lastAt, ...(binary ? { added: 0, removed: 0, binary } : { added: s.additions, removed: s.deletions }) };
  });
  // Newest write first, like the tool-call list; stable, so the files no tool
  // call named keep git's order after them.
  return files.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/** What the `/changes` route knows about the task dispatched to a topic. */
export interface TopicTaskAnchors {
  task: { id: string; deliveryBranch: string | null; deliveryCommit: string | null };
  /** The topic's worktree row, while it still has one. */
  worktree: { absPath: string; mode: string; branchName: string | null } | null;
  /** The project's own checkout: where main, and so the land merge, lives. */
  repoPath: string | null;
}

/**
 * A task topic's changes, read from the task's own diff range: the one the
 * drawer draws (`resolveTaskDiffRange`: the live worktree, then the land
 * merge, then the delivery commit).
 *
 * Git owns the file set here because the tool calls got it wrong twice (review
 * of 23/09): once the worktree is pruned every tool call path points into a
 * folder that is gone (d6158ec6: 42 paths, 0 resolved), and a file a shell
 * command or a sub-agent wrote has no write tool call at all (e8e3b8bf: strip
 * 5, git 9). `null` = no range to read, and the tool calls answer as before.
 */
async function taskRangeChanges(anchors: TopicTaskAnchors, touched: TouchedFile[]): Promise<TopicChanges | null> {
  const wt = anchors.worktree;
  // The drawer's anchors (`routes/tasks.ts`): only a branch worktree still on disk is live.
  const live = wt && wt.mode === "branch" && wt.absPath && existsSync(wt.absPath)
    ? { cwd: wt.absPath, branch: wt.branchName }
    : null;
  const range = await resolveTaskDiffRange({
    taskId: anchors.task.id,
    worktree: live,
    repoPath: anchors.repoPath,
    delivery: { branch: anchors.task.deliveryBranch, commit: anchors.task.deliveryCommit },
  });
  if (!range) return null;
  const { stat } = await gitDiffStat(range.cwd, range.range, {
    includeUntracked: range.live,
    untrackedCap: MAX_UNTRACKED_COUNTS,
  });
  const branch = live?.branch ?? wt?.branchName ?? anchors.task.deliveryBranch ?? (await currentBranch(range.cwd));
  // No `dirty`: the range does not ask which of its files are still
  // uncommitted, and nothing reads that number to pay a git call per turn.
  return { files: rangeFiles(stat, touched), git: { root: canonicalPath(range.cwd), branch } };
}

/**
 * The changes of one topic: its write tool calls, crossed with git when the
 * topic has a folder inside a repository.
 *
 * `cwd` is the topic's worktree if it has one, its project folder otherwise.
 * Outside a repository (or without git at all) the answer is still useful: the
 * paths, the kinds the tool calls imply, and `git: null`. `task` is set on a
 * topic a task was dispatched to, and its range goes first.
 */
export async function computeTopicChanges(
  cwd: string | null | undefined,
  messages: TouchedMessage[],
  task?: TopicTaskAnchors | null,
): Promise<TopicChanges> {
  const touched = aggregateTouchedFiles(messages);
  if (task) {
    const fromRange = await taskRangeChanges(task, touched);
    if (fromRange) return fromRange;
  }
  const plain = (): TopicChanges => ({
    files: touched.map(({ path, kind, turns, lastAt }) => ({ path, kind, turns, lastAt })),
    git: null,
  });
  if (!touched.length || !cwd) return plain();

  const root = await repoRoot(cwd);
  if (!root) return plain();

  // Repository-relative paths, which is what a pathspec wants and what the
  // panel shows. A file the agent wrote OUTSIDE the repo keeps its own path
  // and stays out of every git call.
  const inside: Array<{ touched: TouchedFile; rel: string }> = [];
  const outside: TouchedFile[] = [];
  for (const file of touched) {
    const abs = canonicalPath(isAbsolute(file.path) ? file.path : resolve(root, file.path));
    const rel = relative(root, abs);
    if (!rel || rel.startsWith("..")) outside.push(file);
    else inside.push({ touched: file, rel });
  }
  const scoped = inside.slice(0, MAX_GIT_PATHS);
  const pathspec = scoped.map((f) => f.rel);

  const [branch, head] = await Promise.all([currentBranch(root), hasHead(root)]);
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
  for (const file of [...inside.slice(MAX_GIT_PATHS).map((f) => f.touched), ...outside]) {
    files.push({ path: file.path, kind: file.kind, turns: file.turns, lastAt: file.lastAt });
  }

  return {
    files,
    // `dirty` counts the topic's OWN files that git still reports as changed,
    // not the dirt of the whole repository: the panel is about this topic.
    git: { root, branch, dirty: xyByPath.size },
  };
}
