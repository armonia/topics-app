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
 * (`sudo`, `env`, `xargs`...). Quotes are not parsed, and only a command's
 * own name is looked at: `echo "rm -rf x"` asks nothing.
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
};
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs']);
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

/** The reasons found in one simple command, already split into words. */
function scanWords(words: string[], add: (kind: RiskKind, text: string) => void): void {
  let i = 0;
  // Leading reserved words, assignments and wrappers: what runs is the command after them.
  for (;;) {
    while (i < words.length && (ASSIGNMENT.test(words[i]!) || LEADING_RESERVED.has(words[i]!))) i++;
    const name = commandName(words[i] ?? '');
    if (!WRAPPERS.has(name)) break;
    if (name === 'sudo' || name === 'doas') add('sudo', name);
    const valueOpts = WRAPPER_VALUE_OPTS[name];
    i++;
    while (i < words.length && (words[i]!.startsWith('-') || (name === 'env' && ASSIGNMENT.test(words[i]!)))) {
      if (valueOpts?.has(words[i]!)) i++;
      i++;
    }
    if (name === 'xargs' && commandName(words[i] ?? '') === 'rm') add('xargs-rm', 'xargs rm');
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
