/**
 * THE ADDRESS OF ONE PLACE INSIDE «AGENTI» (AGENTS-NAV-01, AGENTS-02).
 *
 * The Agenti pane has no pathname of its own (it opens as a utility, not a
 * route), so its own place — which agent, Activity or Configure, which
 * Configure section — lives in the hash: `#agenti/<agentId>` for the agent's
 * page (Activity, the default), `#agenti/<agentId>/configura/<section>` for
 * one Configure section. Written with `history.replaceState` on every change
 * so a reload opens on the same section instead of back at the overview —
 * the one thing AGENTS-02 asks for — without touching the pathname-based
 * links the rest of the app owns (`/lavori`, `/tab/…`).
 */
export type AgentsRoute =
  | { view: "overview" }
  | { view: "agent"; agentId: string; tab: "activity" }
  | { view: "agent"; agentId: string; tab: "configure"; section: string };

const PREFIX = "#agenti";

export function agentsRouteToHash(route: AgentsRoute): string {
  if (route.view === "overview") return PREFIX;
  if (route.tab === "activity") return `${PREFIX}/${encodeURIComponent(route.agentId)}`;
  return `${PREFIX}/${encodeURIComponent(route.agentId)}/configura/${encodeURIComponent(route.section)}`;
}

export function agentsRouteFromHash(hash: string): AgentsRoute | null {
  if (!hash.startsWith(PREFIX)) return null;
  const rest = hash.slice(PREFIX.length).replace(/^\/+/, "");
  if (!rest) return { view: "overview" };
  const parts = rest.split("/").map(decodeURIComponent);
  const [agentId, maybeConfigura, section] = parts;
  if (!agentId) return { view: "overview" };
  if (maybeConfigura === "configura" && section) return { view: "agent", agentId, tab: "configure", section };
  return { view: "agent", agentId, tab: "activity" };
}

/** Writes `route` into the hash without adding a history entry (one per navigation would flood it). */
export function writeAgentsRoute(route: AgentsRoute): void {
  const hash = agentsRouteToHash(route);
  if (window.location.hash === hash) return;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", pathname + search + hash);
}

/** The route the current address names, or the overview when it names none. */
export function readAgentsRoute(): AgentsRoute {
  return agentsRouteFromHash(window.location.hash) ?? { view: "overview" };
}
