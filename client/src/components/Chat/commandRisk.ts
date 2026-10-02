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
 * The text is read the way sh and bash read it, by one small lexer: single
 * quotes, double quotes, ANSI-C `$'...'` (where `\'` is a quote), backslash
 * escapes and line continuations, `$(...)`, backticks and `<(...)` (whose
 * content is a command too, read the same way), comments, redirections, and
 * the control operators that end a simple command, only where they are not
 * quoted. Each simple command comes out as the words the shell would hand
 * over, quotes removed, and is scanned word by word: past the reserved words
 * that lead into it (`then`, `do`, `!`, `{`...), the assignments in front of
 * it (`FOO="a b" rm -rf x`) and the wrappers that run another command
 * (`sudo`, `env`, `xargs`, `timeout`, `caffeinate`...). A command handed over
 * as text is read again from that text: the payload of `sh -c`/`bash -c`/
 * `zsh -c`, the words of `eval` and those after `ssh host` (a command run on
 * another machine is no less destructive). Only a command's own name is
 * looked at: `echo "rm -rf x"` asks nothing.
 *
 * A quote that never closes makes bash refuse the line, and which part was
 * meant as the command is a guess: there every word is tried as the start of
 * one, so a destructive word anywhere on it asks.
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

const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/** Words that lead into a command without being one: `then rm -rf x`, `! git push -f`, `{ rm -rf x; }`. */
const LEADING_RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
/** A backslash at the end of a line: the command goes on on the next one. */
const LINE_CONTINUATION = /\\\r?\n/g;
/** Options of a wrapper that take the next word as their value. */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-U']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E']),
  env: new Set(['-u', '-C', '-S']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  caffeinate: new Set(['-t', '-w']),
  ssh: new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']),
};
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs', 'timeout', 'gtimeout', 'caffeinate']);
/** Shells whose `-c` takes the command to run as text, and their options that take a value. */
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const SHELL_VALUE_OPTS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
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

/** The command's name as the shell resolves it: `/bin/rm` is `rm`. */
const commandName = (w: string) => w.split('/').pop() ?? '';
const isShortFlag = (w: string) => /^-[A-Za-z]+$/.test(w);
const shortHas = (w: string, letters: string) => isShortFlag(w) && [...letters].some((l) => w.includes(l));

/**
 * The value of the `$'...'` whose content starts at `i`, and where it ends
 * past its closing quote; null when it never closes. `\'` is a quote, not the
 * end, and `$'\x72m'` is `rm`.
 */
function ansiC(src: string, i: number): [string, number] | null {
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
  return null;
}

/**
 * Splits `src` into simple commands the way sh and bash do, handing the words
 * of each one to `sink` with their quotes and escapes removed, the commands
 * inside `$(...)`, backticks and `<(...)` included. Returns whether a quote
 * never closed: there the quote is read as a plain character, so the words
 * after it are still handed over.
 */
