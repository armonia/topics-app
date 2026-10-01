/**
 * `GET /api/files/search` spawns `grep -r` on the root it is given: it must not
 * read other apps' data on the way (`lib/protected-app-data.ts`), or macOS asks
 * "Topics Host would like to access data from other apps".
 *
 * The root is a temporary tree laid out like a home, never the real one. Every
 * protected file holds `needle`, so a search that enters one returns it.
 *
 * @covers FILE-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createFilesRouter } from "./files";
import { makeFakeHome, type FakeHome } from "../lib/protected-app-data.fixture";

let fake: FakeHome;
beforeAll(() => { fake = makeFakeHome(); });
afterAll(() => fake.dispose());

async function search(root: string): Promise<string[]> {
  const router = createFilesRouter({
    readJSON: (req: Request) => req.json(),
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
    // The real boundary refuses HOME; this test is about what grep reads once a
    // root got through, so every path inside the fake home is accepted here.
    resolveProjectPath: (p: string) => p,
  } as never);
  const url = new URL(`http://x/api/files/search?q=needle&path=${encodeURIComponent(root)}`);
  const res = await router(new Request(url), url, "/api/files/search", "GET");
  const body = (await res!.json()) as { results: Array<{ file: string }> };
  return body.results.map((r) => r.file).sort();
}

describe("file search and other apps' data", () => {
  test("from HOME nothing under Library or in a photo library comes back", async () => {
    expect(await search(fake.home)).toEqual(["Projects/app/src/a.ts", "notes.txt"]);
  });

  test("from ~/Library the per-app folders are skipped, Logs is searched", async () => {
    expect(await search(join(fake.home, "Library"))).toEqual(["Logs/app.log"]);
  });

  test("from a project a nested photo library is skipped", async () => {
    expect(await search(join(fake.home, "Projects", "app"))).toEqual(["src/a.ts"]);
  });
});
