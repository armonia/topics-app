/**
 * WHERE "SHOW IN FINDER" SHOWS SOMETHING (FILE-03).
 *
 * The reveal runs on the SERVER (`open -R`, `server/routes/files.ts`): from a
 * phone, a browser on another computer or a LAN client it opened Finder on
 * the Mac that runs Topics, in front of nobody, and a Windows server answered
 * 500. The row is offered only in the desktop shell talking to a server on the
 * same machine, a loopback origin: there the Finder that opens is the one in
 * front of the person who clicked.
 */
import type { ShellKind } from './shell';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** `serverBase`: the origin the client reaches its server on (`serverHttpBase()`). */
export function revealOffered(shell: ShellKind, serverBase: string): boolean {
  if (shell !== 'tauri' || !serverBase) return false;
  try {
    return LOOPBACK.has(new URL(serverBase).hostname);
  } catch {
    return false;
  }
}
