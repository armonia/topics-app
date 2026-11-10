/** The mark of an empty cell in a table: there to keep the column aligned, silent to screen readers. */
export function Blank() {
  return <span className="text-app-text-faint" aria-hidden="true">–</span>; // allow-emdash: the empty-cell marker is the data
}
