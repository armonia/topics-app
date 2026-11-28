/**
 * The page to photograph is announced as soon as there is one.
 *
 * The failure these tests hold shut: on 27/11 three cards stayed without a
 * preview. The reproduced cause (card 79ab687d) was the old seed's
 * `POST /api/projects` with a fixed slug, hit a second time whenever a preview
 * run reused the previous run's `/tmp/topics-preview-<port>` data — see
 * `project-store.slug-conflict.test.ts` for the 409 reproduced directly, and
 * `still writes the deep link when the backing data is already seeded` below
 * for the regression gate. The seed no longer registers a project at all, so
 * it has nothing left to conflict on; announcing the page before the optional
 * example messages is kept as defense in depth, so a failure there (the
 * messages are best effort) can never cost the announcement either.
 *
 * @covers KANBAN-126
 */
import { describe, expect, it, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("still writes the deep link when the backing data is already seeded (DATA_DIR reused across preview runs)", async () => {
    // `POST /api/projects` with a fixed name/slug is what the OLD seed sent
    // before the topic: a second call with the same slug answers a 409
    // (reproduced in `project-store.slug-conflict.test.ts`). The current seed
    // sends no such call, so running it twice against the same fake backend
    // must announce a page both times; it goes red the day a step like that
    // one comes back.
    const seenProjectSlugs = new Set<string>();
    const announced: string[] = [];
    let topicN = 0;
    const deps = {
      api: async (method: string, path: string, body?: unknown) => {
        if (method === "POST" && path === "/api/projects") {
          const slug = (body as { slug?: string } | undefined)?.slug ?? "example-project";
          if (seenProjectSlugs.has(slug)) throw new Error("409 slug already in use: " + slug);
          seenProjectSlugs.add(slug);
        }
        if (method === "POST" && path === "/api/topics") return { topic: { id: `topic-${++topicN}` } };
        return {};
      },
      announce: (deepLink: string) => announced.push(deepLink),
      log: () => {},
    };
    await seedPreviewData(deps);
    await seedPreviewData(deps);
    expect(announced).toEqual(["/?topic=topic-1", "/?topic=topic-2"]);
  });

  test("the preview script seeds through seedPreviewData, with no project call left to conflict on a reused DATA_DIR", () => {
    const src = readFileSync(join(import.meta.dir, "preview-worktree.ts"), "utf8");
    expect(src).toContain("seedPreviewData(");
    expect(src).not.toMatch(/\/api\/projects/);
  });
});
