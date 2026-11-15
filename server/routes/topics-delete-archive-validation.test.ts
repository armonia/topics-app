/**
 * @covers TOPIC-01
 *
 * DELETE /api/topics/:id — body validation for the archive/unarchive switch.
 *
 * Regression: `try { const body = await req.json(); if (typeof body.archived
 * === 'boolean') archive = body.archived; } catch {}` swallowed EVERY body
 * that was not `{ archived: <boolean> }` — including `{}`, `null`, `[]`,
 * `42`, `"x"`, and the `{"archive":false}` typo (archive vs archived) — and
 * fell through to the destructive default (`archive = true`), silently
 * archiving the topic with a 200 instead of refusing the request.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "./topics";
import type { AppContext } from "../types";

const ROOT = testTmpDir("topics-delete-archive-validation");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

async function makeTopic(ctx: AppContext, name: string): Promise<string> {
  const router = createTopicsRouter(ctx);
  const url = new URL("http://t.test/api/topics");
  const res = await router(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  }), url, url.pathname, "POST");
  const body = await res!.json();
  return body.id;
}

async function deleteWithRawBody(ctx: AppContext, topicId: string, rawBody: string | undefined) {
  const router = createTopicsRouter(ctx);
  const url = new URL(`http://t.test/api/topics/${topicId}`);
  const res = await router(new Request(url, {
    method: "DELETE",
    ...(rawBody !== undefined ? { body: rawBody, headers: { "Content-Type": "application/json" } } : {}),
  }), url, url.pathname, "DELETE");
  return { status: res!.status, body: await res!.json() };
}

describe("DELETE /api/topics/:id — malformed or ambiguous bodies are refused", () => {
  const BAD_BODIES: Array<[string, string]> = [
    ["{}", "{}"],
    ["null", "null"],
    ["[]", "[]"],
    ["42", "42"],
    ['"x"', '"x"'],
    ['{"archive":false} (typo: archive, not archived)', '{"archive":false}'],
  ];

  for (const [label, raw] of BAD_BODIES) {
    test(`body ${label} is refused with 400 and does not archive the topic`, async () => {
      const ctx = await createTestAppContext();
      const id = await makeTopic(ctx, `bad-body-${label}`);
      const { status, body } = await deleteWithRawBody(ctx, id, raw);
      expect(status).toBe(400);
      expect(body.error).toBe("archived must be boolean");
      expect(ctx.getTopicById(id)?.archived).toBeFalsy();
    });
  }

  test("no body at all still archives (unchanged DELETE-without-body default)", async () => {
    const ctx = await createTestAppContext();
    const id = await makeTopic(ctx, "no-body");
    const { status } = await deleteWithRawBody(ctx, id, undefined);
    expect(status).toBe(200);
    expect(ctx.getTopicById(id)?.archived).toBe(true);
  });

  test("{ archived: true } archives as before", async () => {
    const ctx = await createTestAppContext();
    const id = await makeTopic(ctx, "archived-true");
    const { status } = await deleteWithRawBody(ctx, id, JSON.stringify({ archived: true }));
    expect(status).toBe(200);
    expect(ctx.getTopicById(id)?.archived).toBe(true);
  });

  test("{ archived: false } unarchives (reopens) as before", async () => {
    const ctx = await createTestAppContext();
    const id = await makeTopic(ctx, "archived-false");
    await deleteWithRawBody(ctx, id, JSON.stringify({ archived: true }));
    expect(ctx.getTopicById(id)?.archived).toBe(true);
    const { status } = await deleteWithRawBody(ctx, id, JSON.stringify({ archived: false }));
    expect(status).toBe(200);
    expect(ctx.getTopicById(id)?.archived).toBeFalsy();
  });
});
