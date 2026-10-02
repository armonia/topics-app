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
 * The scan is word by word over each simple command (split on `;`, `&&`,
 * `||`, `|`, `&`, parentheses, braces, backticks and newlines, with backslash
 * line continuations joined first), after the reserved words that lead into
 * one (`then`, `do`, `!`...) and the wrappers that run another command
 * (`sudo`, `env`, `xargs`, `timeout`, `caffeinate`...). A command handed over
 * as text is read too: the payload of `sh -c`/`bash -c`/`zsh -c`, of `eval`
 * and of `ssh host` (a command run on another machine is no less destructive).
 * Quotes are not parsed but in the value of a leading assignment, which may
 * span words (`FOO="a b" rm -rf x`), and only a command's own name is looked
 * at: `echo "rm -rf x"` asks nothing, while in `bash -c "rm -rf x"` the quote
 * before `rm` is dropped like any other, so the payload reads as the command
 * it is.
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

const SEPARATORS = /\n|;|&&|\|\||\||&|\$\(|[(){}`]/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/** Words that lead into a command without being one: `then rm -rf x`, `! git push -f`. */
const LEADING_RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
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

const unquote = (w: string) => w.replace(/^['"]+|['"]+$/g, '');
/** The command's name as the shell resolves it: `/bin/rm` and `\rm` are `rm`. */
const commandName = (w: string) => unquote(w).replace(/^\\/, '').split('/').pop() ?? '';
const isShortFlag = (w: string) => /^-[A-Za-z]+$/.test(w);
const shortHas = (w: string, letters: string) => isShortFlag(w) && [...letters].some((l) => w.includes(l));

/** The quote still open at the end of `text`, read with `open` already open. */
function openQuoteAfter(text: string, open: string | null): string | null {
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if (open === "'") { if (c === "'") open = null; continue; }
    if (c === '\\') { k++; continue; }
    if (open === '"') { if (c === '"') open = null; continue; }
    if (c === '"' || c === "'") open = c;
  }
  return open;
}

/**
 * Past the assignment at `i`, or null when `words[i]` is not one. A value
 * quoted across a space (`FOO="a b"`, `GIT_SSH_COMMAND="ssh -i k"`) spans the
 * words up to the one that closes its quote: the word after `FOO="a` is still
 * the value, not the command. A quote that never closes spans nothing, and the
 * next word is read as the command. The quotes in front of the name are not
 * the value's: in `bash -c "FOO='a b' rm -rf x"` the payload's first word is
 * `"FOO='a`.
 */
function pastAssignment(words: string[], i: number): number | null {
  const word = (words[i] ?? '').replace(/^['"]+/, '');
  if (!ASSIGNMENT.test(word)) return null;
  let open = openQuoteAfter(word.slice(word.indexOf('=') + 1), null);
  let j = i + 1;
  while (open && j < words.length) open = openQuoteAfter(words[j++]!, open);
  return open ? i + 1 : j;
}

/** Past the options of the wrapper at `i`, and those that take a value with them. */
function skipOptions(words: string[], i: number, valueOpts: Set<string> | undefined, assignments = false): number {
  for (;;) {
    const past = assignments ? pastAssignment(words, i) : null;
    if (past !== null) { i = past; continue; }
    if (i >= words.length || !words[i]!.startsWith('-')) return i;
    if (valueOpts?.has(words[i]!)) i++;
    i++;
  }
}

/**
 * Where the command run by the wrapper at `i` starts, or null when `name`
 * runs nothing of its own (`bash script.sh`, a bare `ssh host`).
 */
function wrappedCommandAt(name: string, words: string[], i: number): number | null {
  if (WRAPPERS.has(name)) {
    const at = skipOptions(words, i + 1, WRAPPER_VALUE_OPTS[name], name === 'env');
    // `timeout 10 cmd`: the duration comes before the command.
    return name === 'timeout' || name === 'gtimeout' ? at + 1 : at;
  }
  if (name === 'eval') return i + 1;
  if (name === 'ssh') {
    // `ssh [options] host command...`: the words after the host are the remote command.
    const host = skipOptions(words, i + 1, WRAPPER_VALUE_OPTS.ssh);
    return host + 1 < words.length ? host + 1 : null;
  }
  if (SHELL_NAMES.has(name)) {
    // `bash -lc "..."`: the payload is the word after the flag that holds `c`.
    for (let j = i + 1; j < words.length && /^[-+]/.test(words[j]!); j++) {
      if (shortHas(words[j]!, 'c')) return j + 1;
      if (SHELL_VALUE_OPTS.has(words[j]!)) j++;
    }
  }
  return null;
}

/** The reasons found in one simple command, already split into words. */
function scanWords(words: string[], add: (kind: RiskKind, text: string) => void): void {
  let i = 0;
  // Leading reserved words, assignments and wrappers: what runs is the command after them.
  for (;;) {
    for (;;) {
      // Read without its quotes: in `bash -c "FOO=1 rm -rf x"` the payload's first word is `"FOO=1`.
      if (i < words.length && LEADING_RESERVED.has(unquote(words[i]!))) { i++; continue; }
      const past = pastAssignment(words, i);
      if (past === null) break;
      i = past;
    }
    const name = commandName(words[i] ?? '');
    const next = wrappedCommandAt(name, words, i);
    if (next === null) break;
    if (name === 'sudo' || name === 'doas') add('sudo', name);
    if (name === 'xargs' && commandName(words[next] ?? '') === 'rm') add('xargs-rm', 'xargs rm');
    i = next;
  }
  const name = commandName(words[i] ?? '');
  const args = words.slice(i + 1).map(unquote);
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

function scanGit(args: string[], add: (kind: RiskKind, text: string) => void): void {
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
  const joined = command.replace(LINE_CONTINUATION, ' ');
  for (const segment of joined.split(SEPARATORS)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length) scanWords(words, add);
  }
  for (const re of PIPE_TO_SHELL) {
    for (const m of joined.matchAll(re)) {
      const [tool, shell] = /curl|wget/.test(m[1]!) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      add('pipe-to-shell', `${tool} | ${shell}`);
    }
  }
  for (const m of joined.matchAll(PLACEHOLDER)) add('placeholder', m[0]);
  return { block: hasHiddenChars(command) ? 'hidden-chars' : null, confirm };
}
