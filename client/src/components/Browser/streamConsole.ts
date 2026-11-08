/**
 * THE CONSOLE OF THE SHARED (SERVER-STREAMED) PAGE, as this pane keeps it.
 *
 * The server forwards every `console` line of its page over the pane's socket.
 * The pane keeps them as rows, like the native pane does, for two readers: the
 * tab's red dot (the tallies) and the sheet's Console section (the rows, with
 * the command that clears them). A tally without rows was a dot that said
 * "errors on this page" and opened nothing.
 *
 * EACH ROW BELONGS TO A PAGE. The dot speaks about "this page", so when the
 * pane lands on another document the rows of the previous one leave. The page
 * is the one the server was on when the line was logged (`pageUrl`), not the
 * one the pane shows: the server announces a navigation only at `load`, AFTER
 * the scripts of the new page ran, and a page that throws while loading is the
 * very case the dot exists for. Pruning by "what the pane shows" at that moment
 * would erase those errors together with the old ones.
 */
import type { BrowserConsoleEntry } from './browserDevTypes';

/** A row and the page it was logged on. */
export interface StreamConsoleEntry extends BrowserConsoleEntry {
  page: string;
}

/** Same cap as the native pane's console. */
export const STREAM_CONSOLE_CAP = 500;

/** The document, without the fragment: `#section` is the same page. */
function documentOf(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

export function isSameDocument(a: string, b: string): boolean {
  return documentOf(a) === documentOf(b);
}

/** Add a row, dropping the oldest past the cap. */
export function appendStreamConsole(
  entries: readonly StreamConsoleEntry[],
  entry: StreamConsoleEntry,
): StreamConsoleEntry[] {
  const next = entries.concat(entry);
  return next.length > STREAM_CONSOLE_CAP ? next.slice(next.length - STREAM_CONSOLE_CAP) : next;
}

/**
 * The pane landed on `url`: keep only the rows logged on that document. Returns
 * the SAME array when nothing leaves, so a load of the page already shown costs
 * no render.
 */
export function keepConsoleOfPage(
  entries: StreamConsoleEntry[],
  url: string,
): StreamConsoleEntry[] {
  if (entries.every((e) => isSameDocument(e.page, url))) return entries;
  return entries.filter((e) => isSameDocument(e.page, url));
}

export function tallyConsole(entries: readonly BrowserConsoleEntry[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const e of entries) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warn') warnings++;
  }
  return { errors, warnings };
}