function splitCommands(src: string, sink: (words: string[]) => void): boolean {
  let broken = false;

  /** Where the `${...}` whose brace is at `i` ends, or null when it never closes. */
  const braceEnd = (i: number): number | null => {
    for (let depth = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i + 1;
    }
    return null;
  };

  /**
   * Where the expansion at `i` ends when it is `$(...)`, `${...}` or a
   * backtick span, with the commands inside handed to `sink`; null when there
   * is none at `i`, or it never closes.
   */
  const expansionEnd = (i: number): number | null => {
    if (src[i] === '$' && src[i + 1] === '(') return read(i + 2, true);
    if (src[i] === '$' && src[i + 1] === '{') return braceEnd(i + 1);
    if (src[i] !== '`') return null;
    let j = i + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    if (j >= src.length) return null;
    // Inside backticks a backslash keeps only `\\`, `` \` `` and `\$`.
    if (splitCommands(src.slice(i + 1, j).replace(/\\([\\`$])/g, '$1'), sink)) broken = true;
    return j + 1;
  };

  /** The value of the double-quoted text whose content starts at `i`, and where it ends; null when it never closes. */
  const doubleQuoted = (i: number): [string, number] | null => {
    let out = '';
    while (i < src.length) {
      const c = src[i]!;
      if (c === '"') return [out, i + 1];
      const next = src[i + 1];
      if (c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') out += next;
        i += 2;
        continue;
      }
      const end = expansionEnd(i);
      if (end !== null) { out += src.slice(i, end); i = end; continue; }
      out += c;
      i++;
    }
    return null;
  };

  /** Reads from `i`; when `nested`, stops past the `)` that closes the `$(` or `<(` before `i`. */
  const read = (i: number, nested: boolean): number => {
    let words: string[] = [];
    let word = '';
    let inWord = false; // a word has begun, also an empty one (`""`)
    let dropNext = false; // the next word is a redirection's target, not an argument
    let depth = 0; // subshell parentheses open inside this span
    const add = (s: string) => { word += s; inWord = true; };
    const endWord = () => {
      if (inWord) {
        if (dropNext) dropNext = false;
        else words.push(word);
      }
      word = '';
      inWord = false;
    };
    const endCommand = () => {
      endWord();
      dropNext = false;
      if (words.length) sink(words);
      words = [];
    };
    while (i < src.length) {
      const c = src[i]!;
      const next = src[i + 1];
      if (c === '\\') {
        // The next character as it is; a backslash before a newline joins the lines.
        if (next !== '\n') add(next ?? c);
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) { broken = true; add(c); i++; continue; }
        add(src.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      if (c === '"' || (c === '$' && (next === '"' || next === "'"))) {
        const quoted = c === '"' ? doubleQuoted(i + 1) : next === '"' ? doubleQuoted(i + 2) : ansiC(src, i + 2);
        if (!quoted) { broken = true; add(c); i++; continue; }
        add(quoted[0]);
        i = quoted[1];
        continue;
      }
      if (c === '$' || c === '`') {
        const end = expansionEnd(i);
        if (end === null && c === '`') broken = true;
        add(end === null ? c : src.slice(i, end));
        i = end ?? i + 1;
        continue;
      }
      if (c === ' ' || c === '\t') { endWord(); i++; continue; }
      if (c === '#' && !inWord) {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '\n' || c === ';') { endCommand(); i++; continue; }
      if ((c === '<' || c === '>') && next === '(') {
        const end = read(i + 2, true);
        add(src.slice(i, end));
        i = end;
        continue;
      }
      if (c === '<' || c === '>' || (c === '&' && next === '>')) {
        // A redirection: neither the operator nor its target is an argument; `2>` names a descriptor.
        if (/^\d+$/.test(word)) { word = ''; inWord = false; } else endWord();
        i += REDIRECTION.exec(src.slice(i, i + 3))![0].length;
        dropNext = true;
        continue;
      }
      if (c === '&' || c === '|') {
        endCommand();
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
    endCommand();
    return src.length;
  };

  read(0, false);
  return broken;
}

/** The reasons found in a command line, and in each command it hands over as text. */
function scanText(text: string, add: AddReason): void {
  if (!splitCommands(text, (words) => scanWords(words, add))) return;
  // A quote that never closes: every word of every line is tried as a command's name.
  for (const line of text.split('\n')) {
    const words = line.split(/[\s;&|()`]+/).map((w) => w.replace(/['"\\]/g, '')).filter(Boolean);
    for (let k = 0; k < words.length; k++) scanWords(words.slice(k), add);
  }
}

/** Past the options of the wrapper at `i`, and those that take a value with them. */
function skipOptions(words: string[], i: number, valueOpts: Set<string> | undefined): number {
  while (i < words.length && words[i]!.startsWith('-')) i += valueOpts?.has(words[i]!) ? 2 : 1;
  return i;
}

/**
 * What the wrapper at `i` runs: the index of the command it starts, the text
 * it hands to a shell to read, or null when `name` runs nothing of its own
 * (`bash script.sh`, a bare `ssh host`).
 */
function wrappedCommand(name: string, words: string[], i: number): number | string | null {
  if (WRAPPERS.has(name)) {
    const at = skipOptions(words, i + 1, WRAPPER_VALUE_OPTS[name]);
    // `timeout 10 cmd`: the duration comes before the command.
    return name === 'timeout' || name === 'gtimeout' ? at + 1 : at;
  }
  // `eval` joins its words with spaces, and the shell reads the result again.
  if (name === 'eval') return words.slice(i + 1).join(' ');
  if (name === 'ssh') {
    // `ssh [options] host command...`: the words after the host are the remote command.
    const host = skipOptions(words, i + 1, WRAPPER_VALUE_OPTS.ssh);
    return host + 1 < words.length ? host + 1 : null;
  }
  if (SHELL_NAMES.has(name)) {
    // `bash -lc "..."`: the payload is the word after the flag that holds `c`.
    for (let j = i + 1; j < words.length && /^[-+]/.test(words[j]!); j++) {
      if (shortHas(words[j]!, 'c')) return words[j + 1] ?? null;
      if (SHELL_VALUE_OPTS.has(words[j]!)) j++;
    }
  }
  return null;
}

/** The reasons found in one simple command, as the words the shell hands over. */
function scanWords(words: string[], add: AddReason): void {
  let i = 0;
  // Leading reserved words, assignments and wrappers: what runs is the command after them.
  for (;;) {
    while (i < words.length && (LEADING_RESERVED.has(words[i]!) || ASSIGNMENT.test(words[i]!))) i++;
    const name = commandName(words[i] ?? '');
    const runs = wrappedCommand(name, words, i);
    if (runs === null) break;
    if (name === 'sudo' || name === 'doas') add('sudo', name);
    if (typeof runs === 'string') { scanText(runs, add); return; }
    // The remote side joins the words and its shell reads them again; which shell is not
    // known here, so they are read both ways.
    if (name === 'ssh') scanText(words.slice(runs).join(' '), add);
    if (name === 'xargs' && commandName(words[runs] ?? '') === 'rm') add('xargs-rm', 'xargs rm');
    i = runs;
  }
  const name = commandName(words[i] ?? '');
  const args = words.slice(i + 1);
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
      const exec = args.findIndex((a) => a === '-exec' || a === '-execdir');
      if (exec >= 0 && commandName(args[exec + 1] ?? '') === 'rm') add('find-delete', `find ${args[exec]} rm`);
      return;
    }
    case 'kill': {
      const s = args.findIndex((a) => a === '-s' || a === '-n');
      const nine = args.some((a) => /^-(9|KILL|SIGKILL)$/i.test(a)) || (s >= 0 && /^(9|KILL|SIGKILL)$/i.test(args[s + 1] ?? ''));
      if (nine) add('kill', 'kill -9');
      return;
    }
    case 'killall': case 'pkill': add('kill', name); return;
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
  scanText(command, add);
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
