/**
 * THE NAMES THE «/» MENU KNOWS, for the command mark on a sent message
 * (SKILL-04 over SKILL-03).
 *
 * SKILL-03 recognises a command by its SHAPE (`/name` at the start), and the
 * mark used to follow the shape alone: «/parolainventata» was drawn as a
 * command that ran, while it travelled as an ordinary message. The mark is
 * now drawn only for a name some menu knows: Topics' own commands, and every
 * name the engines and the skill folders listed to a composer of this window.
 * A message whose skill was deleted since loses the mark, not its text: the
 * mark says what ran, and that name would not run today.
 */
import { useSyncExternalStore } from 'react';
import { SLASH_COMMANDS } from '../components/Chat/slashCommands';
import { CLAUDE_ALIASES } from '../components/Chat/commandMap';

const known = new Set<string>([
  ...SLASH_COMMANDS.map((c) => c.cmd.slice(1)),
  ...Object.keys(CLAUDE_ALIASES),
]);
let version = 0;
const listeners = new Set<() => void>();

/** Add the names a composer just loaded. */
export function rememberSlashNames(names: readonly string[]): void {
  let grew = false;
  for (const raw of names) {
    const n = raw.toLowerCase();
    if (!known.has(n)) { known.add(n); grew = true; }
  }
  if (!grew) return;
  version++;
  for (const l of listeners) l();
}

/** Is `name` (without the slash) one the menu knows? */
export function isKnownSlashName(name: string): boolean {
  return known.has(name.toLowerCase());
}

/** The same question, redrawn when a composer learns new names. */
export function useKnownSlashName(name: string | null | undefined): boolean {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => version,
    // Static rendering (renderToString in the tests) reads the same version.
    () => version,
  );
  return !!name && isKnownSlashName(name);
}
