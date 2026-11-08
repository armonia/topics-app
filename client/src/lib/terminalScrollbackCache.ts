/**
 * THE LAST SCREEN OF A TERMINAL, kept locally so a reload comes back to it.
 *
 * The server keeps the real scrollback and replays it over the socket, which is
 * the authority and stays the authority. What it cannot do is be there on the
 * first frame: the pane has to mount, xterm has to build, the socket has to
 * open and the backlog has to arrive. Measured on this machine, `.xterm-rows`
 * appeared 294-365 ms after `DOMContentLoaded` - a third of a second of empty
 * black where the reader had left a screen full of output.
 *
 * So the last screen is written down: plain text, the visible rows only, capped
 * hard. It is drawn immediately and it disappears the moment the replay lands,
 * which is the only moment at which it stops being what the reader was looking
 * at.
 */

const KEY = 'terminal-scrollback-cache';
/** How many sessions keep a screen. Beyond this, the oldest goes. */
const MAX_SESSIONS = 8;
/** Per session. A screen, not a history: the history is the server's. */
const MAX_CHARS = 8 * 1024;

/**
 * `rowPx`: the height of one xterm row when the screen was written down. The
 * seed draws its lines at that height; at a fixed 17 px they drifted from the
 * rows drawn over them by the difference per line (15 px rows in WebKit's
 * fallback font: the third line from the bottom 6 px off).
 */
type Entry = { text: string; at: number; rowPx?: number };
/** What the seed draws: the text, and the row height it was written at. */
export type TerminalScreenCopy = { text: string; rowPx: number | null };
type Drawer = Record<string, Entry>;

function readDrawer(): Drawer {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Drawer;
  } catch {
    return {};
  }
}

/** The last screen of `sessionId`, or null when there is none worth drawing. */
export function readTerminalScrollback(sessionId: string): TerminalScreenCopy | null {
  const entry = readDrawer()[sessionId];
  const text = entry && typeof entry.text === 'string' ? entry.text : '';
  if (!text.trim().length) return null;
  const rowPx = typeof entry.rowPx === 'number' && entry.rowPx > 0 ? entry.rowPx : null;
  return { text, rowPx };
}

export function writeTerminalScrollback(sessionId: string, text: string, rowPx?: number): void {
  try {
    const trimmed = text.length > MAX_CHARS ? text.slice(text.length - MAX_CHARS) : text;
    const drawer = readDrawer();
    if (!trimmed.trim().length) delete drawer[sessionId];
    else drawer[sessionId] = { text: trimmed, at: Date.now(), ...(rowPx && rowPx > 0 ? { rowPx } : {}) };
    const kept = Object.entries(drawer)
      .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
      .slice(0, MAX_SESSIONS);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* quota, private mode: the seed is an optimisation, never a requirement */
  }
}
