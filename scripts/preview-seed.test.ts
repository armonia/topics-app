/**
 * The page to photograph is announced as soon as there is one.
 *
 * The failure these tests hold shut: on 27/11 three cards stayed without a
 * preview because the seed announced its page only after the example messages,
 * and `POST /api/topics/:id/system-message` can answer 400 or 404 (measured).
 * The announcement was lost, the manager photographed the bare `/`, and the
 * empty-shell gate retired the shot.
 *
 * @covers KANBAN-126
 */
import { describe, expect, it } from "bun:test";
import { seedPreviewData } from "./preview-seed";

function io(fail?: (method: string, path: string) => boolean) {
  const calls: string[] = [];
  const announced: string[] = [];
  return {
    calls,
    announced,
    deps: {
      api: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (fail?.(method, path)) throw new Error(`${method} ${path} answered 400`);
        if (method === "POST" && path === "/api/topics") return { topic: { id: "topic-1" } };
        return {};
      },
      // Recorded in the SAME list as the calls: what this holds shut is the
      // ORDER, so the announcement has to be comparable with the steps around it.
      announce: (deepLink: string) => { announced.push(deepLink); calls.push(`announce ${deepLink}`); },
      log: () => {},
    },
  };
}

describe("seedPreviewData", () => {
  it("announces the topic's page and only then fills it", async () => {
    const h = io();
    expect(await seedPreviewData(h.deps)).toBe("topic-1");
    expect(h.announced).toEqual(["/?topic=topic-1"]);
    // The announcement comes before the first example message, not after both.
    expect(h.calls).toEqual([
      "PUT /api/app-settings",
      "POST /api/topics",
      "announce /?topic=topic-1",
      "POST /api/topics/topic-1/system-message",
      "POST /api/topics/topic-1/system-message",
    ]);
  });

  it("still announces the page when every example message is refused", async () => {
    const h = io((method, path) => path.endsWith("/system-message"));
    expect(await seedPreviewData(h.deps)).toBe("topic-1");
    expect(h.announced).toEqual(["/?topic=topic-1"]);
  });

  it("announces nothing when the topic itself could not be created", async () => {
    const h = io((method, path) => method === "POST" && path === "/api/topics");
    await expect(seedPreviewData(h.deps)).rejects.toThrow();
    expect(h.announced).toEqual([]);
  });

  it("announces nothing when the answer carries no topic id", async () => {
    const calls: string[] = [];
    const announced: string[] = [];
    await expect(seedPreviewData({
      api: async (method, path) => { calls.push(`${method} ${path}`); return {}; },
      announce: (deepLink) => { announced.push(deepLink); },
      log: () => {},
    })).rejects.toThrow("topic id missing");
    expect(announced).toEqual([]);
  });
});
