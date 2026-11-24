// @covers SYSTEM-PAGE-01
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMemoryStoresRouter } from "./memory-stores";

let root = "";
const savedHome = process.env.TOPICS_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-stores-turn-"));
  process.env.TOPICS_HOME = join(root, "topics");
  const engine = join(root, "engine");
  mkdirSync(engine, { recursive: true });
  for (const id of ["alpha", "beta", "gamma", "delta"]) {
    const dir = join(root, `ws-${id}`, "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), `- [${id}-index](card.md)\n`);
    writeFileSync(join(dir, "card.md"), "---\nname: card\n---\nbody\n");
    mkdirSync(join(root, `ws-${id}`), { recursive: true });
  }
  writeFileSync(
    join(engine, "engine.json"),
    JSON.stringify({
      agents: {
        alpha: {
          workspace: join(root, "ws-alpha"),
          memory: [
            { storeId: "agent:beta", scope: "shared" },
            { storeId: "agent:gamma", scope: "readonly" },
          ],
        },
        beta: { workspace: join(root, "ws-beta") },
        gamma: { workspace: join(root, "ws-gamma") },
        delta: { workspace: join(root, "ws-delta") },
      },
    }),
  );
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

async function turn(agent: string): Promise<{ store: string; path: string; content: string }[]> {
  const ctx = { json: (data: unknown) => data } as never;
  const router = createMemoryStoresRouter(ctx, { engineHome: () => join(root, "engine"), expand: (p) => p });
  const url = new URL(`http://x/api/memory-stores/turn?agent=${agent}`);
  return (await router(new Request(url) as never, url, url.pathname, "GET")) as never;
}

describe("GET /api/memory-stores/turn", () => {
  test("an agent gets its own and shared indexes, never another agent's or a readonly one", async () => {
    const got = await turn("alpha");
    expect(got.map((b) => b.store).sort()).toEqual(["agent:alpha", "agent:beta"]);
    expect(got.find((b) => b.store === "agent:beta")!.content).toContain("beta-index");
  });

  test("an agent with no grants gets only its own", async () => {
    expect((await turn("delta")).map((b) => b.store)).toEqual(["agent:delta"]);
  });
});
