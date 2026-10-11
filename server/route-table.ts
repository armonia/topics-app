import type { RouteHandler } from "./types";

/**
 * The order in which `/api/*` requests are offered to the routers.
 *
 * The first router that returns a Response answers; a router that returns
 * null (or undefined) lets the request fall through to the next one. Order is
 * precedence: a broad matcher placed early hides a narrower one placed later,
 * which is how the Context Inspector went dark outside openclaw (d5f4ca354).
 *
 * This list used to exist only as a 45-line `||` chain inside `fetch`. It now
 * lives here, so it can be read, pinned by a test
 * (`server/route-table.test.ts`) and checked for overlapping claims
 * (`scripts/check-route-shadowing.ts`). Changing the order is a precedence
 * change: update the golden list in the test on purpose, never as a side effect.
 */
export const API_ROUTER_ORDER = [
  "topicsRouter",
  "orchestratorSessionsRouter",
  "voiceRouter",
  "mediaRouter",
  "branchesRouter",
  "projectsRouter",
  "worktreesRouter",
  "machinesRouter",
  "nodesRouter",
  "filesRouter",
  "browserRouter",
  "cronRouter",
  "contextRouter",
  "terminalRouter",
  "statusRouter",
  "memoryRouter",
  "mcpRouter",
  "sessionEnvironmentRouter",
  "activityRouter",
  "externalSessionsRouter",
  "checkpointsRouter",
  "goalsRouter",
  "openRouter",
  "openclawContextRouter",
  "contextPreviewRouter",
  "authRouter",
  "accountRouter",
  "peopleRouter",
  "licenseRouter",
  "billingRouter",
  "dashboardRouter",
  "usageRouter",
  "profileRouter",
  "processesRouter",
  "tasksRouter",
  "pushRouter",
  "notificationsRouter",
  "clientTraceRouter",
  "uiStateRouter",
  "providersRouter",
  "appSettingsRouter",
  "calendarRouter",
  "tabsRouter",
  "viewsRouter",
  "claudeHooksRouter",
  "e2eRouter",
] as const;

export type ApiRouterName = (typeof API_ROUTER_ORDER)[number];

/**
 * Routers that exist only under a condition, with the condition spelled out.
 * Their slot in the order is fixed; when the condition is false the router is
 * null and the slot is skipped, exactly as `(x && await x(...))` did.
 */
export const CONDITIONAL_API_ROUTERS = {
  openclawContextRouter: "aiProvider.name === 'openclaw'",
} as const;

type ConditionalApiRouterName = keyof typeof CONDITIONAL_API_ROUTERS;

/** Every router by name; only the conditional ones may be null. */
export type ApiRouters = {
  [K in ApiRouterName]: K extends ConditionalApiRouterName ? RouteHandler | null : RouteHandler;
};

export interface RouteTableEntry {
  name: ApiRouterName;
  router: RouteHandler | null;
  /** The condition under which the router exists, or null when it always does. */
  condition: string | null;
}

/** Lays the routers out in `API_ROUTER_ORDER`. */
export function buildRouteTable(routers: ApiRouters): readonly RouteTableEntry[] {
  return API_ROUTER_ORDER.map((name) => ({
    name,
    router: routers[name],
    condition: (CONDITIONAL_API_ROUTERS as Partial<Record<ApiRouterName, string>>)[name] ?? null,
  }));
}

/**
 * Offers the request to each router in order; the first truthy result wins.
 * Same semantics as the `a(...) || b(...) || ...` chain it replaces: a falsy
 * result falls through, an absent conditional router is skipped, a throw
 * propagates, and when nobody answers the result is null.
 */
export async function dispatchRouteTable(
  table: readonly RouteTableEntry[],
  req: Request,
  url: URL,
  pathname: string,
  method: string,
): Promise<Response | null> {
  for (const entry of table) {
    if (!entry.router) continue;
    const response = await entry.router(req, url, pathname, method);
    if (response) return response;
  }
  return null;
}
