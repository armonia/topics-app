/**
 * IS THE AGENT DRIVING THIS BROWSER PANE RIGHT NOW?
 *
 * The pill on the tab and the spinner on the sidebar row read this one boolean.
 * It used to have a single input - the `agent_active` frame - and therefore a
 * single way to turn off: the server sending `false`. That `false` is emitted
 * from the `try/finally` of the delegation lock, so on a healthy socket it
 * always comes.
 *
 * On a socket that DIED it never comes, and there was nothing else to switch
 * the pill off: `setAgentActive` had exactly two sites in the whole repo, the
 * initial `useState(false)` and that frame. The socket had no `close` handler,
 * no `error` handler and no reconnection, so the spinner kept turning on a page
 * that had been idle for hours.
 *
 * Two real causes, both of which close the socket rather than dropping a single
 * frame: the server restarting (the file watcher sends SIGTERM on every save
 * under `server/`, so many times a day while someone is working) and the 90s
 * reaper firing on sleep or a network drop.
 *
 * So the rule that was missing: A SOCKET THAT DIED IS NOT REPORTING ANYTHING.
 * Disconnection is an input of this state, not an absence of input.
 *
 * The streaming sibling has two exits this pane lacks - a reconnect backoff and
 * a "take control" button. Adding those is a separate piece of work; this is
 * only about not lying while they are missing.
 */

/** What can change the answer. */
export type AgentActivityEvent =
  /** The server said so, one way or the other. */
  | { kind: 'frame'; active: boolean }
  /** The socket closed or errored. Whatever it was saying, it is not saying it now. */
  | { kind: 'disconnected' };

/**
 * Whether the agent is driving, after this event.
 *
 * It does not read the previous value on purpose: both inputs are ABSOLUTE.
 * A frame states the fact, and a disconnection ends it whatever it was. A rule
 * that folded in the old value would let a lost frame outlive its socket, which
 * is the defect itself.
 *
 * Pure so it can fail in a test: inside an effect it could not.
 */
export function nextAgentActive(event: AgentActivityEvent): boolean {
  return event.kind === 'disconnected' ? false : event.active;
}
