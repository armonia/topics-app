/**
 * @covers USAGE-29
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppContext } from "../types";
import { createUsageRouter } from "./usage";

const ID = "aaaa1111-2222";
const savedBin = process.env.TOPICS_CLAUDE_BIN;
afterEach(() => { if (savedBin === undefined) delete process.env.TOPICS_CLAUDE_BIN; else process.env.TOPICS_CLAUDE_BIN = savedBin; });

function fixture(ageMs: number) {
  const root = mkdtempSync(join(tmpdir(), "top-send-"));
  mkdirSync(join(root, "proj"));
  const file = join(root, "proj", `${ID}.jsonl`);
  const at = new Date(Date.now() - ageMs);
  const line = { type: "assistant", timestamp: at.toISOString(), cwd: root, message: { model: "claude-sonnet-4", usage: { output_tokens: 100 } } };
  writeFileSync(file, JSON.stringify(line) + "\n");
  utimesSync(file, at, at);
  return root;
}

function router(role: "owner" | "guest", root: string) {
  const ctx = {
    db: {},
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    requestIdentity: () => ({ role, deviceId: "d1" }),
  } as unknown as AppContext;
  return createUsageRouter(ctx, { topSessionsRoot: root });
}

const call = (r: ReturnType<typeof router>, path: string, init?: RequestInit) =>
  r(new Request(`http://x${path}`, init), new URL(`http://x${path}`), path, init?.method ?? "GET");
const send = (r: ReturnType<typeof router>) =>
  call(r, "/api/usage/top-sessions/send", { method: "POST", body: JSON.stringify({ sessionId: ID, text: "hi" }) });

describe("POST /api/usage/top-sessions/send", () => {
  test("a guest gets 403, the owner gets 200 with a fake binary", async () => {
    process.env.TOPICS_CLAUDE_BIN = "true";
    const root = fixture(3_600_000);
    const guest = router("guest", root);
    expect((await send(guest))!.status).toBe(403);
    const owner = router("owner", root);
    await call(owner, "/api/usage/top-sessions");
    expect((await send(owner))!.status).toBe(200);
  });

  test("a session written to in the last minutes is refused with 409", async () => {
    process.env.TOPICS_CLAUDE_BIN = "true";
    const owner = router("owner", fixture(30_000));
    await call(owner, "/api/usage/top-sessions");
    const res = (await send(owner))!;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("open session");
  });
});
