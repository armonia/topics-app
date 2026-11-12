/**
 * A small, conservative reader of a bash command line, for the native guards.
 *
 * WHAT IT IS FOR. The `rm` rule has to answer "where do these targets point?"
 * and the turn-files registry "which paths does this command create?". Both
 * need the same three facts the text of one segment cannot give: the directory
 * the segment runs in (`cd /tmp && rm -rf z`), what a variable the command set
 * itself stands for (`W=/tmp/aw; rm -rf $W/pg`), and which words are
 * redirections rather than arguments (`rm -rf /tmp/x 2>/dev/null`).
 *
 * WHAT IT IS NOT. It is not a shell. It splits on `; & | newline` like the
 * guard always did, knows `cd`, plain assignments and `mktemp`, and for
 * everything else says "unknown" (`null`). Every caller treats unknown as
 * "not provably safe", so a form this reader does not understand costs a
 * refusal, never a permission. That is the whole design: no clever parsing,
 * only a short list of forms it is sure about.
 */

import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { expandHome } from "../../lib/expand-home";
import { scratchRoots, shellTmpdir } from "./temp-roots";

/** The separators the guard has always split a command on (a newline too, handled line by line). */
const SEGMENT_SPLIT = /[;&|]+/;

/** A lone redirection operator: `>`, `>>`, `2>`, `&>`, `<`, `<<`, `2>&1`. */
const REDIR_OP = /^(\d*|&)(>>|>\||>|<<<|<<|<)(&\d*-?)?$/;
/** An operator with its target glued on: `2>/dev/null`, `>>log`, `<<'EOF'`. */
const REDIR_GLUED = /^(\d*|&)(>>|>\||>|<<<|<<|<)(.+)$/;

export interface Redirect {
  op: string;
  target: string;
}

export interface ShellSegment {
  /** The raw text of the segment. */
  text: string;
  /** Its words, redirections removed. */
  tokens: string[];
  redirects: Redirect[];
  /** Where the segment runs, or null when a `cd` made it unknowable. */
  cwd: string | null;
  /** What the command assigned so far: a path, or null when it is not provably one. */
  vars: ReadonlyMap<string, string | null>;
  /** The segment is a line of a heredoc body: data for another program, not a command of this shell. */
  inHeredoc: boolean;
}

/** Strip one quote at each end, the way the rm rule always read its targets. */
export function unquote(t: string): string {
  return t.replace(/^["']|["']$/g, "");
}

/** Split a segment into words and redirections. Empty words never exist. */
function parseWords(text: string): { tokens: string[]; redirects: Redirect[] } {
  const words = text.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const redirects: Redirect[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const lone = REDIR_OP.exec(w);
    if (lone) {
      // `2>&1` carries its own target (a descriptor); `>` and `<<` take the next word.
      redirects.push({ op: lone[2]!, target: lone[3] ?? words[++i] ?? "" });
      continue;
    }
    const glued = REDIR_GLUED.exec(w);
    if (glued) {
      redirects.push({ op: glued[2]!, target: glued[3]! });
      continue;
    }
    tokens.push(w);
  }
  return { tokens, redirects };
}

/** The arguments of the first word of `text` matching `word`, redirections removed. */
export function argsAfterWord(text: string, word: RegExp): string[] {
  const at = text.search(word);
  return at < 0 ? [] : parseWords(text.slice(at)).tokens.slice(1);
}

/** `$NAME` or `${NAME}` at the start of a word, replaced by what it stands for; null when unknown. */
function expandLeadingVar(word: string, vars: ReadonlyMap<string, string | null>): string | null {
  const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))(.*)$/.exec(word);
  if (!m) return word;
  const name = (m[1] ?? m[2])!;
  const value = vars.has(name) ? vars.get(name) : name === "TMPDIR" ? shellTmpdir() : undefined;
  return value == null ? null : value + m[3]!;
}

/**
 * The absolute path a word stands for, read STRICTLY: a leftover `$`, backtick,
 * parenthesis or brace means the shell would still rewrite it, so the answer is
 * unknown. Relative words resolve against `cwd` and are unknown without one.
 */
