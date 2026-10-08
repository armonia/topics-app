/**
 * The board feed drops only fields that no client code reads
 * (`shared/board-feed.ts`), and `toFeedTask` drops nothing else.
 * @covers FEEDCOST-01
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FEED_OMITTED_TASK_FIELDS, toFeedTask } from "../../shared/board-feed";

const ROOT = join(import.meta.dir, "..", "..");
const CLIENT_SRC = join(ROOT, "client", "src");
/** Where `BoardTask` is declared: a property declaration there is not a read. */
const TYPE_FILE = join(CLIENT_SRC, "lib", "board.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // The landing demo writes fake rows, it does not read the feed.
      if (entry.name !== "demo" && entry.name !== "__tests__") out.push(...sources(path));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe("the fields the board feed drops", () => {
  test("no client source reads any of them", () => {
    const files = sources(CLIENT_SRC);
    expect(files.length).toBeGreaterThan(500);
    const readers: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const field of FEED_OMITTED_TASK_FIELDS) {
          if (!new RegExp(`\\b${field}\\b`).test(line)) continue;
          const declaration = file === TYPE_FILE && new RegExp(`^\\s*(readonly\\s+)?${field}\\??:`).test(line);
          if (!declaration) readers.push(`${relative(ROOT, file)}:${i + 1} ${field}`);
        }
      });
    }
    expect(readers).toEqual([]);
  });

  test("toFeedTask drops exactly the listed keys and keeps the rest as they were", () => {
    const task: Record<string, unknown> = { id: "t1", status: "todo", blockedBy: { id: "b" }, labels: [] };
    for (const field of FEED_OMITTED_TASK_FIELDS) task[field] = `${field}-value`;
    const lean = toFeedTask(task) as Record<string, unknown>;
    expect(Object.keys(lean)).toEqual(["id", "status", "blockedBy", "labels"]);
    expect(lean.blockedBy).toBe(task.blockedBy);
    expect(lean.labels).toBe(task.labels);
    expect(Object.keys(task).length).toBe(4 + FEED_OMITTED_TASK_FIELDS.length);
  });
});
