/**
 * Did this dragleave really leave `host`, or only cross into one of its children?
 *
 * Every drop zone here asked `relatedTarget && host.contains(relatedTarget)`.
 * That holds in Chromium, but WebKit (Safari, and the WKWebView of the Tauri
 * shell) fires dragleave with a NULL relatedTarget, so each child crossed inside
 * a pane body read as "left": the split preview blinked off under a pointer that
 * never moved out, and on a quick release there was nothing painted to trust.
 *
 * When the browser names the element entered, that name decides: a child means
 * stay, anything else means leave (a strip layered over the body is not a child,
 * and it clears this hover itself). When it names nothing, the pointer does: still
 * strictly inside the host's rect means stay. The boundary pixel counts as out,
 * so the neighbour the pointer is entering can take over.
 */

/** The slice of an element this decision needs, structural so a test can pass
 *  a plain object (this project has no DOM in its unit tests). */
export interface LeaveHost {
  contains(node: unknown): boolean;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
}

export interface LeaveEvent {
  relatedTarget: unknown;
  clientX: number;
  clientY: number;
}

export function dragLeftHost(host: LeaveHost, e: LeaveEvent): boolean {
  if (e.relatedTarget) return !host.contains(e.relatedTarget);
  const r = host.getBoundingClientRect();
  const inside = e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
  return !inside;
}
