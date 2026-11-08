/**
 * THE FILE A COMMAND SENDS ITS OWN STDOUT TO (chat-live-work).
 *
 * `run_command` writes the command's stdout and stderr into its log
 * (`<processId>.log`, CMDRUN-03), and the panel reads that. A command that
 * sends its stdout to a file takes it away from the log: on 07/10 Muse ran for
 * 58 minutes with `freeagent … > /tmp/fa-wallrunv2.log 2>&1`, and the panel said
 * «Waiting for output...» with all the work in the file. This finds that file,
 * so the registry can follow it beside the log.
 *
 * ONLY WHAT THE COMMAND NAMES, read the way the shell would read it but
 * without running anything: the stdout redirects (`> f`, `>> f`, `>| f`,
 * `1> f`, `&> f`, `&>> f`, `>& f`), and `tee f` when tee's own output goes
 * elsewhere. With tee's output in the log those lines are there already, and
 * following the file would write them twice. A relative path resolves against
 * the command's folder, or against a literal `cd` before it.
 *
 * NOTHING IS EXPANDED. A path with `$VAR`, a backtick or a glob is not
 * followed, and says so (`unresolved`), so the panel explains the empty log
 * instead of waiting in silence. What is inside `$( … )` and backticks is not
 * the command's stdout, a heredoc's body is not a command, and inside `[[ ]]`
 * and `(( ))` a `>` is a comparison.
 *
 * `/dev/null`, `/dev/stdout` and the rest of `/dev` are not files to follow.
 * With several files, the first one the command names wins.
 */
import { isAbsolute, join, resolve } from "path";

export type StdoutTarget =
  | { kind: "file"; path: string; append: boolean }
  | { kind: "unresolved"; target: string; reason: UnresolvedReason };

/** `variable`: `$…`, a backtick, `~user`. `pattern`: a glob. `cwd`: relative after a `cd` nobody can read. */
export type UnresolvedReason = "variable" | "pattern" | "cwd";

interface Word { t: "word"; text: string; dynamic: UnresolvedReason | null; tilde: boolean }
interface Op { t: "op"; op: string }
interface Redirect { t: "redir"; fd: number | null; op: string }
type Token = Word | Op | Redirect;

const SPACE = /[ \t\r]/;
const WORD_END = /[ \t\r\n;&|()<>]/;
/** What stands before a command's name without being it: a reserved word, an assignment. */
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "while", "until", "do", "time"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The index after the bracket that closes the one opened at `start`, skipping quotes and nesting. */
function skipBalanced(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const end = s.indexOf("'", i + 1); i = end < 0 ? s.length : end; continue; }
    if (c === "\"") { i = skipDoubleQuoted(s, i + 1) - 1; continue; }
    if (c === "`") { i = skipBacktick(s, i + 1) - 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return s.length;
}

/** The index after the closing `"`, from the first character inside. */
function skipDoubleQuoted(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "$" && s[i + 1] === "(") { i = skipBalanced(s, i + 1, "(", ")") - 1; continue; }
    if (s[i] === "`") { i = skipBacktick(s, i + 1) - 1; continue; }
    if (s[i] === "\"") return i + 1;
  }
  return s.length;
}

function skipBacktick(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") return i + 1;
  }
  return s.length;
}

