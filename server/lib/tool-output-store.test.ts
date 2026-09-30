/**
 * Tool output stored out of the message row (server/lib/tool-output-store.ts).
 *
 * What has to hold, and each test would go red if it stopped holding:
 * - a split row read back whole is the row as it was, field for field;
 * - the history strip reports the same `detailBytes` from the mark as from
 *   the text, and never ships the mark;
 * - only what the history wire does not ship leaves the row;
 * - the output leaves the row only in the transaction that stores it, and a
 *   failure there leaves the row whole;
 * - the backfill resumes from its cursor, never splits twice, and a crash
 *   inside a row's transaction leaves that row whole.
 * @covers WIRE-09
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  backfillToolOutputsTick,
  blocksColumn,
  MIN_MOVED_CHARS,
  readToolOutputs,
  restoreBlocksJson,
  restoreFromStore,
  restoreToolOutputs,
  splitToolOutputs,
  writeSplitRow,
} from "./tool-output-store";
import { leanMessagesForHistory, leanMessagesForWire } from "../../shared/lean-tool-call";
import { decodeCol, encodeCol } from "../../shared/message-blob";

const MIGRATION = readdirSync(join(import.meta.dir, "..", "db", "migrations")).find((f) => f.endsWith("-message-tool-outputs.sql"))!;
const MIGRATION_SQL = readFileSync(join(import.meta.dir, "..", "db", "migrations", MIGRATION), "utf-8");

const big = (seed: string, n = 3000) => `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);

type Block = { kind: string; text?: string; toolCall?: Record<string, unknown> };

function shell(id: string, output: string, extra: Record<string, unknown> = {}): Block {
  return { kind: "tool", toolCall: { id, name: "Bash", status: "success", args: { command: "ls" }, detail: { type: "shell", command: "ls", output }, ...extra } };
}

function db(): Database {
  const d = new Database(":memory:");
  d.run("PRAGMA foreign_keys = ON");
  d.run("CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, partial INTEGER DEFAULT 0, blocks TEXT)");
  d.run(MIGRATION_SQL);
  return d;
}

/** A row written as before the split existed: whole, compressed when big. */
function insertWhole(d: Database, id: string, blocks: Block[], partial = 0): void {
  d.prepare("INSERT INTO messages (id, session_key, role, partial, blocks) VALUES (?, 's', 'assistant', ?, ?)")
    .run(id, partial, (encodeCol(JSON.stringify(blocks)) ?? null) as never);
}

const rawBlocks = (d: Database, id: string) => (d.query("SELECT blocks FROM messages WHERE id = ?").get(id) as { blocks: unknown }).blocks;
const parsedRow = (d: Database, id: string) => JSON.parse(decodeCol(rawBlocks(d, id))!) as Block[];
const fullRow = (d: Database, id: string) => {
  const b = parsedRow(d, id);
  restoreFromStore(d, id, b);
  return b;
};
const sideRows = (d: Database) => (d.query("SELECT COUNT(*) AS n FROM message_tool_outputs").get() as { n: number }).n;

