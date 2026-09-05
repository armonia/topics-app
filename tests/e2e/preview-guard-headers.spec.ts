/**
 * TWO DOORS, THE SAME BYTES, THE SAME GUARDS.
 *
 * `/api/media` and `/preview/` hand back the same project file on our own
 * origin, with the type deduced from the extension. `/api/media` set `nosniff` and
 * `Content-Security-Policy: sandbox`; `/preview/` set nothing, and it is the
 * one of the two that serves ANY file inside a project directory, which is
 * where the `.html` and `.svg` an agent writes end up. A `<script>` in there
 * ran on our origin with the session cookie: the only defence was the
 * sandboxed iframe on the client, walked around by pasting the URL into a
 * pane's address bar.
 *
 * Why a unit test on the header composer is not enough: that shows the
 * function is right, not that the route calls it. Here the question goes to
 * the SERVER, on the same file, through both doors.
 *
 * @covers MEDIA-01
 */
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixtures/test-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("the guards on a file served from the app's own origin", () => {
  test("the same project .html carries nosniff and sandbox from /preview/ as from /api/media", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "MEDIA-01" });
    // A real project directory, because that is what both routes ask for:
    // the boundary does not change here, the headers do.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "preview-guard-")));
    const file = join(dir, "page.html");
    writeFileSync(file, "<script>fetch('/api/topics')</script>");

    const created = await request.post(`${E2E_BASE}/api/topics`, {
      headers: { "Content-Type": "application/json" },
      data: { name: `preview-guard ${process.pid}`, projectPath: dir },
      failOnStatusCode: false,
    });
    expect(created.ok()).toBe(true);
    const topicId = (await created.json())?.id as string | undefined;

    try {
      const fromPreview = await request.get(`${E2E_BASE}/preview${file}`, { failOnStatusCode: false });
      const fromMedia = await request.get(
        `${E2E_BASE}/api/media?path=${encodeURIComponent(file)}`,
        { failOnStatusCode: false },
      );

      for (const [name, res] of [["preview", fromPreview], ["media", fromMedia]] as const) {
        expect(`${name}:${res.status()}`).toBe(`${name}:200`);
        const headers = res.headers();
        expect(`${name}:${headers["x-content-type-options"]}`).toBe(`${name}:nosniff`);
        const policy = headers["content-security-policy"] ?? "";
        expect(`${name}:${policy.startsWith("sandbox")}`).toBe(`${name}:true`);
        // The directive neither of them grants: with no origin, the script
        // inside the page sees neither the cookie nor the API.
        expect(`${name}:${policy.includes("allow-same-origin")}`).toBe(`${name}:false`);
      }
    } finally {
      if (topicId) {
        await request.delete(`${E2E_BASE}/api/topics/${topicId}`, { failOnStatusCode: false }).catch(() => {});
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
