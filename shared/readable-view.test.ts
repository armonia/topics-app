import { describe, expect, test } from "bun:test";
import {
  deterministicReadableView,
  resolveDeclSpec,
  resolvePath,
  shapeSignature,
  validateDeclSpec,
} from "./readable-view";

describe("deterministicReadableView — real shapes from the transcripts", () => {
  test("task_get: a plain key/value object becomes a kv card", () => {
    const value = { id: "458c16a6", status: "review", title: "Formattazione markdown" };
    expect(deterministicReadableView(value)).toEqual({
      kind: "kv",
      fields: [
        { label: "id", value: "458c16a6" },
        { label: "status", value: "review" },
        { label: "title", value: "Formattazione markdown" },
      ],
    });
  });

  test("task_list: a list of task objects becomes a table", () => {
    const value = [
      { id: "a1", text: "Fix the thing", status: "todo" },
      { id: "b2", text: "Ship it", status: "review" },
    ];
    expect(deterministicReadableView(value)).toEqual({
      kind: "table",
      columns: ["id", "text", "status"],
      rows: [
        ["a1", "Fix the thing", "todo"],
        ["b2", "Ship it", "review"],
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
    expect(deterministicReadableView({ count: 7 })).toEqual({ kind: "counter", label: "count", value: "7" });
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
      fields: [{ label: "Stato", value: "review" }, { label: "Titolo", value: "Card" }],
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