describe("splitToolOutputs", () => {
  test("moves the three stripped detail fields and a result that repeats one of them, and nothing else", () => {
    const out = big("line of output");
    const blocks: Block[] = [
      { kind: "text", text: "hello" },
      shell("t1", out, { result: out, args: { command: big("a long command", 2000) } }),
    ];
    const split = splitToolOutputs(blocks)!;
    expect(split).not.toBeNull();
    const tc = split.blocks[1]!.toolCall!;
    expect((tc.detail as { output: string }).output).toBe("");
    expect((tc.detail as { command: string }).command).toBe("ls");
    expect(tc.result).toBeUndefined();
    expect(tc.args).toEqual(blocks[1]!.toolCall!.args);
    expect(tc.movedOutput).toEqual({ detail: { output: out.length }, result: out.length });
    expect(split.moved.get("t1")).toEqual({ detail: { output: out }, result: out });
    // The input is untouched: a caller may still hold it (the live timeline).
    expect((blocks[1]!.toolCall!.detail as { output: string }).output).toBe(out);
    expect(split.blocks[0]).toBe(blocks[0]);
  });

  test("a result of its own stays: the history wire ships it", () => {
    const blocks = [shell("t1", big("out"), { result: "exit 0" })];
    const tc = splitToolOutputs(blocks)!.blocks[0]!.toolCall!;
    expect(tc.result).toBe("exit 0");
    expect(tc.movedOutput).toEqual({ detail: { output: 3000 } });
  });

  test("small outputs, open calls, duplicate ids and details the schema rejects stay in the row", () => {
    expect(splitToolOutputs([shell("t", "x".repeat(MIN_MOVED_CHARS - 1))])).toBeNull();
    expect(splitToolOutputs([shell("t", big("o"), { status: "running" })])).toBeNull();
    expect(splitToolOutputs([shell("t", big("o"), { status: "waiting_for_input" })])).toBeNull();
    expect(splitToolOutputs([shell("t", big("o")), shell("t", big("p"))])).toBeNull();
    // An unknown type is shipped raw with its strings previewed, not blanked.
    const unknown: Block = { kind: "tool", toolCall: { id: "u", status: "success", detail: { type: "made-up", output: big("o") } } };
    expect(splitToolOutputs([unknown])).toBeNull();
    // A key the schema does not know never reaches the history strip.
    const extra: Block = { kind: "tool", toolCall: { id: "e", status: "success", detail: { type: "shell", command: "ls", stray: big("o") } } };
    expect(splitToolOutputs([extra])).toBeNull();
  });

  test("a call split once is not split again", () => {
    const first = splitToolOutputs([shell("t1", big("o"))])!;
    expect(splitToolOutputs(first.blocks)).toBeNull();
  });
});

describe("restoreToolOutputs", () => {
  test("rebuilds the row field for field and drops the mark", () => {
    const out = big("line");
    const original = [shell("t1", out, { result: out }), shell("t2", big("two")), { kind: "text", text: "end" }];
    const split = splitToolOutputs(original)!;
    const rebuilt = structuredClone(split.blocks);
    expect(restoreToolOutputs(rebuilt, split.moved)).toEqual([]);
    expect(rebuilt).toEqual(original);
    expect(JSON.stringify(rebuilt)).not.toContain("movedOutput");
  });

  test("text the row got back after the move wins over the stored copy", () => {
    const split = splitToolOutputs([shell("t1", big("old"))])!;
    const rebuilt = structuredClone(split.blocks);
    (rebuilt[0]!.toolCall!.detail as { output: string }).output = "rewritten";
    restoreToolOutputs(rebuilt, split.moved);
    expect((rebuilt[0]!.toolCall!.detail as { output: string }).output).toBe("rewritten");
  });

  test("a missing stored copy is reported, not invented", () => {
    const split = splitToolOutputs([shell("t1", big("o"))])!;
    expect(restoreToolOutputs(structuredClone(split.blocks), new Map())).toEqual(["t1"]);
  });
});

describe("the history strip on a split row", () => {
  test("ships the same message as the whole row, mark included in detailBytes and never on the wire", () => {
    const out = big("line of output");
    const whole = [{ kind: "text", text: "hi" }, shell("t1", out, { result: out }), shell("t2", "short")];
    const split = splitToolOutputs(whole)!;
    const wire = (blocks: Block[]) => leanMessagesForHistory(leanMessagesForWire([{ role: "assistant", blocks } as never]))[0];
    expect(wire(split.blocks as Block[])).toEqual(wire(whole));
    expect(JSON.stringify(wire(split.blocks as Block[]))).not.toContain("movedOutput");
    expect((wire(whole) as { blocks: Block[] }).blocks[1]!.toolCall!.detailBytes).toBe(out.length);
  });
});

