import type { Pane } from '../../types';

/**
 * WHICH SURFACE OF A PROJECT TAKES THE WINDOW'S TITLE.
 *
 * With the tabs at the side a project with one group draws no bar of its own,
 * and the window's title names the project (approved 25/11). A browser is the
 * exception: its tab is where its address, its icon and its commands live, and
 * with no bar it had them nowhere (25/11, «non vedo la tab del browser»). So a
 * browser in front puts its own tab on the title; every other surface leaves
 * the project's there.
 *
 * One predicate for the two places that must agree: the layout that draws the
 * tab on the title (`GroupLayout`) and the close that keeps it in front while
 * its countdown runs (`useProjectLayout`).
 */
export function takesTheTitle(pane: Pick<Pane, 'type'>): boolean {
  return pane.type === 'browser';
}
