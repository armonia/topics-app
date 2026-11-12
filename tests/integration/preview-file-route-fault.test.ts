/**
 * `GET /preview/<path>` serves any file inside a known project or media root.
 * A fault while reading an EXISTING, allowed file (permission denied, I/O
 * error) used to be swallowed by a bare `catch {}` and answered as 404 Not
 * Found — a server fault looking exactly like "there is no such file".
 *
 * The happy path (an existing, readable file) is the regression guard: this
 * route must keep answering 200 for it. Forcing the exact fs fault the catch
 * is meant to cover (EACCES/EIO on an already-`exists()`-confirmed file) is
 * not reliably reproducible in this sandbox (Bun's `file.exists()` swallows
 * most permission errors to `false` rather than throwing — probed by hand),
 * so the fault branch itself is covered by reading the fixed code
 * (`server.ts`, the `/preview/` handler: `catch (err) { ...; return new
 * Response("Internal Server Error", { status: 500 }); }`) rather than by a
 * forced-fault assertion here.
 *
 * @covers FILE-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnRealServer, testTmpDir, type RealServer } from "./helpers";

const ROOT = testTmpDir("preview-file-route-fault");
let server: RealServer;

beforeAll(async () => {
  server = await spawnRealServer(ROOT);
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("GET /preview/<path>", () => {
  test("an existing, allowed file is still served 200", async () => {
    const uploadsDir = join(ROOT, "data", "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const filePath = join(uploadsDir, "ok.txt");
    fs.writeFileSync(filePath, "hello preview");
    const res = await fetch(`${server.baseUrl}/preview${filePath}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello preview");
  });

  test("a missing file inside an allowed root still answers 404", async () => {
    const uploadsDir = join(ROOT, "data", "uploads");
    const res = await fetch(`${server.baseUrl}/preview${join(uploadsDir, "does-not-exist.txt")}`);
    expect(res.status).toBe(404);
  });
});
