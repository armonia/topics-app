/**
 * Whether the server hosts DOM mirrors from native panes (NATIVE-HOST-03).
 *
 * Learnt from its first `native_dom_host_ack`, not assumed: the shell and the
 * server ship separately, and a pane that stayed native in front of a server
 * that never relays its DOM would leave the other device on a different page.
 * Until the first ack, 'auto' keeps its old rule and joins the shared session.
 */
let accepted = false;
const listeners = new Set<() => void>();

export function noteDomHostAccepted(): void {
  if (accepted) return;
  accepted = true;
  for (const listener of listeners) listener();
}

export function domHostAccepted(): boolean {
  return accepted;
}

export function subscribeDomHostAccepted(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Whether a pane's 'auto' mode still follows the viewer count. Not once the
 * server relays mirrors from native panes: the other device then mirrors this
 * pane's own page, so there is no shared session to join.
 */
export function autoFollowsViewers(tauri: boolean, mode: string, hostsMirror: boolean): boolean {
  return tauri && mode === 'auto' && !hostsMirror;
}
