/**
 * A viewer's input over REST, on a page the Mac hosts: the fallback a device
 * uses while its socket reconnects. It has to reach the host whole, as the
 * socket carries it. A mirror laid out at its own size names the element a
 * tap landed on and the place a scroll reached, and its pixels alone would
 * land on something else in the Mac's layout.
 *
 * @covers BROWSER-DOM-LAYOUT-02
 * @covers BROWSER-DOM-LAYOUT-03
 */
import { describe, test, expect } from "bun:test";
import { createBrowserRouter } from "./browser";

const CTX = "hosted-page";

function harness() {
  const sent: Array<{ type: string; action?: string; payload?: Record<string, unknown> }> = [];
  const ctx = {
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    readJSON: async (req: Request) => req.json(),
    errorResponse: (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status }),
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/");
      const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
  } as unknown as Parameters<typeof createBrowserRouter>[0];
  const service = { setEngineHint: () => {}, listContexts: () => [] } as unknown as Parameters<typeof createBrowserRouter>[1];
  const hosts = {
    isHosting: (id: string) => id === CTX,
    page: () => undefined,
    command: (_id: string, cmd: (typeof sent)[number]) => { sent.push(cmd); },
  } as unknown as NonNullable<Parameters<typeof createBrowserRouter>[3]>;
  const router = createBrowserRouter(ctx, service, () => 0, hosts);
  const interact = (body: unknown) => {
    const url = new URL(`http://x/api/browsers/${CTX}/interact`);
    return router(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, url.pathname, "POST");
  };
  return { interact, sent };
}

describe("POST /api/browsers/:id/interact on a page the Mac hosts", () => {
  test("a tap keeps the element it names and where inside it", async () => {
    const { interact, sent } = harness();
    const res = await interact({ action: "click", x: 40, y: 400, node: 12, fx: 0.3, fy: 0.5, button: "left" });
    expect(res?.status).toBe(200);
    expect(sent).toEqual([{ type: "host_input", action: "click", payload: { x: 40, y: 400, node: 12, fx: 0.3, fy: 0.5, button: "left" } }]);
  });

  test("a scroll keeps the place it reached", async () => {
    const { interact, sent } = harness();
    const anchor = { id: 21, fx: 0.5, fy: 0.5, lx: 0.5, ly: 0.25, rx: 0, ry: 0.4 };
    await interact({ action: "scroll", x: 500, y: 400, deltaY: 30, node: 1, target: 21, anchor });
    expect(sent[0]?.payload).toEqual({ x: 500, y: 400, deltaY: 30, node: 1, target: 21, anchor });
  });

  test("an input the socket would refuse is refused here too", async () => {
    const { interact, sent } = harness();
    const res = await interact({ action: "click", x: "40", y: 400 });
    expect(res?.status).toBe(400);
    expect(sent).toEqual([]);
  });
});
