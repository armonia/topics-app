/**
 * GET /api/files/flat (`walkFlat` in server/routes/files.ts) — unreadable
 * directories, root vs nested.
 *
 * Regression: `walkFlat`'s `try { readdir(...) } catch {}` swallowed a read
 * failure on the ROOT directory exactly like a nested one, so an unreadable
 * project root answered 200 `{files: []}` — indistinguishable from "this
 * project genuinely has no files". A NESTED directory this process cannot
 * read (permissions, a vanished symlink target) must still be skipped
 * silently: that one is deliberate, not a bug.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesRouter } from "./files";

let dirs: string[] = [];
let lockedDirs: string[] = [];
afterEach(() => {
  for (const d of lockedDirs) { try { chmodSync(d, 0o755); } catch { /* best-effort cleanup */ } }
  lockedDirs = [];
  for (const d of dirs) { try { chmodSync(d, 0o755); } catch { /* best-effort cleanup */ } rmSync(d, { recursive: true, force: true }); }
  dirs = [];
});

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => p,
} as never);

async function flat(path: string): Promise<{ status: number; body: { files?: string[]; error?: string } }> {
  const url = new URL(`http://x/api/files/flat?path=${encodeURIComponent(path)}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  return { status: res!.status, body: await res!.json() };
}

describe("walkFlat: root vs nested read failures", () => {
  test("an unreadable ROOT directory is a real error, not 200 with an empty list", async () => {
    const root = mkdtempSync(join(tmpdir(), "walkflat-root-"));
    dirs.push(root);
    writeFileSync(join(root, "would-be-seen.txt"), "x");
    chmodSync(root, 0o000);
    lockedDirs.push(root);
    const { status, body } = await flat(root);
    expect(status).toBe(500);
    expect(body.files).toBeUndefined();
  });

  test("an unreadable NESTED directory is skipped, and a readable sibling still shows up", async () => {
    const root = mkdtempSync(join(tmpdir(), "walkflat-nested-"));
    dirs.push(root);
    const readableDir = join(root, "readable");
    const blockedDir = join(root, "blocked");
    mkdirSync(readableDir);
    mkdirSync(blockedDir);
    writeFileSync(join(readableDir, "seen.txt"), "x");
    writeFileSync(join(blockedDir, "unseen.txt"), "x");
    chmodSync(blockedDir, 0o000);
    lockedDirs.push(blockedDir);

    const { status, body } = await flat(root);
    expect(status).toBe(200);
    expect(body.files).toContain(join("readable", "seen.txt"));
    expect(body.files).not.toContain(join("blocked", "unseen.txt"));
  });
});
