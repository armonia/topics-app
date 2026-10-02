/**
 * A toggle's two words in one box as wide as the longer of them, so that
 * switching between them does not change the width of the line it sits in.
 * The word not in use stays in the layout, hidden (`invisible` is also hidden
 * from assistive technology, which reads only the one shown).
 */
export function StableToggleLabel({ open, show, hide }: { open: boolean; show: string; hide: string }) {
  return (
    <span className="inline-grid">
      <span className={`col-start-1 row-start-1 ${open ? 'invisible' : ''}`}>{show}</span>
      <span className={`col-start-1 row-start-1 ${open ? '' : 'invisible'}`}>{hide}</span>
    </span>
  );
}
