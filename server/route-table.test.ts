/**
 * @covers GATE-17
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_ROUTER_ORDER,
  CONDITIONAL_API_ROUTERS,
  buildRouteTable,
  dispatchRouteTable,
  type ApiRouters,
  type ApiRouterName,
} from "./route-table";
import type { RouteHandler } from "./types";

// Golden precedence list. It is the order of the `||` chain that server.ts
// used before the table (commit 31fd118b9). A change here is a precedence
// change and must be deliberate: the first router to answer wins.
const GOLDEN_ORDER = [
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
];

const req = new Request("http://localhost/api/x");
const url = new URL(req.url);

/** A full router set where every router declines, with optional overrides. */
function routers(overrides: Partial<Record<ApiRouterName, RouteHandler | null>> = {}): ApiRouters {
  const all = Object.fromEntries(API_ROUTER_ORDER.map((n) => [n, () => null])) as Record<string, RouteHandler | null>;
  return { ...all, ...overrides } as ApiRouters;
}

describe("API route table", () => {
  test("the precedence order is the golden list", () => {
    expect<string[]>([...API_ROUTER_ORDER]).toEqual(GOLDEN_ORDER);
    expect<string[]>(buildRouteTable(routers()).map((e) => e.name)).toEqual(GOLDEN_ORDER);
  });

  test("only openclawContextRouter is conditional, on the openclaw provider", () => {
    expect(CONDITIONAL_API_ROUTERS).toEqual({ openclawContextRouter: "aiProvider.name === 'openclaw'" });
    const conditional = buildRouteTable(routers()).filter((e) => e.condition !== null).map((e) => e.name);
    expect(conditional).toEqual(["openclawContextRouter"]);
  });

  test("the first router that answers wins, earlier nulls fall through", async () => {
    const calls: string[] = [];
    const track = (name: ApiRouterName, answer: Response | null | undefined): RouteHandler => () => {
      calls.push(name);
      return answer as Response | null;
    };
    const table = buildRouteTable(routers({
      topicsRouter: track("topicsRouter", null),
      voiceRouter: track("voiceRouter", undefined),
      mediaRouter: track("mediaRouter", new Response("media")),
      branchesRouter: track("branchesRouter", new Response("branches")),
    }));
    const res = await dispatchRouteTable(table, req, url, "/api/x", "GET");
    expect(await res?.text()).toBe("media");
    expect(calls).toEqual(["topicsRouter", "voiceRouter", "mediaRouter"]);
  });

  test("an absent conditional router is skipped, a present one keeps its slot", async () => {
    const answerFrom = (body: string): RouteHandler => async () => new Response(body);
    const absent = buildRouteTable(routers({ openclawContextRouter: null, contextPreviewRouter: answerFrom("preview") }));
    expect(await (await dispatchRouteTable(absent, req, url, "/api/x", "GET"))?.text()).toBe("preview");
    const present = buildRouteTable(routers({ openclawContextRouter: answerFrom("openclaw"), contextPreviewRouter: answerFrom("preview") }));
    expect(await (await dispatchRouteTable(present, req, url, "/api/x", "GET"))?.text()).toBe("openclaw");
  });

  test("nobody answers: null, so the caller sends its 404", async () => {
    expect(await dispatchRouteTable(buildRouteTable(routers()), req, url, "/api/x", "GET")).toBeNull();
  });

  test("a router that throws stops the walk and the error propagates", async () => {
    let laterCalled = false;
    const table = buildRouteTable(routers({
      voiceRouter: () => { throw new Error("boom"); },
      mediaRouter: () => { laterCalled = true; return new Response("late"); },
    }));
    await expect(dispatchRouteTable(table, req, url, "/api/x", "GET")).rejects.toThrow("boom");
    expect(laterCalled).toBe(false);
  });

  test("server.ts hands every router to the table and keeps no chain of its own", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const call = src.match(/const apiRouteTable = buildRouteTable\(\{([\s\S]*?)\}\);/);
    expect(call).not.toBeNull();
    const passed = call![1].split(",").map((s) => s.trim()).filter(Boolean);
    expect([...passed].sort()).toEqual([...GOLDEN_ORDER].sort());
    expect(src).toContain("await dispatchRouteTable(apiRouteTable, req, url, pathname, method)");
    expect(src).not.toMatch(/\|\|\s*await \w+Router\(req, url, pathname, method\)/);
  });
});
