/**
 * TERMINAL MEMORY: what a closed terminal needs to come back as itself. The
 * roster drops a session once its PTY is retired, and a reopen after that has
 * to recreate it: without its folder and its Claude conversation id the new
 * `claude` started in the project root with an empty conversation (the «empty
 * terminal» of ⇧⌘T). So every session the roster shows is remembered here,
 * by id, and the close record and the reopen read it back.
 *
 * In memory and bounded: it covers the reopen of this window's session, which
 * is the undo the shortcut promises; a record persisted across a reload keeps
 * what was copied into it at close time.
 */
import type { TerminalSessionInfo } from '../../../types';
import { TERMINAL_AGENT_TYPES, type TerminalAgentType } from '../../../../../shared/terminal-session-types';

export type RememberedTerminal = Pick<TerminalSessionInfo, 'id' | 'name' | 'cwd' | 'type' | 'claudeSessionId'>;

const MAX = 300;
const memory = new Map<string, RememberedTerminal>();

/** Records the roster's sessions; the newest win, the oldest fall off past the cap. */
export function rememberTerminals(list: ReadonlyArray<RememberedTerminal>): void {
  for (const t of list) {
    const prev = memory.get(t.id);
    memory.delete(t.id);
    // A later roster may not know the conversation yet: keep the one we had.
    memory.set(t.id, { id: t.id, name: t.name, cwd: t.cwd, type: t.type, claudeSessionId: t.claudeSessionId || prev?.claudeSessionId || null });
  }
  while (memory.size > MAX) memory.delete(memory.keys().next().value as string);
}

export function rememberedTerminal(id: string | null | undefined): RememberedTerminal | undefined {
  return id ? memory.get(id) : undefined;
}

/** Its type as a close record can hold it (a pane's agent type), or undefined. */
export function rememberedAgentType(t: RememberedTerminal | undefined): TerminalAgentType | undefined {
  return t && (TERMINAL_AGENT_TYPES as readonly string[]).includes(t.type) ? (t.type as TerminalAgentType) : undefined;
}

/** Test seam. */
export function __resetTerminalMemory(): void {
  memory.clear();
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