/**
 * The command's words and operators. A word keeps its value without quotes,
 * and whether it depends on something only the shell knows.
 */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const heredocs: Array<{ delim: string; stripTabs: boolean }> = [];
  let expectHeredocDelimiter: { stripTabs: boolean } | null = null;
  let i = 0;

  const push = (token: Token) => {
    if (token.t === "word" && expectHeredocDelimiter) {
      heredocs.push({ delim: token.text, stripTabs: expectHeredocDelimiter.stripTabs });
      expectHeredocDelimiter = null;
    }
    out.push(token);
  };

  /** The bodies of the heredocs opened on this line: lines skipped up to the delimiter. */
  const skipHeredocBodies = () => {
    for (const h of heredocs) {
      while (i < s.length) {
        const end = s.indexOf("\n", i);
        const line = s.slice(i, end < 0 ? s.length : end);
        i = end < 0 ? s.length : end + 1;
        if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delim) break;
      }
    }
    heredocs.length = 0;
  };

  while (i < s.length) {
    const c = s[i]!;
    if (SPACE.test(c)) { i++; continue; }
    if (c === "\\" && s[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n") { out.push({ t: "op", op: "\n" }); i++; skipHeredocBodies(); continue; }
    if (c === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === ";") { push({ t: "op", op: ";" }); i += s[i + 1] === ";" ? 2 : 1; continue; }
    if (c === "&") {
      if (s[i + 1] === "&") { push({ t: "op", op: "&&" }); i += 2; continue; }
      if (s[i + 1] === ">") { const app = s[i + 2] === ">"; push({ t: "redir", fd: null, op: app ? "&>>" : "&>" }); i += app ? 3 : 2; continue; }
      push({ t: "op", op: "&" }); i++; continue;
    }
    if (c === "|") {
      if (s[i + 1] === "|" || s[i + 1] === "&") { push({ t: "op", op: s[i + 1] === "|" ? "||" : "|&" }); i += 2; continue; }
      push({ t: "op", op: "|" }); i++; continue;
    }
    if (c === "(") {
      // `(( … ))` at the head of a command is arithmetic, where `>` compares.
      const prev = out[out.length - 1];
      if (s[i + 1] === "(" && (!prev || prev.t === "op")) { i = skipBalanced(s, i, "(", ")"); continue; }
      push({ t: "op", op: "(" }); i++; continue;
    }
    if (c === ")") { push({ t: "op", op: ")" }); i++; continue; }
    if ((c === ">" || c === "<") && s[i + 1] === "(") {
      // Process substitution: a file name that exists only inside the shell.
      i = skipBalanced(s, i + 1, "(", ")");
      push({ t: "word", text: "", dynamic: "variable", tilde: false });
      continue;
    }
    if (c === ">" || c === "<") { i = readRedirectOp(s, i, null, push, (strip) => { expectHeredocDelimiter = { stripTabs: strip }; }); continue; }

    // A word. A number right against `>`/`<` is the redirect's descriptor.
    const fd = /^\d+(?=[<>])/.exec(s.slice(i, i + 12));
    if (fd) { i = readRedirectOp(s, i + fd[0].length, Number(fd[0]), push, (strip) => { expectHeredocDelimiter = { stripTabs: strip }; }); continue; }
    let text = "";
    let dynamic: UnresolvedReason | null = null;
    const tilde = c === "~";
    while (i < s.length && !WORD_END.test(s[i]!)) {
      const ch = s[i]!;
      if (ch === "\\") { if (s[i + 1] !== "\n") text += s[i + 1] ?? ""; i += 2; continue; }
      if (ch === "'") { const end = s.indexOf("'", i + 1); text += s.slice(i + 1, end < 0 ? s.length : end); i = end < 0 ? s.length : end + 1; continue; }
      if (ch === "$" && s[i + 1] === "'") {
        let j = i + 2;
        for (; j < s.length && s[j] !== "'"; j++) if (s[j] === "\\") j++;
        text += s.slice(i + 2, j); i = j + 1; continue;
      }
      if (ch === "\"") {
        const end = skipDoubleQuoted(s, i + 1);
        const inner = s.slice(i + 1, Math.max(i + 1, end - 1));
        if (/[$`]/.test(inner.replace(/\\./g, ""))) dynamic ??= "variable";
        text += inner.replace(/\\(["\\$`])/g, "$1");
        i = end; continue;
      }
      if (ch === "$") {
        dynamic ??= "variable";
        if (s[i + 1] === "(") { i = skipBalanced(s, i + 1, "(", ")"); continue; }
        if (s[i + 1] === "{") { i = skipBalanced(s, i + 1, "{", "}"); continue; }
        text += ch; i++; continue;
      }
      if (ch === "`") { dynamic ??= "variable"; i = skipBacktick(s, i + 1); continue; }
      if (ch === "*" || ch === "?" || ch === "[") dynamic ??= "pattern";
      text += ch; i++;
    }
    push({ t: "word", text, dynamic, tilde });
  }
  return out;
}

/** A redirect operator at `i`; returns the index after it. */
function readRedirectOp(s: string, i: number, fd: number | null, push: (t: Token) => void, heredoc: (stripTabs: boolean) => void): number {
  const ops = [">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", ">", "<"];
  const op = ops.find((o) => s.startsWith(o, i)) ?? s[i]!;
  push({ t: "redir", fd, op });
  if (op === "<<" || op === "<<-") heredoc(op === "<<-");
  return i + op.length;
}

