/**
 * THE FILE YOU ALREADY OPENED, kept locally so opening it again is instant.
 *
 * `FilePane` starts with `content = ''` and `loading = true`: every open - and
 * every reload with a file open - paints a spinner in the middle of an empty
 * pane, then swaps in the text. The swap is the flash, and on a reload it is
 * also a layout shift, because the spinner is centred and the text is not.
 *
 * What is kept is the TEXT of a handful of recently opened files. Not a mirror
 * of the project: a file you looked at in the last few minutes, at most
 * `MAX_ENTRIES` of them, each under `MAX_BYTES`, evicted oldest-first. Anything
 * larger is not worth a quota error to save one spinner.
 *
 * The copy is a SEED, not an authority: the read leaves in the same breath and
 * replaces the text as soon as it answers, so a file changed on disk (or by an
 * agent) shows its real content a moment later - in the same box, without
 * moving anything.
 */

const KEY = 'file-content-cache';
/** How many files stay in the drawer. A tab strip rarely holds more. */
const MAX_ENTRIES = 12;
/** Per file. Past this the spinner is cheaper than the storage. */
const MAX_BYTES = 128 * 1024;

type Entry = { text: string; at: number };
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

/** The cached text of `path`, or null when it was never read or was too big. */
export function readFileContentCache(path: string): string | null {
  const entry = readDrawer()[path];
  return entry && typeof entry.text === 'string' ? entry.text : null;
}

export function writeFileContentCache(path: string, text: string): void {
  if (text.length > MAX_BYTES) return;
  try {
    const drawer = readDrawer();
    drawer[path] = { text, at: Date.now() };
    const kept = Object.entries(drawer)
      .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* quota, private mode: the seed is an optimisation, never a requirement */
  }
}
