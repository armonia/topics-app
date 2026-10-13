/**
 * One navigation per url, its outcome to every viewer, its state to a newcomer.
 *
 * @covers BROWSER-LOAD-01
 */
import { describe, expect, test } from "bun:test";
import { createNavFlight, type NavFlightMessage } from "./browser-nav-flight";

/** A page load the test settles by hand. */
function deferred<R>() {
  let resolve!: (r: R) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<R>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  let clock = 1_000;
  const heard: { ctx: string; msg: NavFlightMessage }[] = [];
  const flight = createNavFlight({ publish: (ctx, msg) => heard.push({ ctx, msg }), now: () => clock });
  return { flight, heard, advance: (ms: number) => { clock += ms; } };
}

describe("browser-nav-flight (BROWSER-LOAD-01)", () => {
  test("every viewer hears the load start and its failure, not only whoever asked", async () => {
    const { flight, heard } = setup();
    const load = deferred<{ error?: string }>();
    const run = flight.run("ctx", "http://127.0.0.1:4444/", () => load.promise);
    expect(heard.map((h) => h.msg.phase)).toEqual(["loading"]);
    load.resolve({ error: "goto: Timeout 30000ms exceeded." });
    await run;
    expect(heard[1]).toEqual({
      ctx: "ctx",
      msg: { type: "nav", phase: "error", url: "http://127.0.0.1:4444/", error: "goto: Timeout 30000ms exceeded." },
    });
  });

  test("a second request for the url being loaded joins it instead of starting over", async () => {
    const { flight } = setup();
    const load = deferred<{ error?: string }>();
    let loads = 0;
    const go = () => { loads++; return load.promise; };
    const first = flight.run("ctx", "http://a.test/", go);
    const second = flight.run("ctx", "http://a.test/", go);
    load.resolve({});
    expect(await second).toBe(await first);
    expect(loads).toBe(1);
  });

  test("a request for ANOTHER url is a new load, and the old one's outcome is not news", async () => {
    const { flight, heard } = setup();
    const old = deferred<{ error?: string }>();
    const fresh = deferred<{ error?: string }>();
    const oldRun = flight.run("ctx", "http://a.test/", () => old.promise);
    const freshRun = flight.run("ctx", "http://b.test/", () => fresh.promise);
    old.resolve({ error: "net::ERR_ABORTED" });
    await oldRun;
    expect(heard.filter((h) => h.msg.phase === "error")).toEqual([]);
    expect(flight.replay("ctx")).toMatchObject({ phase: "loading", url: "http://b.test/" });
    fresh.resolve({});
    await freshRun;
    expect(flight.replay("ctx")).toBeNull();
  });

  test("a socket opening in the middle is told how long the load has been going", () => {
    const { flight, advance } = setup();
    void flight.run("ctx", "http://a.test/", () => new Promise<{ error?: string }>(() => {}));
    advance(12_000);
    expect(flight.replay("ctx")).toEqual({ type: "nav", phase: "loading", url: "http://a.test/", elapsedMs: 12_000 });
    expect(flight.inFlight("ctx")).toBe(true);
  });

  test("after a failure a newcomer is told the failure, until a page loads by any route", async () => {
    const { flight } = setup();
    await flight.run("ctx", "http://a.test/", async () => ({ error: "net::ERR_NAME_NOT_RESOLVED" }));
    expect(flight.replay("ctx")).toEqual({ type: "nav", phase: "error", url: "http://a.test/", error: "net::ERR_NAME_NOT_RESOLVED" });
    flight.noteLoaded("ctx");
    expect(flight.replay("ctx")).toBeNull();
  });

  test("a launch that throws is a failure too, and the caller still gets the throw", async () => {
    const { flight, heard } = setup();
    const run = flight.run("ctx", "http://a.test/", async () => { throw new Error("Browser failed to start\nstack"); });
    await expect(run).rejects.toThrow("Browser failed to start");
    expect(heard.at(-1)?.msg).toEqual({ type: "nav", phase: "error", url: "http://a.test/", error: "Browser failed to start" });
    expect(flight.inFlight("ctx")).toBe(false);
  });

  test("a forgotten context has nothing to replay", () => {
    const { flight } = setup();
    void flight.run("ctx", "http://a.test/", () => new Promise<{ error?: string }>(() => {}));
    flight.forget("ctx");
    expect(flight.replay("ctx")).toBeNull();
    expect(flight.inFlight("ctx")).toBe(false);
  });
});
