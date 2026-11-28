/**
 * @covers READABLE-01
 */
import { describe, expect, test } from "bun:test";
import {
  deterministicReadableView,
  resolveDeclSpec,
  resolvePath,
  shapeSignature,
  validateDeclSpec,
} from "./readable-view";

describe("deterministicReadableView — real shapes from the transcripts", () => {
  test("task_get: an object with title and status becomes a card with a status chip and label chips", () => {
    const value = { id: "458c16a6", status: "in_progress", title: "Formattazione markdown", labels: ["ui", "chat"], branch: "topics/x", delivery: null, updatedAt: "2026-11-21T11:48:00Z" };
    expect(deterministicReadableView(value)).toEqual({
      kind: "card",
      title: "Formattazione markdown",
      status: { text: "in progress", kind: "status", tone: "warning" },
      labels: ["ui", "chat"],
      fields: [
        { label: "id", value: { text: "458c16a6" } },
        { label: "branch", value: { text: "topics/x" } },
        { label: "delivery", value: { text: "—", kind: "empty" } },
        { label: "updatedAt", value: { text: "2026-11-21T11:48:00Z", kind: "date" } },
      ],
    });
  });

  test("an object without a title stays a key/value list, arrays as chips", () => {
    expect(deterministicReadableView({ id: "x1", tags: ["ui", "chat"] })).toEqual({
      kind: "kv",
      fields: [
        { label: "id", value: { text: "x1" } },
        { label: "tags", value: { text: "ui, chat", kind: "chips", items: ["ui", "chat"] } },
      ],
    });
  });

  test("task_list: a list of task objects becomes a table with typed cells", () => {
    const value = [
      { id: "a1", branch: "topics/a", status: "todo", labels: ["ui"] },
      { id: "b2", branch: "topics/b", status: "review", labels: [] },
    ];
    expect(deterministicReadableView(value)).toEqual({
      kind: "table",
      columns: ["id", "branch", "status", "labels"],
      rows: [
        [{ text: "a1" }, { text: "topics/a" }, { text: "todo", kind: "status", tone: "warning" }, { text: "ui", kind: "chips", items: ["ui"] }],
        [{ text: "b2" }, { text: "topics/b" }, { text: "review", kind: "status", tone: "warning" }, { text: "—", kind: "empty" }],
      ],
    });
  });

  test("gh pr checks (JSON array of check objects) becomes a table", () => {
    const value = [
      { name: "unit", state: "SUCCESS", bucket: "pass" },
      { name: "e2e", state: "FAILURE", bucket: "fail" },
    ];
    const got = deterministicReadableView(value);
    expect(got?.kind).toBe("table");
    expect((got as { columns: string[] }).columns).toEqual(["name", "state", "bucket"]);
  });

  test("a file search result (array of paths) becomes a clickable list", () => {
    const value = ["shared/readable-view.ts", "shared/readable-view.test.ts", "client/src/components/Chat/ToolCards.tsx"];
    expect(deterministicReadableView(value)).toEqual({
      kind: "list",
      items: value.map((text) => ({ text })),
    });
  });

  test("an unknown MCP result (no recognizable shape here) needs the fallback", () => {
    // A deeply irregular array — not all strings, not all objects — has no
    // deterministic view: this is exactly the case the model fallback exists for.
    const value = ["a", 1, { weird: true }];
    expect(deterministicReadableView(value)).toBeNull();
  });

  test("an error result becomes an error view, not a generic kv card", () => {
    const value = { error: "task not found", ok: false };
    expect(deterministicReadableView(value)).toEqual({ kind: "error", message: "task not found" });
  });

  test("a single scalar field becomes a counter, not a one-row table", () => {
    expect(deterministicReadableView({ count: 7 })).toEqual({ kind: "counter", label: "count", value: { text: "7" } });
  });

  test("null/undefined/empty have no deterministic view", () => {
    expect(deterministicReadableView(null)).toBeNull();
    expect(deterministicReadableView(undefined)).toBeNull();
    expect(deterministicReadableView({})).toBeNull();
    expect(deterministicReadableView([])).toBeNull();
  });
});

describe("resolvePath", () => {
  test("dotted and bracket paths", () => {
    const value = { a: { b: [{ c: "x" }] } };
    expect(resolvePath(value, "a.b[0].c")).toBe("x");
    expect(resolvePath(value, "a.b.0.c")).toBe("x");
    expect(resolvePath(value, "a.missing")).toBeUndefined();
  });
});