describe("blocksColumn", () => {
  test("an open row, a small row and a machine-marked row are written exactly as before", () => {
    const blocks = [shell("t1", big("o"))];
    expect(blocksColumn(blocks, false).moved).toBeNull();
    expect(blocksColumn(blocks, false).value).toEqual(encodeCol(JSON.stringify(blocks))!);
    const marked = [...blocks, { kind: "dispatched-envelope", commentIds: ["c1"] }];
    const col = blocksColumn(marked, true);
    expect(col.moved).toBeNull();
    expect(typeof col.value).toBe("string");
  });

  test("a closed row sheds its output and stays a blob, even when what is left is small", () => {
    const col = blocksColumn([shell("t1", big("o"))], true);
    expect(col.moved?.size).toBe(1);
    expect(col.value).toBeInstanceOf(Uint8Array);
    expect(decodeCol(col.value)!.length).toBeLessThan(512);
  });
});

describe("writeSplitRow", () => {
  test("the row and its output are written together and read back whole", () => {
    const d = db();
    const blocks = [shell("t1", big("o")), { kind: "text", text: "done" }];
    const col = blocksColumn(blocks, true);
    writeSplitRow(d, "m1", col, (v) => d.prepare("INSERT INTO messages (id, blocks) VALUES ('m1', ?)").run(v as never));
    expect(sideRows(d)).toBe(1);
    expect(parsedRow(d, "m1")[0]!.toolCall!.movedOutput).toBeDefined();
    expect(fullRow(d, "m1")).toEqual(blocks);
  });

  test("when the output cannot be stored the row is written whole, and nothing is left behind", () => {
    const d = db();
    const blocks = [shell("t1", big("o"))];
    const col = blocksColumn(blocks, true);
    // The row goes under another id, so the output's foreign key fails.
    writeSplitRow(d, "m-missing", col, (v) => d.prepare("INSERT OR REPLACE INTO messages (id, blocks) VALUES ('other', ?)").run(v as never));
    expect(sideRows(d)).toBe(0);
    expect(parsedRow(d, "other")).toEqual(blocks);
  });

  test("a stored body that does not rebuild the row rolls the split back", () => {
    const d = db();
    const blocks = [shell("t1", big("o"))];
    // What the table hands back is not what was written: the read-back check
    // must refuse it, and the row must go down whole.
    const wrong = Buffer.from(Bun.zstdCompressSync(Buffer.from(JSON.stringify({ t1: { detail: { output: "WRONG" } } })))).toString("hex");
    d.run(`CREATE TRIGGER corrupt AFTER INSERT ON message_tool_outputs BEGIN UPDATE message_tool_outputs SET body = X'${wrong}' WHERE message_id = NEW.message_id; END`);
    writeSplitRow(d, "m1", blocksColumn(blocks, true), (v) => d.prepare("INSERT OR REPLACE INTO messages (id, blocks) VALUES ('m1', ?)").run(v as never));
    expect(sideRows(d)).toBe(0);
    expect(parsedRow(d, "m1")).toEqual(blocks);
  });

  test("deleting the message deletes its output", () => {
    const d = db();
    const col = blocksColumn([shell("t1", big("o"))], true);
    writeSplitRow(d, "m1", col, (v) => d.prepare("INSERT INTO messages (id, blocks) VALUES ('m1', ?)").run(v as never));
    d.run("DELETE FROM messages WHERE id = 'm1'");
    expect(sideRows(d)).toBe(0);
  });
});

describe("restoreBlocksJson", () => {
  test("the raw column of a split row comes back whole; any other text comes back untouched", () => {
    const d = db();
    const blocks = [shell("t1", big("o"))];
    writeSplitRow(d, "m1", blocksColumn(blocks, true), (v) => d.prepare("INSERT INTO messages (id, blocks) VALUES ('m1', ?)").run(v as never));
    expect(JSON.parse(restoreBlocksJson(d, "m1", decodeCol(rawBlocks(d, "m1")))!)).toEqual(blocks);
    const plain = JSON.stringify([{ kind: "text", text: "x" }]);
    expect(restoreBlocksJson(d, "m1", plain)).toBe(plain);
    expect(restoreBlocksJson(d, "m1", null)).toBeNull();
  });
});

