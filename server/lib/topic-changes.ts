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
 */
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { realpathSync } from "fs";
import { gitRead, parsePorcelainZ } from "./git-porcelain";
import { parseNumstatZ, type Numstat } from "./git-numstat";
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

/** Tool names that write a file even on rows too old to carry a `detail`. */
const WRITE_TOOL_NAMES = new Set(["write", "edit", "multiedit", "str_replace_editor", "apply_patch"]);

/** The path a write tool call names, or `null` if it is not a write. */
function writtenPath(call: ToolCall): { path: string; whole: boolean } | null {
  // A call that ended in an error wrote nothing: listing it would promise a
  // change that is not on disk.
  if (call.error) return null;
  const detail = call.detail;
  if (detail && (detail.type === "write" || detail.type === "edit")) {
    return detail.filePath ? { path: detail.filePath, whole: detail.type === "write" } : null;
  }
  if (detail) return null;
  // Older rows and stateless providers carry no typed detail: fall back to the
  // raw arguments, which is the only thing left that names the file.
  if (!WRITE_TOOL_NAMES.has(call.name?.toLowerCase() ?? "")) return null;
  const args = call.args ?? {};
  const raw = args.file_path ?? args.filePath ?? args.path;
  if (typeof raw !== "string" || !raw) return null;
  return { path: raw, whole: call.name.toLowerCase() === "write" };
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
/** Untracked files cost one `--no-index` spawn each: count the first few only. */
const MAX_UNTRACKED_COUNTS = 50;

async function git(cwd: string, args: string[]): Promise<{ code: number; text: string }> {
  try {
    const proc = Bun.spawn(gitRead(...args), { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return { code: proc.exitCode ?? 1, text };
  } catch {
    // No git on the machine, or a directory that vanished: the panel degrades
    // to the tool calls alone instead of failing the request.
    return { code: 1, text: "" };
  }
}

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
 * The changes of one topic: its write tool calls, crossed with git when the
 * topic has a folder inside a repository.
 *
 * `cwd` is the topic's worktree if it has one, its project folder otherwise.
 * Outside a repository (or without git at all) the answer is still useful: the
 * paths, the kinds the tool calls imply, and `git: null`.
 */
export async function computeTopicChanges(
  cwd: string | null | undefined,
  messages: TouchedMessage[],
): Promise<TopicChanges> {
  const touched = aggregateTouchedFiles(messages);
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