describe("validateDeclSpec — structural gate before any path is resolved", () => {
  test("accepts a well-formed kv spec", () => {
    expect(validateDeclSpec({ kind: "kv", fields: [{ label: "Stato", path: "status" }] })).not.toBeNull();
  });

  test("rejects a spec carrying a literal value next to a path", () => {
    // The model is only allowed to name PATHS; a 'value' key is the one thing
    // that would let it invent a number.
    expect(validateDeclSpec({ kind: "counter", label: "Totale", path: "total", value: 42 })).toBeNull();
  });

  test("rejects an unknown kind", () => {
    expect(validateDeclSpec({ kind: "chart", path: "x" })).toBeNull();
  });
});

describe("resolveDeclSpec — mutation gate: an invented path discards the whole spec", () => {
  const value = { status: "review", title: "Card" };

  test("a spec whose paths all resolve renders", () => {
    const spec = validateDeclSpec({ kind: "kv", fields: [{ label: "Stato", path: "status" }, { label: "Titolo", path: "title" }] });
    expect(spec).not.toBeNull();
    expect(resolveDeclSpec(spec!, value)).toEqual({
      kind: "kv",
      fields: [{ label: "Stato", value: { text: "review", kind: "status", tone: "warning" } }, { label: "Titolo", value: { text: "Card" } }],
    });
  });

  test("a path that does not exist in the source discards the whole spec (no partial view)", () => {
    const spec = validateDeclSpec({ kind: "kv", fields: [{ label: "Stato", path: "status" }, { label: "Budget", path: "budgetCents" }] });
    expect(spec).not.toBeNull();
    // Without this check the test is red: `budgetCents` is not in `value`, and
    // a naive resolver would silently render "—" instead of refusing the spec.
    expect(resolveDeclSpec(spec!, value)).toBeNull();
  });

  test("a table whose rowsPath does not point at an array discards the spec", () => {
    const spec = validateDeclSpec({ kind: "table", columns: [{ label: "Stato", path: "status" }], rowsPath: "notAnArray" });
    expect(resolveDeclSpec(spec!, value)).toBeNull();
  });
});

describe("shapeSignature — keys and types only, never values", () => {
  test("two objects with the same keys/types share a signature regardless of their values", () => {
    const a = { id: "x1", status: "todo" };
    const b = { id: "y2", status: "review" };
    expect(shapeSignature(a)).toBe(shapeSignature(b));
  });

  test("a different key set changes the signature", () => {
    expect(shapeSignature({ id: "x" })).not.toBe(shapeSignature({ id: "x", extra: 1 }));
  });
});

describe("nested values go to the fallback", () => {
  test("an object with an array of objects inside is not deterministic", () => {
    expect(deterministicReadableView({ results: [{ id: 1, name: "a" }], total: 3 })).toBeNull();
  });
  test("a nested object in a table cell is not deterministic", () => {
    expect(deterministicReadableView([{ id: 1, meta: { a: 1 } }])).toBeNull();
  });
  test("flat shapes stay deterministic", () => {
    expect(deterministicReadableView({ a: 1, b: "x", tags: ["p", "q"] })?.kind).toBe("kv");
  });
});

describe("resolvePath fan-out", () => {
  const value = { data: { items: [{ name: "a", n: 1 }, { name: "b", n: 2 }] } };
  test("[] maps over an array", () => {
    expect(resolvePath(value, "data.items[].name")).toEqual(["a", "b"]);
    expect(resolvePath(value, "data.items[]")).toEqual(value.data.items);
  });
  test("a step missing in one element discards the path", () => {
    expect(resolvePath({ items: [{ a: 1 }, {}] }, "items[].a")).toBeUndefined();
  });
  test("table columns resolve relative to the row, absolute notation included", () => {
    const spec = { kind: "table" as const, rowsPath: "data.items[]", columns: [{ label: "N", path: "data.items[].name" }, { label: "Num", path: "n" }] };
    expect(resolveDeclSpec(spec, value)).toEqual({ kind: "table", columns: ["N", "Num"], rows: [[{ text: "a" }, { text: "1" }], [{ text: "b" }, { text: "2" }]] });
  });
});