describe("backfillToolOutputsTick", () => {
  function seeded(): { d: Database; rows: Record<string, Block[]> } {
    const d = db();
    const rows: Record<string, Block[]> = {
      a1: [shell("a", big("alpha"), { result: big("alpha") })],
      a2: [shell("b", "small"), { kind: "text", text: big("prose", 2000) }],
      a3: [shell("c", big("gamma")), shell("d", big("delta"))],
      a4: [shell("e", big("open"))],
      a5: [{ kind: "text", text: "tiny" }],
    };
    for (const [id, b] of Object.entries(rows)) insertWhole(d, id, b, id === "a4" ? 1 : 0);
    return { d, rows };
  }

  test("splits the closed blob rows, resumes from its cursor, and ends", () => {
    const { d, rows } = seeded();
    const first = backfillToolOutputsTick(d, { maxRows: 2, maxMs: 1000 });
    expect(first).toMatchObject({ scanned: 2, split: 1, done: false });
    const second = backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 });
    expect(second).toMatchObject({ scanned: 1, split: 1, done: false });
    expect(backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 }).done).toBe(true);
    // a1 and a3 split; a2 (nothing big enough), a4 (open), a5 (plain text) not.
    expect([...readToolOutputs(d, "a1").keys()]).toEqual(["a"]);
    expect([...readToolOutputs(d, "a3").keys()].sort()).toEqual(["c", "d"]);
    // One stored body per split message.
    expect(sideRows(d)).toBe(2);
    for (const [id, b] of Object.entries(rows)) expect(fullRow(d, id)).toEqual(b);
    expect(rawBlocks(d, "a1")).toBeInstanceOf(Uint8Array);
    // A finished backfill stays finished.
    expect(backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 })).toMatchObject({ scanned: 0, done: true });
  });

  test("a crash inside a row's transaction leaves that row whole and the cursor on it", () => {
    const { d, rows } = seeded();
    // The row write succeeds, then the store fails: the transaction must take
    // the row write back with it.
    d.run(`CREATE TRIGGER boom BEFORE INSERT ON message_tool_outputs WHEN NEW.message_id = 'a3' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 });
    expect(parsedRow(d, "a3")).toEqual(rows.a3!);
    expect(readToolOutputs(d, "a3").size).toBe(0);
    // Stepped past on its own, so one bad row does not stall the rest.
    expect((d.query("SELECT after_id FROM message_tool_outputs_backfill").get() as { after_id: string }).after_id).toBe("a3");
    expect(fullRow(d, "a1")).toEqual(rows.a1!);
  });

  test("a busy database is retried from the same row, not skipped", () => {
    const { d, rows } = seeded();
    d.run(`CREATE TRIGGER busy BEFORE INSERT ON message_tool_outputs WHEN NEW.message_id = 'a1' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
    const tick = backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 });
    expect(tick.split).toBe(0);
    expect((d.query("SELECT after_id FROM message_tool_outputs_backfill").get() as { after_id: string }).after_id).toBe("");
    d.run("DROP TRIGGER busy");
    backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 });
    expect(readToolOutputs(d, "a1").size).toBe(1);
    expect(fullRow(d, "a1")).toEqual(rows.a1!);
  });

  test("running it again over split rows changes nothing", () => {
    const { d } = seeded();
    while (!backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 }).done) { /* drain */ }
    const before = JSON.stringify(d.query("SELECT id, hex(blocks) h FROM messages ORDER BY id").all());
    d.run("UPDATE message_tool_outputs_backfill SET after_id = '', finished_at = NULL");
    while (!backfillToolOutputsTick(d, { maxRows: 10, maxMs: 1000 }).done) { /* drain */ }
    expect(JSON.stringify(d.query("SELECT id, hex(blocks) h FROM messages ORDER BY id").all())).toBe(before);
    expect(sideRows(d)).toBe(2);
  });
});
