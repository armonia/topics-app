/**
 * Il contratto su cui `board_comment` (gateway topics-board) fa affidamento:
 * un commento di board con due allegati li salva entrambi e il filo li
 * riporta. Il 400 per i path fuori allowlist lo dà il gateway PRIMA di
 * scrivere; questa rotta continua a scartarli in silenzio (fissato dal test
 * "DROPPED at write time" in tasks.test.ts), quindi qui non si testa nessun
 * 400.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("board comments with media (board_comment contract)", () => {
  let db: Database; let broadcasts: any[];
  beforeEach(() => { db = freshDb(); broadcasts = []; });

  test("two PNGs land on the comment and stay visible in the thread", async () => {
    const ctx = makeCtx(db, broadcasts) as any;
    ctx.isPathAllowed = (p: string) => p.startsWith("/media/");
    const router = createTasksRouter(ctx);
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const shots = ["/media/proposta-a.png", "/media/proposta-b.png"];
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${t.id}/comments`, {
      content: "due proposte a confronto", media: shots, quiet: true,
    }))!;
    expect(resp.status).toBe(201);
    expect(await resp.json()).toMatchObject({ media: shots });
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    const last = got.comments.at(-1);
    expect(last.content).toBe("due proposte a confronto");
    expect(last.media).toEqual(shots);
  });
});
