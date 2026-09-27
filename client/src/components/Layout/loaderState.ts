/**
 * The three states of the loader glyph (`StreamingIndicator`), and the one
 * rule that picks among them. Its own module because a component file that
 * also exports a function breaks Vite's fast refresh.
 *
 *   - working:    the blue arc turns. A turn is answering; a message would queue.
 *   - waiting:    the amber arc stands still. The open turn waits for you.
 *   - background: the grey arc turns slowly. No turn is open, the chat is free,
 *                 and work its last turn left running goes on by itself.
 */
export type LoaderState = 'working' | 'waiting' | 'background';

/**
 * Which glyph a row, a tab or a folder draws, or null for none. On one surface
 * waiting > working > background: what asks for you first, then what answers.
 */
export function loaderStateFor({ loading, waiting, background }: {
  loading: boolean;
  waiting: boolean;
  background: boolean;
}): LoaderState | null {
  if (!loading && !background) return null;
  if (waiting) return 'waiting';
  return loading ? 'working' : 'background';
}
