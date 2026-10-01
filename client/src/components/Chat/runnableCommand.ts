/**
 * The command a code block of a reply would run, or null when the block is
 * not a command (CHAT-RUN-01).
 *
 * Only by label. 25 unlabelled blocks in nine months began with a command, but
 * `bash` blocks also began with `from` and `import`: a label that lies costs a
 * `command not found` read under the block, a guess on an unlabelled one would
 * offer Run on prose and code alike.
 */
const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell']);
const TRANSCRIPT_LANGS = new Set(['console', 'shellsession']);
/** The prompt a transcript line starts with: `$ ` or `% `. */
const PROMPT = /^[$%] /;

export function runnableCommand(lang: string, text: string): string | null {
  const label = lang.trim().toLowerCase();
  let command: string;
  if (SHELL_LANGS.has(label)) {
    // The whole block runs as one script: its `cd` carries over to the next line.
    command = text.replace(/\n$/, '');
  } else if (TRANSCRIPT_LANGS.has(label)) {
    // A transcript mixes commands and what they printed; only the prompted lines run.
    command = text.split('\n').filter((l) => PROMPT.test(l)).map((l) => l.slice(2)).join('\n');
  } else {
    return null;
  }
  return command.trim() ? command : null;
}
