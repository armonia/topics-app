/**
 * ↑ in an EMPTY composer brings back the previous prompt, ↓ walks forward and
 * past the newest one returns to the empty field. The shell and Claude Code
 * both do it, and in a chat where the same kind of request comes back all the
 * time («rifallo con...», «ancora le zanne») retyping it is the one cost here. allow-italian: quoted prompts
 *
 * Pure: the component owns the state and the key events. The rules:
 *  - it STARTS only from an empty field, so writing and editing keep their
 *    arrows;
 *  - while the field still shows the entry the history put there, ↑ on its
 *    first line goes further back and ↓ on its last line goes forward: inside a
 *    multi-line entry the arrows still move the caret, like the shell;
 *  - the moment the entry is edited it is text being written, not history.
 */
export interface PromptHistoryState {
  /** Index into `entries` (0 = oldest); null = not browsing. */
  index: number | null;
}

export const IDLE: PromptHistoryState = { index: null };

export interface ArrowInput {
  key: 'ArrowUp' | 'ArrowDown';
  /** Prompts of the person in this chat, oldest first (see `historyEntries`). */
  entries: readonly string[];
  value: string;
  /** No line break before the caret, and nothing selected. */
  caretOnFirstLine: boolean;
  /** No line break after the caret, and nothing selected. */
  caretOnLastLine: boolean;
}

export type ArrowResult =
  | { handled: false; state: PromptHistoryState }
  | { handled: true; state: PromptHistoryState; value: string };

export function onArrow(state: PromptHistoryState, i: ArrowInput): ArrowResult {
  const browsing = state.index !== null && i.entries[state.index] === i.value;
  if (i.key === 'ArrowUp') {
    if (browsing) {
      if (!i.caretOnFirstLine || state.index === 0) return { handled: false, state };
      const next = (state.index as number) - 1;
      return { handled: true, state: { index: next }, value: i.entries[next] };
    }
    if (i.value !== '' || i.entries.length === 0) return { handled: false, state: IDLE };
    const last = i.entries.length - 1;
    return { handled: true, state: { index: last }, value: i.entries[last] };
  }
  if (!browsing) return { handled: false, state: IDLE };
  if (!i.caretOnLastLine) return { handled: false, state };
  const next = (state.index as number) + 1;
  if (next >= i.entries.length) return { handled: true, state: IDLE, value: '' };
  return { handled: true, state: { index: next }, value: i.entries[next] };
}

/**
 * What the person TYPED in a stored prompt: the composer wraps it with the
 * uploaded files' paths, the files quoted with @ and the quote of a reply, and
 * recalling those would resend stale attachments as text.
 */
export function typedText(content: string): string {
  let s = content;
  s = s.replace(/^\[Context files\][\s\S]*?\[\/Context files\]\s*/, '');
  s = s.replace(/^(?:\[Attached file: [^\]\n]*\]\n?)+/, '');
  s = s.replace(/^(?:> .*\n)+\n/, '');
  return s.trim();
}

/** The entries from the person's prompts, oldest first, consecutive repeats
 *  collapsed (the shell's `ignoredups`): ↑ twice on «ok» «ok» is one step. */
export function historyEntries(prompts: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of prompts) {
    const t = typedText(p);
    if (!t || out[out.length - 1] === t) continue;
    out.push(t);
  }
  return out;
}
