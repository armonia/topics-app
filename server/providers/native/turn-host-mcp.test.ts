/**
 * An MCP call from a detached native turn is retried only when it never
 * reached the server (lossless-restart).
 *
 * @covers CCLI-04
 */
import { describe, test, expect, afterEach } from "bun:test";
import { callServerMcp } from "./turn-host";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

function spec(baseUrl: string) {
  return { sessionKey: "topic:mcp00001", server: { baseUrl } };
}

describe("MCP call through the server", () => {
  test("a connection cut after the request arrived is not sent again", async () => {
    let received = 0;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data(s) { received++; s.end(); }, open() {} },
    });
    servers.push(listener);
    const out = await callServerMcp(spec(`http://127.0.0.1:${listener.port}`), "send_mail", {}, undefined, 5_000);
    expect(out.result.isError).toBe(true);
    expect(String(out.result.content)).toContain("outcome unknown");
    expect(received).toBe(1);
  });

  test("a refused connection is retried until the server is back", async () => {
    // A port nothing listens on yet.
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const call = callServerMcp(spec(`http://127.0.0.1:${port}`), "tool", {}, undefined, 20_000);
    setTimeout(() => {
      servers.push(Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ result: { content: "ok" } }) }));
    }, 400);
    const out = await call;
    expect(out.result).toEqual({ content: "ok" });
  }, 30_000);

  test("the turn's Stop ends the wait for a server that is down", async () => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort("user"), 300);
    const out = await callServerMcp(spec(`http://127.0.0.1:${port}`), "tool", {}, stop.signal, 60_000);
    expect(out.result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  test("the turn's Stop ends a call the server is still running", async () => {
    // Accepts the request and never answers, like a long tool.
    servers.push(Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } }));
    const port = (servers.at(-1) as unknown as { port: number }).port;
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort("user"), 300);
    const out = await callServerMcp(spec(`http://127.0.0.1:${port}`), "tool", {}, stop.signal, 60_000);
    expect(out.result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);
});