/** It takes the command's stdout: to a file, when the word after it is one. */
function isStdoutRedirect(r: Redirect, target: Word): boolean {
  if (r.op === "&>" || r.op === "&>>") return r.fd === null;
  if (r.fd !== null && r.fd !== 1) return false;
  if (r.op === ">" || r.op === ">>" || r.op === ">|") return true;
  // `>& file` sends stdout and stderr to the file; `>&2` and `>&-` are a descriptor.
  return r.op === ">&" && !target.dynamic && !/^(\d+|-)$/.test(target.text);
}

/** Where a `cd` goes, or null when that is not known without running it. */
function cdTarget(cwd: string | null, args: Word[], home: string): string | null {
  const arg = args.find((a) => !/^-[LPe@]+$/.test(a.text));
  if (!arg) return home;
  if (arg.dynamic || arg.text === "-") return null;
  const path = expandTilde(arg, home);
  if (path === null) return null;
  return isAbsolute(path) ? path : cwd ? resolve(cwd, path) : null;
}

/** `~` and `~/…` on the home; `~user` is somebody else's and stays null. */
function expandTilde(w: Word, home: string): string | null {
  if (!w.tilde) return w.text;
  if (w.text === "~") return home;
  if (w.text.startsWith("~/")) return join(home, w.text.slice(2));
  return null;
}

/**
 * The file `command`, run in `cwd`, sends its own stdout to; null when the
 * stdout reaches the log (or goes to `/dev`).
 */
export function stdoutTargetOf(command: string, opts: { cwd: string; home: string }): StdoutTarget | null {
  const tokens = tokenize(command);
  let cwd: string | null = opts.cwd;
  const subshells: Array<string | null> = [];
  const found: StdoutTarget[] = [];
  let words: Word[] = [];
  let outs: Array<{ r: Redirect; target: Word }> = [];
  let inTest = false;

  const resolveTarget = (w: Word, append: boolean, dir: string | null): StdoutTarget | null => {
    const raw = w.text;
    if (w.dynamic) return { kind: "unresolved", target: raw || "?", reason: w.dynamic };
    const path = expandTilde(w, opts.home);
    if (path === null) return { kind: "unresolved", target: raw, reason: "variable" };
    if (!path) return null;
    if (isAbsolute(path)) return path === "/dev" || path.startsWith("/dev/") ? null : { kind: "file", path, append };
    return dir ? { kind: "file", path: resolve(dir, path), append } : { kind: "unresolved", target: raw, reason: "cwd" };
  };

  const endCommand = () => {
    const name = words[0]?.dynamic ? "" : words[0]?.text;
    const stdoutRedirected = outs.some((o) => isStdoutRedirect(o.r, o.target));
    if (name === "tee" && stdoutRedirected) {
      const append = words.slice(1).some((w) => /^-[a-z]*a/.test(w.text) || w.text === "--append");
      for (const w of words.slice(1)) if (!w.text.startsWith("-") || w.dynamic) { const t = resolveTarget(w, append, cwd); if (t) found.push(t); }
    }
    for (const o of outs) {
      if (!isStdoutRedirect(o.r, o.target)) continue;
      const t = resolveTarget(o.target, o.r.op === ">>" || o.r.op === "&>>", cwd);
      if (t) found.push(t);
    }
    if (name === "cd") cwd = cdTarget(cwd, words.slice(1), opts.home);
    words = [];
    outs = [];
  };

  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (inTest) {
      if (token.t === "word" && token.text === "]]") inTest = false;
      continue;
    }
    if (token.t === "word") {
      if (words.length === 0 && !token.dynamic) {
        if (token.text === "[[") { inTest = true; continue; }
        if (KEYWORDS.has(token.text) || ASSIGNMENT.test(token.text)) continue;
      }
      words.push(token);
      continue;
    }
    if (token.t === "redir") {
      const next = tokens[k + 1];
      if (next?.t !== "word") continue;
      k++;
      if (token.op.startsWith("<")) continue;
      outs.push({ r: token, target: next });
      continue;
    }
    endCommand();
    if (token.op === "(") subshells.push(cwd);
    else if (token.op === ")" && subshells.length) cwd = subshells.pop()!;
  }
  endCommand();
  return found.find((t) => t.kind === "file") ?? found[0] ?? null;
}
