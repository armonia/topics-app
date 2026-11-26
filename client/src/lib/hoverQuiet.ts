/**
 * Two moments where a closed tab's hover ground would lie, handled where they
 * happen. Every tab in the column takes the same ground under the pointer, the
 * closed ones included (25/11), and a closed row under the pointer is one
 * shade off an open tab at rest. That is the point of a hover, except here:
 *
 *  - the row that a click just CLOSED is still under the pointer. With its
 *    ground on, the close looks like it did nothing (25/11: "if I press a
 *    tab's close nothing seems to happen"). The row gets `data-hover-quiet`
 *    from the moment it turns closed until the pointer leaves it.
 *  - WKWebView keeps `:hover` on the last element after the pointer leaves the
 *    window, so a closed row would keep a ground and read as open (25/11, a
 *    closed project that looked open). `<html data-pointer-away>` is set while
 *    the pointer is outside the window.
 *
 * index.css cancels a plain closed row's hover ground under either attribute
 * (never an attention fill). Both are CSS hooks only: nothing reads them back.
 */

const QUIET = 'data-hover-quiet';
const AWAY = 'data-pointer-away';
const OPEN_ROW = '[data-tab-state="open"]';

export function installHoverQuiet(doc: Document = document): () => void {
  const html = doc.documentElement;
  const watched = new WeakSet<Element>();

  const onClick = (event: MouseEvent) => {
    const row = (event.target as Element | null)?.closest?.(OPEN_ROW);
    if (!row || watched.has(row)) return;
    watched.add(row);
    // The close is not synchronous (a store update, sometimes a server round
    // trip), so the row is watched until the pointer leaves it.
    const observer = new MutationObserver(() => {
      if (row.getAttribute('data-tab-state') === 'closed') row.setAttribute(QUIET, '');
      else row.removeAttribute(QUIET);
    });
    observer.observe(row, { attributes: true, attributeFilter: ['data-tab-state'] });
    const release = () => {
      observer.disconnect();
      row.removeAttribute(QUIET);
      row.removeEventListener('pointerleave', release);
      watched.delete(row);
    };
    row.addEventListener('pointerleave', release);
  };

  const back = () => html.removeAttribute(AWAY);
  // A `mouseout` with no element on the other side is the pointer leaving the
  // page itself.
  const onWindowOut = (event: MouseEvent) => {
    if (!event.relatedTarget) html.setAttribute(AWAY, '');
  };

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('mouseout', onWindowOut);
  doc.addEventListener('pointermove', back, { passive: true });

  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('mouseout', onWindowOut);
    doc.removeEventListener('pointermove', back);
    back();
  };
}
