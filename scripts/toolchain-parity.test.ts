/**
 * The TS 5 vs TS 7 parity bar: reading tsc output, comparing it, and refusing to
 * call "identical" what it never measured.
 *
 * @covers GATE-04
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compilerDidNotRun, diffErrors, EXIT_NOT_MEASURED, parseConfig, parseErrors } from "./toolchain-parity";

const ROOT = join(import.meta.dir, "..");

describe("parseErrors", () => {
  test("keeps file, position and code, drops the message text", () => {
    const out = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src\\b.ts(10,1): error TS7006: Parameter 'x' implicitly has an 'any' type.",
      "  some continuation line",
      "error TS5083: Cannot read file 'x.json'.",
    ].join("\n");
    expect(parseErrors(out)).toEqual(["<global>: TS5083", "src/a.ts(3,7): TS2322", "src/b.ts(10,1): TS7006"]);
  });

  test("the same error reworded by TS 7 is the same key", () => {
    const a = parseErrors("x.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.");
    const b = parseErrors("x.ts(1,1): error TS2322: Type 'A' is not assignable to 'B'.");
    expect(diffErrors(a, b)).toEqual({ onlyA: [], onlyB: [] });
  });
});

describe("diffErrors", () => {
  test("counts duplicates: one compiler reporting an error twice is a difference", () => {
    expect(diffErrors(["k", "k"], ["k"])).toEqual({ onlyA: ["k"], onlyB: [] });
    expect(diffErrors(["a"], ["b"])).toEqual({ onlyA: ["a"], onlyB: ["b"] });
  });
});

describe("not measured is never green", () => {
  test("TS 7 launcher without its native package is detected", () => {
    expect(compilerDidNotRun("Error: Unable to resolve @typescript/typescript-darwin-arm64")).toBe(true);
    expect(compilerDidNotRun("x.ts(1,1): error TS2322: nope")).toBe(false);
    expect(EXIT_NOT_MEASURED).toBe(97);
  });

  test("a config without runs is rejected, not compared as identical", () => {
    expect(() => parseConfig({ typecheck: { nodeModules: "client/node_modules", runs: [] } })).toThrow();
    expect(() => parseConfig({})).toThrow();
    expect(() => parseConfig({ typecheck: { nodeModules: "x", runs: [{ name: "a", args: [1] }] } })).toThrow();
  });

  test("the committed config parses and lists the five gated projects", async () => {
    const cfg = parseConfig(await Bun.file(join(ROOT, "spec-flow.toolchain.json")).json());
    const names = cfg.runs.map((r) => r.name);
    for (const n of ["client (tsc -b)", "client test", "server", "e2e", "relay"]) expect(names).toContain(n);
  });

  test("barra:toolchain points at a script that exists", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json();
    const cmd: string = pkg.scripts["barra:toolchain"];
    const file = /(\S+\.(?:ts|mjs|js))/.exec(cmd)?.[1];
    expect(file).toBeDefined();
    expect(await Bun.file(join(ROOT, file!)).exists()).toBe(true);
  });
});
