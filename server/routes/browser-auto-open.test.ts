/**
 * The auto-open tries at most ONCE per contextId every 60 s: with no Topics
 * window connected every op would otherwise pay the pane wait plus a
 * navigation. After a failed attempt the ops in that window dispatch headless
 * directly; past the window it tries again. @covers BROWSER-CHAT-04
 */
import { describe, test, expect } from "bun:test";
import {
  maybeOpenPaneForPageOp,
  AUTO_OPEN_RETRY_MS,
  type AutoOpenPaneDeps,
  type AutoOpenPaneOp,
} from "./browser-auto-open";
import type { BrowserService } from "../browser-service";
import type { Topic } from "../types";

function topic(): Topic {
  return {
    id: "t1",
    projectPath: "/tmp",
    browserState: { url: "https://example.com/last", contextId: "t1", lastActiveAt: 1 },
  } as Topic;
}

function setup(clock: { at: number }) {
  const openings: string[] = [];
  const marked: string[] = [];
  const service = { getUrl: (_id: string) => null } as unknown as BrowserService;
  const deps: AutoOpenPaneDeps = {
    paneAttachedTo: () => false,
    openPaneFlow: async (opts) => {
      openings.push(opts.url);
      return new Response("{}");
    },
    markNavigated: (id) => { marked.push(id); },
    isTaskTopic: () => false,
    attempts: new Map(),
    now: () => clock.at,
  };
  const op: AutoOpenPaneOp = {
    toolName: "browser_screenshot",
    topic: topic(),
    contextId: "t1",
    hasOverride: false,
    service,
    announce: () => {},
  };
  return { deps, op, openings, marked };
}

describe("auto-open retry window", () => {
  test("two ops in the window → a single opening, both dispatch", async () => {
    const clock = { at: 1_000_000 };
    const { deps, op, openings } = setup(clock);
    await maybeOpenPaneForPageOp(deps, op);
    await maybeOpenPaneForPageOp(deps, op);
    expect(openings).toHaveLength(1);
  });

  test("past the window → it tries again", async () => {
    const clock = { at: 1_000_000 };
    const { deps, op, openings } = setup(clock);
    await maybeOpenPaneForPageOp(deps, op);
    clock.at += AUTO_OPEN_RETRY_MS + 1;
    await maybeOpenPaneForPageOp(deps, op);
    expect(openings).toHaveLength(2);
  });

  test("the window is per contextId: another context still opens", async () => {
    const clock = { at: 1_000_000 };
    const { deps, op, openings } = setup(clock);
    await maybeOpenPaneForPageOp(deps, op);
    await maybeOpenPaneForPageOp(deps, { ...op, contextId: "t2" });
    expect(openings).toHaveLength(2);
  });

  test("a throttled op marks nothing as navigated", async () => {
    const clock = { at: 1_000_000 };
    const { deps, op, marked } = setup(clock);
    await maybeOpenPaneForPageOp(deps, op);
    await maybeOpenPaneForPageOp(deps, op);
    expect(marked).toEqual(["t1"]);
  });
});
