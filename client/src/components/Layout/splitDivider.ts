/**
 * Pure divider-placement rule for the SplitTree renderer. Lives in its own
 * (non-component) module so SplitTree.tsx keeps a component-only export surface
 * (react-refresh/only-export-components) and this stays unit-testable.
 */
import type { SplitChild } from '../../state/layout/layoutTree';

/** Whether the gap BEFORE child `i` should render a resize divider. A divider
 *  is meaningful only between two visible siblings, so it renders iff `i > 0`
 *  and BOTH the child at `i` and its predecessor have weight > 0. A dedup'd or
 *  empty-row placeholder collapses to weight 0 (`buildShallowGridTree`); a
 *  divider adjacent to that zero-width cell is a dead grab strip that overlaps —
 *  and masks — the neighbouring real divider, which is how a resizer goes
 *  "missing". */
export function gapHasDivider(children: readonly SplitChild[], i: number): boolean {
  return i > 0 && (children[i]?.weight ?? 0) > 0 && (children[i - 1]?.weight ?? 0) > 0;
}
