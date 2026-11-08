/**
 * A board agent must never change the branch of a LIVE checkout.
 *
 * Why it exists: a card session ran `git checkout -b <name>` in the human's own
 * checkout (the one the production server runs from) and committed there, so
 * the server kept running a branch nobody had published. A card's work belongs
 * in its own worktree; the live checkout stays on the branch it was left on.
 *
 * The cure is a `PreToolUse` hook on `Bash`, passed through `--settings` to
 * dispatched sessions only (see `buildClaudeArgs`). It refuses a command that
 * moves HEAD (`git checkout`/`switch` to another branch, a new branch, a
 * detached ref) when the directory it would run in is a main working tree,
 * that is a checkout whose `.git` is the common dir. A linked worktree has its
 * own HEAD, so the agent keeps full use of git there.
 *
 * `evaluateBranchChange` is self-contained ON PURPOSE: the hook ships as its
 * own source text (`Function.prototype.toString`) inside a `bun -e` command, so
 * it can reference nothing outside its own body.
 */

export interface BranchGuardInput {
  command: string;
  cwd: string;
}

/** Runs `git <args>` in `dir`; null when git fails (not a repo, missing dir). */
export type BranchGuardGit = (dir: string, args: string[]) => string | null;

export function evaluateBranchChange(input: BranchGuardInput, git: BranchGuardGit): string | null {
  const isAbsolute = (p: string): boolean => /^([a-zA-Z]:)?[\\/]/.test(p);
  const join = (base: string, rel: string): string => (isAbsolute(rel) ? rel : `${base.replace(/[\\/]+$/, "")}/${rel}`);
  const unquote = (t: string): string => t.replace(/^(['"])(.*)\1$/, "$2");
  const isLive = (dir: string): boolean => {
    const out = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
    if (!out) return false;
    const [gitDir, common] = out.split(/\r?\n/).map((l) => l.trim());
    return !!gitDir && !!common && gitDir === common;
  };
  const movesHead = (args: string[]): boolean => {
    const sub = args[0];
    if (sub !== "checkout" && sub !== "switch") return false;
    const rest = args.slice(1);
    // File restores never move HEAD.
    if (rest.includes("--") && !rest.some((a) => /^-[bBcC]$|^--orphan$|^--detach$/.test(a))) return false;
    const flags = rest.filter((a) => a.startsWith("-"));
    if (flags.some((a) => /^(-p|--patch|--ours|--theirs|--merge)$/.test(a))) return false;
    const positional = rest.filter((a) => !a.startsWith("-"));
    if (flags.some((a) => /^-[bBcC]/.test(a) || a === "--orphan" || a === "--detach" || a === "-d")) return true;
    if (positional.length === 0) return false;
    // `git checkout .` restores the tree; anything else here names a ref.
    if (sub === "checkout" && positional.length === 1 && positional[0] === ".") return false;
    return true;
  };

  let dir = input.cwd;
  for (const segment of input.command.split(/&&|\|\||;|\||\n/)) {
    const tokens = (segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
    if (tokens[0] === "cd" && tokens[1]) {
      dir = join(dir, tokens[1]);
      continue;
    }
    const at = tokens.indexOf("git");
    if (at < 0) continue;
    let where = dir;
    let i = at + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      if (tokens[i] === "-C" && tokens[i + 1]) {
        where = join(where, tokens[i + 1]);
        i += 2;
      } else if (tokens[i] === "-c") {
        i += 2;
      } else {
        i += 1;
      }
    }
    if (movesHead(tokens.slice(i)) && isLive(where)) {
      return (
        "Refused: this is a live checkout, and a board agent never changes its branch. "
        + "Work in your own worktree (the working directory you were started in) and commit there."
      );
    }
  }
  return null;
}

/** The `bun -e` source of the hook: reads the hook JSON, exits 2 to refuse. */
function hookSource(): string {
  return `
const evaluate = ${evaluateBranchChange.toString()};
const { spawnSync } = await import("node:child_process");
const data = JSON.parse(await Bun.stdin.text());
const reason = evaluate(
  { command: String(data?.tool_input?.command ?? ""), cwd: String(data?.cwd ?? process.cwd()) },
  (dir, args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
    return r.status === 0 ? r.stdout : null;
  },
);
if (reason) { console.error(reason); process.exit(2); }
`;
}

/** Base64 keeps the source clear of every shell quoting rule. */
export const LIVE_CHECKOUT_GUARD_CMD =
  `bun -e "eval('(async()=>{'+atob('${Buffer.from(hookSource()).toString("base64")}')+'})()')"`;

export const LIVE_CHECKOUT_GUARD_SETTINGS = {
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: LIVE_CHECKOUT_GUARD_CMD }] }],
  },
};
