/**
 * One console line for each decision between `open_browser_pane` and an
 * attached `/ws/browser/<ctx>` socket.
 *
 * The 24/09 incident (card c5c1c68f) left nothing to read on the client side.
 * The server log showed a pane socket closing two seconds after a reconnect,
 * and a force-open that attached nothing fourteen minutes later. Every theory
 * about what happened in between came from reading code. These lines are what
 * the next occurrence must leave behind: which project windows saw the
 * broadcast, whether the pane existed and in which cell, which branch
 * force-open took, and what unmounted the pane.
 *
 * `console.info` rather than a debug flag: these events are rare (a handful per
 * browser opening), and a flag nobody turned on logs nothing.
 */
export function tracePaneAttach(event: string, fields: Record<string, unknown> = {}): void {
  console.info('[pane-attach]', event, fields);
}
