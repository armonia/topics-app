/**
 * `GET /api/files/flat` walks the tree with one recursive `walkFlat`, and its
 * try/catch used to cover a failure to read the ROOT directory the same way
 * as a nested one: silently, answering 200 with `files: []` as if the project
 * were simply empty.
 *
 * @covers FILE-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesRouter } from "./files";

let root = "";
let unreadableRoot = "";

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => p,
} as never);

async function flatRoute(dir: string) {
  const url = new URL(`http://x/api/files/flat?path=${encodeURIComponent(dir)}`);
  const res = (await router(new Request(url), url, url.pathname, "GET"))!;
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "files-flat-root-"));
  unreadableRoot = join(root, "locked");
  mkdirSync(unreadableRoot);
  writeFileSync(join(unreadableRoot, "f.txt"), "x");
  chmodSync(unreadableRoot, 0o000);
});
afterAll(() => {
  chmodSync(unreadableRoot, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/files/flat", () => {
  test("a normal project still lists its files", async () => {
    const dir = join(root, "ok");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), "a");
    const r = await flatRoute(dir);
    expect(r.status).toBe(200);
    expect((r.body as { files: string[] }).files).toEqual(["a.txt"]);
  });

  test("an unreadable project root answers an error, never 200 with an empty list", async () => {
    // Skipped when the sandbox ignores chmod (e.g. running as root).
    const probe = Bun.spawnSync(["test", "-r", unreadableRoot]);
    if (probe.exitCode !== 1) return;
    const r = await flatRoute(unreadableRoot);
    expect(r.status).not.toBe(200);
    expect(r.body).toHaveProperty("error");
  });
});
