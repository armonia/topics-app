/**
 * THE OVERFLOW'S WIRING in `server.ts`: what the dispatcher is handed as
 * `overflowMachines`, `githubOriginOf` and `node.ensureBranchOnOrigin`.
 *
 * The dispatcher's own tests inject these three, so none of them can see a
 * server that passes the wrong machine list (the cloud online without an
 * environment, a PC without its wake-up) or no list at all. The behaviour is
 * tested on the two functions server.ts calls; that server.ts calls them, with
 * the live inputs, is pinned by reading the source, like
 * `swap-freeze.wiring.test.ts` does for its order.
 *
 * @covers KANBAN-76
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { githubOriginFrom, overflowMachinesFrom, type OverflowMachineRow } from "./dispatch-overflow";

const server = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");

/** The source of the `createTaskDispatcher({ ... })` call: the wiring must be inside it. */
function dispatcherCall(): string {
  const start = server.indexOf("const taskDispatcher = createTaskDispatcher({");
  expect(start, "createTaskDispatcher is not called any more").toBeGreaterThan(-1);
  const end = server.indexOf("\n});", start);
  return server.slice(start, end);
}

const rows: OverflowMachineRow[] = [
  { id: "local", name: "Questo Mac", baseUrl: null, status: "online" },
  { id: "cloud", name: "Cloud Claude", baseUrl: "claude-cloud://", status: "online" },
  { id: "pc", name: "PC Windows", baseUrl: "https://pc.local", status: "offline" },
];
const isCloud = (url: string) => url.startsWith("claude-cloud:");

describe("overflowMachinesFrom: the machine list the server hands the dispatcher", () => {
  it("only rows with an address; the cloud online with its environment, a sleeping PC wakeable by the hook", () => {
    expect(overflowMachinesFrom({ rows, isCloud, cloudEnabled: true, environmentOk: true, wakeable: true })).toEqual([
      { id: "cloud", name: "Cloud Claude", kind: "cloud", online: true },
      { id: "pc", name: "PC Windows", kind: "node", online: false, wakeable: true },
    ]);
  });

  it("an account without an active cloud environment: the cloud is not online", () => {
    const [cloud] = overflowMachinesFrom({ rows, isCloud, cloudEnabled: true, environmentOk: false, wakeable: false });
    expect(cloud).toMatchObject({ id: "cloud", online: false });
  });

  it("not asked yet (null) does not take the cloud offline; the cloud switched off here does", () => {
    expect(overflowMachinesFrom({ rows, isCloud, cloudEnabled: true, environmentOk: null, wakeable: false })[0]!.online).toBe(true);
    expect(overflowMachinesFrom({ rows, isCloud, cloudEnabled: false, environmentOk: true, wakeable: false })[0]!.online).toBe(false);
  });

  it("no node-run hook: the sleeping PC is not wakeable", () => {
    const pc = overflowMachinesFrom({ rows, isCloud, cloudEnabled: true, environmentOk: true, wakeable: false })[1]!;
    expect(pc).toMatchObject({ id: "pc", online: false, wakeable: false });
  });
});

describe("githubOriginFrom: is the project's origin on GitHub", () => {
  it("a slug is yes; no origin, no slug or a failing lookup is no", async () => {
    expect(await githubOriginFrom("git@github.com:acme/alpha.git", async () => "acme/alpha")).toBe(true);
    expect(await githubOriginFrom(null, async () => "acme/alpha")).toBe(false);
    expect(await githubOriginFrom("https://gitlab.com/acme/alpha.git", async () => null)).toBe(false);
    expect(await githubOriginFrom("git@github.com:acme/alpha.git", async () => { throw new Error("offline"); })).toBe(false);
  });
});

describe("server.ts hands those functions to the dispatcher, with the live inputs", () => {
  const call = dispatcherCall();

  it("overflowMachines reads the machine store, the cloud switch, the environment and the node-run hook", () => {
    const at = call.indexOf("overflowMachines: () => overflowMachinesFrom({");
    expect(at, "overflowMachines is not wired through overflowMachinesFrom").toBeGreaterThan(-1);
    const body = call.slice(at, call.indexOf("}),", at));
    expect(body).toContain("rows: ctx.machineStore.list()");
    expect(body).toContain("isCloud: isCloudBaseUrl");
    expect(body).toContain("cloudEnabled");
    expect(body).toContain("environmentOk: cloudNode.environmentReady()?.ok ?? null");
    expect(body).toContain('declares?.("node-run")');
  });

  it("githubOriginOf asks the planter for the origin and resolves its GitHub slug", () => {
    expect(call).toContain("githubOriginOf: async (projectId) => githubOriginFrom(await nodeBranchPlanter.originUrlOf(projectId), resolveGithubSlug)");
  });

  it("the remote lane can push a card's own branch before it leaves", () => {
    expect(call).toContain("ensureBranchOnOrigin: ({ projectId, branch }) => ensureBranchOnOrigin(projectPathForNode(projectId), branch)");
  });

  it("the cloud row goes offline from the heartbeat when the account has no environment", () => {
    const beat = server.slice(server.indexOf("function tickHeartbeat()"));
    expect(beat).toContain("void cloudNode.probeEnvironment();");
    expect(beat).toContain("ctx.machineStore.markNodeOffline(cloud.id)");
  });
});
