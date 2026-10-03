/**
 * Whether Run on a command asks a second time, and whether it is offered at
 * all (CHAT-RUN-02).
 *
 * A reminder before the click, not a sandbox: the list is short on purpose,
 * and a command it misses costs what pasting the same text in a terminal costs
 * today. A click on every `ls` would teach clicking without reading, so a
 * plain command asks nothing. The WHOLE text is read, also when the code
 * block shows only its first ten lines.
 *
 * The text is read the way sh, bash and zsh (the shell Run uses on macOS)
 * read it, by one small lexer: single quotes, double quotes, ANSI-C `$'...'`
 * (where `\'` is a quote), backslash escapes and line continuations, `$(...)`,
 * `${...}`, backticks and `<(...)` (whose commands are read the same way),
 * comments, redirections, heredocs (whose body is text, and code only for its
 * expansions when the delimiter is unquoted), and the control operators that
 * end a simple command, only where they are not quoted. Each simple command
 * comes out as the words the shell would hand over, quotes removed, and is
 * scanned word by word: past the reserved words that lead into it (`then`,
 * `do`, `!`, `{`, `function name`...), the assignments in front of it
 * (`FOO="a b" rm -rf x`, `A+=1 rm -rf x`) and the wrappers that run another
 * command (`sudo`, `env`, `xargs`, `exec -a`, `builtin`, `watch -x`, zsh's
 * `noglob`...). The commands of find's `-exec`, `-execdir`, `-ok` and `-okdir`
 * are read the same way, up to their `;` or `+`.
 * A command handed over as text is read again from that text: the payload of
 * `sh -c`/`bash -c`/`zsh -c`, of `su -c` and of `env -S`, the words of `eval`,
 * of `watch` (which hands them to `sh -c`) and those after `ssh host` (a
 * command run on another machine is no less destructive),
 * and what a shell reads on its input: a here-string, a heredoc, or the text
 * the command before it in a pipeline was given. Only a command's own name is
 * looked at: `echo "rm -rf x"` asks nothing.
 *
 * A quote or an expansion that never closes makes the shell refuse the line,
 * and which part was meant as the command is a guess: there every word is
 * tried as the start of one, so a destructive word anywhere on it asks. The
 * lexer stops at the first such quote, so the time stays linear in the text:
 * this runs on every render of a runnable block.
 */

export type RiskKind =
  | 'rm' | 'sudo' | 'git-push-force' | 'git-reset-hard' | 'git-clean' | 'git-discard'
  | 'dd' | 'mkfs' | 'diskutil-erase' | 'chmod-recursive' | 'find-delete' | 'xargs-rm'
  | 'pipe-to-shell' | 'kill' | 'launchctl' | 'placeholder';

/** One reason for the second step: what kind, and the words that triggered it, as written. */
export interface RiskReason { kind: RiskKind; text: string }

export interface CommandRisk {
  /** `hidden-chars`: what is shown is not what would run, and Run is not offered. */
  block: 'hidden-chars' | null;
  confirm: RiskReason[];
}

/**
 * Bidi controls (U+202A-U+202E, U+2066-U+2069), zero-width characters
 * (U+200B-U+200D, U+2060, U+FEFF) and C0 control bytes other than tab and
 * newline. Read by code point rather than with a regex of control characters.
 */
function hasHiddenChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a) return true;
    if ((c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

/** `A=1`, `A+=1`, `A[0]=1`: an assignment in front of a command, not its name. */
const ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;
/** Words that lead into a command without being one: `then rm -rf x`, `! git push -f`, `{ rm -rf x; }`. */
const LEADING_RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
/** zsh's short forms open the body with `{` on the condition's line: `if true { rm -rf x }`. */
const BRACE_BODY = new Set(['if', 'elif', 'while', 'until', 'for', 'foreach', 'repeat', 'select']);
/** A backslash at the end of a line: the command goes on on the next one. */
const LINE_CONTINUATION = /\\\r?\n/g;
/** Wrappers that run the command after their options, and the short options that take a value. */
const WRAPPER_VALUE_OPTS = new Map(Object.entries({
  sudo: 'ughpCDURrTt', doas: 'uC', env: 'uCPSa', command: '', exec: 'a', builtin: '', nohup: '', time: '', nice: 'n',
  xargs: 'IJnPLdsERSa', timeout: 'sk', gtimeout: 'sk', caffeinate: 'tw', noglob: '', nocorrect: '', '-': '', coproc: '',
}));
/** Long options that take a value, as the short letter they stand for. */
const LONG_VALUE_OPTS = new Map(Object.entries({
  '--split-string': 'S', '--unset': 'u', '--chdir': 'C', '--argv0': 'a', '--user': 'u', '--group': 'g',
  '--signal': 's', '--kill-after': 'k', '--max-args': 'n', '--max-procs': 'P', '--max-lines': 'L', '--delimiter': 'd',
  '--arg-file': 'a', '--replace': 'I', '--eof': 'E', '--rcfile': 'f', '--init-file': 'f',
  '--command': 'c', '--shell': 's', '--supp-group': 'G', '--whitelist-environment': 'w', '--interval': 'n',
}));
/** su's short options that take a value; `-c` is the command its shell runs. */
const SU_VALUE_OPTS = 'cgGsw';
/** find's actions that run a command, up to a `;` or `+` word. */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const SSH_VALUE_OPTS = 'BbcDEeFIiJLlmOoPpQRSWw';
/** Shells whose `-c` takes the command to run as text, and that read a script on their input otherwise. */
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** A word the shell would read differently from itself if it were read again, as `eval` and `ssh` do. */
const REREAD_CHANGES = /[\s'"\\$`;&|()<>{}#]/;
/** How many stages back a pipeline is followed to find the text a shell reads. */
const PIPE_STAGES = 4;
/** How many words after a name are read as its arguments when every word is tried as a name. */
const LOOSE_ARGS = 64;
const SHELLS = '(?:ba|z|da|k|fi)?sh';
const PIPE_TO_SHELL = [
  new RegExp(String.raw`\b(curl|wget)\b[^\n|;&]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\S*/)?(${SHELLS})\b`, 'g'),
  new RegExp(String.raw`\b(${SHELLS})\s+(?:-\w+\s+)*["']?(?:\$\(|<\()\s*(curl|wget)\b`, 'g'),
];
/** `<word>`, but not `<<EOF`, `<<<`, `< file`, `<(cmd)` nor `a<b>`. */
const PLACEHOLDER = /(?<![<\w])<[A-Za-z][\w.-]*>/g;
/** A redirection operator, longest first. */
const REDIRECTION = /^(?:<<<|<<-|&>>|<<|>>|<>|<&|>&|>\||&>|<|>)/;
/** What a backslash stands for inside `$'...'`, past the numeric forms. */
const ANSI_C_ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
};

type AddReason = (kind: RiskKind, text: string) => void;
/**
 * One reading of a command: where reasons go, and how many characters may
 * still be lexed. Every text read again (a payload, a shell's input, what
 * `eval` or `ssh` join) is paid for from the budget, so nested wrappers stay
 * linear in the text; past it, every word of the whole text is tried as a
 * command's name instead.
 */
interface Scan { add: AddReason; budget: number; exhausted: boolean }

/** The command's name as the shell resolves it: `/bin/rm` is `rm`. */
const commandName = (w: string) => w.split('/').pop() ?? '';
const isShortFlag = (w: string) => /^-[A-Za-z]+$/.test(w);
const shortHas = (w: string, letters: string) => isShortFlag(w) && [...letters].some((l) => w.includes(l));

/** One simple command: its words, and what it reads on its input when that is written in the text. */
interface SimpleCommand {
  words: string[];
  /** Heredoc bodies and here-strings. */
  input: string[];
  /** The stage before it in a pipeline. */
  from: SimpleCommand | null;
}

/** A quote, an expansion or a parenthesis that never closes: the shell refuses the line. */
class Unclosed extends Error {}

/**
 * The value of the `$'...'` whose content starts at `i`, and where it ends
 * past its closing quote. `\'` is a quote, not the end, and `$'\x72m'` is `rm`.
 */
function ansiC(src: string, i: number): [string, number] {
  let out = '';
  while (i < src.length) {
    const c = src[i]!;
    if (c === "'") return [out, i + 1];
    if (c !== '\\') { out += c; i++; continue; }
    const num = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/.exec(src.slice(i + 1, i + 10));
    if (num) {
      const hex = num[1] ?? num[2] ?? num[3];
      out += String.fromCodePoint(Math.min(hex ? parseInt(hex, 16) : parseInt(num[4]!, 8), 0x10ffff));
      i += 1 + num[0].length;
      continue;
    }
    const e = src[i + 1] ?? '';
    if (e === 'c' && i + 2 < src.length) { out += String.fromCharCode(src.charCodeAt(i + 2) & 0x1f); i += 3; continue; }
    out += ANSI_C_ESCAPES[e] ?? `\\${e}`;
    i += 2;
  }
  throw new Unclosed();
}

/**
 * Splits `src` into simple commands the way the shell does, pushing each one
 * to `out` with its words' quotes and escapes removed, the commands inside
 * `$(...)`, `${...}`, backticks, `<(...)` and unquoted heredoc bodies
 * included. With `body`, `src` is a heredoc body: text, where only the
 * expansions run. Throws `Unclosed` at the first thing that never closes,
 * with what came before it already in `out`.
 */
function lex(src: string, out: SimpleCommand[], body = false): void {
  /** Delimiters looked for and not found from a position on: they are not found from any later one either. */
  const missing = new Map<string, number>();

  /** Where the `${...}` whose brace is at `i` ends; quotes and expansions inside it are read, braces nest. */
  const braceEnd = (i: number): number => {
    let depth = 0;
    for (i++; i < src.length;) {
      const c = src[i]!;
      if (c === '}' && depth-- === 0) return i + 1;
      if (c === '{') depth++;
      if (c === '\\') { i += 2; continue; }
      if (c === "'") { const end = src.indexOf("'", i + 1); if (end < 0) throw new Unclosed(); i = end + 1; continue; }
      if (c === '"') { i = doubleQuoted(i + 1)[1]; continue; }
      i = expansionEnd(i) ?? i + 1;
    }
    throw new Unclosed();
  };

  /**
   * Where the expansion at `i` ends when it is `$(...)`, `${...}` or a
   * backtick span, with the commands inside pushed to `out`; null when there
   * is none at `i`.
   */
  const expansionEnd = (i: number): number | null => {
    if (src[i] === '$' && src[i + 1] === '(') return read(i + 2, true);
    if (src[i] === '$' && src[i + 1] === '{') return braceEnd(i + 1);
    if (src[i] !== '`') return null;
    let j = i + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    if (j >= src.length) throw new Unclosed();
    // Inside backticks a backslash keeps only `\\`, `` \` `` and `\$`.
    lex(src.slice(i + 1, j).replace(/\\([\\`$])/g, '$1'), out);
    return j + 1;
  };

  /** The value of the double-quoted text whose content starts at `i`, and where it ends. */
  const doubleQuoted = (i: number): [string, number] => {
    let value = '';
    while (i < src.length) {
      const c = src[i]!;
      if (c === '"') return [value, i + 1];
      const next = src[i + 1];
      if (c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') value += next;
        i += 2;
        continue;
      }
      const end = expansionEnd(i);
      if (end !== null) { value += src.slice(i, end); i = end; continue; }
      value += c;
      i++;
    }
    throw new Unclosed();
  };

  /** Where the line `delim` (after tabs, with `strip`) starts and where the line after it starts, from `pos`; null when none. */
  const delimiterLine = (delim: string, strip: boolean, pos: number): [number, number] | null => {
    const key = `${strip ? '-' : ''}${delim}`;
    if ((missing.get(key) ?? Infinity) <= pos) return null;
    const re = new RegExp(`^${strip ? '\\t*' : ''}${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm');
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) { missing.set(key, pos); return null; }
    return [m.index, Math.min(src.length, m.index + m[0].length + 1)];
  };

  /** Reads from `i`; when `nested`, stops past the `)` that closes the `$(` or `<(` before `i`. */
  const read = (i: number, nested: boolean): number => {
    let cmd: SimpleCommand = { words: [], input: [], from: null };
    let word = '';
    let inWord = false; // a word has begun, also an empty one (`""`)
    let quoted = false; // the word holds a quote or an escape
    // What the next word is when it follows a redirection: dropped, a here-string, a heredoc's delimiter.
    let target: null | 'drop' | 'string' | 'heredoc' | 'heredoc-strip' = null;
    // Heredocs opened on this line: their bodies start past its newline.
    const pendingBodies: Array<{ delim: string; quoted: boolean; strip: boolean; cmd: SimpleCommand }> = [];
    let depth = 0; // subshell parentheses open inside this span
    const add = (s: string, q = false) => { word += s; inWord = true; quoted ||= q; };
    const endCommand = (pipe = false) => {
      endWord();
      target = null;
      const prev = cmd;
      if (cmd.words.length) out.push(cmd);
      cmd = { words: [], input: [], from: pipe && prev.words.length ? prev : null };
    };
    function endWord() {
      if (inWord) {
        if (target === 'string') cmd.input.push(word);
        else if (target === 'heredoc' || target === 'heredoc-strip') pendingBodies.push({ delim: word, quoted, strip: target === 'heredoc-strip', cmd });
        else if (target === null) {
          // `if true { rm -rf x }`: the body is a command of its own.
          if (word === '{' && !quoted && BRACE_BODY.has(cmd.words[0] ?? '')) {
            out.push(cmd);
            cmd = { words: [], input: [], from: null };
          }
          cmd.words.push(word);
        }
        target = null;
      }
      word = '';
      inWord = false;
      quoted = false;
    }
    /** Past the heredoc bodies that start at `pos`; a delimiter never found leaves the lines to be read as code. */
    const skipBodies = (pos: number): number => {
      for (const h of pendingBodies.splice(0)) {
        const line = delimiterLine(h.delim, h.strip, pos);
        if (!line) continue;
        const text = src.slice(pos, line[0]);
        h.cmd.input.push(text);
        if (!h.quoted) lex(text, out, true);
        pos = line[1];
      }
      return pos;
    };
    while (i < src.length) {
      const c = src[i]!;
      const next = src[i + 1];
      if (c === '\\') {
        // The next character as it is; a backslash before a newline joins the lines.
        if (next !== '\n') add(next ?? c, true);
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new Unclosed();
        add(src.slice(i + 1, end), true);
        i = end + 1;
        continue;
      }
      if (c === '"' || (c === '$' && (next === '"' || next === "'"))) {
        const [value, end] = c === '"' ? doubleQuoted(i + 1) : next === '"' ? doubleQuoted(i + 2) : ansiC(src, i + 2);
        add(value, true);
        i = end;
        continue;
      }
      if (c === '$' || c === '`') {
        const end = expansionEnd(i);
        add(end === null ? c : src.slice(i, end));
        i = end ?? i + 1;
        continue;
      }
      if (c === ' ' || c === '\t') { endWord(); i++; continue; }
      if (c === '#' && !inWord) {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '\n') { endCommand(); i = skipBodies(i + 1); continue; }
      if (c === ';') { endCommand(); i++; continue; }
      if ((c === '<' || c === '>') && next === '(') {
        const end = read(i + 2, true);
        add(src.slice(i, end));
        i = end;
        continue;
      }
      if (c === '<' || c === '>' || (c === '&' && next === '>')) {
        // A redirection: neither the operator nor its target is an argument; `2>` names a descriptor.
        if (/^\d+$/.test(word) && !quoted) { word = ''; inWord = false; } else endWord();
        const op = REDIRECTION.exec(src.slice(i, i + 3))![0];
        i += op.length;
        target = op === '<<<' ? 'string' : op === '<<' ? 'heredoc' : op === '<<-' ? 'heredoc-strip' : 'drop';
        continue;
      }
      if (c === '&' || c === '|') {
        const pipe = c === '|' && next !== '|';
        endCommand(pipe);
        i += next === c || (c === '|' && next === '&') ? 2 : 1;
        continue;
      }
      if (c === '(') { endCommand(); depth++; i++; continue; }
      if (c === ')') {
        endCommand();
        i++;
        if (depth === 0 && nested) return i;
        depth = Math.max(0, depth - 1);
        continue;
      }
      add(c);
      i++;
    }
    if (nested) throw new Unclosed();
    endCommand();
    return src.length;
  };

  if (!body) { read(0, false); return; }
  // A heredoc body with an unquoted delimiter: only `$(...)`, `${...}` and backticks run.
  for (let i = 0; i < src.length;) i = src[i] === '\\' ? i + 2 : expansionEnd(i) ?? i + 1;
}

/** The text a shell reading its input would run: heredocs, here-strings, and what the stages before it were given. */
function inputOf(cmd: SimpleCommand): string[] {
  const texts = [...cmd.input];
  let stage = cmd.from;
  for (let n = 0; stage && n < PIPE_STAGES; n++, stage = stage.from) {
    const args = stage.words.slice(1);
    // `echo rm -rf x | sh` runs the words joined; `printf '%s\n' 'rm -rf x' | sh` runs each one.
    texts.push(...stage.input, args.join(' '), ...args.filter((a) => REREAD_CHANGES.test(a)));
  }
  return texts;
}

/** The reasons found in a command line, and in each command it hands over as text. */
function scanText(text: string, scan: Scan): void {
  if (scan.budget < text.length) { scan.exhausted = true; return; }
  scan.budget -= text.length;
  const commands: SimpleCommand[] = [];
  let broken = false;
  try {
    lex(text, commands);
  } catch {
    // Something never closes (or nests past the stack): the shell refuses the line.
    broken = true;
  }
  for (const cmd of commands) scanWords(cmd.words, scan, () => inputOf(cmd));
  if (broken) scanLoose(text, scan.add);
}

/**
 * Every word of every line tried as a command's name, with the words after it
 * as its arguments, up to a comment: for a text the lexer could not read.
 */
function scanLoose(text: string, add: AddReason): void {
  for (const line of text.split('\n')) {
    let words = line.split(/[\s;&|()`]+/).map((w) => w.replace(/['"\\]/g, ''));
    const comment = words.findIndex((w) => w.startsWith('#'));
    words = (comment >= 0 ? words.slice(0, comment) : words).filter(Boolean);
    for (let k = 0; k < words.length; k++) {
      const name = commandName(words[k]!);
      const args = words.slice(k + 1, k + 1 + LOOSE_ARGS);
      if (name === 'sudo' || name === 'doas') add('sudo', name);
      if (name === 'xargs' && args.some((w) => commandName(w) === 'rm')) add('xargs-rm', 'xargs rm');
      scanCommand(name, args, add);
    }
  }
}

/**
 * Past the options at `i`: `-abc` clusters, where a letter of `values` takes
 * the rest of its word or the next word as its value (handed to `onValue`),
 * `--long` options, and `--`, which ends them.
 */
function skipOptions(words: string[], i: number, values: string, onValue?: (letter: string, value: string) => void): number {
  while (i < words.length) {
    const w = words[i]!;
    if (w === '--') return i + 1;
    if (!w.startsWith('-') || w === '-') return i;
    i++;
    if (w.startsWith('--')) {
      const [long, attached] = w.split(/=(.*)/s);
      const letter = LONG_VALUE_OPTS.get(long!);
      if (!letter || !values.includes(letter)) continue;
      const value = attached ?? words[i++] ?? '';
      onValue?.(letter, value);
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      if (!values.includes(w[k]!)) continue;
      const value = k + 1 < w.length ? w.slice(k + 1) : words[i++] ?? '';
      onValue?.(w[k]!, value);
      break;
    }
  }
  return i;
}

/** `ssh [options] host [options] command...`: OpenSSH reads options again after the host, unless `--` came first. */
function sshCommand(words: string[], i: number): number | null {
  let at = skipOptions(words, i + 1, SSH_VALUE_OPTS);
  const terminated = words[at - 1] === '--';
  if (at >= words.length) return null;
  at++;
  if (!terminated) at = skipOptions(words, at, SSH_VALUE_OPTS);
  return at < words.length ? at : null;
}

/** The text `sh -c`, `bash -lc`, `zsh -c -- ...` run: the first word past the options, when one of them holds `c`. */
function shellPayload(words: string[], i: number): string | null {
  let c = false;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j]!;
    if (w === '--' || w === '-') return c ? words[j + 1] ?? null : null;
    if (!/^[-+]/.test(w)) return c ? w : null;
    if (w.startsWith('--')) { if (LONG_VALUE_OPTS.get(w) === 'f') j++; continue; }
    if (w.includes('c')) c = true;
    if (/[oO]/.test(w)) j++;
  }
  return null;
}

/**
 * What the wrapper at `i` runs: the index of the command it starts, the text
 * it hands to a shell to read, or null when `name` runs nothing of its own
 * (`bash script.sh`, a bare `ssh host`).
 */
function wrappedCommand(name: string, words: string[], i: number): number | string | null {
  if (name === 'env') {
    let split: string | null = null;
    let at = skipOptions(words, i + 1, WRAPPER_VALUE_OPTS.get('env')!, (letter, value) => { if (letter === 'S') split = value; });
    // env takes every word with `=` before the command as an assignment.
    while (at < words.length && words[at]!.includes('=')) at++;
    // `env -S 'rm -rf x'`: env splits the string into words, and reads them as its own.
    return split === null ? at : ['env', split, ...words.slice(at)].join(' ');
  }
  if (name === 'timeout' || name === 'gtimeout') {
    // `timeout 10 cmd`: the duration comes before the command.
    return skipOptions(words, i + 1, WRAPPER_VALUE_OPTS.get(name)!) + 1;
  }
  // zsh's `repeat 3 cmd`, and `coproc NAME { cmd; }` in bash.
  if (name === 'repeat') return i + 2;
  if (name === 'coproc' && words[i + 2] === '{') return i + 2;
  const values = WRAPPER_VALUE_OPTS.get(name);
  if (values !== undefined) return skipOptions(words, i + 1, values);
  // `eval` joins its words with spaces, and the shell reads the result again.
  if (name === 'eval') return words[i + 1] === '--' ? i + 2 : i + 1;
  if (name === 'ssh') return sshCommand(words, i);
  if (SHELL_NAMES.has(name)) return shellPayload(words, i);
  if (name === 'su') return suPayload(words, i);
  if (name === 'watch') {
    let exec = false;
    const at = skipOptions(words, i + 1, 'n');
    for (let k = i + 1; k < at; k++) if (shortHas(words[k]!, 'x') || words[k] === '--exec') exec = true;
    // `watch -x` runs the words; otherwise it joins them and hands them to `sh -c`.
    return exec ? at : words.slice(at).join(' ');
  }
  return null;
}

/**
 * The text `su [options] [-] [user [args]]` hands its shell with `-c`: util-linux
 * reads options also after the user, so `su root -c 'rm -rf x'` runs it too.
 * Null without `-c`: an interactive shell, nothing written here runs.
 */
function suPayload(words: string[], i: number): string | null {
  let payload: string | null = null;
  const take = (letter: string, value: string) => { if (letter === 'c') payload = value; };
  let at = skipOptions(words, i + 1, SU_VALUE_OPTS, take);
  if (words[at] === '-') at = skipOptions(words, at + 1, SU_VALUE_OPTS, take);
  if (at < words.length) skipOptions(words, at + 1, SU_VALUE_OPTS, take);
  return payload;
}

/** The commands find runs for each file: the words after each `-exec`-like action, up to its `;` or `+`. */
function findCommands(args: string[]): string[][] {
  const out: string[][] = [];
  for (let k = 0; k < args.length; k++) {
    if (!FIND_EXEC.has(args[k]!)) continue;
    let end = k + 1;
    while (end < args.length && args[end] !== ';' && args[end] !== '+') end++;
    out.push(args.slice(k + 1, end));
    k = end;
  }
  return out;
}

/** The reasons found in one simple command, as the words the shell hands over, and what it reads on its input. */
function scanWords(words: string[], scan: Scan, input: () => string[]): void {
  const { add } = scan;
  // The last word that would read differently if read again: past it, `eval` and `ssh` change nothing.
  let lastChanging = -1;
  words.forEach((w, k) => { if (REREAD_CHANGES.test(w)) lastChanging = k; });
  let i = 0;
  // Leading reserved words, assignments and wrappers: what runs is the command after them.
  for (;;) {
    for (;;) {
      const w = words[i];
      if (w === 'function') i += 2;
      else if (w !== undefined && (LEADING_RESERVED.has(w) || ASSIGNMENT.test(w))) i++;
      else break;
    }
    // `{rm,-rf,x}`: bash's brace expansion makes the words.
    const brace = /^\{([^{}]*,[^{}]*)\}$/.exec(words[i] ?? '');
    if (brace) { words = [...words.slice(0, i), ...brace[1]!.split(','), ...words.slice(i + 1)]; continue; }
    const name = commandName(words[i] ?? '');
    const runs = wrappedCommand(name, words, i);
    if (runs === null) break;
    if (name === 'sudo' || name === 'doas' || name === 'su') add('sudo', name);
    if (typeof runs === 'string') { scanText(runs, scan); return; }
    if (lastChanging >= runs && !scan.exhausted) {
      // `eval` joins its words and the shell reads them again.
      if (name === 'eval') { scanText(words.slice(runs).join(' '), scan); return; }
      // So does the remote side of `ssh`, with a shell not known here: the words are read both ways.
      if (name === 'ssh') scanText(words.slice(runs).join(' '), scan);
    }
    if (name === 'xargs' && commandName(words[runs] ?? '') === 'rm') add('xargs-rm', 'xargs rm');
    i = runs;
  }
  const name = commandName(words[i] ?? '');
  // A shell with no `-c` reads its script on its input.
  if (SHELL_NAMES.has(name)) { for (const text of input()) scanText(text, scan); return; }
  if (name === 'find') for (const command of findCommands(words.slice(i + 1))) scanWords(command, scan, () => []);
  scanCommand(name, words.slice(i + 1), add);
}

/** The reasons the command `name` gives with `args`. */
function scanCommand(name: string, args: string[], add: AddReason): void {
  switch (name) {
    case 'rm': {
      const flags = args.filter((a) => shortHas(a, 'rRf') || a === '--recursive' || a === '--force');
      if (flags.length) add('rm', `rm ${flags.join(' ')}`);
      return;
    }
    case 'git': return scanGit(args, add);
    case 'dd': add('dd', 'dd'); return;
    case 'diskutil': {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub && /^(erase\w*|secureErase|zeroDisk|randomDisk|partitionDisk)$/i.test(sub)) add('diskutil-erase', `diskutil ${sub}`);
      return;
    }
    case 'chmod': case 'chown': case 'chgrp': {
      if (args.some((a) => shortHas(a, 'R') || a === '--recursive')) add('chmod-recursive', `${name} -R`);
      return;
    }
    case 'find': {
      if (args.includes('-delete')) add('find-delete', 'find -delete');
      for (let k = 0; k < args.length; k++) {
        if (FIND_EXEC.has(args[k]!) && commandName(args[k + 1] ?? '') === 'rm') add('find-delete', `find ${args[k]} rm`);
      }
      return;
    }
    case 'kill': {
      const s = args.findIndex((a) => a === '-s' || a === '-n');
      const nine = args.some((a) => /^-(9|KILL|SIGKILL)$/i.test(a)) || (s >= 0 && /^(9|KILL|SIGKILL)$/i.test(args[s + 1] ?? ''));
      if (nine) add('kill', 'kill -9');
      return;
    }
    case 'killall': case 'pkill': add('kill', name); return;
    // Another user's shell, `root` when none is named: the same step as sudo.
    case 'su': add('sudo', name); return;
    case 'launchctl': {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub === 'bootout') add('launchctl', 'launchctl bootout');
      if (sub === 'kickstart' && args.some((a) => shortHas(a, 'k'))) add('launchctl', 'launchctl kickstart -k');
      return;
    }
    default:
      if (/^mkfs(\.\w+)?$/.test(name) || name === 'newfs' || /^newfs_\w+$/.test(name)) add('mkfs', name);
  }
}

function scanGit(args: string[], add: AddReason): void {
  let i = 0;
  // Global options before the subcommand: `-C <dir>` and `-c <k=v>` take a value.
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  switch (sub) {
    case 'push': {
      const force = rest.find((a) => a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || shortHas(a, 'f') || /^\+\S/.test(a));
      if (force) add('git-push-force', `git push ${force}`);
      return;
    }
    case 'reset':
      if (rest.includes('--hard')) add('git-reset-hard', 'git reset --hard');
      return;
    case 'clean': {
      const force = rest.find((a) => a === '--force' || shortHas(a, 'f'));
      if (force) add('git-clean', `git clean ${force}`);
      return;
    }
    case 'checkout': {
      const dashes = rest.indexOf('--');
      if ((dashes >= 0 && dashes < rest.length - 1) || rest.includes('.')) add('git-discard', `git checkout ${rest.join(' ')}`);
      return;
    }
    case 'restore': {
      const paths = rest.filter((a) => !a.startsWith('-'));
      const stagedOnly = rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W');
      if (paths.length && !stagedOnly) add('git-discard', `git restore ${paths.join(' ')}`);
      return;
    }
  }
}

export function commandRisk(command: string): CommandRisk {
  const confirm: RiskReason[] = [];
  const seen = new Set<string>();
  const add = (kind: RiskKind, text: string) => {
    const key = `${kind} ${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    confirm.push({ kind, text });
  };
  const scan: Scan = { add, budget: 4 * command.length + 4096, exhausted: false };
  scanText(command, scan);
  if (scan.exhausted) scanLoose(command, add);
  const joined = command.replace(LINE_CONTINUATION, ' ');
  for (const re of PIPE_TO_SHELL) {
    for (const m of joined.matchAll(re)) {
      const [tool, shell] = /curl|wget/.test(m[1]!) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      add('pipe-to-shell', `${tool} | ${shell}`);
    }
  }
  for (const m of joined.matchAll(PLACEHOLDER)) add('placeholder', m[0]);
  return { block: hasHiddenChars(command) ? 'hidden-chars' : null, confirm };
}
