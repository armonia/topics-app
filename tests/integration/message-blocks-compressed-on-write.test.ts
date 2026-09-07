/**
 * The `blocks` column reaches the disk COMPRESSED, from the writer.
 *
 * `shared/message-blob.ts` has always been symmetric on paper: `encodeCol` on
 * the way in, `decodeCol` on the way out. In practice only the second half was
 * wired. Every reader went through `decodeCol`, the one-off backfill script
 * compressed the rows that already existed, and the writer kept putting plain
 * JSON in the column, so the table started growing in plaintext again the day
 * after the backfill: measured on 2026-09-07, 976 rows above the 512 byte
 * threshold written in the clear since 2026-08-20.
 *
 * This is the gate on the writer, and it has two halves, because half a fix is
 * worse than none here:
 *
 *   1. what SQLite holds is a `blob`, not `text` — the byte saving is real;
 *   2. `rowToMessage` reads back exactly what went in — no message is lost to
 *      the saving.
 *
 * Both `insertMessage` (through `metaParams`) and every `updateMessage` are
 * covered, because a streaming turn writes the row through the second one
 * dozens of times: a writer that compressed only on insert would put the
 * timeline back in plaintext on the first `persistBlocks`.
 *
 * @covers COMPRESS-01
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";
import type { ContentBlock } from "../../shared/types";
import { decodeCol } from "../../shared/message-blob";

const TEST_DATA = testTmpDir("message-blocks-compressed-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

/**
 * Well above the 512 byte threshold and compressible, which is what a real
 * timeline looks like: JSON keys and tool output repeat themselves.
 */
function fatBlocks(marker: string): ContentBlock[] {
  return [
    { kind: "text", text: `${marker} ${"la risposta lunga di un turno agentico. ".repeat(60)}` },
  ] as ContentBlock[];
}

/** How SQLite itself classifies the stored value, and how many bytes it holds. */
function blocksOnDisk(ctx: AppContext, id: string): { type: string; bytes: number; raw: unknown } {
  const row = ctx.db.prepare(
    "SELECT typeof(blocks) AS t, LENGTH(blocks) AS n, blocks FROM messages WHERE id = ?",
  ).get(id) as { t: string; n: number; blocks: unknown };
  return { type: row.t, bytes: row.n, raw: row.blocks };
}

describe("i blocchi scritti finiscono sul disco compressi, e si rileggono identici", () => {
  test("insertMessage scrive un blob zstd, e rowToMessage lo rilegge identico", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:blocks-compressed-insert";
    const blocks = fatBlocks("insert");
    const written = ctx.appendLocalMessage(sk, "user", "prompt", undefined, blocks);

    const disk = blocksOnDisk(ctx, written.id);
    expect(disk.type).toBe("blob");
    // The saving is the point of the change, not a side effect: the JSON of
    // this timeline is worth several KB and zstd level 3 folds it well past 2x.
    expect(disk.bytes).toBeLessThan(JSON.stringify(blocks).length / 2);
    // Nothing is lost to the saving: the column decodes back to the same JSON.
    expect(decodeCol(disk.raw)).toBe(JSON.stringify(blocks));
    expect(ctx.getMessageById(written.id)?.blocks).toEqual(blocks);
  });

  test("updateLastMessage riscrive la riga e la lascia compressa", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:blocks-compressed-update";
    ctx.appendLocalMessage(sk, "user", "prompt");
    const placeholder = ctx.createPartialMessage(sk, "assistant");

    // The path a streaming turn takes: `persistBlocks` goes through
    // `lib/turn-body-persist.ts`, which calls exactly this mutator.
    const blocks = fatBlocks("update");
    ctx.updateLastMessage(sk, { content: "ecco", blocks, partial: undefined, streamedAt: undefined });

    const disk = blocksOnDisk(ctx, placeholder.id);
    expect(disk.type).toBe("blob");
    expect(decodeCol(disk.raw)).toBe(JSON.stringify(blocks));
    expect(ctx.getMessageById(placeholder.id)?.blocks).toEqual(blocks);
  });

  test("sotto la soglia la colonna resta testo: il codec non aggiunge overhead al piccolo", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:blocks-compressed-short";
    const blocks = [{ kind: "text", text: "ok" }] as ContentBlock[];
    const written = ctx.appendLocalMessage(sk, "user", "corto", undefined, blocks);

    const disk = blocksOnDisk(ctx, written.id);
    expect(disk.type).toBe("text");
    expect(ctx.getMessageById(written.id)?.blocks).toEqual(blocks);
  });
});