function resolveWord(raw: string, vars: ReadonlyMap<string, string | null>, cwd: string | null): string | null {
  let t = expandLeadingVar(raw, vars);
  if (t === null) return null;
  if (/[$`(){}]/.test(t)) return null;
  if (t === "~" || t.startsWith("~/")) t = homedir() + t.slice(1);
  else if (t.startsWith("~")) return null;
  if (isAbsolute(t)) return resolve(t);
  return cwd ? resolve(cwd, t) : null;
}

/**
 * Where an `rm` or a creation target points, or null when it cannot be known.
 *
 * An ABSOLUTE LITERAL is taken as written, exactly as the rule always did
 * (`/tmp/x/$c` was and is accepted). Anything that needs a variable, a `~` or
 * the current directory to be understood is the new reach, and gets the strict
 * reading of `resolveWord`. A `..` anywhere is unknown, in both.
 */
export function resolveTarget(raw: string, seg: ShellSegment): string | null {
  const t = unquote(raw);
  if (t.includes("..")) return null;
  if (t.startsWith("/")) return resolve(t);
  return resolveWord(t, seg.vars, seg.cwd);
}

/** What `$(mktemp ...)` yields, as a path under a scratch root; null for forms this reader does not know. */
function mktempResult(args: string, cwd: string | null): string | null {
  let useTmpdir = false;
  let template: string | null = null;
  for (const a of args.split(/\s+/).filter(Boolean)) {
    if (a.startsWith("-")) {
      // Only the flags that do not move the result; `-p DIR` and `--tmpdir` do.
      if (!/^-[dtuq]+$/.test(a)) return null;
      if (a.includes("t")) useTmpdir = true;
    } else if (template === null) {
      template = unquote(a);
    } else {
      return null;
    }
  }
  const root = scratchRoots()[0]!;
  if (template === null) return resolve(root, "tmp.mktemp");
  if (template.startsWith("~") && !template.startsWith("~/")) return null;
  const expanded = template.startsWith("~/") ? homedir() + template.slice(1) : template;
  // A bare template lives in the current directory, unless `-t` sends it to the temp dir.
  const abs = isAbsolute(expanded) ? resolve(expanded) : useTmpdir && !expanded.includes("/") ? resolve(root, expanded) : cwd ? resolve(cwd, expanded) : null;
  return abs && !/[$`(){}]/.test(abs) ? abs : null;
}

const ASSIGNMENT = /^\s*(?:(?:export|local|declare|typeset|readonly)\s+(?:-[A-Za-z]+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/;
const MKTEMP = /^(?:\$\(\s*mktemp\b([^)]*)\)|`\s*mktemp\b([^`]*)`)$/;
const ONE_WORD = /^(?:"([^"]*)"|'([^']*)'|(\S+))$/;

/** Record `NAME=value` in `vars`: a path when provable, null otherwise (so a reassignment forgets the old path). */
function applyAssignment(text: string, vars: Map<string, string | null>, cwd: string | null): void {
  const m = ASSIGNMENT.exec(text);
  if (!m) return;
  const name = m[1]!;
  const rhs = m[2]!;
  const mk = MKTEMP.exec(rhs);
  if (mk) {
    vars.set(name, mktempResult(mk[1] ?? mk[2] ?? "", cwd));
    return;
  }
  // `NAME=value command ...` sets the variable for that command only, and has spaces: unknown here.
  const word = ONE_WORD.exec(rhs);
  const single = rhs.startsWith("'");
  vars.set(name, word && !single ? resolveWord((word[1] ?? word[3])!, vars, cwd) : null);
}

/** True when `dir` exists and is a directory right now. */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory after `cd ARGS`. Unknown unless it is a plain `cd <dir>` into a
 * directory that EXISTS: after `cd /tmp/typo; rm -rf build` a failed `cd` leaves
 * the shell where it was, and the `rm` would run in the workspace.
 */
function cdTarget(args: string[], cwd: string | null, vars: ReadonlyMap<string, string | null>): string | null {
  if (args.includes("-")) return null;
  const dirs = args.filter((a) => !a.startsWith("-"));
  if (dirs.length === 0) return homedir();
  if (dirs.length > 1) return null;
  const target = resolveWord(unquote(dirs[0]!), vars, cwd);
  return target && isDirectory(target) ? target : null;
}

/** `cd`, `pushd` or `popd` anywhere in a segment: used to forget the directory when the form is not a plain `cd`. */
const MENTIONS_CD = /(^|[\s({])(cd|pushd|popd)(\s|$)/;

/** The delimiter of the heredoc a line opens (`<<'EOF'`, `<<-EOF`, `<<"EOF"`), or null. A here-string `<<<` is not one. */
function heredocDelimiter(line: string): string | null {
  const m = /(?<!<)<<(?!<)-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w-]*))/.exec(line);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

const NO_VARS: ReadonlyMap<string, string | null> = new Map();

/**
 * Visit each segment of `cmd` in order, with the directory and the variables as
 * they stand BEFORE it runs. `startCwd` is where the command starts; null when
 * the caller does not know.
 *
 * THE LINES OF A HEREDOC BODY ARE VISITED TOO, because the rm rule has always
 * read them as text. But they get no directory and no variables, and they never
 * change either: `cat > s.sh <<'EOF'` followed by a body line `cd /tmp` must not
 * move the directory the NEXT real command runs in.
 */
export function walkShell(cmd: string, startCwd: string | null, visit: (seg: ShellSegment) => void): void {
  let cwd = startCwd;
  const vars = new Map<string, string | null>();
  let heredocEnd: string | null = null;
  for (const line of cmd.split("\n")) {
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      else {
        for (const text of line.split(SEGMENT_SPLIT)) {
          visit({ text, ...parseWords(text), cwd: null, vars: NO_VARS, inHeredoc: true });
        }
      }
      continue;
    }
    for (const text of line.split(SEGMENT_SPLIT)) {
      const { tokens, redirects } = parseWords(text);
      visit({ text, tokens, redirects, cwd, vars, inHeredoc: false });
      if (tokens[0] === "cd") cwd = cdTarget(tokens.slice(1), cwd, vars);
      else if (MENTIONS_CD.test(text)) cwd = null;
      else applyAssignment(text, vars, cwd);
    }
    heredocEnd = heredocDelimiter(line);
  }
}

/** The directory a call starts in: its `cwd` input, relative to the workspace; null without a workspace to anchor to. */
export function callCwd(input: Record<string, unknown>, workspace: string | undefined): string | null {
  const raw = typeof input.cwd === "string" && input.cwd ? expandHome(input.cwd) : "";
  if (raw && isAbsolute(raw)) return resolve(raw);
  if (!workspace) return null;
  return raw ? resolve(workspace, raw) : resolve(workspace);
}

/** True when something is at `abs` right now, a dangling symlink included. */
export function pathExists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute paths a segment creates, as far as its text says so: `>`, `>|`
 * and `>>` redirections, `touch`, `mkdir`, `tee` and `cp`. A form that only
 * touches a file that was already there (`>>` on an old log, `touch` on an old
 * file) is fine here: whether the path really is NEW is the caller's check, made
 * before anything runs. Globs are left out because they name files that exist.
 */
export function segmentCreations(seg: ShellSegment): string[] {
  if (seg.inHeredoc) return [];
  const out: string[] = [];
  const add = (raw: string) => {
    if (/[*?[]/.test(raw)) return;
    const abs = resolveTarget(raw, seg);
    if (abs) out.push(abs);
  };
  for (const r of seg.redirects) if ((r.op === ">" || r.op === ">|" || r.op === ">>") && !r.target.startsWith("&")) add(r.target);
  const [head, ...args] = seg.tokens;
  const words = args.filter((a) => !a.startsWith("-"));
  if (head === "touch" || head === "mkdir") words.forEach(add);
  else if (head === "tee") words.forEach(add);
  else if (head === "cp" && words.length >= 2) {
    // Into an existing directory the new files are `dir/<source name>`, not the directory.
    const dest = unquote(words[words.length - 1]!);
    const destAbs = resolveTarget(dest, seg);
    const intoDir = dest.endsWith("/") || (destAbs !== null && isDirectory(destAbs));
    if (intoDir) for (const src of words.slice(0, -1)) add(join(dest, basename(unquote(src))));
    else add(dest);
  }
  return out;
}
