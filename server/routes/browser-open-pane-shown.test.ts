/**
 * What `open_browser_pane` leaves in the message, and what it tells the agent
 * about the road that works (SHOWN-01, SHOWN-02, SHOWN-03).
 *
 * @covers SHOWN-01
 * @covers SHOWN-02
 * @covers SHOWN-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeOpenPaneFlow, SURFACE_NOTES } from "./browser-open-pane-flow";
import type { BrowserService } from "../browser-service";
import type { OpenPaneFlowOptions } from "./browser-open-pane-flow";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const service = {} as BrowserService;

let home: string;
let savedHome: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "shown-"));
  savedHome = process.env.TOPICS_HOME;
  process.env.TOPICS_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

/** A flow whose pane answers `reached` to the navigation and counts its screenshots. */
function flow(reached: (asked: string) => string, shots: { n: number }, shotFile?: string) {
  const announced: string[] = [];
  const open = makeOpenPaneFlow({
    json,
    broadcastToAll: () => {},
    waitForAttachedPane: async () => true,
    paneWaitMs: 10,
    portOwnershipWarning: async () => undefined,
    dispatch: (async (tool: string, args: { url?: string }) => {
      if (tool === "browser_screenshot") {
        shots.n++;
        return shotFile ? { path: shotFile } : { error: "no pane" };
      }
      return { url: reached(String(args.url)), title: "T" };
    }) as never,
  });
  const run = async (opts: Partial<OpenPaneFlowOptions> & { url: string }) => {
    const res = await open({
      contextId: "ctx", projectPath: null, service,
      announce: (u) => announced.push(u),
      ...opts,
    });
    return (await res.json()) as Record<string, unknown>;
  };
  return { run, announced };
}

describe("SHOWN-01 what the opening leaves", () => {
  test("a served file is shown as itself and costs no photo", async () => {
    const shots = { n: 0 };
    const path = "/m/a b.png";
    const { run } = flow((u) => u, shots);
    const out = await run({ url: `/api/media?path=${encodeURIComponent(path)}` });
    expect(out.media).toBe(path);
    expect(shots.n).toBe(0);
  });

  test("a web page leaves ONE photo, kept in a folder that is not pruned", async () => {
    const shots = { n: 0 };
    const shot = join(home, "shot.jpg");
    writeFileSync(shot, "jpg");
    const { run } = flow((u) => u, shots, shot);
    const out = await run({ url: "https://example.com/" });
    expect(shots.n).toBe(1);
    const kept = String(out.media);
    expect(kept.startsWith(join(home, "media", "browser", "opened"))).toBe(true);
    expect(existsSync(kept)).toBe(true);
  });

  test("a page that did not load has no photo and says so", async () => {
    const shots = { n: 0 };
    const { run } = flow(() => "about:blank", shots);
    const res = await makeOpenPaneFlow({
      json, broadcastToAll: () => {}, waitForAttachedPane: async () => true, paneWaitMs: 10,
      portOwnershipWarning: async () => undefined,
      dispatch: (async () => ({ url: "about:blank", title: "" })) as never,
    })({ contextId: "ctx", url: "https://nope.invalid/", projectPath: null, service, announce: () => {}, navigationFatal: false });
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.media).toBeUndefined();
    expect(String(out.warning)).toContain("never loaded");
    expect(shots.n).toBe(0);
    void run;
  });

  test("a document that is not a file shown as itself gets a photo, not a broken link", async () => {
    const shots = { n: 0 };
    const { run } = flow((u) => u, shots);
    const out = await run({ url: "/api/media?path=%2Fm%2Fpage.html" });
    expect(out.media).toBeUndefined();
    expect(shots.n).toBe(1);
  });
});

describe("SHOWN-02 the page asked for is the page answered", () => {
  test("A then B on the same origin: the answer and the announcement say B", async () => {
    const shots = { n: 0 };
    const { run, announced } = flow((u) => u, shots);
    await run({ url: "http://127.0.0.1:5173/a" });
    const second = await run({ url: "http://127.0.0.1:5173/b" });
    expect(second.url).toBe("http://127.0.0.1:5173/b");
    expect(announced).toEqual(["http://127.0.0.1:5173/a", "http://127.0.0.1:5173/b"]);
  });

  test("a redirect keeps the URL that was reached", async () => {
    const { run, announced } = flow(() => "https://example.com/login", { n: 0 });
    const out = await run({ url: "https://example.com/private" });
    expect(out.url).toBe("https://example.com/login");
    expect(announced.at(-1)).toBe("https://example.com/login");
  });
});

describe("SHOWN-03 the road that works", () => {
  test.each(["agent", "card", "terminal"] as const)("%s names its road even when a pane is attached", async (surface) => {
    const { run } = flow((u) => u, { n: 0 });
    const out = await run({ url: "https://example.com/", surface });
    expect(out.visible).toBe(true);
    expect(out.note).toBe(SURFACE_NOTES[surface]);
  });

  test("a plain chat has no note", async () => {
    const { run } = flow((u) => u, { n: 0 });
    expect((await run({ url: "https://example.com/" })).note).toBeUndefined();
  });
});
