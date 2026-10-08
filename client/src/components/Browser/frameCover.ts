/**
 * WHILE THE PHONE'S LIST COVERS THE PANES, THE PAGES ARE NOT PAINTED.
 *
 * On the phone the list is a drawer as wide as the screen, drawn over the
 * panes from INSIDE the app's root, so it paints under the layer of browser
 * pages (`hostedIframe.ts`, see `LAYER_Z`). With a browser tab behind it, the
 * tab's page covered the list from the top row to the button row, and the
 * «bundle rebuilt» notice docked at its bottom with it: Reload and close
 * answered `browser-iframe` (usability audit, phone, 07/10;
 * `browser-frame-under-phone-list.spec.ts`). The pane shows nothing while the
 * drawer is open, so its page must not either.
 *
 * The whole layer goes `visibility: hidden`, and nothing else changes: no frame
 * is detached, moved or hidden one by one, so no page reloads and each keeps
 * its rectangle for the moment the list goes away. A hidden layer takes no
 * taps either. The drawer's own hook says when (`useSidebarSwipe`).
 *
 * A MODULE OF ITS OWN because the drawer is on the startup path and the frame
 * layer is not: importing `hostedIframe` from the drawer's hook put the whole
 * module in the entry chunk (critical path +1.1 KB gz, `check:bundle`). The
 * layer is found by its attribute, and a layer created later reads
 * `framesCovered()` when it is born.
 */

/** The attribute `hostedIframe` puts on its layer. */
export const FRAME_LAYER_ATTR = 'data-browser-frame-layer';

let covered = false;

export function framesCovered(): boolean {
  return covered;
}

export function setFramesCovered(next: boolean): void {
  covered = next;
  const layer = document.querySelector<HTMLElement>(`[${FRAME_LAYER_ATTR}]`);
  if (layer) layer.style.visibility = next ? 'hidden' : '';
}
