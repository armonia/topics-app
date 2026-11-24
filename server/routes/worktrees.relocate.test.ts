/**
 * The two routes of the by-hand relocation: the cleanup preview and
 * `POST /api/worktrees/relocate`. The router is built over a stub context; the
 * decisions themselves are tested on real git in `worktree-relocate.test.ts`.
 *
 * @covers WORKTREE-STD-07
 */
import { describe, expect, test } from "bun:test";
import { createWorktreesRouter } from "./worktrees";
import type { AppContext } from "../types";
import type { RelocateCheckPayload, RelocateResultPayload } from "../../shared/worktree-plan";

const check = (over: Partial<RelocateCheckPayload> = {}): RelocateCheckPayload => ({
  action: "move", from: "/x/wt", to: "/r/p/wt", projectId: "p", projectName: "p", rowId: "w1", ok: true, refusals: [], warnings: [], ...over,
});

function build(result: RelocateResultPayload, sent: unknown[]) {
  const ctx = {
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    readJSON: async (req: Request) => req.json(),
    matchRoute: () => null,
    errorResponse: (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status }),
    worktreeStore: { get: (id: string) => (id === "w1" ? { id: "w1", absPath: "/r/p/wt" } : null) },
    worktreeManager: {},
    broadcastToAll: (m: unknown) => { sent.push(m); },
  } as unknown as AppContext;
  const calls: string[] = [];
  const router = createWorktreesRouter(ctx, {
    planGc: async ({ weigh }) => ({ entries: [], foreignCount: weigh ? 2 : 1, scanMs: 0, overCap: [] }),
    relocate: {
      check: async (a, p) => { calls.push(`check:${a}:${p}`); return check({ action: a }); },
      run: async (a, p) => { calls.push(`run:${a}:${p}`); return result; },
    },
  });
  const post = (body: unknown) => router(
    new Request("http://x/api/worktrees/relocate", { method: "POST", body: JSON.stringify(body) }),
    new URL("http://x/api/worktrees/relocate"), "/api/worktrees/relocate", "POST",
  );
  return { router, post, calls };
}

describe("worktree relocation routes", () => {
  test("a relative path and an unknown action are 400", async () => {
    const { post } = build({ ok: true, check: check() }, []);
    expect((await post({ path: "rel/wt", action: "move" }))!.status).toBe(400);
    expect((await post({ path: "/x/wt", action: "burn" }))!.status).toBe(400);
  });

  test("dryRun only checks; a move runs and tells the clients the row changed", async () => {
    const sent: any[] = [];
    const { post, calls } = build({ ok: true, check: check(), to: "/r/p/wt", rowId: "w1" }, sent);
    const dry = await post({ path: "/x/wt", action: "move", dryRun: true });
    expect((await dry!.json()).check.ok).toBe(true);
    expect(calls).toEqual(["check:move:/x/wt"]);
    expect(sent).toHaveLength(0);
    const res = await post({ path: "/x/wt", action: "move" });
    expect((await res!.json()).ok).toBe(true);
    expect(calls).toEqual(["check:move:/x/wt", "run:move:/x/wt"]);
    expect(sent[0]).toMatchObject({ type: "worktree:updated", worktree: { id: "w1" } });
  });

  test("a refusal is a 200 with the reasons and broadcasts nothing", async () => {
    const sent: unknown[] = [];
    const { post } = build({ ok: false, check: check({ ok: false, refusals: ["dirty"] }) }, sent);
    const res = await post({ path: "/x/wt", action: "move" });
    expect(res!.status).toBe(200);
    expect((await res!.json()).check.refusals).toEqual(["dirty"]);
    expect(sent).toHaveLength(0);
  });

  test("a removal announces the deleted row", async () => {
    const sent: any[] = [];
    const { post } = build({ ok: true, check: check({ action: "remove" }), rowId: "w1" }, sent);
    await post({ path: "/x/wt", action: "remove" });
    expect(sent[0]).toMatchObject({ type: "worktree:deleted", worktree: { id: "w1" } });
  });

  test("the preview route reads the weigh flag", async () => {
    const { router } = build({ ok: true, check: check() }, []);
    const get = (q: string) => router(new Request(`http://x/api/worktrees/gc/plan${q}`), new URL(`http://x/api/worktrees/gc/plan${q}`), "/api/worktrees/gc/plan", "GET");
    expect((await (await get(""))!.json()).plan.foreignCount).toBe(1);
    expect((await (await get("?weigh=1"))!.json()).plan.foreignCount).toBe(2);
  });
});
